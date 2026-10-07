import {
  OwnerIdSchema,
  OwnerStateSchema,
  type ActiveTaskState,
  type DurableOwnerState,
  type OwnerId,
} from '@aven/contracts';
import { OwnerModelError, type OwnerModelErrorCode } from './errors.ts';

/**
 * AVEN-009 patch 2: owner-bound typed owner-state intake.
 *
 * `intakeOwnerState` receives UNKNOWN runtime values, keeps only the
 * requesting owner's records, validates each against the frozen AVEN-002
 * `OwnerStateSchema` (durable owner state or active task state), enforces
 * local identity invariants, and returns deeply frozen records in one
 * canonical order. It does not resolve lineage (replacement, fallback,
 * supersession), verify lifecycle or promotion claims, judge transitions
 * between versions, read storage or the Ledger, or interpret anything.
 *
 * Request: an ordinary object with exactly two own data properties, `ownerId`
 * (the externally supplied owner binding) and `records` (an array). Records
 * never change the binding.
 *
 * Owner recognition reads ONE own data property, `ownerId`, of each element,
 * through its property descriptor: no getter runs, nothing inherited counts,
 * and a Proxy is asked once. Each element falls in exactly one class:
 *   A. recognizable foreign: `ownerId` is a well-formed owner ID other than
 *      the requester's. Dropped before anything else is read, so it never
 *      affects validation, duplicates, counts, ordering, conflicts or errors.
 *   B. requesting owner: `ownerId` equals the requester's. Snapshotted and
 *      validated as described below.
 *   C. unrecognizable: a hole, a non-object, an accessor or unreadable
 *      element, or an `ownerId` that is missing, inherited, an accessor, not a
 *      string or not a well-formed owner ID. Ownership cannot be established,
 *      so the whole intake fails closed with `invalid_input`, which is the
 *      same public error a malformed requesting-owner record produces. No
 *      error ever carries a position, count, ID or owner, so a class-C or
 *      class-B failure is identical wherever it sits among foreign records.
 *
 * A raw resource bound (MAX_RAW_RECORDS) is checked on the array length alone,
 * before any element is read; like the AVEN-008 raw bound it is resource
 * safety over the caller's whole array, not an owner quota, and its failure
 * carries no count.
 *
 * Snapshot: a class-B element is copied once into plain data before
 * validation. Only ordinary objects (prototype Object.prototype or null) and
 * dense ordinary arrays are accepted; every property must be an own,
 * enumerable, string-keyed data property (no getter is ever invoked, no
 * symbol key, no `__proto__` key); functions, symbols, bigints, class
 * instances, cycles and nesting deeper than MAX_SNAPSHOT_DEPTH fail closed.
 * Each descriptor is read once, so values cannot change between checks. The
 * snapshot's `ownerId` must still equal the requester's. The frozen schema
 * then validates the snapshot strictly (unknown keys, NaN, Infinity,
 * non-integer or non-positive versions, malformed lifecycle, references or
 * timestamps all fail); nothing is coerced or repaired.
 *
 * Nested owner identity: the frozen contracts carry an owner ID only in
 * owner-origin provenance (`provenance.ownerId`) and in owner confirmation
 * provenance (`evidence.ownerConfirmation.provenance.ownerId`); the frozen
 * schema already requires both to equal the record owner, and intake also
 * rejects any nested `ownerId` that differs. Evidence, counterexample,
 * learned-item, candidate and evaluation references are OWNERLESS IDs in the
 * frozen contracts; intake cannot and does not establish which owner they
 * resolve to. That resolution belongs to later persistence/lineage patches.
 *
 * Identity invariants over the requesting owner's validated records, checked
 * per stable ID in canonical ID order, so the reported failure never depends
 * on input order:
 *   1. one ID is one record kind (durable owner state XOR active task state)
 *      across all versions, else `identity_conflict`;
 *   2. records with the same ID and version are collapsed when canonically
 *      identical, else `conflicting_duplicate` (neither is ever chosen);
 *   3. a durable ID keeps one content category across versions, else
 *      `identity_conflict`;
 *   4. `metadata.createdAt` never moves backwards as `recordVersion`
 *      increases (equal is accepted), compared exactly from the timestamp
 *      text with no clock, else `version_order_conflict`.
 * Version gaps are accepted and no first version is required. Transitions
 * between versions (for example trusted then observed) are not judged here.
 *
 * Canonical output: `durable` and `activeTasks` partitions, each ordered by
 * stable ID (UTF-16 code units) then numeric `recordVersion`. Object keys are
 * in code-unit order and keys whose value is `undefined` are omitted. Every
 * object and array is a fresh copy, frozen; the caller's input is never
 * frozen or retained. The result is a pure function of the requesting owner's
 * record set: foreign records and input order cannot change it.
 */

/** Raw resource bound on the caller's array length (all owners). */
const MAX_RAW_RECORDS = 100_000;
/** Nesting bound for the plain-data snapshot of one record. */
const MAX_SNAPSHOT_DEPTH = 32;

/** The documented request shape; the function itself accepts `unknown`. */
export interface OwnerStateIntakeRequest {
  readonly ownerId: string;
  readonly records: readonly unknown[];
}

/** Deeply frozen, canonically ordered, owner-bound intake result. */
export interface OwnerStateIntake {
  readonly ownerId: OwnerId;
  readonly durable: readonly DurableOwnerState[];
  readonly activeTasks: readonly ActiveTaskState[];
}

/* Internal failure tokens, compared by identity only (never inspected). */
const REJECT = Object.freeze({ token: 'reject' });
const INTERNAL = Object.freeze({ token: 'internal' });
const DUPLICATE = Object.freeze({ token: 'duplicate' });
const IDENTITY = Object.freeze({ token: 'identity' });
const VERSION_ORDER = Object.freeze({ token: 'version_order' });
const FAILURES: ReadonlyMap<object, OwnerModelErrorCode> = new Map<
  object,
  OwnerModelErrorCode
>([
  [REJECT, 'invalid_input'],
  [INTERNAL, 'internal_error'],
  [DUPLICATE, 'conflicting_duplicate'],
  [IDENTITY, 'identity_conflict'],
  [VERSION_ORDER, 'version_order_conflict'],
]);

/** Runs caller-influenced reads; anything they throw becomes REJECT. */
function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw REJECT;
  }
}

type OwnData =
  { readonly found: false } | { readonly found: true; value: unknown };
const MISSING: OwnData = Object.freeze({ found: false });

/**
 * One own property, read once through its descriptor. An accessor fails
 * closed (its getter is never invoked); an absent or inherited property is
 * MISSING. Must be called inside `guarded`.
 */
function ownData(target: object, key: string): OwnData {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return MISSING;
  if (!Object.hasOwn(descriptor, 'value')) throw REJECT;
  return { found: true, value: descriptor.value };
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** Plain-data copy of one record; must be called inside `guarded`. */
function snapshot(value: unknown, depth: number, ancestors: object[]): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  )
    return value;
  if (!isObject(value)) throw REJECT;
  if (depth > MAX_SNAPSHOT_DEPTH || ancestors.includes(value)) throw REJECT;
  const isArray = Array.isArray(value);
  const prototype = Reflect.getPrototypeOf(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw REJECT;
  const keys = Reflect.ownKeys(value);
  ancestors.push(value);
  try {
    if (isArray) {
      const length = ownData(value, 'length');
      if (
        !length.found ||
        typeof length.value !== 'number' ||
        !Number.isSafeInteger(length.value) ||
        keys.length !== length.value + 1
      )
        throw REJECT;
      const copy: unknown[] = [];
      for (let i = 0; i < length.value; i += 1)
        copy.push(
          snapshot(enumerableData(value, String(i)), depth + 1, ancestors),
        );
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') throw REJECT;
      Object.defineProperty(copy, key, {
        value: snapshot(enumerableData(value, key), depth + 1, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.pop();
  }
}

/** An own, enumerable data property's value, read once. */
function enumerableData(target: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== true
  )
    throw REJECT;
  return descriptor.value;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fresh, frozen copy of validated data: keys in code-unit order, `undefined`
 * values omitted, and any nested `ownerId` required to equal the requester's.
 */
function canonical(value: unknown, ownerId: string): unknown {
  if (Array.isArray(value))
    return Object.freeze(value.map((entry) => canonical(entry, ownerId)));
  if (!isObject(value)) return value;
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareCodeUnits)) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (key === 'ownerId' && entry !== ownerId) throw REJECT;
    Object.defineProperty(copy, key, {
      value: canonical(entry, ownerId),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

/* Exact instant comparison of frozen AVEN-002 timestamps (no clock). */
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function compareTimestamps(a: string, b: string): number {
  const [x, y] = [a.match(TIMESTAMP), b.match(TIMESTAMP)];
  if (x === null || y === null) throw INTERNAL;
  const [msA, msB] = [
    Date.parse(`${x[1]}${x[3]}`),
    Date.parse(`${y[1]}${y[3]}`),
  ];
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) throw INTERNAL;
  if (msA !== msB) return msA < msB ? -1 : 1;
  const [fa, fb] = [x[2] ?? '', y[2] ?? ''];
  const width = Math.max(fa.length, fb.length);
  return compareCodeUnits(fa.padEnd(width, '0'), fb.padEnd(width, '0'));
}

interface Entry {
  readonly id: string;
  readonly version: number;
  readonly durable: boolean;
  readonly category: string | undefined;
  readonly createdAt: string;
  readonly text: string;
  readonly record: DurableOwnerState | ActiveTaskState;
}

function byIdentity(a: Entry, b: Entry): number {
  return (
    compareCodeUnits(a.id, b.id) ||
    a.version - b.version ||
    compareCodeUnits(a.text, b.text)
  );
}

/** Phase 1: owner binding, raw bound and class A/B/C recognition. */
function ownedElements(request: unknown): {
  ownerId: OwnerId;
  owned: object[];
} {
  return guarded(() => {
    if (!isObject(request) || Array.isArray(request)) throw REJECT;
    const keys = Reflect.ownKeys(request);
    if (
      keys.length !== 2 ||
      !keys.includes('ownerId') ||
      !keys.includes('records')
    )
      throw REJECT;
    const requester = ownData(request, 'ownerId');
    if (!requester.found || typeof requester.value !== 'string') throw REJECT;
    const parsedOwner = OwnerIdSchema.safeParse(requester.value);
    if (!parsedOwner.success) throw REJECT;
    const records = ownData(request, 'records');
    if (!records.found || !isObject(records.value)) throw REJECT;
    const list = records.value;
    if (!Array.isArray(list)) throw REJECT;
    const length = ownData(list, 'length');
    if (
      !length.found ||
      typeof length.value !== 'number' ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > MAX_RAW_RECORDS
    )
      throw REJECT;
    const owned: object[] = [];
    for (let i = 0; i < length.value; i += 1) {
      const element = ownData(list, String(i));
      if (!element.found || !isObject(element.value)) throw REJECT;
      const owner = ownData(element.value, 'ownerId');
      if (!owner.found || typeof owner.value !== 'string') throw REJECT;
      if (owner.value === parsedOwner.data) owned.push(element.value);
      else if (!OwnerIdSchema.safeParse(owner.value).success) throw REJECT;
      /* else: class A, recognizable foreign, dropped unread. */
    }
    return { ownerId: parsedOwner.data, owned };
  });
}

/** Phase 2: snapshot, strict frozen-contract validation, canonical copy. */
function validated(ownerId: OwnerId, element: object): Entry {
  const plain = guarded(() => snapshot(element, 0, []));
  if (!isObject(plain) || (plain as { ownerId?: unknown }).ownerId !== ownerId)
    throw REJECT;
  const parsed = OwnerStateSchema.safeParse(plain);
  if (!parsed.success) throw REJECT;
  const record = canonical(parsed.data, ownerId) as
    DurableOwnerState | ActiveTaskState;
  const durable = record.kind === 'durable_owner_state';
  return {
    id: record.id,
    version: record.metadata.recordVersion,
    durable,
    category: durable ? record.content.category : undefined,
    createdAt: record.metadata.createdAt,
    text: JSON.stringify(record),
    record,
  };
}

/** Phase 3: identity invariants per stable ID, in canonical order. */
function distinct(entries: Entry[]): Entry[] {
  const sorted = [...entries].sort(byIdentity);
  const kept: Entry[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end < sorted.length && sorted[end]!.id === sorted[start]!.id)
      end += 1;
    const group = sorted.slice(start, end);
    const first = group[0]!;
    if (group.some((e) => e.durable !== first.durable)) throw IDENTITY;
    const versions: Entry[] = [];
    for (const entry of group) {
      const previous = versions[versions.length - 1];
      if (previous !== undefined && previous.version === entry.version) {
        if (previous.text !== entry.text) throw DUPLICATE;
        continue;
      }
      versions.push(entry);
    }
    if (versions.some((e) => e.category !== first.category)) throw IDENTITY;
    for (let i = 1; i < versions.length; i += 1)
      if (
        compareTimestamps(versions[i - 1]!.createdAt, versions[i]!.createdAt) >
        0
      )
        throw VERSION_ORDER;
    kept.push(...versions);
    start = end;
  }
  return kept;
}

/**
 * Owner-bound intake of potential owner-state records. Accepts `unknown`
 * (see `OwnerStateIntakeRequest`); throws `OwnerModelError` with a fixed code
 * and message and nothing else.
 */
export function intakeOwnerState(request: unknown): OwnerStateIntake {
  try {
    const { ownerId, owned } = ownedElements(request);
    const kept = distinct(owned.map((element) => validated(ownerId, element)));
    const durable: DurableOwnerState[] = [];
    const activeTasks: ActiveTaskState[] = [];
    for (const { record } of kept)
      if (record.kind === 'durable_owner_state') durable.push(record);
      else activeTasks.push(record);
    return Object.freeze({
      ownerId,
      durable: Object.freeze(durable),
      activeTasks: Object.freeze(activeTasks),
    });
  } catch (thrown) {
    throw new OwnerModelError(
      isObject(thrown)
        ? (FAILURES.get(thrown) ?? 'internal_error')
        : 'internal_error',
    );
  }
}
