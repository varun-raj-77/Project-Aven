import {
  LearningTransitionSchema,
  type DurableOwnerState,
  type EventId,
  type LearnedItemId,
  type LearnedItemReference,
  type LearningTransition,
  type OwnerId,
} from '@aven/contracts';
import { ambientIntact, sealAmbient, type AmbientSeal } from './ambient.ts';
import { compareCodeUnits } from './canonical-text.ts';
import { OwnerModelError, type OwnerModelErrorCode } from './errors.ts';
import {
  isDurableLineage,
  type DurableLineage,
  type LineageEdge,
  type LineageNode,
} from './lineage.ts';

/**
 * AVEN-009 patch 4: agreement of durable lifecycle CLAIMS with supplied
 * recorded learning-transition records (internal; not exported from the
 * package index).
 *
 * Input: a lineage produced by `buildDurableLineage` (Patch 3, recognized by
 * identity only; anything else fails with `invalid_input`) and an array of
 * recorded transitions (frozen AVEN-002 `LearningTransition` values, as a
 * later persistence patch will read them from the Ledger). Nothing is
 * fetched: no Ledger, storage, Root or network.
 *
 * Which snapshots need backing (frozen contracts; the storage reference
 * projection maps the same pointers to the same event types):
 *   - `trusted`: `promotionEventId` -> a `learning_promotion` whose
 *     `trustedState` is exactly this snapshot, and whose `candidate` and
 *     `evaluations` (ordered; the contract declares an array, not a set)
 *     equal the snapshot's;
 *   - `superseded`: `eventId` -> a `learning_supersession` whose `previous`
 *     is exactly this snapshot and whose `replacement` is exactly the
 *     Patch-3 replacement edge target;
 *   - `revoked`: `eventId` -> a `learning_revocation` whose `revoked` is
 *     exactly this snapshot, whose `fallback` is absent exactly when the
 *     snapshot has no fallback edge and otherwise equals the Patch-3
 *     fallback edge target, and whose `reason` equals the snapshot's.
 * `observed` and `validated` snapshots carry no transition reference and
 * need none. Fields present on only one side (`lastValidatedAt`,
 * `previousTrustedState`, the supersession `reason` and `promotionEventId`,
 * `evidence`, `authority`) are not compared.
 *
 * Timestamps are NOT compared. No frozen contract, constraint or document
 * states that a transition's `occurredAt` equals the snapshot's
 * `supersededAt` or `revokedAt` (they are independent TimestampSchema
 * fields; frozen fixtures merely reuse one value), so Patch 4 does not
 * invent that equality.
 *
 * Transition boundary (inert snapshot): each element is first copied into
 * inert own data WITHOUT executing caller code on ordinary objects: only
 * plain or null-prototype objects and dense Array.prototype arrays are
 * accepted; every property must be an own data property (enumerable, except
 * an array `length`) read through its descriptor, so a getter or setter is
 * never invoked and an accessor fails with `invalid_input`; symbol keys,
 * other prototypes (class instances, exotic objects), holes, extra array
 * properties, cycles and excessive depth fail with `invalid_input`; nothing
 * inherited can supply a field. A Proxy can run its reflection traps during
 * this copy (this is before any validation, so it has no more power than
 * code run before the call), and is then rejected with `invalid_input` by a
 * `structuredClone` screen, which refuses any Proxy without running traps.
 * Only then is the frozen `LearningTransitionSchema` run, on the inert copy
 * alone, so no caller code can run while the schema decides; only the
 * schema output is used. A schema-invalid element of ANY owner fails closed
 * with `invalid_lifecycle_claim`. The Patch-2 ambient gate is reused at
 * entry and re-checked after the caller reads, after the snapshot and after
 * validation (defense in depth, not the reason validation is unaffected).
 * Valid transitions of another owner are then dropped unread (never
 * indexed), so a foreign transition can never back a claim and its presence
 * is indistinguishable from its absence.
 *
 * Event identity: a transition's `eventId` is the ID of the Ledger event that
 * records it (frozen ExperienceEvent refinement: payload `eventId` equals the
 * event `id`), and frozen storage keeps both `experience_events` and
 * `lifecycle_records` (keyed by `$.eventId`) UNIQUE per (owner, record ID).
 * So an owner-bound set never legitimately holds two transitions with one
 * `eventId`. Any repeated `eventId` (even an identical copy) makes the whole
 * set ambiguous and fails closed; nothing wins by position, kind or content.
 * Resolution is by exact `eventId` only.
 * Unused transitions (rejections, rollbacks, unrelated promotions,
 * supersessions or revocations) are allowed and change nothing.
 *
 * Every disagreement (missing, foreign, wrong kind, ambiguous, schema-invalid
 * or field mismatch) is the one fixed `invalid_lifecycle_claim` error, so no
 * outcome reveals where an event ID exists or why it failed. Non-inert input
 * (accessor, Proxy, exotic object) is `invalid_input`, independent of any
 * event ID.
 *
 * Authority: a transition's policy `authority` reference is schema-validated
 * as recorded data and nothing more. Agreement means "the recorded
 * transition agrees structurally with the snapshot's lifecycle claim"; it is
 * NOT proof that Root authorized anything, and no Root is consulted.
 *
 * Verification applies nothing: no lifecycle is created or rewritten, no
 * rejection, rollback, replacement or fallback takes effect, and nothing
 * decides which version applies. The result references the frozen Patch-3
 * lineage unchanged and adds only a minimal claim trace. Index construction
 * is linear in transitions, lineage edges and snapshots, plus one sort of
 * the claims.
 *
 * Results are recognized only by the module instance that built them
 * (WeakSet identity); they are not serializable proofs.
 */

/** The lifecycle status a snapshot claims, for which backing was checked. */
export type LifecycleClaimKind = 'revoked' | 'superseded' | 'trusted';

/** One verified claim: which snapshot claimed it and the exact event. */
export interface LifecycleClaim {
  readonly kind: LifecycleClaimKind;
  readonly snapshot: LineageNode;
  readonly eventId: EventId;
}

export interface VerifiedDurableLineage {
  readonly ownerId: OwnerId;
  readonly lineage: DurableLineage;
  readonly claims: readonly LifecycleClaim[];
}

/** Raw resource bound on the caller's transition array length. */
const MAX_TRANSITIONS = 100_000;

const PRODUCED = new WeakSet<object>();

/** Whether `value` was produced by `verifyLifecycleClaims` (internal). */
export function isVerifiedDurableLineage(
  value: unknown,
): value is VerifiedDurableLineage {
  return value !== null && typeof value === 'object' && PRODUCED.has(value);
}

/* Internal failure tokens, compared by identity only. */
const REJECT = Object.freeze({ token: 'reject' });
const CLAIM = Object.freeze({ token: 'claim' });
const FAILURES: ReadonlyMap<object, OwnerModelErrorCode> = new Map<
  object,
  OwnerModelErrorCode
>([
  [REJECT, 'invalid_input'],
  [CLAIM, 'invalid_lifecycle_claim'],
]);

function sameItem(
  reference: LearnedItemReference | undefined,
  learnedItemId: LearnedItemId,
  version: number,
): boolean {
  return (
    reference !== undefined &&
    reference.learnedItemId === learnedItemId &&
    reference.version === version
  );
}

function sameNode(
  reference: LearnedItemReference | undefined,
  target: LineageNode | undefined,
): boolean {
  return (
    target !== undefined &&
    sameItem(reference, target.learnedItemId, target.version)
  );
}

type Lifecycle = DurableOwnerState['lifecycle'];
type Trusted = Extract<Lifecycle, { promotionEventId: string }>;

/** Ordered, field-by-field equality of the frozen reference arrays. */
function sameValidation(lifecycle: Trusted, transition: LearningTransition) {
  if (transition.kind !== 'learning_promotion') return false;
  const a = lifecycle.evaluations;
  const b = transition.evaluations;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1)
    if (
      a[i]!.evaluationId !== b[i]!.evaluationId ||
      a[i]!.version !== b[i]!.version
    )
      return false;
  return (
    lifecycle.candidate.candidateId === transition.candidate.candidateId &&
    lifecycle.candidate.version === transition.candidate.version
  );
}

/** Whether `transition` agrees with every claim `record` makes about it. */
function agrees(
  record: DurableOwnerState,
  transition: LearningTransition,
  edge: LineageEdge | undefined,
): boolean {
  const id = record.id;
  const version = record.metadata.recordVersion;
  const lifecycle = record.lifecycle;
  if (lifecycle.status === 'trusted')
    return (
      transition.kind === 'learning_promotion' &&
      sameItem(transition.trustedState, id, version) &&
      sameValidation(lifecycle, transition)
    );
  if (lifecycle.status === 'superseded')
    return (
      transition.kind === 'learning_supersession' &&
      edge !== undefined &&
      edge.kind === 'replacement' &&
      sameItem(transition.previous, id, version) &&
      sameNode(transition.replacement, edge.target) &&
      sameNode(lifecycle.replacement, edge.target)
    );
  if (lifecycle.status === 'revoked')
    return (
      transition.kind === 'learning_revocation' &&
      sameItem(transition.revoked, id, version) &&
      (edge === undefined
        ? lifecycle.fallback === undefined && transition.fallback === undefined
        : edge.kind === 'fallback' &&
          sameNode(lifecycle.fallback, edge.target) &&
          sameNode(transition.fallback, edge.target)) &&
      transition.reason === lifecycle.reason
    );
  return false;
}

/** The event a snapshot's lifecycle says backs it, if it names one. */
function backing(
  record: DurableOwnerState,
): { kind: LifecycleClaimKind; eventId: EventId } | undefined {
  const lifecycle = record.lifecycle;
  if (lifecycle.status === 'trusted')
    return { kind: 'trusted', eventId: lifecycle.promotionEventId };
  if (lifecycle.status === 'superseded')
    return { kind: 'superseded', eventId: lifecycle.eventId };
  if (lifecycle.status === 'revoked')
    return { kind: 'revoked', eventId: lifecycle.eventId };
  return undefined;
}

function byClaim(a: LifecycleClaim, b: LifecycleClaim): number {
  return (
    compareCodeUnits(a.kind, b.kind) ||
    compareCodeUnits(a.snapshot.learnedItemId, b.snapshot.learnedItemId) ||
    a.snapshot.version - b.snapshot.version ||
    compareCodeUnits(a.eventId, b.eventId)
  );
}

/** Nesting bound for one transition snapshot (the frozen shapes are shallow). */
const MAX_SNAPSHOT_DEPTH = 16;

/**
 * The value of an own DATA property, read through its descriptor so that a
 * getter or setter is never invoked; anything else fails with `REJECT`.
 */
function dataValue(target: object, key: string, enumerable: boolean): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set') ||
    !Object.hasOwn(descriptor, 'enumerable') ||
    descriptor.enumerable !== enumerable
  )
    throw REJECT;
  return descriptor.value;
}

/** Inert own-data copy of one caller value (see the module comment). */
function snapshot(value: unknown, depth: number, path: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value !== 'object' || depth > MAX_SNAPSHOT_DEPTH) throw REJECT;
  if (path.has(value)) throw REJECT;
  path.add(value);
  const prototype = Reflect.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  let copy: unknown;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw REJECT;
    const length = dataValue(value, 'length', false);
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      keys.length !== length + 1 ||
      keys[length] !== 'length'
    )
      throw REJECT;
    const items: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      const key = keys[i];
      if (key !== String(i)) throw REJECT;
      items.push(snapshot(dataValue(value, key, true), depth + 1, path));
    }
    copy = items;
  } else {
    if (prototype !== Object.prototype && prototype !== null) throw REJECT;
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') throw REJECT;
      record[key] = snapshot(dataValue(value, key, true), depth + 1, path);
    }
    copy = record;
  }
  path.delete(value);
  return copy;
}

/**
 * The inert copy of one transition element: descriptor-only snapshot first
 * (no getter or setter runs), then a `structuredClone` screen that refuses
 * any Proxy in the element without running its traps. The clone itself is
 * discarded; only the snapshot is used.
 */
function inert(value: unknown): unknown {
  const copy = snapshot(value, 0, new Set());
  structuredClone(value);
  return copy;
}

/**
 * Reads the caller's array once (length, then each index once), makes an
 * inert own-data copy of every element, and only then validates each copy
 * with the frozen transition schema. Non-inert input fails with
 * `invalid_input`; a schema-invalid copy fails closed with the claim error.
 */
function validatedTransitions(
  transitions: unknown,
  seal: AmbientSeal,
): LearningTransition[] {
  const raw: unknown[] = [];
  try {
    if (!Array.isArray(transitions)) throw REJECT;
    const length: unknown = transitions.length;
    if (!ambientIntact(seal)) throw REJECT;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_TRANSITIONS
    )
      throw REJECT;
    for (let i = 0; i < length; i += 1) raw.push(transitions[i] as unknown);
  } catch {
    // A revoked Proxy, a throwing trap or any rejection above.
    throw REJECT;
  }
  if (!ambientIntact(seal)) throw REJECT;
  const copies: unknown[] = [];
  try {
    for (const value of raw) copies.push(inert(value));
  } catch {
    // An accessor, Proxy, exotic object, hole, cycle or throwing trap.
    throw REJECT;
  }
  if (!ambientIntact(seal)) throw REJECT;
  const parsed: LearningTransition[] = [];
  let malformed = false;
  for (const copy of copies) {
    let result: ReturnType<typeof LearningTransitionSchema.safeParse>;
    try {
      result = LearningTransitionSchema.safeParse(copy);
    } catch {
      malformed = true;
      continue;
    } finally {
      if (!ambientIntact(seal)) throw REJECT;
    }
    if (result.success) parsed.push(result.data);
    else malformed = true;
  }
  if (malformed) throw CLAIM;
  return parsed;
}

/**
 * Verifies that every durable lifecycle claim in a Patch-3 lineage is backed
 * by exactly one agreeing recorded transition of the same owner. Throws
 * `OwnerModelError` with a fixed code and message.
 */
export function verifyLifecycleClaims(
  lineage: DurableLineage,
  transitions: readonly unknown[],
): VerifiedDurableLineage {
  try {
    if (!isDurableLineage(lineage)) throw REJECT;
    let seal: AmbientSeal | undefined;
    try {
      seal = sealAmbient();
    } catch {
      seal = undefined;
    }
    if (seal === undefined) throw REJECT;
    const ownerId = lineage.ownerId;
    const recorded = validatedTransitions(transitions, seal);

    // Owner-bound exact-event index; a repeated event ID poisons the set.
    const byEvent = new Map<string, LearningTransition>();
    let ambiguous = false;
    for (const transition of recorded) {
      if (transition.ownerId !== ownerId) continue;
      if (byEvent.has(transition.eventId)) ambiguous = true;
      else byEvent.set(transition.eventId, transition);
    }
    if (ambiguous) throw CLAIM;

    // The Patch-3 edge declared by each source snapshot (at most one).
    const edgeOf = new Map<string, Map<number, LineageEdge>>();
    for (const edge of lineage.edges) {
      let versions = edgeOf.get(edge.source.learnedItemId);
      if (versions === undefined) {
        versions = new Map();
        edgeOf.set(edge.source.learnedItemId, versions);
      }
      versions.set(edge.source.version, edge);
    }

    const claims: LifecycleClaim[] = [];
    for (const history of lineage.histories)
      for (const record of history.versions) {
        const claim = backing(record);
        if (claim === undefined) continue;
        const transition = byEvent.get(claim.eventId);
        const edge = edgeOf.get(record.id)?.get(record.metadata.recordVersion);
        if (transition === undefined || !agrees(record, transition, edge))
          throw CLAIM;
        const snapshot = Object.create(null) as {
          learnedItemId: LearnedItemId;
          version: number;
        };
        snapshot.learnedItemId = record.id;
        snapshot.version = record.metadata.recordVersion;
        const trace = Object.create(null) as {
          kind: LifecycleClaimKind;
          snapshot: LineageNode;
          eventId: EventId;
        };
        trace.kind = claim.kind;
        trace.snapshot = Object.freeze(snapshot);
        trace.eventId = claim.eventId;
        claims.push(Object.freeze(trace));
      }
    claims.sort(byClaim);

    const verified = Object.create(null) as {
      ownerId: OwnerId;
      lineage: DurableLineage;
      claims: readonly LifecycleClaim[];
    };
    verified.ownerId = ownerId;
    verified.lineage = lineage;
    verified.claims = Object.freeze(claims);
    PRODUCED.add(Object.freeze(verified));
    return verified;
  } catch (thrown) {
    throw new OwnerModelError(
      thrown !== null && typeof thrown === 'object'
        ? (FAILURES.get(thrown) ?? 'internal_error')
        : 'internal_error',
    );
  }
}
