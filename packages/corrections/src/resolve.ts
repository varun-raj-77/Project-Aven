import { z } from 'zod';
import {
  EvidenceRecordSchema,
  ExperienceEventSchema,
  OwnerIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
} from '@aven/contracts';
import { CorrectionError } from './errors.ts';
import { inertCopy, type InertLimits } from './inert.ts';

/**
 * AVEN-010 patch 4: the PURE immediate-override resolver.
 *
 * Given one owner's complete recorded correction history (frozen AVEN-002
 * `owner_correction` events with their evidence and owner-local Ledger
 * sequence numbers), one queried task binding and an explicit as-of
 * boundary, it returns an immutable view of which corrections apply to that
 * binding now: active instructions, inactive ones with an exact reason,
 * explicit supersession links, unresolved overlaps and exact suppression
 * targets. It reads no storage, Ledger, clock or randomness, calls no model
 * and writes nothing. Declared owner provenance is checked for consistency,
 * never treated as authenticated identity.
 *
 * Rules (accepted design D3, D4 as modified, D5, D12):
 *   - ORDER is the owner-local Ledger sequence only; never occurrence time or
 *     input order.
 *   - AS-OF: the included history is the longest sequence-ordered PREFIX whose
 *     entries are all at or below `throughSequence` (when not null) and were
 *     recorded at or before `referenceTime` (exact instant comparison). It is
 *     applied before any chain, so a later correction can never deactivate an
 *     earlier one in an earlier replay.
 *   - SCOPE: `current_task` applies only to its exact declared task;
 *     `current_session` to every task of its declared session (including
 *     later ones); `unspecified` only to its origin task (the event's
 *     envelope binding), labelled `unspecified_origin_task`. A correction
 *     whose declared binding disagrees with its envelope, or an `unspecified`
 *     one without an envelope task, has no immediate effect for any binding.
 *     `durableScopeHint` is never read.
 *   - PERMISSION corrections are never active (`deferred_to_root`); they
 *     deactivate nothing and suppress nothing.
 *   - SUPERSESSION only by explicit linkage: a later, applicable,
 *     non-permission correction whose target is an earlier applicable
 *     correction's event ID or its exact own evidence reference deactivates
 *     it for this binding (`superseded_by_correction`). It stays inactive
 *     even if the superseding correction is itself corrected later: no
 *     resurrection. Shared targets or categories never supersede; active
 *     corrections with an identical structured target are reported as an
 *     unresolved overlap. Text is never interpreted.
 *   - SUPPRESSION targets come only from ACTIVE corrections' structured
 *     targets; `unidentified` targets have none.
 *   - EVIDENCE: each correction's own evidence must be `recorded_text` whose
 *     text equals its `correctedInstruction` exactly and whose `recordedAt`
 *     equals the event's (one Ledger append records both).
 */
export const IMMEDIATE_RESOLUTION_VERSION = 'aven-010-immediate-resolution-v1';

/** Resource bounds on the raw history (process protection, not semantics). */
export const HISTORY_LIMITS: InertLimits = Object.freeze({
  maxDepth: 24,
  maxNodes: 4_000_000,
  maxArrayLength: 100_000,
  maxStringLength: 1_000_000,
});
const QUERY_LIMITS: InertLimits = Object.freeze({
  maxDepth: 2,
  maxNodes: 8,
  maxArrayLength: 0,
  maxStringLength: 256,
});

const SequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const HistorySchema = z.strictObject({
  ownerId: OwnerIdSchema,
  entries: z.array(
    z.strictObject({
      sequence: SequenceSchema,
      event: ExperienceEventSchema,
      evidence: z.array(EvidenceRecordSchema),
    }),
  ),
});
const BindingSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
const OptionsSchema = z.strictObject({
  referenceTime: TimestampSchema,
  throughSequence: z.union([SequenceSchema, z.null()]),
});

/** One recorded correction, as a Ledger replay yields it (input shape). */
export interface CorrectionHistoryEntry {
  readonly sequence: number;
  readonly event: unknown;
  readonly evidence: readonly unknown[];
}
export interface CorrectionHistory {
  readonly ownerId: string;
  readonly entries: readonly CorrectionHistoryEntry[];
}
export interface CorrectionQueryBinding {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly taskId: string;
}
export interface CorrectionResolutionOptions {
  /** Explicit as-of instant (frozen AVEN-002 timestamp); no clock is read. */
  readonly referenceTime: string;
  /** Exact Ledger sequence boundary, or null for the whole supplied history. */
  readonly throughSequence: number | null;
}

export type ImmediateApplicabilityLabel =
  'current_task' | 'current_session' | 'unspecified_origin_task';
export type StructuredTarget =
  | { readonly kind: 'event'; readonly eventId: string }
  | {
      readonly kind: 'evidence';
      readonly reference: {
        readonly evidenceId: string;
        readonly eventId: string;
      };
    }
  | {
      readonly kind: 'owner_state';
      readonly reference: {
        readonly learnedItemId: string;
        readonly version: number;
      };
    }
  | { readonly kind: 'unidentified'; readonly description: string };
export type SuppressionTarget = Exclude<
  StructuredTarget,
  { kind: 'unidentified' }
>;
export interface ResolvedCorrection {
  readonly sequence: number;
  readonly eventId: string;
  /** The correction's own evidence reference (its recorded instruction). */
  readonly evidence: { readonly evidenceId: string; readonly eventId: string };
  readonly recordedAt: string;
  readonly category: CorrectionCategory;
  readonly applicability: ImmediateApplicabilityLabel;
  /** Where the correction applies from: its session and, when known, task. */
  readonly origin: {
    readonly sessionId: string;
    readonly taskId: string | null;
  };
  readonly target: StructuredTarget;
}
export interface ActiveCorrection extends ResolvedCorrection {
  /** The owner's corrected instruction, exactly as recorded. */
  readonly correctedInstruction: string;
}
export interface InactiveCorrection extends ResolvedCorrection {
  readonly reason: 'superseded_by_correction' | 'deferred_to_root';
  /** Explicitly correcting corrections, in sequence order (supersession only). */
  readonly supersededBy: readonly string[];
}
export interface ImmediateCorrectionView {
  readonly kind: 'immediate_correction_view';
  readonly version: typeof IMMEDIATE_RESOLUTION_VERSION;
  readonly ownerId: string;
  readonly binding: { readonly sessionId: string; readonly taskId: string };
  readonly asOf: {
    readonly referenceTime: string;
    readonly throughSequence: number | null;
    readonly lastIncludedSequence: number | null;
  };
  readonly active: readonly ActiveCorrection[];
  readonly inactive: readonly InactiveCorrection[];
  readonly supersessions: readonly {
    readonly supersededEventId: string;
    readonly byEventId: string;
  }[];
  readonly overlaps: readonly {
    readonly target: SuppressionTarget;
    readonly eventIds: readonly string[];
  }[];
  readonly suppressionTargets: readonly {
    readonly target: SuppressionTarget;
    readonly byEventIds: readonly string[];
  }[];
}

const invalid = (): never => {
  throw new CorrectionError('invalid_correction_history');
};

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  limits: InertLimits,
): z.output<S> {
  const inert = inertCopy(value, limits);
  if (inert === undefined) return invalid();
  const parsed = schema.safeParse(inert.copy);
  return parsed.success ? parsed.data : invalid();
}

type Event = z.output<typeof ExperienceEventSchema>;
type CorrectionEvent = Extract<Event, { eventType: 'owner_correction' }>;
/** The frozen AVEN-002 correction categories (read from the frozen event type). */
export type CorrectionCategory = CorrectionEvent['payload']['category'];
interface Entry {
  readonly sequence: number;
  readonly event: CorrectionEvent;
}

/** Exact comparison of two frozen AVEN-002 timestamps (any fraction length). */
function compareInstants(a: string, b: string): number {
  const split = (t: string): [number, string] => {
    const m = t.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
    );
    const seconds = m ? Date.parse(`${m[1]}${m[3]}`) : Number.NaN;
    if (!m || !Number.isFinite(seconds)) return invalid();
    return [seconds, (m[2] ?? '').replace(/0+$/, '')];
  };
  const [as, af] = split(a);
  const [bs, bf] = split(b);
  if (as !== bs) return as < bs ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const x = af.padEnd(width, '0');
  const y = bf.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Structural and identity consistency of the whole supplied history. */
function validate(history: z.output<typeof HistorySchema>): Entry[] {
  const sequences = new Set<number>();
  const eventIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const entries: Entry[] = [];
  for (const entry of history.entries) {
    const event = entry.event;
    if (event.eventType !== 'owner_correction') return invalid();
    if (event.ownerId !== history.ownerId) return invalid();
    if (sequences.has(entry.sequence) || eventIds.has(event.id))
      return invalid();
    sequences.add(entry.sequence);
    eventIds.add(event.id);
    const named = event.evidenceIds;
    if (
      new Set(named).size !== named.length ||
      entry.evidence.length !== named.length
    )
      return invalid();
    for (const record of entry.evidence) {
      if (
        record.ownerId !== history.ownerId ||
        record.eventId !== event.id ||
        !named.includes(record.id) ||
        evidenceIds.has(record.id)
      )
        return invalid();
      evidenceIds.add(record.id);
      // Owner-origin evidence can only originate at this correction event.
      if (
        'ownerId' in record.provenance &&
        (record.provenance.kind !== 'explicit_owner_correction' ||
          record.provenance.sourceEventId !== event.id)
      )
        return invalid();
    }
    const own = entry.evidence.find(
      (record) => record.id === event.payload.evidence.evidenceId,
    );
    // The correction's own evidence is the recorded instruction itself: the
    // same text, exactly (no trimming or normalization), as recorded text,
    // recorded in the same Ledger append as its event. Additional evidence
    // records keep their own content.
    if (
      own === undefined ||
      own.provenance.kind !== 'explicit_owner_correction' ||
      own.content.kind !== 'recorded_text' ||
      own.content.text !== event.payload.correctedInstruction ||
      own.recordedAt !== event.recordedAt
    )
      return invalid();
    entries.push({ sequence: entry.sequence, event });
  }
  entries.sort((a, b) => a.sequence - b.sequence);
  // Identity indexes over the supplied correction history: every correction
  // event, every evidence record those events own (own and additional), and
  // exact event-to-evidence membership. The input holds corrections only, so
  // a reference that resolves to neither a known correction event nor known
  // correction evidence is external (ordinary Ledger history) and allowed.
  const byEvent = new Map(entries.map((e) => [e.event.id, e]));
  const evidenceOwner = new Map<string, Entry>();
  for (const e of entries)
    for (const evidenceId of e.event.evidenceIds)
      evidenceOwner.set(evidenceId, e);
  for (const entry of entries) {
    const target = entry.event.payload.target;
    // A correction can only reference corrections recorded before it.
    const earlier = (other: Entry) => other.sequence < entry.sequence;
    if (target.kind === 'event') {
      const known = byEvent.get(target.eventId);
      if (known !== undefined && !earlier(known)) return invalid();
    }
    if (target.kind === 'evidence') {
      const { evidenceId, eventId } = target.reference;
      // Evidence IDs are unique across the supplied corrections, so one
      // comparison checks both directions: known correction evidence must
      // name the event that owns it, and a known correction event must own
      // the named evidence. Neither known means external (allowed).
      const holder = evidenceOwner.get(evidenceId);
      const known = byEvent.get(eventId);
      if (holder !== known) return invalid();
      if (known !== undefined && !earlier(known)) return invalid();
    }
  }
  return entries;
}

/** The longest sequence-ordered prefix inside the as-of boundary. */
function asOf(
  entries: readonly Entry[],
  options: z.output<typeof OptionsSchema>,
): Entry[] {
  const included: Entry[] = [];
  for (const entry of entries) {
    if (
      (options.throughSequence !== null &&
        entry.sequence > options.throughSequence) ||
      compareInstants(entry.event.recordedAt, options.referenceTime) > 0
    )
      break;
    included.push(entry);
  }
  return included;
}

interface Applicable {
  readonly entry: Entry;
  readonly label: ImmediateApplicabilityLabel;
  readonly origin: { sessionId: string; taskId: string | null };
}

function applicability(
  entry: Entry,
  binding: z.output<typeof BindingSchema>,
): Applicable | undefined {
  const envelope = entry.event.task;
  const declared = entry.event.payload.immediateApplicability;
  switch (declared.kind) {
    case 'current_task': {
      const task = declared.task;
      if (
        envelope !== undefined &&
        (envelope.sessionId !== task.sessionId ||
          envelope.taskId !== task.taskId)
      )
        return undefined;
      return task.sessionId === binding.sessionId &&
        task.taskId === binding.taskId
        ? {
            entry,
            label: 'current_task',
            origin: { sessionId: task.sessionId, taskId: task.taskId },
          }
        : undefined;
    }
    case 'current_session': {
      if (envelope !== undefined && envelope.sessionId !== declared.sessionId)
        return undefined;
      return declared.sessionId === binding.sessionId
        ? {
            entry,
            label: 'current_session',
            origin: {
              sessionId: declared.sessionId,
              taskId: envelope?.taskId ?? null,
            },
          }
        : undefined;
    }
    case 'unspecified':
      return envelope !== undefined &&
        envelope.sessionId === binding.sessionId &&
        envelope.taskId === binding.taskId
        ? {
            entry,
            label: 'unspecified_origin_task',
            origin: { sessionId: envelope.sessionId, taskId: envelope.taskId },
          }
        : undefined;
  }
}

/** Explicit correction-to-correction linkage: event ID or exact own evidence. */
function corrects(later: Entry, earlier: Entry): boolean {
  const target = later.event.payload.target;
  const own = earlier.event.payload.evidence;
  return (
    (target.kind === 'event' && target.eventId === earlier.event.id) ||
    (target.kind === 'evidence' &&
      target.reference.evidenceId === own.evidenceId &&
      target.reference.eventId === own.eventId)
  );
}

const isPermission = (entry: Entry) =>
  entry.event.payload.category === 'permission';

function copyTarget(entry: Entry): StructuredTarget {
  const t = entry.event.payload.target;
  switch (t.kind) {
    case 'event':
      return { kind: 'event', eventId: t.eventId };
    case 'evidence':
      return {
        kind: 'evidence',
        reference: {
          evidenceId: t.reference.evidenceId,
          eventId: t.reference.eventId,
        },
      };
    case 'owner_state':
      return {
        kind: 'owner_state',
        reference: {
          learnedItemId: t.reference.learnedItemId,
          version: t.reference.version,
        },
      };
    case 'unidentified':
      return { kind: 'unidentified', description: t.description };
  }
}

/** Identity key of an exact structured target (never of prose). */
function targetKey(target: StructuredTarget): string | undefined {
  switch (target.kind) {
    case 'event':
      return JSON.stringify(['event', target.eventId]);
    case 'evidence':
      return JSON.stringify([
        'evidence',
        target.reference.evidenceId,
        target.reference.eventId,
      ]);
    case 'owner_state':
      return JSON.stringify([
        'owner_state',
        target.reference.learnedItemId,
        target.reference.version,
      ]);
    case 'unidentified':
      return undefined;
  }
}

function base(item: Applicable): ResolvedCorrection {
  const event = item.entry.event;
  return {
    sequence: item.entry.sequence,
    eventId: event.id,
    evidence: {
      evidenceId: event.payload.evidence.evidenceId,
      eventId: event.payload.evidence.eventId,
    },
    recordedAt: event.recordedAt,
    category: event.payload.category,
    applicability: item.label,
    origin: { sessionId: item.origin.sessionId, taskId: item.origin.taskId },
    target: copyTarget(item.entry),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Groups items by exact target key, keeping first-seen (sequence) order. */
function groupByTarget(
  items: readonly { target: StructuredTarget; eventId: string }[],
) {
  const groups = new Map<
    string,
    { target: SuppressionTarget; eventIds: string[] }
  >();
  for (const item of items) {
    const key = targetKey(item.target);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group) group.eventIds.push(item.eventId);
    else
      groups.set(key, {
        target: item.target as SuppressionTarget,
        eventIds: [item.eventId],
      });
  }
  return [...groups.values()];
}

function resolve(
  rawHistory: unknown,
  rawBinding: unknown,
  rawOptions: unknown,
): ImmediateCorrectionView {
  const history = parse(HistorySchema, rawHistory, HISTORY_LIMITS);
  const binding = parse(BindingSchema, rawBinding, QUERY_LIMITS);
  const options = parse(OptionsSchema, rawOptions, QUERY_LIMITS);
  if (binding.ownerId !== history.ownerId) return invalid();
  const included = asOf(validate(history), options);

  const applicable = included
    .map((entry) => applicability(entry, binding))
    .filter((item): item is Applicable => item !== undefined);

  const supersededBy = new Map<string, string[]>();
  for (const [i, earlier] of applicable.entries()) {
    if (isPermission(earlier.entry)) continue;
    for (const later of applicable.slice(i + 1))
      if (!isPermission(later.entry) && corrects(later.entry, earlier.entry)) {
        const list = supersededBy.get(earlier.entry.event.id) ?? [];
        list.push(later.entry.event.id);
        supersededBy.set(earlier.entry.event.id, list);
      }
  }

  const active: ActiveCorrection[] = [];
  const inactive: InactiveCorrection[] = [];
  for (const item of applicable) {
    const by = supersededBy.get(item.entry.event.id);
    if (isPermission(item.entry))
      inactive.push({
        ...base(item),
        reason: 'deferred_to_root',
        supersededBy: [],
      });
    else if (by !== undefined)
      inactive.push({
        ...base(item),
        reason: 'superseded_by_correction',
        supersededBy: [...by],
      });
    else
      active.push({
        ...base(item),
        correctedInstruction: item.entry.event.payload.correctedInstruction,
      });
  }

  const supersessions = inactive.flatMap((item) =>
    item.supersededBy.map((byEventId) => ({
      supersededEventId: item.eventId,
      byEventId,
    })),
  );
  const overlaps = groupByTarget(active)
    .filter((group) => group.eventIds.length > 1)
    .map((group) => ({ target: group.target, eventIds: group.eventIds }));
  const suppressionTargets = groupByTarget(active).map((group) => ({
    target: group.target,
    byEventIds: group.eventIds,
  }));
  const last = included.at(-1);

  return deepFreeze({
    kind: 'immediate_correction_view',
    version: IMMEDIATE_RESOLUTION_VERSION,
    ownerId: history.ownerId,
    binding: { sessionId: binding.sessionId, taskId: binding.taskId },
    asOf: {
      referenceTime: options.referenceTime,
      throughSequence: options.throughSequence,
      lastIncludedSequence: last === undefined ? null : last.sequence,
    },
    active,
    inactive,
    supersessions,
    overlaps,
    suppressionTargets,
  });
}

/**
 * Resolves one owner's recorded corrections for one exact task binding at an
 * explicit as-of boundary. Every failure is a fixed `CorrectionError`
 * (`invalid_correction_history`, or `internal_error` for an unexpected
 * fault) with no cause and no detail about which record was wrong.
 */
export function resolveImmediateCorrections(
  history: unknown,
  binding: unknown,
  options: unknown,
): ImmediateCorrectionView {
  try {
    return resolve(history, binding, options);
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError('internal_error');
  }
}
