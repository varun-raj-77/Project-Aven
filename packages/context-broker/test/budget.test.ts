import { describe, expect, it } from 'vitest';
import {
  ContextBrokerError,
  MAX_SELECTED_CONTEXT_CHARS,
  MAX_SELECTED_ITEMS,
  MAX_SINGLE_CONTEXT_ITEM_CHARS,
} from '../src/index.ts';
import {
  assemble,
  codePoints,
  evidence,
  memorySource,
  request,
  selectedIds,
  traceOf,
} from './fixtures.ts';

// SYNTHETIC text only. Character counts are Unicode code points.

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const cp = (s: string) => Array.from(s).length;
const ranked = (i: number) => ({
  confidence: 1 - i / 100,
  salience: 0.5,
  negativeRetrieval: 0,
});

describe('AVEN-008 budgets and truncation (code-point semantics)', () => {
  it('uses the specified v1 budgets', () => {
    expect(MAX_SELECTED_CONTEXT_CHARS).toBe(10000);
    expect(MAX_SINGLE_CONTEXT_ITEM_CHARS).toBe(1600);
    expect(MAX_SELECTED_ITEMS).toBe(10);
  });

  it('truncates at exactly 1600 code points: 1599 / 1600 / 1601 (V)', async () => {
    // Astral emoji are two UTF-16 code units but one code point each.
    const text = (n: number) => `Budget ${codePoints(n - 7, '😀')}`;
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('n1599', text(1599)),
          evidence('n1600', text(1600)),
          evidence('n1601', text(1601)),
        ]),
      ],
      request('Budget review'),
    );
    const item = (id: string) =>
      result.bundle.items.find((i) => i.candidateId === id)!;
    expect(cp(text(1599))).toBe(1599);
    expect(cp(text(1601))).toBe(1601);
    expect(item('n1599')).toMatchObject({
      truncated: false,
      originalChars: 1599,
      includedChars: 1599,
    });
    expect(item('n1600')).toMatchObject({
      truncated: false,
      originalChars: 1600,
      includedChars: 1600,
    });
    expect(item('n1601')).toMatchObject({
      truncated: true,
      originalChars: 1601,
      includedChars: 1600,
    });
    expect(item('n1600').text).toBe(text(1600));
    expect(item('n1601').text).toBe(text(1600));
    for (const i of result.bundle.items) {
      expect(cp(i.text)).toBe(i.includedChars);
      expect(LONE_SURROGATE.test(i.text)).toBe(false);
    }
    expect(traceOf(result, 'n1601').text).toEqual({
      originalChars: 1601,
      includedChars: 1600,
      truncated: true,
    });
    expect(result.bundle.budget.truncatedItems).toBe(1);
    expect(result.bundle.budget.usedChars).toBe(1599 + 1600 + 1600);
    // Serialization round-trips exactly.
    expect(JSON.parse(JSON.stringify(result.bundle))).toEqual(result.bundle);
  });

  it('judges relevance on the included text only: a term past the cut does not count', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('late-term', `${codePoints(1600, 'x')} budget`),
          evidence('early-term', `budget ${codePoints(1600, 'x')}`),
        ]),
      ],
      request('Budget review'),
    );
    expect(selectedIds(result)).toEqual(['early-term']);
    expect(traceOf(result, 'late-term').relevance.score).toBe(0);
    expect(traceOf(result, 'late-term').exclusionReason).toBe(
      'no_relevance_channel',
    );
  });

  it('keeps the total within 10000 code points as a rank-order prefix (W)', async () => {
    const big = (i: number) =>
      evidence(`big-${i}`, `Budget ${codePoints(1593, 'x')}`, {
        signals: ranked(i),
      });
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          ...Array.from({ length: 7 }, (_, i) => big(i)),
          evidence('small-after', 'Budget memo', { signals: ranked(50) }),
        ]),
      ],
      request('Budget review'),
    );
    expect(selectedIds(result)).toEqual(
      Array.from({ length: 6 }, (_, i) => `big-${i}`),
    );
    expect(result.bundle.budget).toEqual({
      characterUnit: 'unicode_code_point',
      maxSelectedItems: 10,
      maxContextChars: 10000,
      maxItemChars: 1600,
      selectedItems: 6,
      usedChars: 9600,
      truncatedItems: 0,
      stopReason: 'context_budget',
    });
    expect(traceOf(result, 'big-6').exclusionReason).toBe('context_budget');
    // Prefix policy: a smaller, lower-ranked item is not packed in afterwards.
    expect(traceOf(result, 'small-after').exclusionReason).toBe(
      'context_budget',
    );
    expect(traceOf(result, 'small-after').eligibleRank).toBe(8);
  });

  it('includes an item that fills the budget exactly and stops at the next', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          ...Array.from({ length: 6 }, (_, i) =>
            evidence(`big-${i}`, `Budget ${codePoints(1593, 'x')}`, {
              signals: ranked(i),
            }),
          ),
          evidence('fill', `Budget ${codePoints(393, 'y')}`, {
            signals: ranked(10),
          }),
          evidence('one-more', 'Budget', { signals: ranked(11) }),
        ]),
      ],
      request('Budget review'),
    );
    expect(result.bundle.budget.usedChars).toBe(10000);
    expect(selectedIds(result)).toContain('fill');
    expect(traceOf(result, 'one-more').exclusionReason).toBe('context_budget');
  });

  it('selects at most 10 items (X)', async () => {
    const result = await assemble(
      [
        memorySource(
          'episodes',
          'episode_history',
          Array.from({ length: 12 }, (_, i) =>
            evidence(`item-${String(i).padStart(2, '0')}`, 'Budget line', {
              signals: ranked(i),
            }),
          ),
        ),
      ],
      request('Budget review'),
    );
    expect(result.bundle.items).toHaveLength(10);
    expect(result.bundle.budget.stopReason).toBe('item_limit');
    expect(
      result.trace.candidates
        .filter((c) => c.exclusionReason === 'item_limit')
        .map((c) => c.candidateId),
    ).toEqual(['item-10', 'item-11']);
    expect(result.bundle.items.map((i) => i.rank)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });
});

describe('AVEN-008 Unicode identifiers and text (U)', () => {
  it('accepts NFC Unicode IDs and orders them by code unit', async () => {
    const ids = ['候选-1', 'kandidat-ü', 'ελληνικά', 'Ärger:2'];
    const result = await assemble(
      [
        memorySource(
          'quelle-ö',
          'episode_history',
          ids.map((id) => evidence(id, 'Budget 東京 naïve 🎉')),
        ),
      ],
      request('budget'),
    );
    expect(selectedIds(result)).toEqual(
      [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(result.bundle.items[0]!.sourceId).toBe('quelle-ö');
    expect(result.bundle.items[0]!.text).toBe('Budget 東京 naïve 🎉');
  });

  it('rejects non-NFC, emoji, whitespace and over-long IDs', async () => {
    for (const id of ['café', '🎉', 'has space', '', `a${'b'.repeat(128)}`]) {
      await expect(
        assemble(
          [
            memorySource('episodes', 'episode_history', [
              evidence(id, 'Budget'),
            ]),
          ],
          request('budget'),
        ),
        id,
      ).rejects.toMatchObject({ code: 'invalid_candidate' });
    }
    await expect(
      assemble(
        [memorySource('café', 'episode_history', [])],
        request('budget'),
      ),
    ).rejects.toBeInstanceOf(ContextBrokerError);
  });
});
