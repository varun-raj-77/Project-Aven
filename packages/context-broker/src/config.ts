import { deepFreeze, SCORE_DECIMALS } from './util.ts';

/**
 * AVEN-008 Context Broker configuration, version 2.
 *
 * Version 1 (`aven-008-context-broker-config-v1`, commit 630369a) was the
 * reviewed pre-freeze candidate. It was never frozen, and it was superseded
 * after independent review, before AVEN-009 or condition C existed. No
 * real-model result informed the change. Git history preserves v1 unchanged.
 *
 * v2 changes ONLY review-driven policy: a source-collection deadline, a raw
 * resource bound separate from owner-context quotas, conservative bounded
 * scope (`aven-008-scope-v2`), identity deduplication, a
 * skip-non-fitting budget traversal, direct owner-provenance consistency and a
 * trace without cross-owner counts or request-derived strings
 * (`aven-008-trace-v2`). The ranking weights, factor tables, relevance
 * algorithm, freshness half-life, negative-signal policy and budgets are
 * unchanged from v1 and were not retuned.
 *
 * Every value was PRE-SPECIFIED without looking at AVEN-007 development or
 * held-out cases and without any model result. The whole object is deeply
 * frozen at runtime and pinned by a test.
 */
export const CONTEXT_BROKER_VERSION = 'aven-008-context-broker-v2';
export const CONTEXT_BROKER_CONFIG_VERSION =
  'aven-008-context-broker-config-v2';
export const RELEVANCE_VERSION = 'aven-008-lexical-coverage-v1';
export const TOKENIZER_VERSION = 'aven-008-tokenizer-v1';
export const SCOPE_VERSION = 'aven-008-scope-v2';
export const TRACE_VERSION = 'aven-008-trace-v2';

/** The seven ranking factors, in their fixed reporting order. */
export const RANKING_FACTORS = Object.freeze([
  'relevance',
  'scope',
  'provenance',
  'confidence',
  'freshness',
  'salience',
  'trust',
] as const);
export type RankingFactor = (typeof RANKING_FACTORS)[number];

/**
 * Pre-specified factor weights in basis points (10000 = 1.00), unchanged from
 * v1: relevance 0.40, scope 0.20, provenance 0.10, confidence 0.10,
 * freshness 0.07, salience 0.07, trust 0.06. The negative-retrieval penalty is
 * applied separately, after the weighted composite.
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
 * Scope factor by scope status (policy v2, see `scope.ts`). `mismatch` and
 * `unresolved` are eligibility decisions, never low scores, so they have no
 * factor. v1's `partial_label_match` and `indeterminate` no longer exist: an
 * unresolved declared restriction is never evidence of applicability.
 */
export const SCOPE_FACTORS = Object.freeze({
  task_match: 1,
  label_match: 1,
  global: 0.5,
  unknown: 0.25,
  uncertain: 0.25,
});

/** Provenance factor by frozen AVEN-002 provenance kind (unchanged from v1). */
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
 * Trust factor (unchanged from v1): a provenance trust label (`untrusted`,
 * `potentially_untrusted`) caps trust whatever the lifecycle; otherwise the
 * reference kind and owner-state lifecycle decide. Lifecycle labels are claims
 * of the trusted adapter; the broker never verifies or upgrades them.
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

/** Freshness: 0.5 ^ (age / half-life) against the request's referenceTime. */
export const FRESHNESS_HALF_LIFE_DAYS = 90;
export const MILLISECONDS_PER_DAY = 86_400_000;

/** `final = composite * (1 - negativeRetrieval)`; exactly 1 suppresses. */
export const NEGATIVE_SIGNAL_SUPPRESSION_VALUE = 1;

export { SCORE_DECIMALS };

/** Context budgets. Characters are Unicode code points of item text. */
export const MAX_SELECTED_CONTEXT_CHARS = 10000;
export const MAX_SINGLE_CONTEXT_ITEM_CHARS = 1600;
export const MAX_SELECTED_ITEMS = 10;

/**
 * Source-collection deadline. One deadline per `assemble` call covers every
 * source; a source still unsettled when it expires fails the whole assembly
 * with `source_timeout`. The timer only bounds waiting: it never feeds
 * ranking, freshness or any output value.
 */
export const SOURCE_COLLECTION_DEADLINE_MS = 5000;

/**
 * RAW TRANSPORT / RESOURCE SAFETY bounds: the number of raw items a source may
 * return before ANY inspection, whoever they belong to. They protect the
 * process from pathological adapters. They are NOT owner-context quotas and
 * their failure carries no count or owner information.
 */
export const MAX_RAW_ITEMS_PER_SOURCE = 10000;
export const MAX_RAW_ITEMS_TOTAL = 40000;

/**
 * OWNER-CONTEXT quotas: counted only over items NOT recognizable as another
 * owner's (recognizable foreign items are dropped first and never count).
 */
export const MAX_SOURCES = 16;
export const MAX_CANDIDATES_PER_SOURCE = 500;
export const MAX_TOTAL_CANDIDATES = 2000;

/** Input-size guards (validation limits, not context budgets). */
export const MAX_REQUEST_CHARS = 8000;
export const MAX_CANDIDATE_TEXT_CHARS = 20000;
export const MAX_LABEL_CHARS = 256;
/** Every other string inside a candidate's reference, provenance or scope. */
export const MAX_METADATA_CHARS = 1000;
export const MAX_LOCAL_ID_CHARS = 128;

/** Injected source kinds and the candidate reference kinds each may return. */
export const CONTEXT_SOURCE_KINDS = Object.freeze([
  'owner_state',
  'episode_history',
  'procedure',
  'active_task',
  'permitted_external',
] as const);
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export const SOURCE_KIND_REFERENCE_KINDS: Readonly<
  Record<ContextSourceKind, readonly string[]>
> = deepFreeze({
  owner_state: ['owner_state'],
  episode_history: ['evidence', 'owner_state'],
  procedure: ['owner_state'],
  active_task: ['active_task_state', 'current_instruction'],
  permitted_external: ['evidence'],
});
export const EXTERNAL_SOURCE_PROVENANCE_KINDS: readonly string[] =
  Object.freeze(['external_content', 'tool_result']);

export const CONTEXT_BROKER_CONFIG_V2 = deepFreeze({
  brokerVersion: CONTEXT_BROKER_VERSION,
  configVersion: CONTEXT_BROKER_CONFIG_VERSION,
  supersedes: {
    configVersion: 'aven-008-context-broker-config-v1',
    status: 'reviewed_pre_freeze_candidate_never_frozen',
    reviewedCommit: '630369a45e05f7720db5c7a4ce10d9276465babd',
    supersededBefore: 'aven-009_and_condition_c_existed',
    realModelResultInformedChange: false,
  },
  relevance: {
    version: RELEVANCE_VERSION,
    tokenizer: TOKENIZER_VERSION,
    tokenizerSteps: [
      'unicode_nfkc',
      'lowercase_locale_independent',
      'expand_negative_contractions_to_not',
      'split_on_non_letter_mark_number',
      'remove_STOPWORDS_V1',
      'harman_s_plural_fold',
    ],
    metric: 'unique_query_term_coverage',
    scoredText: 'included_item_text',
  },
  weightsBasisPoints: RANKING_WEIGHTS_BASIS_POINTS,
  scope: {
    version: SCOPE_VERSION,
    boundedRule: 'every_declared_restriction_satisfied',
    unresolvedRestriction: 'ineligible',
    taskBindingClearsUnresolved: false,
    uncertainRule: 'every_possibility_satisfied_else_unresolved_or_mismatch',
    sessionWideScope: 'not_representable_deferred',
    factors: SCOPE_FACTORS,
  },
  provenanceFactors: PROVENANCE_FACTORS,
  trustFactors: TRUST_FACTORS,
  provenanceConsistency: [
    'owner_origin_provenance_owner_equals_candidate_owner',
    'direct_owner_origin_evidence_event_equals_provenance_source_event',
  ],
  freshness: {
    halfLifeDays: FRESHNESS_HALF_LIFE_DAYS,
    anchor: 'lastValidatedAt_else_recordedAt',
    clock: 'request_reference_time',
  },
  negativeRetrieval: {
    penalty: 'multiplicative_one_minus_signal',
    suppressionValue: NEGATIVE_SIGNAL_SUPPRESSION_VALUE,
  },
  deduplication: {
    keys: [
      'candidateId',
      'evidence_reference_evidenceId',
      'learned_reference_learnedItemId_and_version',
    ],
    consistentDuplicates: 'keep_first_by_sourceId_then_candidateId',
    inconsistentDuplicates: 'fail_closed_conflicting_duplicate',
  },
  eligibility: [
    'recognizable_foreign_owner_dropped_before_validation_and_quotas',
    'identity_duplicate_excluded',
    'lifecycle_not_superseded',
    'lifecycle_not_revoked',
    'timestamps_not_after_reference_time',
    'task_binding_matches_request_task',
    'scope_not_explicit_mismatch',
    'scope_not_unresolved',
    'negative_retrieval_below_suppression_value',
    'at_least_one_relevance_channel',
  ],
  relevanceChannels: ['lexical_content_term', 'task', 'scope_label'],
  ordering: [
    'final_score_descending',
    'sourceId_ascending_code_unit',
    'candidateId_ascending_code_unit',
  ],
  scoreDecimals: SCORE_DECIMALS,
  budget: {
    maxSelectedItems: MAX_SELECTED_ITEMS,
    maxContextChars: MAX_SELECTED_CONTEXT_CHARS,
    maxItemChars: MAX_SINGLE_CONTEXT_ITEM_CHARS,
    policy: 'rank_order_skip_non_fitting_stop_at_item_limit',
    itemTruncation: 'code_point_prefix',
  },
  collection: {
    deadlineMilliseconds: SOURCE_COLLECTION_DEADLINE_MS,
    deadlineScope: 'one_deadline_per_assemble_call_all_sources',
    rawResourceLimits: {
      maxRawItemsPerSource: MAX_RAW_ITEMS_PER_SOURCE,
      maxRawItemsTotal: MAX_RAW_ITEMS_TOTAL,
    },
    ownerContextQuotas: {
      maxSources: MAX_SOURCES,
      maxCandidatesPerSource: MAX_CANDIDATES_PER_SOURCE,
      maxTotalCandidates: MAX_TOTAL_CANDIDATES,
    },
    sourceFailurePolicy: 'fail_closed_whole_assembly',
    foreignOwnerPolicy: 'drop_recognizable_foreign_first_no_trace',
    errorPolicy: 'fixed_code_and_message_no_cause',
  },
  limits: {
    maxRequestChars: MAX_REQUEST_CHARS,
    maxCandidateTextChars: MAX_CANDIDATE_TEXT_CHARS,
    maxLabelChars: MAX_LABEL_CHARS,
    maxMetadataChars: MAX_METADATA_CHARS,
    maxLocalIdChars: MAX_LOCAL_ID_CHARS,
  },
  trace: {
    version: TRACE_VERSION,
    content: 'owner_local_ids_codes_counts_numbers_only',
    excludes: [
      'item_text',
      'request_derived_terms',
      'foreign_owner_ids_counts_or_totals',
    ],
  },
  characterUnit: 'unicode_code_point',
});
export type ContextBrokerConfiguration = typeof CONTEXT_BROKER_CONFIG_V2;

// Import-time guard: a weight edit that breaks the 1.00 total fails loudly.
const weightTotal = RANKING_FACTORS.reduce(
  (sum, factor) => sum + RANKING_WEIGHTS_BASIS_POINTS[factor],
  0,
);
if (weightTotal !== WEIGHT_BASIS_POINTS_TOTAL) {
  throw new Error('Context Broker ranking weights must total 1.00');
}
