/**
 * AVEN-007 baseline configuration, version 2.
 *
 * Version 1 (`aven-007-baseline-config-v1`, tokenizer v1) was independently
 * reviewed and superseded before any freeze or real-model run because its
 * stoplist discarded negation, restriction, scope, ordering and temporal
 * words (review finding H1). Version 2 changes only the tokenizer; BM25,
 * budgets, ordering and precedence are unchanged.
 *
 * These values are experimental configuration, not tuning knobs. They are
 * copied into `evals/aven-007/manifest.json` and a test fails if the two
 * drift. Changing any of them requires a new configuration version and a
 * documented experiment change, never silent tuning of B after C's results
 * are visible.
 */
export const BASELINE_CONFIG_VERSION = 'aven-007-baseline-config-v2';

export const BASELINE_CONDITIONS = ['fresh', 'naive_personalized'] as const;
export type BaselineCondition = (typeof BASELINE_CONDITIONS)[number];

/** Profile limits. Characters are Unicode code points of entry text. */
export const MAX_PROFILE_ENTRIES = 64;
export const MAX_PROFILE_ENTRY_CHARS = 1000;
export const MAX_PROFILE_CONTEXT_CHARS = 4000;

/** Naive history search (BM25) parameters and context budgets. */
export const HISTORY_SEARCH_ALGORITHM = 'bm25';
export const HISTORY_SEARCH_VERSION = 'aven-007-naive-history-search-v2';
export const TOKENIZER_VERSION = 'aven-007-tokenizer-v2';
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const HISTORY_TOP_K = 8;
export const MAX_HISTORY_CONTEXT_CHARS = 6000;
export const MAX_SINGLE_HISTORY_ITEM_CHARS = 1200;

/** Input-size guards (validation limits, not context budgets). */
export const MAX_HISTORY_RECORDS = 20000;
export const MAX_HISTORY_RECORD_CHARS = 20000;
export const MAX_REQUEST_CHARS = 8000;

export interface BaselineConfiguration {
  readonly version: string;
  readonly conditions: readonly BaselineCondition[];
  readonly profile: {
    readonly format: 'ordered_free_text_entries';
    readonly maxEntries: number;
    readonly maxEntryChars: number;
    readonly maxContextChars: number;
    readonly truncation: 'owner_order_prefix_at_entry_boundary';
  };
  readonly history: {
    readonly algorithm: string;
    readonly version: string;
    readonly tokenizer: string;
    readonly tokenizerSteps: readonly string[];
    readonly k1: number;
    readonly b: number;
    readonly idf: string;
    readonly queryTerms: 'unique_tokens_of_current_request';
    readonly topK: number;
    readonly minimumScoreExclusive: number;
    readonly maxContextChars: number;
    readonly maxItemChars: number;
    readonly ordering: readonly string[];
    readonly budgetPolicy: 'rank_order_prefix';
  };
  readonly precedence: readonly string[];
  readonly characterUnit: 'unicode_code_point';
}

export const BASELINE_CONFIG_V2: BaselineConfiguration = Object.freeze({
  version: BASELINE_CONFIG_VERSION,
  conditions: Object.freeze([...BASELINE_CONDITIONS]),
  profile: Object.freeze({
    format: 'ordered_free_text_entries',
    maxEntries: MAX_PROFILE_ENTRIES,
    maxEntryChars: MAX_PROFILE_ENTRY_CHARS,
    maxContextChars: MAX_PROFILE_CONTEXT_CHARS,
    truncation: 'owner_order_prefix_at_entry_boundary',
  }),
  history: Object.freeze({
    algorithm: HISTORY_SEARCH_ALGORITHM,
    version: HISTORY_SEARCH_VERSION,
    tokenizer: TOKENIZER_VERSION,
    tokenizerSteps: Object.freeze([
      'unicode_nfkc',
      'lowercase_locale_independent',
      'expand_negative_contractions_to_not',
      'split_on_non_letter_mark_number',
      'remove_STOPWORDS_V2',
      'harman_s_stemmer',
    ]),
    k1: BM25_K1,
    b: BM25_B,
    idf: 'ln(1 + (N - df + 0.5) / (df + 0.5))',
    queryTerms: 'unique_tokens_of_current_request',
    topK: HISTORY_TOP_K,
    minimumScoreExclusive: 0,
    maxContextChars: MAX_HISTORY_CONTEXT_CHARS,
    maxItemChars: MAX_SINGLE_HISTORY_ITEM_CHARS,
    ordering: Object.freeze([
      'score_descending',
      'occurredAt_descending',
      'eventId_ascending_code_unit',
    ]),
    budgetPolicy: 'rank_order_prefix',
  }),
  precedence: Object.freeze([
    'current_request',
    'editable_profile',
    'retrieved_history',
  ]),
  characterUnit: 'unicode_code_point',
});
