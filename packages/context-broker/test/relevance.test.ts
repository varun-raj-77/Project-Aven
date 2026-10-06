import { describe, expect, it } from 'vitest';
import {
  extractQueryTerms,
  isQualifierTerm,
  lexicalRelevance,
  pluralFold,
  QUALIFIER_TERMS_V1,
  STOPWORDS_V1,
  tokenize,
} from '../src/index.ts';

// SYNTHETIC text only. Nothing here is drawn from or tuned on AVEN-007 cases.

const REQUIRED_KEPT = [
  'no',
  'not',
  'never',
  'only',
  'before',
  'after',
  'until',
  'without',
  'except',
  'unless',
];

describe('AVEN-008 lexical relevance v1 (deterministic coverage, not semantic)', () => {
  it('normalizes with NFKC, lowercases, splits on non-letters and removes only stopwords', () => {
    expect(tokenize('The QUICK, brown fox!')).toEqual([
      'quick',
      'brown',
      'fox',
    ]);
    // NFKC: fullwidth letters and ligatures fold; decomposed accents compose.
    expect(tokenize('ＣＡＦＥ ﬁle')).toEqual(['cafe', 'file']);
    expect(tokenize('Café')).toEqual(tokenize('Café'));
    expect(tokenize('')).toEqual([]);
    expect(tokenize('the of and to')).toEqual([]);
  });

  it('retains negation and meaningful scope/temporal words (E)', () => {
    const tokens = tokenize(
      'No. Not never only before after until without except unless.',
    );
    for (const word of REQUIRED_KEPT) expect(tokens, word).toContain(word);
    for (const word of REQUIRED_KEPT) {
      expect(STOPWORDS_V1).not.toContain(word);
      expect(isQualifierTerm(word), word).toBe(true);
    }
  });

  it('expands negative contractions so "don\'t" keeps the same "not" evidence', () => {
    expect(tokenize("Don't send it")).toEqual(['not', 'send']);
    expect(tokenize('Do not send it')).toEqual(['not', 'send']);
    expect(tokenize('I can’t, won’t, shan’t; cannot')).toEqual([
      'can',
      'not',
      'will',
      'not',
      'shall',
      'not',
      'can',
      'not',
    ]);
  });

  it('keeps negated and affirmative requests lexically distinct', () => {
    const query = extractQueryTerms('Do not send the draft');
    expect(query.terms).toEqual(['draft', 'not', 'send']);
    expect(lexicalRelevance(query, 'Do not send the draft').score).toBe(1);
    expect(lexicalRelevance(query, 'Send the draft').score).toBe(0.666666667);
  });

  it('plural-folds content terms only (Harman S rule) and never folds qualifiers', () => {
    expect(pluralFold('emails')).toBe('email');
    expect(pluralFold('stories')).toBe('story');
    expect(pluralFold('boxes')).toBe('boxe');
    expect(pluralFold('glass')).toBe('glass');
    expect(pluralFold('status')).toBe('status');
    expect(pluralFold('bus')).toBe('bus');
    expect(pluralFold('café')).toBe('café');
    expect(tokenize('always')).toEqual(['always']);
    expect(tokenize('emails Emails')).toEqual(['email', 'email']);
  });

  it('keeps the stoplist and the qualifier list disjoint, sorted and frozen', () => {
    expect(STOPWORDS_V1.filter((w) => QUALIFIER_TERMS_V1.includes(w))).toEqual(
      [],
    );
    expect([...STOPWORDS_V1].sort()).toEqual(STOPWORDS_V1);
    expect([...QUALIFIER_TERMS_V1].sort()).toEqual(QUALIFIER_TERMS_V1);
    expect(Object.isFrozen(STOPWORDS_V1)).toBe(true);
    expect(Object.isFrozen(QUALIFIER_TERMS_V1)).toBe(true);
  });

  it('scores unique-query-term coverage in [0, 1]; repetition changes nothing', () => {
    const query = extractQueryTerms(
      'Summarize the quarterly budget report report report',
    );
    expect(query.terms).toEqual(['budget', 'quarterly', 'report', 'summarize']);
    expect(query.contentTermCount).toBe(4);
    expect(query.qualifierTermCount).toBe(0);
    const half = lexicalRelevance(query, 'Quarterly budget, budget, budget');
    expect(half).toEqual({
      score: 0.5,
      matchedTerms: ['budget', 'quarterly'],
      matchedContentTermCount: 2,
    });
    expect(lexicalRelevance(query, 'Unrelated gardening notes').score).toBe(0);
    expect(
      lexicalRelevance(query, 'summarize quarterly budget report').score,
    ).toBe(1);
  });

  it('reports qualifier-only matches separately from content matches', () => {
    const query = extractQueryTerms('Do not include the appendix');
    const onlyNot = lexicalRelevance(query, 'I do not eat mushrooms');
    expect(onlyNot.matchedTerms).toEqual(['not']);
    expect(onlyNot.matchedContentTermCount).toBe(0);
    expect(onlyNot.score).toBe(0.333333333);
  });

  it('returns zero relevance for a stopword-only or empty query', () => {
    const query = extractQueryTerms('What is this?');
    expect(query.terms).toEqual([]);
    expect(lexicalRelevance(query, 'what is this').score).toBe(0);
  });

  it('handles Unicode text deterministically (U)', () => {
    const query = extractQueryTerms('Résumé für Ελλάδα 東京 naïve');
    expect(query.terms).toEqual(['für', 'naïve', 'résumé', 'ελλάδα', '東京']);
    expect(
      lexicalRelevance(query, 'RESUME? no: Résumé in 東京 🎉').matchedTerms,
    ).toEqual(['résumé', '東京']);
    // No CJK word segmentation: a run of ideographs is one token.
    expect(tokenize('東京大学')).toEqual(['東京大学']);
  });

  it('is pure: identical input gives identical output on every call', () => {
    const text = 'Never schedule meetings before nine except on Fridays';
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(
        lexicalRelevance(extractQueryTerms(text), `${text} again`),
      ),
    );
    expect(new Set(runs).size).toBe(1);
  });
});
