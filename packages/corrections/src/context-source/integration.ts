import { createHash } from 'node:crypto';
import { OwnerIdSchema } from '@aven/contracts';
import {
  CONTEXT_BROKER_ERROR_CODES,
  ContextBrokerError,
  ContextCandidateSchema,
  ContextRequestSchema,
  createContextBroker,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_RAW_ITEMS_PER_SOURCE,
  MAX_RAW_ITEMS_TOTAL,
  MAX_SOURCES,
  MAX_TOTAL_CANDIDATES,
  type ContextBrokerErrorCode,
  type ContextBrokerTrace,
  type ContextBundle,
  type ContextBundleItem,
  type ContextCandidate,
  type ContextRequest,
  type ContextSource,
  type ContextSourceCollectOptions,
  type ContextSourceQuery,
  type ExclusionReason,
} from '@aven/context-broker';
import { CorrectionError } from '../errors.ts';
import {
  resolveImmediateCorrections,
  type ActiveCorrection,
  type ImmediateCorrectionView,
} from '../resolve.ts';

/**
 * AVEN-010 patch 6: correction-aware Context Broker assembly with exposure
 * verification (`@aven/corrections/context-source`).
 *
 * For ONE request it computes ONE immutable immediate correction view with
 * the accepted pure resolver (the request's owner, session, task and
 * `referenceTime`, plus an explicit `throughSequence`), and that same view
 * drives all three steps:
 *   A. INSTRUCTIONS (D7, D8): one `current_instruction` candidate per active
 *      correction (never a permission correction: those are
 *      `deferred_to_root`, never active), from one `active_task` source. The
 *      reference binds the REQUESTING task and cites the correction's own
 *      evidence; provenance is `explicit_owner_correction` naming the owner
 *      and the correction event; scope is `{ kind: 'bounded', taskId }` of
 *      the requesting task; the text is exactly `correctedInstruction`
 *      (never `originalBehavior`); signals are confidence 1, salience 1,
 *      negativeRetrieval 0; `recordedAt` is the stored event's. Every
 *      candidate is preflighted against the Broker's own public schema; one
 *      that cannot be represented fails closed before assembly.
 *   B. SUPPRESSION (D6): each base source is wrapped. A same-owner candidate
 *      whose STRUCTURED reference exactly equals an active correction's
 *      target gets a copy with negativeRetrieval set to the Broker's frozen
 *      suppression value 1; nothing else changes and nothing is mutated in
 *      place. Exact identity only: an `evidence` reference must match both
 *      evidence and event IDs, an `owner_state` reference both learned item
 *      ID and version. An `event` target has no candidate reference carrying
 *      just an event ID and suppresses nothing; `unidentified` targets have
 *      none; `active_task_state` and `current_instruction` references are
 *      never compared with correction targets.
 *   C. EXPOSURE (D9): after the frozen Broker assembles, every required
 *      instruction must be in the SELECTED bundle with its exact identity,
 *      binding, provenance and complete, untruncated text. Otherwise the
 *      outcome is a fixed `not_exposed` result: no bundle is returned as a
 *      success. A Broker failure (source failure or timeout, conflicting
 *      duplicate, configuration) is never success either.
 *
 * The Broker alone validates, isolates owners, deduplicates, ranks, budgets
 * and selects; its weights, limits and scope rules are unchanged. Nothing
 * here reads storage, writes anything, keeps state between calls, reads a
 * clock or randomness, calls a model, executes a tool or decides authority.
 * An exposed instruction is transient context for one task, not owner
 * memory, not a durable preference and not Root approval.
 */

export const CORRECTION_INSTRUCTION_SOURCE_ID = 'aven-correction-instruction';
const CANDIDATE_ID_VERSION = 'aven-010-correction-instruction-id-v1';
const INSTRUCTION_SIGNALS = Object.freeze({
  confidence: 1,
  salience: 1,
  negativeRetrieval: 0,
});
const SUPPRESSION_VALUE = 1;

export interface CorrectionAssemblyInput {
  /** One owner's complete correction history (e.g. `readCorrectionHistory`). */
  readonly history: unknown;
  /** The exact Context Broker request. */
  readonly request: ContextRequest;
  /** The base sources; the correction instruction source is added here. */
  readonly sources: readonly ContextSource[];
  /** Explicit Ledger sequence boundary for the correction view, or null. */
  readonly throughSequence: number | null;
}

/** One exposed (or required) instruction, by identity only. */
export interface InstructionIdentity {
  readonly correctionEventId: string;
  readonly evidenceId: string;
  readonly candidateId: string;
}

export type NotExposedReason =
  | 'instruction_unrepresentable'
  | 'assembly_failed'
  | 'instruction_not_selected'
  | 'instruction_truncated'
  | 'instruction_altered';

export interface MissingInstruction extends InstructionIdentity {
  readonly failure: Exclude<NotExposedReason, 'assembly_failed'>;
  /** The Broker's exclusion reason when it traced the candidate, else null. */
  readonly exclusionReason: ExclusionReason | null;
}

export type CorrectionAssemblyOutcome =
  | {
      readonly status: 'exposed';
      /** Every required instruction is in this selected bundle, exactly. */
      readonly bundle: ContextBundle;
      readonly trace: ContextBrokerTrace;
      readonly exposed: readonly InstructionIdentity[];
    }
  | {
      readonly status: 'not_exposed';
      readonly reason: NotExposedReason;
      readonly missing: readonly MissingInstruction[];
      /** Owner-scoped diagnostics only; never a usable bundle. */
      readonly trace: ContextBrokerTrace | null;
      readonly brokerErrorCode: ContextBrokerErrorCode | null;
    };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Exact structured identity of a suppressible reference or target. */
const evidenceKey = (evidenceId: string, eventId: string) =>
  JSON.stringify(['evidence', evidenceId, eventId]);
const ownerStateKey = (learnedItemId: string, version: number) =>
  JSON.stringify(['owner_state', learnedItemId, version]);

function suppressionKeys(view: ImmediateCorrectionView): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const { target } of view.suppressionTargets) {
    if (target.kind === 'evidence')
      keys.add(
        evidenceKey(target.reference.evidenceId, target.reference.eventId),
      );
    else if (target.kind === 'owner_state')
      keys.add(
        ownerStateKey(target.reference.learnedItemId, target.reference.version),
      );
    // `event` targets: no candidate reference carries only an event ID.
  }
  return keys;
}

/** The key of a VALIDATED candidate's reference, if it is comparable. */
function referenceKey(
  reference: ContextCandidate['reference'],
): string | undefined {
  if (reference.kind === 'evidence')
    return evidenceKey(
      reference.reference.evidenceId,
      reference.reference.eventId,
    );
  if (reference.kind === 'owner_state')
    return ownerStateKey(
      reference.reference.learnedItemId,
      reference.reference.version,
    );
  return undefined;
}

/**
 * Per-assembly coordination of the wrapped base sources (Codex audit F4).
 * The frozen Broker checks every source's RAW length, then the aggregate raw
 * length, then drops foreign records, then checks owner quotas, and only then
 * clones and validates. Wrapped sources run inside its collection step, so
 * they wait for one another at two barriers and read no element until every
 * source has reported its raw length within the Broker's public raw limits,
 * and clone nothing until every owner count is within its public quotas.
 * Otherwise they hand the Broker inert, same-length placeholders and it
 * reports its own fixed limit error. A failed or aborted sibling (the
 * Broker's deadline aborts its signal) releases every barrier: that
 * assembly fails in the Broker regardless.
 */
interface Coordination {
  readonly instructionCount: number;
  failed: boolean;
  rawTotal: number;
  rawExceeded: boolean;
  ownedTotal: number;
  quotaExceeded: boolean;
  readonly raw: Barrier;
  readonly owned: Barrier;
  aborts: boolean;
}

interface Barrier {
  arrive(): Promise<void>;
  open(): void;
}

function barrier(parties: number): Barrier {
  let remaining = parties;
  let release: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (remaining <= 0) release();
  return {
    arrive() {
      remaining -= 1;
      if (remaining <= 0) release();
      return ready;
    },
    open: () => release(),
  };
}

function coordination(parties: number, instructionCount: number): Coordination {
  return {
    instructionCount,
    failed: false,
    rawTotal: 0,
    rawExceeded: false,
    ownedTotal: 0,
    quotaExceeded: false,
    raw: barrier(parties),
    owned: barrier(parties),
    aborts: false,
  };
}

/** An inert stand-in the Broker drops as foreign (it reads only `ownerId`). */
const foreignPlaceholder = (ownerId: string) => Object.freeze({ ownerId });
/** An inert stand-in the Broker counts and then rejects as invalid. */
const INVALID_PLACEHOLDER = Object.freeze({});

type Classified =
  | { readonly kind: 'foreign'; readonly ownerId: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'primitive'; readonly value: unknown }
  | {
      readonly kind: 'owned' | 'unrecognized';
      readonly item: object;
    };

/**
 * Exactly the Broker's ownership read: one `Reflect.get` of `ownerId`, and a
 * recognizable foreign owner is decided on that single read. Nothing else of
 * a foreign record is ever read.
 */
function classify(
  value: readonly unknown[],
  index: number,
  requester: string,
): Classified {
  let item: unknown;
  let owner: unknown;
  try {
    item = value[index];
    if (item === null || typeof item !== 'object')
      return { kind: 'primitive', value: item };
    owner = Reflect.get(item, 'ownerId');
  } catch {
    return { kind: 'invalid' };
  }
  if (
    typeof owner === 'string' &&
    owner !== requester &&
    OwnerIdSchema.safeParse(owner).success
  )
    return { kind: 'foreign', ownerId: owner };
  return {
    kind: owner === requester ? 'owned' : 'unrecognized',
    item: item as object,
  };
}

/**
 * One snapshot of a non-foreign item, consistent with its ownership read;
 * any inconsistency or unreadable data fails closed in the Broker. A
 * same-owner snapshot that is a VALID candidate whose reference exactly
 * equals an active target becomes a copy with the suppression value; every
 * other snapshot is handed over unchanged, so the Broker validates (and
 * rejects) exactly what it would have read itself.
 */
function settle(
  entry: Extract<Classified, { kind: 'owned' | 'unrecognized' }>,
  requester: string,
  keys: ReadonlySet<string>,
): unknown {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(entry.item);
  } catch {
    return INVALID_PLACEHOLDER;
  }
  if (snapshot === null || typeof snapshot !== 'object')
    return INVALID_PLACEHOLDER;
  const owner = (snapshot as { ownerId?: unknown }).ownerId;
  if (entry.kind === 'owned' && owner !== requester) return INVALID_PLACEHOLDER;
  if (
    entry.kind === 'unrecognized' &&
    typeof owner === 'string' &&
    owner !== requester &&
    OwnerIdSchema.safeParse(owner).success
  )
    return INVALID_PLACEHOLDER;
  if (owner !== requester) return snapshot;
  const parsed = ContextCandidateSchema.safeParse(snapshot);
  if (!parsed.success) return snapshot;
  const key = referenceKey(parsed.data.reference);
  if (key === undefined || !keys.has(key)) return snapshot;
  return {
    ...(snapshot as object),
    signals: {
      ...(snapshot as { signals: object }).signals,
      negativeRetrieval: SUPPRESSION_VALUE,
    },
  };
}

/**
 * Wraps one base source: same ID, kind, query and abort signal. With no
 * active exact target it is a pure pass-through that reads nothing. Source
 * failures and timeouts propagate; malformed output is handed to the Broker
 * to reject with its own fixed codes.
 */
function suppressing(
  base: {
    readonly sourceId: unknown;
    readonly kind: unknown;
    readonly collect: unknown;
    readonly target: object;
  },
  keys: ReadonlySet<string>,
  shared: Coordination,
): ContextSource {
  const collect = base.collect as ContextSource['collect'];
  return Object.freeze({
    sourceId: base.sourceId as string,
    kind: base.kind as ContextSource['kind'],
    async collect(
      query: ContextSourceQuery,
      options: ContextSourceCollectOptions,
    ): Promise<readonly unknown[]> {
      if (keys.size === 0) return collect.call(base.target, query, options);
      const release = () => {
        shared.failed = true;
        shared.raw.open();
        shared.owned.open();
      };
      if (!shared.aborts) {
        shared.aborts = true;
        options.signal.addEventListener('abort', release, { once: true });
      }
      let value: unknown;
      try {
        value = await collect.call(base.target, query, options);
      } catch (error) {
        release();
        throw error;
      }
      // 1. The raw length, read once, before any element.
      let length: number | undefined;
      try {
        if (Array.isArray(value)) {
          const n: unknown = (value as unknown[]).length;
          if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
            length = n;
        }
      } catch {
        length = undefined;
      }
      if (length === undefined) {
        release();
        return undefined as never; // The Broker reports source_failure.
      }
      if (length > MAX_RAW_ITEMS_PER_SOURCE) shared.rawExceeded = true;
      shared.rawTotal += length;
      await shared.raw.arrive();
      if (
        shared.failed ||
        shared.rawExceeded ||
        shared.rawTotal + shared.instructionCount > MAX_RAW_ITEMS_TOTAL
      ) {
        shared.owned.arrive();
        // Never read: the Broker fails first. An over-limit length is
        // untrusted and may not be a representable array length (Codex
        // N2), so the stand-in is one item over the per-source limit, which
        // the Broker rejects by itself; within-limit lengths are kept so the
        // aggregate check sees the same total.
        return new Array<unknown>(
          length > MAX_RAW_ITEMS_PER_SOURCE
            ? MAX_RAW_ITEMS_PER_SOURCE + 1
            : length,
        );
      }
      // 2. Ownership, one read per element, foreign records decided first.
      const items = value as readonly unknown[];
      const classified: Classified[] = [];
      for (let i = 0; i < length; i += 1)
        classified.push(classify(items, i, query.ownerId));
      const owned = classified.filter((c) => c.kind !== 'foreign').length;
      if (owned > MAX_CANDIDATES_PER_SOURCE) shared.quotaExceeded = true;
      shared.ownedTotal += owned;
      await shared.owned.arrive();
      const overQuota =
        shared.failed ||
        shared.quotaExceeded ||
        shared.ownedTotal + shared.instructionCount > MAX_TOTAL_CANDIDATES;
      // 3. Snapshots only within every quota; foreign records stay inert.
      return classified.map((c) => {
        switch (c.kind) {
          case 'foreign':
            return foreignPlaceholder(c.ownerId);
          case 'invalid':
            return INVALID_PLACEHOLDER;
          case 'primitive':
            return c.value;
          default:
            return overQuota
              ? INVALID_PLACEHOLDER
              : settle(c, query.ownerId, keys);
        }
      });
    },
  });
}

/** Reads one base source's registration fields exactly once. */
function readSource(source: unknown) {
  if (source === null || typeof source !== 'object')
    throw new ContextBrokerError('invalid_configuration');
  const collect: unknown = Reflect.get(source, 'collect');
  const read = {
    sourceId: Reflect.get(source, 'sourceId') as unknown,
    kind: Reflect.get(source, 'kind') as unknown,
    collect,
    target: source,
  };
  if (typeof read.collect !== 'function')
    throw new ContextBrokerError('invalid_configuration');
  return read;
}

/**
 * A fixed Broker error code, or null (Codex audit F3): only a code from the
 * Broker's declared vocabulary, read as an own data property without running
 * any getter, is ever reported. Exported for this package's own tests only;
 * not a subpath export.
 */
export function brokerCode(error: unknown): ContextBrokerErrorCode | null {
  try {
    if (!(error instanceof ContextBrokerError)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    const code: unknown =
      descriptor !== undefined && 'value' in descriptor
        ? descriptor.value
        : undefined;
    return typeof code === 'string' &&
      (CONTEXT_BROKER_ERROR_CODES as readonly string[]).includes(code)
      ? (code as ContextBrokerErrorCode)
      : null;
  } catch {
    return null;
  }
}

function candidateIdOf(
  ownerId: string,
  task: { sessionId: string; taskId: string },
  correction: ActiveCorrection,
): string {
  // Identity tuple only (no instruction text): version, owner, requesting
  // binding, correction event and its own evidence.
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        CANDIDATE_ID_VERSION,
        ownerId,
        task.sessionId,
        task.taskId,
        correction.eventId,
        correction.evidence.evidenceId,
      ]),
      'utf8',
    )
    .digest('hex');
  return `correction:${digest}`;
}

/** One required instruction: its identity and the exact candidate offered. */
export interface RequiredInstruction {
  readonly identity: InstructionIdentity;
  readonly candidate: ContextCandidate;
}
type Required = RequiredInstruction;

function instructionCandidate(
  ownerId: string,
  task: { sessionId: string; taskId: string },
  correction: ActiveCorrection,
): ContextCandidate {
  return {
    candidateId: candidateIdOf(ownerId, task, correction),
    ownerId,
    reference: {
      kind: 'current_instruction',
      evidence: {
        evidenceId: correction.evidence.evidenceId,
        eventId: correction.evidence.eventId,
      },
      task: { sessionId: task.sessionId, taskId: task.taskId },
    },
    provenance: {
      kind: 'explicit_owner_correction',
      ownerId,
      sourceEventId: correction.eventId,
    },
    scope: { kind: 'bounded', taskId: task.taskId },
    text: correction.correctedInstruction,
    timestamps: { recordedAt: correction.recordedAt },
    signals: { ...INSTRUCTION_SIGNALS },
  };
}

/** The selected item for a required instruction, judged exactly. */
function judge(
  required: Required,
  bundle: ContextBundle,
): MissingInstruction['failure'] | null {
  const expected = required.candidate;
  const item: ContextBundleItem | undefined = bundle.items.find(
    (i) =>
      i.sourceId === CORRECTION_INSTRUCTION_SOURCE_ID &&
      i.candidateId === expected.candidateId,
  );
  if (item === undefined) return 'instruction_not_selected';
  if (
    item.truncated ||
    item.includedChars !== item.originalChars ||
    item.text.length < expected.text.length
  )
    return 'instruction_truncated';
  if (
    item.sourceKind !== 'active_task' ||
    item.text !== expected.text ||
    JSON.stringify(item.reference) !== JSON.stringify(expected.reference) ||
    JSON.stringify(item.provenance) !== JSON.stringify(expected.provenance) ||
    JSON.stringify(item.scope) !== JSON.stringify(expected.scope) ||
    item.recordedAt !== expected.timestamps.recordedAt
  )
    return 'instruction_altered';
  return null;
}

const FAILURE_ORDER: readonly MissingInstruction['failure'][] = [
  'instruction_unrepresentable',
  'instruction_altered',
  'instruction_truncated',
  'instruction_not_selected',
];

/**
 * D9 exposure verification over the SELECTED bundle (the trace is used only
 * to report why a missing instruction was excluded). Exported for this
 * package's own tests; not a subpath export.
 */
export function verifyExposure(
  required: readonly RequiredInstruction[],
  assembly: {
    readonly bundle: ContextBundle;
    readonly trace: ContextBrokerTrace;
  },
  binding: {
    readonly ownerId: string;
    readonly sessionId: string;
    readonly taskId: string;
  },
): {
  readonly reason: NotExposedReason | null;
  readonly missing: MissingInstruction[];
} {
  const bundle = assembly.bundle;
  const traced = new Map(
    assembly.trace.candidates
      .filter((c) => c.sourceId === CORRECTION_INSTRUCTION_SOURCE_ID)
      .map((c) => [c.candidateId, c.exclusionReason]),
  );
  const missing: MissingInstruction[] = [];
  for (const r of required) {
    const failure = judge(r, bundle);
    if (failure !== null)
      missing.push({
        ...r.identity,
        failure,
        exclusionReason: traced.get(r.identity.candidateId) ?? null,
      });
  }
  // Nothing but required instructions may come from the instruction source,
  // and the bundle must be for exactly the requesting owner and task.
  const expectedIds = new Set(required.map((r) => r.identity.candidateId));
  const unexpected = bundle.items.some(
    (i) =>
      i.sourceId === CORRECTION_INSTRUCTION_SOURCE_ID &&
      !expectedIds.has(i.candidateId),
  );
  if (
    bundle.ownerId !== binding.ownerId ||
    bundle.task.sessionId !== binding.sessionId ||
    bundle.task.taskId !== binding.taskId ||
    unexpected
  )
    return { reason: 'instruction_altered', missing };
  if (missing.length > 0)
    return {
      reason: FAILURE_ORDER.find((f) => missing.some((m) => m.failure === f))!,
      missing,
    };
  return { reason: null, missing };
}

function notExposed(
  reason: NotExposedReason,
  missing: readonly MissingInstruction[],
  trace: ContextBrokerTrace | null,
  brokerErrorCode: ContextBrokerErrorCode | null,
): CorrectionAssemblyOutcome {
  return deepFreeze({
    status: 'not_exposed' as const,
    reason,
    missing: [...missing],
    trace,
    brokerErrorCode,
  });
}

/**
 * Assembles task context with the owner's immediate corrections and verifies
 * that every required instruction was actually selected. Invalid history or
 * request: a fixed `CorrectionError` (`invalid_correction_history`).
 */
export async function assembleWithCorrections(
  input: CorrectionAssemblyInput,
): Promise<CorrectionAssemblyOutcome> {
  let history: unknown;
  let rawRequest: unknown;
  let rawSources: unknown;
  let throughSequence: unknown;
  try {
    ({
      history,
      request: rawRequest,
      sources: rawSources,
      throughSequence,
    } = input);
  } catch {
    throw new CorrectionError('invalid_correction_history');
  }
  // The request is read once, as plain data, and that snapshot is what the
  // correction view and the Broker both use.
  let request: ContextRequest;
  try {
    const parsed = ContextRequestSchema.safeParse(structuredClone(rawRequest));
    if (!parsed.success)
      throw new CorrectionError('invalid_correction_history');
    request = deepFreeze(parsed.data as ContextRequest);
  } catch {
    throw new CorrectionError('invalid_correction_history');
  }
  const task = {
    sessionId: request.task.sessionId,
    taskId: request.task.taskId,
  };
  const view = resolveImmediateCorrections(
    history,
    {
      ownerId: request.ownerId,
      sessionId: task.sessionId,
      taskId: task.taskId,
    },
    { referenceTime: request.referenceTime, throughSequence },
  );

  try {
    const required: Required[] = view.active.map((correction) => {
      if (correction.category === 'permission')
        throw new CorrectionError('internal_error');
      const candidate = instructionCandidate(request.ownerId, task, correction);
      return deepFreeze({
        identity: {
          correctionEventId: correction.eventId,
          evidenceId: correction.evidence.evidenceId,
          candidateId: candidate.candidateId,
        },
        candidate,
      });
    });
    const unrepresentable = required.filter(
      (r) => !ContextCandidateSchema.safeParse(r.candidate).success,
    );
    if (unrepresentable.length > 0)
      return notExposed(
        'instruction_unrepresentable',
        unrepresentable.map((r) => ({
          ...r.identity,
          failure: 'instruction_unrepresentable' as const,
          exclusionReason: null,
        })),
        null,
        null,
      );

    const instructionSource: ContextSource = Object.freeze({
      sourceId: CORRECTION_INSTRUCTION_SOURCE_ID,
      kind: 'active_task' as const,
      collect(query: ContextSourceQuery) {
        if (
          query.ownerId !== request.ownerId ||
          query.task.sessionId !== task.sessionId ||
          query.task.taskId !== task.taskId
        )
          throw new CorrectionError('internal_error');
        return required.map((r) => structuredClone(r.candidate));
      },
    });

    // Wrapper preparation (Codex audit F3): every base source is read here,
    // once, outside the Broker; ANY throw is the fixed invalid_configuration
    // the Broker itself reports for an unreadable source.
    let wrapped: ContextSource[];
    try {
      if (!Array.isArray(rawSources))
        throw new ContextBrokerError('invalid_configuration');
      // The Broker's source-count limit, with one slot reserved for the
      // instruction source, before ANY source element or property is read
      // (Codex N1).
      const count: unknown = (rawSources as unknown[]).length;
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > MAX_SOURCES - 1
      )
        throw new ContextBrokerError('invalid_configuration');
      const read: ReturnType<typeof readSource>[] = [];
      for (let i = 0; i < count; i += 1)
        read.push(readSource((rawSources as unknown[])[i]));
      const keys = suppressionKeys(view);
      const shared = coordination(read.length, required.length);
      wrapped = read.map((source) => suppressing(source, keys, shared));
    } catch {
      return notExposed('assembly_failed', [], null, 'invalid_configuration');
    }

    let assembly: Awaited<
      ReturnType<ReturnType<typeof createContextBroker>['assemble']>
    >;
    try {
      const broker = createContextBroker({
        sources: [...wrapped, instructionSource],
      });
      assembly = await broker.assemble(request);
    } catch (error) {
      return notExposed('assembly_failed', [], null, brokerCode(error));
    }

    const verdict = verifyExposure(required, assembly, {
      ownerId: request.ownerId,
      ...task,
    });
    if (verdict.reason !== null)
      return notExposed(verdict.reason, verdict.missing, assembly.trace, null);
    return deepFreeze({
      status: 'exposed' as const,
      bundle: assembly.bundle,
      trace: assembly.trace,
      exposed: required.map((r) => r.identity),
    });
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError('internal_error');
  }
}
