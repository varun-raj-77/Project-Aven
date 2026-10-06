/**
 * AVEN-008 Context Broker configuration, version 1.
 *
 * Every value here was PRE-SPECIFIED before any model-quality experiment and
 * without looking at AVEN-007 development or held-out cases. The values are
 * provisional, not learned and not tuned. Changing any of them requires a new
 * configuration version and a documented experiment change; a test pins the
 * whole object so a silent edit fails.
 */
export const CONTEXT_BROKER_VERSION = 'aven-008-context-broker-v1';
export const CONTEXT_BROKER_CONFIG_VERSION =
  'aven-008-context-broker-config-v1';
export const RELEVANCE_VERSION = 'aven-008-lexical-coverage-v1';
export const TOKENIZER_VERSION = 'aven-008-tokenizer-v1';

/** The seven ranking factors, in their fixed reporting order. */
export const RANKING_FACTORS = [
  'relevance',
  'scope',
  'provenance',
  'confidence',
  'freshness',
  'salience',
  'trust',
] as const;
export type RankingFactor = (typeof RANKING_FACTORS)[number];

/**
 * Pre-specified v1 factor weights in basis points (10000 = 1.00):
 * relevance 0.40, scope 0.20, provenance 0.10, confidence 0.10,
 * freshness 0.07, salience 0.07, trust 0.06. Integer basis points make the
 * sum exactly checkable. The negative-retrieval penalty is applied separately,
 * after the weighted composite.
 */
export const RANKING_WEIGHTS_BASIS_POINTS: Readonly<
  Record<RankingFactor, number>
> = Object.freeze({
  relevance: 4000,
  scope: 2000,
  provenance: 1000,
  confidence: 1000,
  freshness: 700,
  salience: 700,
  trust: 600,
});
export const WEIGHT_BASIS_POINTS_TOTAL = 10000;

/**
 * Scope factor by deterministic scope status (see `scope.ts`). A `mismatch` is
 * an eligibility decision, never a low score, so it has no factor.
 */
export const SCOPE_FACTORS = Object.freeze({
  task_match: 1,
  label_match: 1,
  partial_label_match: 0.75,
  global: 0.5,
  indeterminate: 0.25,
  unknown: 0.25,
  uncertain: 0.25,
});

/**
 * Provenance factor by the frozen AVEN-002 provenance kind supplied as
 * structured metadata by the source adapter. Owner-origin kinds rank highest;
 * candidate prose can never select or change the kind.
 */
export const PROVENANCE_FACTORS = Object.freeze({
  explicit_owner_statement: 1,
  explicit_owner_correction: 1,
  owner_approval: 1,
  system_generated: 0.6,
  model_inference: 0.4,
  tool_result: 0.3,
  external_content: 0.2,
});

/**
 * Trust factor. It describes governance status, derived only from frozen
 * structured metadata, in this precedence:
 *   1. a provenance trust label: `untrusted` (external content) or
 *      `potentially_untrusted` (tool result) caps trust whatever the lifecycle;
 *   2. otherwise the reference kind, and for owner state its lifecycle label.
 * Lifecycle labels are claims of the trusted adapter; the broker does not
 * verify promotion lineage and never upgrades trust.
 */
export const TRUST_FACTORS = Object.freeze({
  label_untrusted: 0,
  label_potentially_untrusted: 0.25,
  owner_state_trusted: 1,
  owner_state_validated: 0.75,
  owner_state_observed: 0.5,
  current_instruction: 1,
  active_task_state: 0.5,
  evidence: 0.5,
});

/**
 * Freshness: 0.5 ^ (age / half-life). Age is measured from the candidate's
 * `lastValidatedAt` (if supplied) or `recordedAt` to the request's explicit
 * `referenceTime`; no wall clock is read.
 */
export const FRESHNESS_HALF_LIFE_DAYS = 90;
export const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Negative retrieval: `final = composite * (1 - negativeRetrieval)`. A maximal
 * signal (exactly 1) is a hard suppression: an eligibility decision.
 */
export const NEGATIVE_SIGNAL_SUPPRESSION_VALUE = 1;

/** Factor and score values are rounded to this many decimal places. */
export const SCORE_DECIMALS = 9;

/** Context budgets. Characters are Unicode code points of item text. */
export const MAX_SELECTED_CONTEXT_CHARS = 10000;
export const MAX_SINGLE_CONTEXT_ITEM_CHARS = 1600;
export const MAX_SELECTED_ITEMS = 10;

/** Input-size guards (validation limits, not context budgets). */
export const MAX_SOURCES = 16;
export const MAX_CANDIDATES_PER_SOURCE = 500;
export const MAX_TOTAL_CANDIDATES = 2000;
export const MAX_REQUEST_CHARS = 8000;
export const MAX_CANDIDATE_TEXT_CHARS = 20000;
export const MAX_LABEL_CHARS = 256;
/** Every other string inside a candidate's reference, provenance or scope. */
export const MAX_METADATA_CHARS = 1000;
export const MAX_LOCAL_ID_CHARS = 128;

/**
 * Injected source kinds and the candidate reference kinds each may return.
 * `permitted_external` may return only recorded evidence carrying an
 * `external_content` or `tool_result` provenance, so an external adapter can
 * never present its content as owner-origin, owner state or an instruction.
 */
export const CONTEXT_SOURCE_KINDS = [
  'owner_state',
  'episode_history',
  'procedure',
  'active_task',
  'permitted_external',
] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export const SOURCE_KIND_REFERENCE_KINDS: Readonly<
  Record<ContextSourceKind, readonly string[]>
> = Object.freeze({
  owner_state: Object.freeze(['owner_state']),
  episode_history: Object.freeze(['evidence', 'owner_state']),
  procedure: Object.freeze(['owner_state']),
  active_task: Object.freeze(['active_task_state', 'current_instruction']),
  permitted_external: Object.freeze(['evidence']),
});
export const EXTERNAL_SOURCE_PROVENANCE_KINDS: readonly string[] =
  Object.freeze(['external_content', 'tool_result']);

export interface ContextBrokerConfiguration {
  readonly brokerVersion: string;
  readonly configVersion: string;
  readonly relevance: {
    readonly version: string;
    readonly tokenizer: string;
    readonly tokenizerSteps: readonly string[];
    readonly metric: 'unique_query_term_coverage';
    readonly scoredText: 'included_item_text';
  };
  readonly weightsBasisPoints: Readonly<Record<RankingFactor, number>>;
  readonly scopeFactors: Readonly<Record<string, number>>;
  readonly provenanceFactors: Readonly<Record<string, number>>;
  readonly trustFactors: Readonly<Record<string, number>>;
  readonly freshness: {
    readonly halfLifeDays: number;
    readonly anchor: 'lastValidatedAt_else_recordedAt';
    readonly clock: 'request_reference_time';
  };
  readonly negativeRetrieval: {
    readonly penalty: 'multiplicative_one_minus_signal';
    readonly suppressionValue: number;
  };
  readonly eligibility: readonly string[];
  readonly relevanceChannels: readonly string[];
  readonly ordering: readonly string[];
  readonly scoreDecimals: number;
  readonly budget: {
    readonly maxSelectedItems: number;
    readonly maxContextChars: number;
    readonly maxItemChars: number;
    readonly policy: 'rank_order_prefix';
    readonly itemTruncation: 'code_point_prefix';
  };
  readonly limits: {
    readonly maxSources: number;
    readonly maxCandidatesPerSource: number;
    readonly maxTotalCandidates: number;
    readonly maxRequestChars: number;
    readonly maxCandidateTextChars: number;
    readonly maxLabelChars: number;
    readonly maxMetadataChars: number;
    readonly maxLocalIdChars: number;
  };
  readonly sourceFailurePolicy: 'fail_closed_whole_assembly';
  readonly foreignOwnerPolicy: 'exclude_before_statistics_and_count';
  readonly characterUnit: 'unicode_code_point';
}

export const CONTEXT_BROKER_CONFIG_V1: ContextBrokerConfiguration =
  Object.freeze({
    brokerVersion: CONTEXT_BROKER_VERSION,
    configVersion: CONTEXT_BROKER_CONFIG_VERSION,
    relevance: Object.freeze({
      version: RELEVANCE_VERSION,
      tokenizer: TOKENIZER_VERSION,
      tokenizerSteps: Object.freeze([
        'unicode_nfkc',
        'lowercase_locale_independent',
        'expand_negative_contractions_to_not',
        'split_on_non_letter_mark_number',
        'remove_STOPWORDS_V1',
        'harman_s_plural_fold',
      ]),
      metric: 'unique_query_term_coverage',
      scoredText: 'included_item_text',
    }),
    weightsBasisPoints: RANKING_WEIGHTS_BASIS_POINTS,
    scopeFactors: SCOPE_FACTORS,
    provenanceFactors: PROVENANCE_FACTORS,
    trustFactors: TRUST_FACTORS,
    freshness: Object.freeze({
      halfLifeDays: FRESHNESS_HALF_LIFE_DAYS,
      anchor: 'lastValidatedAt_else_recordedAt',
      clock: 'request_reference_time',
    }),
    negativeRetrieval: Object.freeze({
      penalty: 'multiplicative_one_minus_signal',
      suppressionValue: NEGATIVE_SIGNAL_SUPPRESSION_VALUE,
    }),
    eligibility: Object.freeze([
      'same_owner_else_excluded_before_statistics',
      'owner_origin_provenance_names_same_owner',
      'lifecycle_not_superseded',
      'lifecycle_not_revoked',
      'timestamps_not_after_reference_time',
      'task_binding_matches_request_task',
      'scope_not_explicit_mismatch',
      'negative_retrieval_below_suppression_value',
      'at_least_one_relevance_channel',
    ]),
    relevanceChannels: Object.freeze([
      'lexical_content_term',
      'task',
      'scope_label',
    ]),
    ordering: Object.freeze([
      'final_score_descending',
      'sourceId_ascending_code_unit',
      'candidateId_ascending_code_unit',
    ]),
    scoreDecimals: SCORE_DECIMALS,
    budget: Object.freeze({
      maxSelectedItems: MAX_SELECTED_ITEMS,
      maxContextChars: MAX_SELECTED_CONTEXT_CHARS,
      maxItemChars: MAX_SINGLE_CONTEXT_ITEM_CHARS,
      policy: 'rank_order_prefix',
      itemTruncation: 'code_point_prefix',
    }),
    limits: Object.freeze({
      maxSources: MAX_SOURCES,
      maxCandidatesPerSource: MAX_CANDIDATES_PER_SOURCE,
      maxTotalCandidates: MAX_TOTAL_CANDIDATES,
      maxRequestChars: MAX_REQUEST_CHARS,
      maxCandidateTextChars: MAX_CANDIDATE_TEXT_CHARS,
      maxLabelChars: MAX_LABEL_CHARS,
      maxMetadataChars: MAX_METADATA_CHARS,
      maxLocalIdChars: MAX_LOCAL_ID_CHARS,
    }),
    sourceFailurePolicy: 'fail_closed_whole_assembly',
    foreignOwnerPolicy: 'exclude_before_statistics_and_count',
    characterUnit: 'unicode_code_point',
  });

// Import-time guard: a weight edit that breaks the 1.00 total fails loudly.
const weightTotal = RANKING_FACTORS.reduce(
  (sum, factor) => sum + RANKING_WEIGHTS_BASIS_POINTS[factor],
  0,
);
if (weightTotal !== WEIGHT_BASIS_POINTS_TOTAL) {
  throw new Error('Context Broker v1 ranking weights must total 1.00');
}
