import { z } from 'zod';
import {
  CONTEXT_BROKER_CONFIG_VERSION,
  CONTEXT_BROKER_VERSION,
  EXTERNAL_SOURCE_PROVENANCE_KINDS,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_SELECTED_CONTEXT_CHARS,
  MAX_SELECTED_ITEMS,
  MAX_SINGLE_CONTEXT_ITEM_CHARS,
  MAX_SOURCES,
  MAX_TOTAL_CANDIDATES,
  NEGATIVE_SIGNAL_SUPPRESSION_VALUE,
  RELEVANCE_VERSION,
  SOURCE_KIND_REFERENCE_KINDS,
  type ContextSourceKind,
} from './config.ts';
import { ContextBrokerError } from './errors.ts';
import {
  extractQueryTerms,
  lexicalRelevance,
  type LexicalRelevance,
} from './relevance.ts';
import {
  freshness,
  provenanceFactor,
  scopeFactor,
  score,
  trustBasis,
  trustFactor,
  type FreshnessAssessment,
  type ScoreBreakdown,
  type TrustBasis,
} from './ranking.ts';
import {
  assessScope,
  taskBindingMatches,
  withTaskBinding,
  type ScopeAssessment,
} from './scope.ts';
import {
  ContextCandidateSchema,
  ContextRequestSchema,
  ContextSourceKindSchema,
  LocalIdSchema,
  type ContextRequest,
  type ParsedContextCandidate,
  type ParsedContextRequest,
  type TaskDescriptor,
} from './types.ts';
import {
  codePointLength,
  compareCodeUnits,
  deepFreeze,
  truncateCodePoints,
} from './util.ts';

/**
 * Context Broker v1 (AVEN-008): TASK-SPECIFIC CONTEXT ASSEMBLY.
 *
 *   request + transient candidates from injected sources
 *     -> owner isolation -> eligibility/scope -> transparent ranking
 *     -> negative-signal handling -> budgeted deterministic selection
 *     -> ContextBundle + observable trace
 *
 * Context is not memory. The broker is read/compute-only: it owns no storage,
 * appends nothing to the Ledger, persists no score, signal or selection,
 * mutates no source or candidate, creates no learned state or correction,
 * calls no model or network, and makes no permission decision. Candidate text
 * is data; it never changes ownership, provenance, trust or scope. The bundle
 * is structured context, not a prompt; later fast-loop code serializes it.
 */

/** The owner-scoped, deep-frozen query every source receives. */
export interface ContextSourceQuery {
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly request: string;
  readonly referenceTime: string;
  readonly taskDescriptor: Readonly<TaskDescriptor>;
  /** Collections larger than this fail the whole assembly. */
  readonly maxCandidates: number;
}

/**
 * Injected source boundary. A trusted caller registers each source with an ID
 * and a kind; future adapters (Owner Model, episodes, procedures, active task,
 * permitted external content) implement `collect`. The broker validates every
 * returned candidate itself and does not trust the source for owner isolation.
 *
 * Note: AVEN-002's `ContextSourceSchema` describes a candidate's REFERENCE
 * (what item it points to); it is the candidate's `reference` field here.
 */
export interface ContextSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  collect(
    query: ContextSourceQuery,
  ): readonly unknown[] | Promise<readonly unknown[]>;
}

export interface ContextBrokerOptions {
  readonly sources: readonly ContextSource[];
}

export type ExclusionReason =
  | 'superseded'
  | 'revoked'
  | 'recorded_after_reference_time'
  | 'task_binding_mismatch'
  | 'scope_mismatch'
  | 'negative_signal_suppressed'
  | 'no_relevance_channel'
  | 'item_limit'
  | 'context_budget';

/** Eligibility reasons in precedence order, then the two budget reasons. */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = Object.freeze([
  'superseded',
  'revoked',
  'recorded_after_reference_time',
  'task_binding_mismatch',
  'scope_mismatch',
  'negative_signal_suppressed',
  'no_relevance_channel',
  'item_limit',
  'context_budget',
]);

export type RelevanceChannel = 'lexical_content_term' | 'task' | 'scope_label';

export interface BudgetUsage {
  readonly characterUnit: 'unicode_code_point';
  readonly maxSelectedItems: number;
  readonly maxContextChars: number;
  readonly maxItemChars: number;
  readonly selectedItems: number;
  readonly usedChars: number;
  readonly truncatedItems: number;
  /** Why selection stopped before the eligible list ended, if it did. */
  readonly stopReason: 'item_limit' | 'context_budget' | null;
}

export interface ContextBundleItem {
  readonly rank: number;
  readonly sourceId: string;
  readonly sourceKind: ContextSourceKind;
  readonly candidateId: string;
  readonly reference: ParsedContextCandidate['reference'];
  readonly provenance: ParsedContextCandidate['provenance'];
  readonly scope: ParsedContextCandidate['scope'];
  readonly recordedAt: string;
  readonly lastValidatedAt: string | null;
  /** Item text as data, possibly truncated to `maxItemChars` code points. */
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly includedChars: number;
  readonly score: ScoreBreakdown;
}

/** Transient context for ONE task. Not owner memory and not authority. */
export interface ContextBundle {
  readonly kind: 'context_bundle';
  readonly brokerVersion: string;
  readonly configVersion: string;
  readonly relevanceVersion: string;
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly referenceTime: string;
  /** Selected items in rank order. */
  readonly items: readonly ContextBundleItem[];
  readonly budget: BudgetUsage;
}

export interface TraceCandidate {
  readonly sourceId: string;
  readonly sourceKind: ContextSourceKind;
  readonly candidateId: string;
  readonly referenceKind: ParsedContextCandidate['reference']['kind'];
  readonly lifecycle: string | null;
  readonly provenanceKind: ParsedContextCandidate['provenance']['kind'];
  readonly signals: {
    readonly confidence: number;
    readonly salience: number;
    readonly negativeRetrieval: number;
  };
  readonly selection: 'selected' | 'excluded';
  readonly exclusionReason: ExclusionReason | null;
  /** 1-based position among eligible candidates; null if ineligible. */
  readonly eligibleRank: number | null;
  readonly taskBinding: 'matches' | 'does_not_match' | 'not_task_bound';
  readonly scope: ScopeAssessment;
  readonly relevance: LexicalRelevance;
  readonly channels: readonly RelevanceChannel[];
  readonly freshness: FreshnessAssessment | null;
  readonly trustBasis: TrustBasis;
  /** Present only for eligible candidates; eligibility is never a low score. */
  readonly score: ScoreBreakdown | null;
  readonly text: {
    readonly originalChars: number;
    readonly includedChars: number;
    readonly truncated: boolean;
  };
}

export interface TraceSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  readonly returned: number;
  /** Candidates of another owner: excluded before any statistic; no IDs kept. */
  readonly foreignOwnerExcluded: number;
  /** Owner-origin provenance naming another owner: excluded; no IDs kept. */
  readonly ownerProvenanceMismatchExcluded: number;
  readonly considered: number;
}

/**
 * Observable, non-chain-of-thought trace of the deterministic computation:
 * identifiers, codes and numbers only. It holds no item text, no hidden
 * reasoning, no secret and no authority decision.
 */
export interface ContextBrokerTrace {
  readonly kind: 'context_broker_trace';
  readonly brokerVersion: string;
  readonly configVersion: string;
  readonly relevanceVersion: string;
  readonly ownerId: string;
  readonly task: { readonly sessionId: string; readonly taskId: string };
  readonly referenceTime: string;
  readonly query: {
    readonly terms: readonly string[];
    readonly contentTermCount: number;
    readonly qualifierTermCount: number;
  };
  readonly sources: readonly TraceSource[];
  /** Every same-owner candidate, ordered by sourceId then candidateId. */
  readonly candidates: readonly TraceCandidate[];
  /** Eligible candidates in rank order with their final scores. */
  readonly ranking: readonly {
    readonly sourceId: string;
    readonly candidateId: string;
    readonly final: number;
  }[];
  readonly selected: readonly {
    readonly rank: number;
    readonly sourceId: string;
    readonly candidateId: string;
  }[];
  readonly totals: {
    readonly returned: number;
    readonly foreignOwnerExcluded: number;
    readonly ownerProvenanceMismatchExcluded: number;
    readonly considered: number;
    readonly eligible: number;
    readonly selected: number;
    readonly excludedByReason: Readonly<Record<ExclusionReason, number>>;
  };
  readonly budget: BudgetUsage;
}

export interface ContextAssembly {
  readonly bundle: ContextBundle;
  readonly trace: ContextBrokerTrace;
}

export interface ContextBroker {
  /** Registered sources, ordered by sourceId. */
  readonly sources: readonly {
    readonly sourceId: string;
    readonly kind: ContextSourceKind;
  }[];
  assemble(request: ContextRequest): Promise<ContextAssembly>;
}

interface RegisteredSource {
  readonly sourceId: string;
  readonly kind: ContextSourceKind;
  readonly target: ContextSource;
  readonly collect: ContextSource['collect'];
}

const OptionsSchema = z.strictObject({
  sources: z.array(z.unknown()).max(MAX_SOURCES),
});

function register(options: unknown): RegisteredSource[] {
  const parsed = OptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new ContextBrokerError('invalid_configuration', {}, parsed.error);
  const registered = parsed.data.sources.map((raw) => {
    const source = raw as Partial<ContextSource> | null;
    // Read once at registration: a source cannot later change its ID or kind.
    const sourceId = source?.sourceId;
    const kind = source?.kind;
    const collect = source?.collect;
    if (
      !LocalIdSchema.safeParse(sourceId).success ||
      !ContextSourceKindSchema.safeParse(kind).success ||
      typeof collect !== 'function'
    )
      throw new ContextBrokerError('invalid_configuration');
    return Object.freeze({
      sourceId: sourceId as string,
      kind: kind as ContextSourceKind,
      target: source as ContextSource,
      collect,
    });
  });
  registered.sort((a, b) => compareCodeUnits(a.sourceId, b.sourceId));
  if (new Set(registered.map((s) => s.sourceId)).size !== registered.length)
    throw new ContextBrokerError('invalid_configuration');
  return registered;
}

function parseCandidate(
  raw: unknown,
  source: RegisteredSource,
  index: number,
): ParsedContextCandidate {
  const parsed = ContextCandidateSchema.safeParse(raw);
  const location = { sourceId: source.sourceId, candidateIndex: index };
  if (!parsed.success) {
    const signalIssue = parsed.error.issues.some(
      (i) => i.path[0] === 'signals',
    );
    throw new ContextBrokerError(
      signalIssue ? 'invalid_score_metadata' : 'invalid_candidate',
      location,
      parsed.error,
    );
  }
  const candidate = parsed.data;
  // Structural consistency with the registered source kind. An external
  // adapter can never present its content as owner-origin, owner state or a
  // current instruction.
  if (
    !SOURCE_KIND_REFERENCE_KINDS[source.kind].includes(
      candidate.reference.kind,
    ) ||
    (source.kind === 'permitted_external' &&
      !EXTERNAL_SOURCE_PROVENANCE_KINDS.includes(candidate.provenance.kind))
  )
    throw new ContextBrokerError('invalid_candidate', location);
  return candidate;
}

interface Collected {
  readonly source: RegisteredSource;
  readonly returned: number;
  readonly candidates: readonly ParsedContextCandidate[];
}

async function collectAll(
  sources: readonly RegisteredSource[],
  query: ContextSourceQuery,
): Promise<Collected[]> {
  const settled = await Promise.allSettled(
    sources.map((s) =>
      Promise.resolve().then(() => s.collect.call(s.target, query)),
    ),
  );
  // Collection-level checks first, in sourceId order: a failed or oversized
  // source fails the whole assembly (no partial bundle that looks complete).
  const snapshots: unknown[][] = [];
  let total = 0;
  settled.forEach((result, i) => {
    const source = sources[i]!;
    if (result.status === 'rejected')
      throw new ContextBrokerError(
        'source_failure',
        { sourceId: source.sourceId },
        result.reason,
      );
    const value: unknown = result.value;
    if (!Array.isArray(value))
      throw new ContextBrokerError('source_failure', {
        sourceId: source.sourceId,
      });
    if (value.length > MAX_CANDIDATES_PER_SOURCE)
      throw new ContextBrokerError('candidate_limit_exceeded', {
        sourceId: source.sourceId,
      });
    total += value.length;
    snapshots.push(Array.prototype.slice.call(value) as unknown[]);
  });
  if (total > MAX_TOTAL_CANDIDATES)
    throw new ContextBrokerError('candidate_limit_exceeded');
  return sources.map((source, i) => {
    const raw = snapshots[i]!;
    const seen = new Set<string>();
    const candidates = raw.map((item, index) => {
      const candidate = parseCandidate(item, source, index);
      if (seen.has(candidate.candidateId))
        throw new ContextBrokerError('invalid_candidate', {
          sourceId: source.sourceId,
          candidateIndex: index,
        });
      seen.add(candidate.candidateId);
      return candidate;
    });
    return { source, returned: raw.length, candidates };
  });
}

interface Assessed {
  readonly source: RegisteredSource;
  readonly candidate: ParsedContextCandidate;
  readonly includedText: string;
  readonly originalChars: number;
  readonly includedChars: number;
  readonly truncated: boolean;
  readonly bindingMatch: boolean | undefined;
  readonly scope: ScopeAssessment;
  readonly relevance: LexicalRelevance;
  readonly channels: readonly RelevanceChannel[];
  readonly freshness: FreshnessAssessment | null;
  readonly trustBasis: TrustBasis;
  readonly ineligibility: ExclusionReason | null;
  readonly score: ScoreBreakdown | null;
}

function assess(
  source: RegisteredSource,
  candidate: ParsedContextCandidate,
  request: ParsedContextRequest,
  query: ReturnType<typeof extractQueryTerms>,
): Assessed {
  const originalChars = codePointLength(candidate.text);
  const truncated = originalChars > MAX_SINGLE_CONTEXT_ITEM_CHARS;
  const includedText = truncated
    ? truncateCodePoints(candidate.text, MAX_SINGLE_CONTEXT_ITEM_CHARS)
    : candidate.text;
  const includedChars = Math.min(originalChars, MAX_SINGLE_CONTEXT_ITEM_CHARS);
  // Relevance is judged on exactly the text the bundle would carry.
  const relevance = lexicalRelevance(query, includedText);
  const bindingMatch = taskBindingMatches(candidate, request);
  const declared = assessScope(candidate, request);
  const scope =
    bindingMatch === true && declared.status !== 'mismatch'
      ? withTaskBinding(declared)
      : declared;
  const reference = Date.parse(request.referenceTime);
  const afterReference =
    Date.parse(candidate.timestamps.recordedAt) > reference ||
    (candidate.timestamps.lastValidatedAt !== undefined &&
      Date.parse(candidate.timestamps.lastValidatedAt) > reference);
  const fresh = afterReference
    ? null
    : freshness(candidate, request.referenceTime);
  const channels: RelevanceChannel[] = [];
  if (relevance.matchedContentTermCount > 0)
    channels.push('lexical_content_term');
  if (scope.status === 'task_match') channels.push('task');
  if (scope.status === 'label_match' || scope.status === 'partial_label_match')
    channels.push('scope_label');
  const lifecycle =
    candidate.reference.kind === 'owner_state'
      ? candidate.reference.lifecycle
      : undefined;
  const negative = candidate.signals.negativeRetrieval;
  // Eligibility in fixed precedence; the first failing rule is reported.
  const ineligibility: ExclusionReason | null =
    lifecycle === 'superseded'
      ? 'superseded'
      : lifecycle === 'revoked'
        ? 'revoked'
        : afterReference
          ? 'recorded_after_reference_time'
          : bindingMatch === false
            ? 'task_binding_mismatch'
            : scope.status === 'mismatch'
              ? 'scope_mismatch'
              : negative >= NEGATIVE_SIGNAL_SUPPRESSION_VALUE
                ? 'negative_signal_suppressed'
                : channels.length === 0
                  ? 'no_relevance_channel'
                  : null;
  const basis = trustBasis(candidate);
  const breakdown =
    ineligibility === null && fresh !== null && scope.status !== 'mismatch'
      ? score(
          {
            relevance: relevance.score,
            scope: scopeFactor(scope.status),
            provenance: provenanceFactor(candidate),
            confidence: candidate.signals.confidence,
            freshness: fresh.factor,
            salience: candidate.signals.salience,
            trust: trustFactor(basis),
          },
          negative,
        )
      : null;
  return {
    source,
    candidate,
    includedText,
    originalChars,
    includedChars,
    truncated,
    bindingMatch,
    scope,
    relevance,
    channels: Object.freeze(channels),
    freshness: fresh,
    trustBasis: basis,
    ineligibility,
    score: breakdown,
  };
}

/** Final score descending, then sourceId, then candidateId (code units). */
function byRank(a: Assessed, b: Assessed): number {
  return (
    b.score!.final - a.score!.final ||
    compareCodeUnits(a.source.sourceId, b.source.sourceId) ||
    compareCodeUnits(a.candidate.candidateId, b.candidate.candidateId)
  );
}

export function createContextBroker(
  options: ContextBrokerOptions,
): ContextBroker {
  const sources = register(options);
  const descriptors = deepFreeze(
    sources.map(({ sourceId, kind }) => ({ sourceId, kind })),
  );

  async function assemble(input: ContextRequest): Promise<ContextAssembly> {
    const parsedRequest = ContextRequestSchema.safeParse(input);
    if (!parsedRequest.success)
      throw new ContextBrokerError('invalid_request', {}, parsedRequest.error);
    const request = parsedRequest.data;
    const task = {
      sessionId: request.task.sessionId,
      taskId: request.task.taskId,
    };
    const sourceQuery: ContextSourceQuery = deepFreeze({
      ownerId: request.ownerId,
      task: { ...task },
      request: request.request,
      referenceTime: request.referenceTime,
      taskDescriptor: structuredClone(request.taskDescriptor),
      maxCandidates: MAX_CANDIDATES_PER_SOURCE,
    });

    const collected = await collectAll(sources, sourceQuery);
    const query = extractQueryTerms(request.request);

    // Owner isolation BEFORE any statistic: foreign candidates and candidates
    // whose owner-origin provenance names another owner are dropped and only
    // counted, so they can affect neither membership nor any score.
    const traceSources: TraceSource[] = [];
    const assessed: Assessed[] = [];
    for (const { source, returned, candidates } of collected) {
      let foreignOwnerExcluded = 0;
      let ownerProvenanceMismatchExcluded = 0;
      const own: ParsedContextCandidate[] = [];
      for (const candidate of candidates) {
        if (candidate.ownerId !== request.ownerId) foreignOwnerExcluded += 1;
        else if (
          'ownerId' in candidate.provenance &&
          candidate.provenance.ownerId !== request.ownerId
        )
          ownerProvenanceMismatchExcluded += 1;
        else own.push(candidate);
      }
      own.sort((a, b) => compareCodeUnits(a.candidateId, b.candidateId));
      for (const candidate of own)
        assessed.push(assess(source, candidate, request, query));
      traceSources.push({
        sourceId: source.sourceId,
        kind: source.kind,
        returned,
        foreignOwnerExcluded,
        ownerProvenanceMismatchExcluded,
        considered: own.length,
      });
    }

    const eligible = assessed
      .filter((a) => a.ineligibility === null)
      .sort(byRank);
    const eligibleRank = new Map(eligible.map((a, i) => [a, i + 1]));

    // Budget: a rank-order prefix. At the first eligible item that does not
    // fit, it and every lower-ranked eligible item are excluded with the
    // reason that stopped selection. Items are never reordered or split
    // beyond the per-item code-point prefix.
    const budgetExclusion = new Map<Assessed, ExclusionReason>();
    const selected: Assessed[] = [];
    let usedChars = 0;
    let stopReason: 'item_limit' | 'context_budget' | null = null;
    for (const item of eligible) {
      if (stopReason === null) {
        if (selected.length >= MAX_SELECTED_ITEMS) stopReason = 'item_limit';
        else if (usedChars + item.includedChars > MAX_SELECTED_CONTEXT_CHARS)
          stopReason = 'context_budget';
      }
      if (stopReason !== null) budgetExclusion.set(item, stopReason);
      else {
        selected.push(item);
        usedChars += item.includedChars;
      }
    }

    const budget: BudgetUsage = {
      characterUnit: 'unicode_code_point',
      maxSelectedItems: MAX_SELECTED_ITEMS,
      maxContextChars: MAX_SELECTED_CONTEXT_CHARS,
      maxItemChars: MAX_SINGLE_CONTEXT_ITEM_CHARS,
      selectedItems: selected.length,
      usedChars,
      truncatedItems: selected.filter((s) => s.truncated).length,
      stopReason,
    };
    const versions = {
      brokerVersion: CONTEXT_BROKER_VERSION,
      configVersion: CONTEXT_BROKER_CONFIG_VERSION,
      relevanceVersion: RELEVANCE_VERSION,
    };
    const identity = {
      ownerId: request.ownerId,
      task,
      referenceTime: request.referenceTime,
    };

    const bundle: ContextBundle = {
      kind: 'context_bundle',
      ...versions,
      ...identity,
      items: selected.map((s, i) => ({
        rank: i + 1,
        sourceId: s.source.sourceId,
        sourceKind: s.source.kind,
        candidateId: s.candidate.candidateId,
        reference: structuredClone(s.candidate.reference),
        provenance: structuredClone(s.candidate.provenance),
        scope: structuredClone(s.candidate.scope),
        recordedAt: s.candidate.timestamps.recordedAt,
        lastValidatedAt: s.candidate.timestamps.lastValidatedAt ?? null,
        text: s.includedText,
        truncated: s.truncated,
        originalChars: s.originalChars,
        includedChars: s.includedChars,
        score: s.score!,
      })),
      budget: { ...budget },
    };

    const excludedByReason = Object.fromEntries(
      EXCLUSION_REASONS.map((r) => [r, 0]),
    ) as Record<ExclusionReason, number>;
    const traceCandidates: TraceCandidate[] = assessed.map((a) => {
      const exclusionReason = a.ineligibility ?? budgetExclusion.get(a) ?? null;
      if (exclusionReason !== null) excludedByReason[exclusionReason] += 1;
      return {
        sourceId: a.source.sourceId,
        sourceKind: a.source.kind,
        candidateId: a.candidate.candidateId,
        referenceKind: a.candidate.reference.kind,
        lifecycle:
          a.candidate.reference.kind === 'owner_state'
            ? a.candidate.reference.lifecycle
            : null,
        provenanceKind: a.candidate.provenance.kind,
        signals: { ...a.candidate.signals },
        selection: exclusionReason === null ? 'selected' : 'excluded',
        exclusionReason,
        eligibleRank: eligibleRank.get(a) ?? null,
        taskBinding:
          a.bindingMatch === undefined
            ? 'not_task_bound'
            : a.bindingMatch
              ? 'matches'
              : 'does_not_match',
        scope: a.scope,
        relevance: a.relevance,
        channels: a.channels,
        freshness: a.freshness,
        trustBasis: a.trustBasis,
        score: a.score,
        text: {
          originalChars: a.originalChars,
          includedChars: a.includedChars,
          truncated: a.truncated,
        },
      };
    });

    const trace: ContextBrokerTrace = {
      kind: 'context_broker_trace',
      ...versions,
      ...identity,
      task: { ...task },
      query: {
        terms: query.terms,
        contentTermCount: query.contentTermCount,
        qualifierTermCount: query.qualifierTermCount,
      },
      sources: traceSources,
      candidates: traceCandidates,
      ranking: eligible.map((a) => ({
        sourceId: a.source.sourceId,
        candidateId: a.candidate.candidateId,
        final: a.score!.final,
      })),
      selected: bundle.items.map((item) => ({
        rank: item.rank,
        sourceId: item.sourceId,
        candidateId: item.candidateId,
      })),
      totals: {
        returned: traceSources.reduce((n, s) => n + s.returned, 0),
        foreignOwnerExcluded: traceSources.reduce(
          (n, s) => n + s.foreignOwnerExcluded,
          0,
        ),
        ownerProvenanceMismatchExcluded: traceSources.reduce(
          (n, s) => n + s.ownerProvenanceMismatchExcluded,
          0,
        ),
        considered: assessed.length,
        eligible: eligible.length,
        selected: selected.length,
        excludedByReason,
      },
      budget: { ...budget },
    };

    return deepFreeze({ bundle, trace });
  }

  return Object.freeze({ sources: descriptors, assemble });
}
