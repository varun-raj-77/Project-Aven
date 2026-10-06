import {
  BM25_B,
  BM25_K1,
  HISTORY_TOP_K,
  MAX_HISTORY_CONTEXT_CHARS,
  MAX_REQUEST_CHARS,
  MAX_SINGLE_HISTORY_ITEM_CHARS,
} from './config.ts';
import { BaselineError } from './errors.ts';
import { codePointLength, HistorySchema, type HistoryRecord } from './types.ts';
import { OwnerIdSchema } from '@aven/contracts';

/**
 * NaiveHistorySearch — the B-condition lexical retriever (AVEN-007).
 *
 * This is deliberately NOT the AVEN-008 Context Broker. It uses only:
 *   - lexical relevance of the CURRENT REQUEST to each record (BM25),
 *   - owner filtering,
 *   - fixed top-K and character budgets,
 *   - deterministic tie-breaking (time, then event ID).
 * It never uses learned relevance, provenance quality, trust, confidence,
 * semantic scope, supersession, counterexamples, salience, recency boosts,
 * embeddings, rerankers or negative retrieval signals. Recency is a
 * tie-breaker only. Records are read, never modified, tagged or persisted.
 */

/**
 * Tokenizer v2 stoplist (`STOPWORDS_V2`, 107 entries).
 *
 * It removes only these listed English words: articles, personal and
 * possessive pronouns, auxiliary and modal verbs, common prepositions and
 * conjunctions, question words, a few intensifiers ("very", "too", "so"),
 * "please", and the fragments left by splitting contractions on apostrophes
 * ("s", "ll", "re", "ve", "d", "m", "t"). Every word not on the list is kept.
 *
 * Version 1 also removed words that can invert or restrict an instruction.
 * External review (H1) showed that this collapsed contrasts such as "do send"
 * versus "do not send" and "before launch" versus "after launch". Version 2
 * therefore KEEPS: negation (no, nor, not); restriction and exclusion (only,
 * just, other, than, off); quantifier scope (all, any, both, each, few, more,
 * most, some); conditionals (if, when, while); ordering and time (after,
 * again, before, during, now, once, then, until); and comparative bounds
 * (above, below, between, over, under). Keeping these preserves lexical
 * evidence only. Bag-of-words BM25 still does not understand logical
 * negation, scope or order. Modal verbs (must, should, may, can, will...)
 * remain stopwords; that is a documented limitation.
 */
export const STOPWORDS_V2: readonly string[] = Object.freeze(
  [
    'a',
    'about',
    'also',
    'am',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'because',
    'been',
    'being',
    'but',
    'by',
    'can',
    'could',
    'd',
    'did',
    'do',
    'does',
    'doing',
    'down',
    'for',
    'from',
    'further',
    'had',
    'has',
    'have',
    'having',
    'he',
    'her',
    'here',
    'hers',
    'herself',
    'him',
    'himself',
    'his',
    'how',
    'i',
    'in',
    'into',
    'is',
    'it',
    'its',
    'itself',
    'll',
    'm',
    'may',
    'me',
    'might',
    'must',
    'my',
    'myself',
    'of',
    'on',
    'or',
    'our',
    'ours',
    'ourselves',
    'out',
    'own',
    'please',
    're',
    's',
    'same',
    'shall',
    'she',
    'should',
    'so',
    'such',
    't',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'themselves',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'to',
    'too',
    'up',
    'us',
    've',
    'very',
    'was',
    'we',
    'were',
    'what',
    'where',
    'which',
    'who',
    'whom',
    'why',
    'will',
    'with',
    'would',
    'you',
    'your',
    'yours',
    'yourself',
    'yourselves',
  ].sort(),
);
const STOPWORDS = new Set(STOPWORDS_V2);

/**
 * Harman (1991) "S" stemmer: a minimal, published plural-folding rule so that
 * "emails" matches "email". Applied only to ASCII-letter tokens longer than
 * three characters, after stopword removal. No other stemming. Known
 * artifacts of the rule (kept, documented, tested): "boxes" -> "boxe",
 * "ties" -> "ty", "series" -> "sery", "news" -> "new", "indexes" -> "indexe".
 */
export function sStem(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/.test(token)) return token;
  if (token.endsWith('ies') && !/[ae]ies$/.test(token))
    return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && !/[aeo]es$/.test(token))
    return token.slice(0, -1);
  if (token.endsWith('s') && !/[us]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Negative contractions are expanded so that "don't send" keeps the same
 * lexical evidence ("not") as "do not send". Only the "n't" family and
 * "cannot" are rewritten; other contractions split on the apostrophe.
 */
function expandNegativeContractions(text: string): string {
  return text
    .replace(/\bcannot\b/g, 'can not')
    .replace(/\bwon['\u2019]t\b/g, 'will not')
    .replace(/\bshan['\u2019]t\b/g, 'shall not')
    .replace(/\bcan['\u2019]t\b/g, 'can not')
    .replace(/n['\u2019]t\b/g, ' not');
}

/**
 * Deterministic tokenizer v2: Unicode NFKC normalization, locale-independent
 * lowercasing, negative-contraction expansion, split on anything that is not
 * a letter, combining mark or number, remove `STOPWORDS_V2`, then apply the
 * S stemmer.
 */
export function tokenize(text: string): string[] {
  return expandNegativeContractions(text.normalize('NFKC').toLowerCase())
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(sStem);
}

export interface ScoredHistoryRecord {
  readonly record: HistoryRecord;
  readonly score: number;
}

const epoch = (timestamp: string): number => Date.parse(timestamp);

/** Code-unit comparison: locale-independent and stable across platforms. */
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * BM25 over the owner's own records, with the current request as the query.
 * Records of any other owner are removed before corpus statistics are
 * computed, so they influence neither membership nor scores. Query terms are
 * the request's unique tokens (repeating a word does not change ranking).
 * Only strictly positive scores are returned; unused slots are never filled
 * with unrelated zero-score history. Ordering: score descending, then
 * `occurredAt` descending, then `eventId` ascending.
 */
export function searchHistory(
  ownerId: string,
  query: string,
  history: readonly HistoryRecord[],
): ScoredHistoryRecord[] {
  const k1 = BM25_K1;
  const b = BM25_B;
  const topK = HISTORY_TOP_K;
  // Fail closed on malformed input (e.g. an unparseable timestamp would make
  // the tie-break order undefined).
  const parsed = HistorySchema.safeParse(history);
  if (
    !parsed.success ||
    !OwnerIdSchema.safeParse(ownerId).success ||
    typeof query !== 'string' ||
    codePointLength(query) > MAX_REQUEST_CHARS
  )
    throw new BaselineError(
      'invalid_input',
      parsed.success ? undefined : parsed.error,
    );
  const queryTerms = [...new Set(tokenize(query))].sort(compareIds);
  const owned = parsed.data.filter((r) => r.ownerId === ownerId);
  if (queryTerms.length === 0 || owned.length === 0) return [];

  const documents = owned.map((record) => {
    const tokens = tokenize(record.text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { record, length: tokens.length, tf };
  });
  const n = documents.length;
  const averageLength = documents.reduce((sum, d) => sum + d.length, 0) / n;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = documents.filter((d) => d.tf.has(term)).length;
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const scored: ScoredHistoryRecord[] = [];
  for (const document of documents) {
    if (document.length === 0) continue;
    let score = 0;
    for (const term of queryTerms) {
      const frequency = document.tf.get(term);
      if (frequency === undefined) continue;
      const norm = k1 * (1 - b + (b * document.length) / averageLength);
      score +=
        (idf.get(term) ?? 0) * ((frequency * (k1 + 1)) / (frequency + norm));
    }
    if (score > 0) scored.push({ record: document.record, score });
  }
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      epoch(y.record.occurredAt) - epoch(x.record.occurredAt) ||
      compareIds(x.record.eventId, y.record.eventId),
  );
  return scored.slice(0, topK);
}

/** One retrieved record as supplied to the model: quoted data only. */
export interface HistoryContextItem {
  readonly eventId: string;
  readonly role: 'owner' | 'assistant';
  readonly occurredAt: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface HistoryContextSelection {
  readonly items: readonly HistoryContextItem[];
  /** Scores of every ranked (top-K, positive) record, in rank order. */
  readonly scores: readonly {
    readonly eventId: string;
    readonly score: number;
  }[];
  /** Ranked records left out because the history budget was reached. */
  readonly omittedForBudgetEventIds: readonly string[];
  readonly usedChars: number;
}

function truncateCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/**
 * Applies the fixed history budgets to the ranked results. Each item's text
 * is cut to `MAX_SINGLE_HISTORY_ITEM_CHARS` code points (and marked
 * `truncated`). Items are then taken in rank order while the cumulative text
 * length stays within `MAX_HISTORY_CONTEXT_CHARS`; at the first item that
 * would exceed it, it and all lower-ranked items are omitted, so the included
 * set is always a rank-order prefix.
 */
export function selectHistoryContext(
  ownerId: string,
  request: string,
  history: readonly HistoryRecord[],
): HistoryContextSelection {
  const ranked = searchHistory(ownerId, request, history);
  const items: HistoryContextItem[] = [];
  const omitted: string[] = [];
  let usedChars = 0;
  for (const { record } of ranked) {
    const full = codePointLength(record.text);
    const truncated = full > MAX_SINGLE_HISTORY_ITEM_CHARS;
    const text = truncated
      ? truncateCodePoints(record.text, MAX_SINGLE_HISTORY_ITEM_CHARS)
      : record.text;
    const size = Math.min(full, MAX_SINGLE_HISTORY_ITEM_CHARS);
    if (omitted.length === 0 && usedChars + size <= MAX_HISTORY_CONTEXT_CHARS) {
      items.push(
        Object.freeze({
          eventId: record.eventId,
          role: record.role,
          occurredAt: record.occurredAt,
          text,
          truncated,
        }),
      );
      usedChars += size;
    } else {
      omitted.push(record.eventId);
    }
  }
  return Object.freeze({
    items: Object.freeze(items),
    scores: Object.freeze(
      ranked.map((r) =>
        Object.freeze({ eventId: r.record.eventId, score: r.score }),
      ),
    ),
    omittedForBudgetEventIds: Object.freeze(omitted),
    usedChars,
  });
}
