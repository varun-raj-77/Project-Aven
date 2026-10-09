import { createHash } from 'node:crypto';
import type {
  ActiveTaskState,
  DurableOwnerState,
  OwnerId,
} from '@aven/contracts';
import {
  ContextCandidateSchema,
  type ContextCandidate,
  type ContextSource,
  type ContextSourceKind,
  type ContextSourceQuery,
} from '@aven/context-broker';
import { buildActiveTaskView } from '../active-task.ts';
import { compareCodeUnits } from '../canonical-text.ts';
import { OwnerModelError } from '../errors.ts';
import {
  isRebuiltOwnerModel,
  type RebuiltOwnerModel,
} from '../persistence/rebuild.ts';
import { buildDurableCategoryViews } from '../views.ts';

/**
 * AVEN-009 patch 8: read-only Owner Model -> AVEN-008 Context Broker source
 * adapter (`@aven/owner-model/context-source`).
 *
 * From ONE genuine Patch-7 `RebuiltOwnerModel` (recognized by identity; a
 * look-alike is `invalid_input`) it builds exactly four frozen
 * `ContextSource`s bound to that model's owner:
 *   - `aven-owner-state` (owner_state): fact, preference, intent_pattern;
 *   - `aven-procedure` (procedure): procedure;
 *   - `aven-episode-history` (episode_history): episode;
 *   - `aven-active-task` (active_task): the active task state.
 * Each record reaches exactly one source as exactly one candidate.
 *
 * `collect(query)` returns `[]` for any other owner, before anything is
 * built. Otherwise durable sources offer only Patch-5 `currentDeclared`
 * records at `query.referenceTime` (so lifecycle is observed, validated or
 * trusted; superseded and revoked heads, future versions, out-of-window
 * temporal scopes, replacement and fallback are never offered), as
 * `owner_state` references carrying that lifecycle. The active-task source
 * offers the Patch-6 view for the exact `query.task` binding, as an
 * `active_task_state` reference with scope `{ kind: 'bounded', taskId }`.
 * No `current_instruction` is emitted (AVEN-010).
 *
 * Candidates copy the frozen record's provenance and scope unchanged (no
 * widening, no choice among uncertain possibilities, no trust inferred from
 * text), use `metadata.createdAt` as `recordedAt` and the lifecycle's own
 * `lastValidatedAt` when present, and render text deterministically from
 * structured content only. Signals come from the pre-specified, frozen
 * `AVEN_OWNER_MODEL_SOURCE_CONFIG_V1` (provisional and ordinal, never a
 * probability, not to be tuned on results): durable confidence is the
 * minimum of the evidence-support and inference-certainty factors; active
 * tasks use a fixed confidence; salience is one fixed value; and
 * negativeRetrieval is always exactly 0. Candidate IDs are SHA-256 digests
 * of a canonical identity tuple, so no record text or raw ID enters them.
 *
 * Every candidate is preflighted against the Broker's own public
 * `ContextCandidateSchema`. A candidate that cannot satisfy it (text or
 * metadata over the frozen limits, inconsistent timestamps) or more
 * candidates than `query.maxCandidates` fail the whole collection with the
 * fixed `invalid_owner_model_context`: nothing is truncated, dropped, ranked
 * or trimmed. The Broker alone ranks, selects and budgets. Nothing here
 * writes, reads storage, uses a clock or randomness, builds prompts, decides
 * permission or interprets corrections.
 */

type DurableCategory = DurableOwnerState['content']['category'];
type Content = DurableOwnerState['content'];
type SourceKind = Extract<
  ContextSourceKind,
  'owner_state' | 'procedure' | 'episode_history' | 'active_task'
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Pre-specified v1 source configuration. Ordinal, not calibrated. */
export const AVEN_OWNER_MODEL_SOURCE_CONFIG_V1 = deepFreeze({
  version: 'aven-009-owner-model-source-config-v1',
  calibration: 'provisional_ordinal_not_probability',
  sources: {
    owner_state: 'aven-owner-state',
    procedure: 'aven-procedure',
    episode_history: 'aven-episode-history',
    active_task: 'aven-active-task',
  },
  routing: {
    fact: 'owner_state',
    preference: 'owner_state',
    intent_pattern: 'owner_state',
    procedure: 'procedure',
    episode: 'episode_history',
  },
  supportConfidence: {
    unassessed: 0.25,
    limited: 0.5,
    corroborated: 1,
    contested: 0.25,
  },
  inferenceCertaintyConfidence: {
    not_applicable: 1,
    unassessed: 0.5,
    tentative: 0.5,
    supported: 1,
    disputed: 0.25,
  },
  confidenceCombiner: 'minimum',
  activeTaskConfidence: 0.5,
  salience: 0.5,
  negativeRetrieval: 0,
  rendering: {
    version: 'aven-009-owner-model-render-v1',
    fact: 'subject\\nassertion',
    preference: 'subject\\ndesiredBehavior',
    intent_pattern: 'cue\\ninterpretedIntent',
    episode: 'summary',
    procedure:
      'objective, then per step in order: \\n<n>. instruction[ [precondition: precondition]]',
    active_task:
      'objective; when open loops exist: \\nOpen loops:, then per loop in order: \\n- loop',
  },
  candidateId: {
    version: 'aven-009-owner-model-candidate-id-v1',
    hash: 'sha256',
    input:
      'utf8 JSON array [candidateIdVersion, configVersion, sourceKind, ownerId, learnedItemId, recordVersion]',
    format: 'om:<source-token>:<lowercase-hex-digest>',
    sourceTokens: {
      owner_state: 'state',
      procedure: 'procedure',
      episode_history: 'episode',
      active_task: 'task',
    },
  },
} as const);

const CONFIG = AVEN_OWNER_MODEL_SOURCE_CONFIG_V1;
const SOURCE_KINDS: readonly SourceKind[] = Object.freeze([
  'owner_state',
  'procedure',
  'episode_history',
  'active_task',
]);
const EMPTY: readonly unknown[] = Object.freeze([]);

/** Fail-closed token for output that cannot honour the source contract. */
const UNFIT = Object.freeze({ token: 'unfit' });

/** Deterministic compact candidate ID from the canonical identity tuple. */
function candidateId(
  kind: SourceKind,
  owner: OwnerId,
  learnedItemId: string,
  version: number,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        CONFIG.candidateId.version,
        CONFIG.version,
        kind,
        owner,
        learnedItemId,
        version,
      ]),
      'utf8',
    )
    .digest('hex');
  return `om:${CONFIG.candidateId.sourceTokens[kind]}:${digest}`;
}

function render(content: Content): string {
  switch (content.category) {
    case 'fact':
      return `${content.subject}\n${content.assertion}`;
    case 'preference':
      return `${content.subject}\n${content.desiredBehavior}`;
    case 'intent_pattern':
      return `${content.cue}\n${content.interpretedIntent}`;
    case 'episode':
      return content.summary;
    case 'procedure': {
      const lines = [content.objective];
      content.steps.forEach((step, index) => {
        const suffix =
          step.precondition === undefined
            ? ''
            : ` [precondition: ${step.precondition}]`;
        lines.push(`${index + 1}. ${step.instruction}${suffix}`);
      });
      return lines.join('\n');
    }
  }
}

function renderTask(state: ActiveTaskState): string {
  if (state.openLoops.length === 0) return state.objective;
  return [
    state.objective,
    'Open loops:',
    ...state.openLoops.map((loop) => `- ${loop}`),
  ].join('\n');
}

function frozen<T extends object>(fields: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, fields));
}

function durableConfidence(record: DurableOwnerState): number {
  const evidence = record.evidence;
  return Math.min(
    CONFIG.supportConfidence[evidence.support],
    CONFIG.inferenceCertaintyConfidence[evidence.inferenceCertainty],
  );
}

function durableCandidate(
  kind: SourceKind,
  owner: OwnerId,
  record: DurableOwnerState,
): ContextCandidate {
  const lifecycle = record.lifecycle;
  const version = record.metadata.recordVersion;
  return frozen({
    candidateId: candidateId(kind, owner, record.id, version),
    ownerId: owner,
    reference: frozen({
      kind: 'owner_state' as const,
      reference: frozen({ learnedItemId: record.id, version }),
      lifecycle: lifecycle.status,
    }),
    provenance: record.provenance,
    scope: record.scope,
    text: render(record.content),
    timestamps: frozen({
      recordedAt: record.metadata.createdAt,
      ...('lastValidatedAt' in lifecycle &&
      lifecycle.lastValidatedAt !== undefined
        ? { lastValidatedAt: lifecycle.lastValidatedAt }
        : {}),
    }),
    signals: frozen({
      confidence: durableConfidence(record),
      salience: CONFIG.salience,
      negativeRetrieval: CONFIG.negativeRetrieval,
    }),
  });
}

function taskCandidate(
  owner: OwnerId,
  state: ActiveTaskState,
): ContextCandidate {
  const version = state.metadata.recordVersion;
  return frozen({
    candidateId: candidateId('active_task', owner, state.id, version),
    ownerId: owner,
    reference: frozen({
      kind: 'active_task_state' as const,
      reference: frozen({ learnedItemId: state.id, version }),
      task: frozen({
        sessionId: state.task.sessionId,
        taskId: state.task.taskId,
      }),
    }),
    provenance: state.provenance,
    scope: frozen({ kind: 'bounded' as const, taskId: state.task.taskId }),
    text: renderTask(state),
    timestamps: frozen({ recordedAt: state.metadata.createdAt }),
    signals: frozen({
      confidence: CONFIG.activeTaskConfidence,
      salience: CONFIG.salience,
      negativeRetrieval: CONFIG.negativeRetrieval,
    }),
  });
}

/** The current declared durable records this source kind offers. */
function currentRecords(
  rebuilt: RebuiltOwnerModel,
  kind: SourceKind,
  referenceTime: string,
): DurableOwnerState[] {
  const views = buildDurableCategoryViews(rebuilt.verified, { referenceTime });
  const groups: Record<
    DurableCategory,
    readonly { readonly currentDeclared?: DurableOwnerState }[]
  > = {
    fact: views.facts,
    preference: views.preferences,
    intent_pattern: views.intentPatterns,
    procedure: views.procedures,
    episode: views.episodes,
  };
  const records: DurableOwnerState[] = [];
  for (const category of Object.keys(CONFIG.routing) as DurableCategory[]) {
    if (CONFIG.routing[category] !== kind) continue;
    for (const item of groups[category])
      if (item.currentDeclared !== undefined)
        records.push(item.currentDeclared);
  }
  return records;
}

function collectFor(
  rebuilt: RebuiltOwnerModel,
  kind: SourceKind,
  query: ContextSourceQuery,
): readonly unknown[] {
  const owner = rebuilt.ownerId;
  if (query.ownerId !== owner) return EMPTY;
  const max = query.maxCandidates;
  if (!Number.isSafeInteger(max) || max < 0) throw UNFIT;
  let candidates: ContextCandidate[];
  if (kind === 'active_task') {
    const view = buildActiveTaskView(rebuilt.intake, {
      sessionId: query.task.sessionId,
      taskId: query.task.taskId,
    });
    candidates = view === undefined ? [] : [taskCandidate(owner, view.state)];
  } else {
    const records = currentRecords(rebuilt, kind, query.referenceTime);
    if (records.length > max) throw UNFIT;
    candidates = records.map((record) => durableCandidate(kind, owner, record));
  }
  if (candidates.length > max) throw UNFIT;
  for (const candidate of candidates)
    if (!ContextCandidateSchema.safeParse(candidate).success) throw UNFIT;
  candidates.sort((a, b) => compareCodeUnits(a.candidateId, b.candidateId));
  return Object.freeze(candidates);
}

/**
 * The four Owner Model context sources over one genuine rebuilt model.
 * Throws `OwnerModelError('invalid_input')` for anything else.
 */
export function createOwnerModelContextSources(
  rebuilt: RebuiltOwnerModel,
): readonly ContextSource[] {
  if (!isRebuiltOwnerModel(rebuilt)) throw new OwnerModelError('invalid_input');
  const sources = SOURCE_KINDS.map((kind) =>
    frozen({
      sourceId: CONFIG.sources[kind],
      kind,
      collect(query: ContextSourceQuery): readonly unknown[] {
        try {
          return collectFor(rebuilt, kind, query);
        } catch (thrown) {
          // Fixed owner-model codes pass through as fresh errors; anything
          // else is the one fixed context-contract error. No cause is kept.
          throw new OwnerModelError(
            thrown instanceof OwnerModelError
              ? thrown.code
              : 'invalid_owner_model_context',
          );
        }
      },
    }),
  );
  return Object.freeze(sources);
}
