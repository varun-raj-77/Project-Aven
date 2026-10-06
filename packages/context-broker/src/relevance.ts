import { compareCodeUnits, quantize } from './util.ts';

/**
 * Lexical relevance v1 (`aven-008-lexical-coverage-v1`), owned by AVEN-008.
 *
 * Deliberately NOT the AVEN-007 baseline's BM25 and not imported from it: the
 * governed architecture does not depend on an experiment baseline. The metric
 * is unique-query-term coverage: the share of the request's unique terms that
 * also occur in the candidate's included text. It is deterministic, in [0, 1],
 * makes no model or network call and uses no randomness. It is not semantic
 * relevance: paraphrases and synonyms do not match.
 */

/**
 * Tokenizer v1 stoplist (`STOPWORDS_V1`). It removes ONLY these English words:
 * articles, personal/possessive/reflexive pronouns, demonstratives, forms of
 * "be", "have" and "do", common prepositions and conjunctions, a few question
 * words, "here", "there", "please", "also", "very", and the fragments left
 * by splitting contractions on apostrophes. Every other word is kept.
 */
export const STOPWORDS_V1: readonly string[] = Object.freeze(
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
    'been',
    'being',
    'but',
    'by',
    'd',
    'did',
    'do',
    'does',
    'doing',
    'for',
    'from',
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
    'me',
    'mine',
    'my',
    'myself',
    'of',
    'on',
    'onto',
    'or',
    'our',
    'ours',
    'ourselves',
    'please',
    're',
    's',
    'she',
    'so',
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
    'to',
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
    'whose',
    'why',
    'with',
    'you',
    'your',
    'yours',
    'yourself',
    'yourselves',
  ].sort(compareCodeUnits),
);

/**
 * Qualifier terms (`QUALIFIER_TERMS_V1`): negation, restriction/exclusion,
 * temporal and ordering, conditional, quantity, bounds, modality and phrasal
 * particles. They are NEVER removed (the AVEN-007 v1 stoplist mistake): they
 * are query terms, count toward coverage and are reported as matches. They are
 * not plural-folded ("always" stays "always"). Because they are so common, a
 * candidate whose ONLY matching terms are qualifiers does not satisfy the
 * lexical relevance channel on its own (see `broker.ts`).
 */
export const QUALIFIER_TERMS_V1: readonly string[] = Object.freeze(
  [
    'above',
    'after',
    'again',
    'all',
    'already',
    'always',
    'any',
    'before',
    'below',
    'beyond',
    'both',
    'can',
    'could',
    'down',
    'during',
    'each',
    'either',
    'else',
    'every',
    'except',
    'few',
    'first',
    'if',
    'instead',
    'just',
    'last',
    'later',
    'least',
    'less',
    'many',
    'may',
    'might',
    'more',
    'most',
    'much',
    'must',
    'neither',
    'never',
    'next',
    'no',
    'nobody',
    'none',
    'nor',
    'not',
    'nothing',
    'now',
    'nowhere',
    'off',
    'once',
    'only',
    'other',
    'out',
    'over',
    'previous',
    'rather',
    'shall',
    'should',
    'since',
    'some',
    'soon',
    'still',
    'than',
    'then',
    'till',
    'too',
    'under',
    'unless',
    'until',
    'up',
    'when',
    'whenever',
    'while',
    'will',
    'within',
    'without',
    'would',
    'yet',
  ].sort(compareCodeUnits),
);

const STOPWORDS = new Set(STOPWORDS_V1);
const QUALIFIERS = new Set(QUALIFIER_TERMS_V1);

/** True when `term` is a qualifier term (kept, but not a content term). */
export function isQualifierTerm(term: string): boolean {
  return QUALIFIERS.has(term);
}

/**
 * Harman (1991) "S" plural fold, applied only to ASCII-letter tokens longer
 * than three characters that are not qualifier terms. Known artifacts are
 * accepted and documented: "boxes" -> "boxe", "series" -> "sery",
 * "news" -> "new".
 */
export function pluralFold(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/.test(token)) return token;
  if (token.endsWith('ies') && !/[ae]ies$/.test(token))
    return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && !/[aeo]es$/.test(token))
    return token.slice(0, -1);
  if (token.endsWith('s') && !/[us]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Negative contractions keep their lexical evidence: "don't send" yields the
 * same "not" term as "do not send". Only the "n't" family and "cannot" are
 * rewritten; other contractions split on the apostrophe.
 */
function expandNegativeContractions(text: string): string {
  return text
    .replace(/\bcannot\b/g, 'can not')
    .replace(/\bwon['’]t\b/g, 'will not')
    .replace(/\bshan['’]t\b/g, 'shall not')
    .replace(/\bcan['’]t\b/g, 'can not')
    .replace(/n['’]t\b/g, ' not');
}

/**
 * Tokenizer v1 (`aven-008-tokenizer-v1`): Unicode NFKC normalization,
 * locale-independent lowercasing, negative-contraction expansion, split on
 * anything that is not a letter, combining mark or number, removal of
 * `STOPWORDS_V1`, then the S plural fold for non-qualifier tokens.
 */
export function tokenize(text: string): string[] {
  return expandNegativeContractions(text.normalize('NFKC').toLowerCase())
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map((t) => (QUALIFIERS.has(t) ? t : pluralFold(t)));
}

export interface QueryTerms {
  /** Unique terms of the request, sorted by code unit. */
  readonly terms: readonly string[];
  readonly contentTermCount: number;
  readonly qualifierTermCount: number;
}

/** The request's unique terms; repeating a word does not change ranking. */
export function extractQueryTerms(request: string): QueryTerms {
  const terms = [...new Set(tokenize(request))].sort(compareCodeUnits);
  const qualifierTermCount = terms.filter(isQualifierTerm).length;
  return Object.freeze({
    terms: Object.freeze(terms),
    contentTermCount: terms.length - qualifierTermCount,
    qualifierTermCount,
  });
}

export interface LexicalRelevance {
  /** Matched unique query terms / unique query terms, in [0, 1]; 0 if no terms. */
  readonly score: number;
  /** Matched query terms, sorted by code unit. */
  readonly matchedTerms: readonly string[];
  /** How many matched terms are content (non-qualifier) terms. */
  readonly matchedContentTermCount: number;
}

export function lexicalRelevance(
  query: QueryTerms,
  text: string,
): LexicalRelevance {
  if (query.terms.length === 0)
    return Object.freeze({
      score: 0,
      matchedTerms: Object.freeze([]),
      matchedContentTermCount: 0,
    });
  const present = new Set(tokenize(text));
  const matchedTerms = query.terms.filter((t) => present.has(t));
  return Object.freeze({
    score: quantize(matchedTerms.length / query.terms.length),
    matchedTerms: Object.freeze(matchedTerms),
    matchedContentTermCount: matchedTerms.filter((t) => !isQualifierTerm(t))
      .length,
  });
}
