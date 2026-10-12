import { createHash } from 'node:crypto';
import {
  ContextBrokerError,
  ContextCandidateSchema,
  ContextRequestSchema,
  createContextBroker,
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

/** The key of a candidate snapshot's reference, if it is comparable. */
function referenceKey(snapshot: unknown): string | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined;
  const reference = (snapshot as { reference?: unknown }).reference;
  if (reference === null || typeof reference !== 'object') return undefined;
  const r = reference as {
    kind?: unknown;
    reference?: {
      evidenceId?: unknown;
      eventId?: unknown;
      learnedItemId?: unknown;
      version?: unknown;
    };
  };
  const inner = r.reference;
  if (inner === null || typeof inner !== 'object') return undefined;
  if (
    r.kind === 'evidence' &&
    typeof inner.evidenceId === 'string' &&
    typeof inner.eventId === 'string'
  )
    return evidenceKey(inner.evidenceId, inner.eventId);
  if (
    r.kind === 'owner_state' &&
    typeof inner.learnedItemId === 'string' &&
    typeof inner.version === 'number'
  )
    return ownerStateKey(inner.learnedItemId, inner.version);
  return undefined;
}

/**
 * Wraps one base source: same ID, kind and query; only exactly targeted
 * same-owner candidates are replaced by a copy with the suppression signal.
 * Foreign, non-matching, unreadable or invalid items pass through untouched
 * (the Broker drops, keeps or rejects them as before); source failures and
 * timeouts propagate.
 */
function suppressing(
  base: ContextSource,
  keys: ReadonlySet<string>,
): ContextSource {
  const sourceId = base.sourceId;
  const kind = base.kind;
  const collect: unknown = base.collect;
  if (typeof collect !== 'function')
    throw new ContextBrokerError('invalid_configuration');
  return Object.freeze({
    sourceId,
    kind,
    async collect(
      query: ContextSourceQuery,
      options: ContextSourceCollectOptions,
    ): Promise<readonly unknown[]> {
      const items: unknown = await (collect as ContextSource['collect']).call(
        base,
        query,
        options,
      );
      if (keys.size === 0 || !Array.isArray(items))
        return items as readonly unknown[];
      return items.map((item: unknown) => {
        if (item === null || typeof item !== 'object') return item;
        let snapshot: unknown;
        try {
          if ((item as { ownerId?: unknown }).ownerId !== query.ownerId)
            return item;
          snapshot = structuredClone(item);
        } catch {
          return item;
        }
        const key = referenceKey(snapshot);
        if (key === undefined || !keys.has(key)) return item;
        const signals = (snapshot as { signals?: unknown }).signals;
        if (signals === null || typeof signals !== 'object') return item;
        return {
          ...(snapshot as object),
          signals: { ...signals, negativeRetrieval: SUPPRESSION_VALUE },
        };
      });
    },
  });
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

    let assembly: Awaited<
      ReturnType<ReturnType<typeof createContextBroker>['assemble']>
    >;
    try {
      if (!Array.isArray(rawSources))
        throw new ContextBrokerError('invalid_configuration');
      const keys = suppressionKeys(view);
      const wrapped = (rawSources as readonly ContextSource[]).map((source) =>
        suppressing(source, keys),
      );
      const broker = createContextBroker({
        sources: [...wrapped, instructionSource],
      });
      assembly = await broker.assemble(request);
    } catch (error) {
      return notExposed(
        'assembly_failed',
        [],
        null,
        error instanceof ContextBrokerError ? error.code : null,
      );
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
