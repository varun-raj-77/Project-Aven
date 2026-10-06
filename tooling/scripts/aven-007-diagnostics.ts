import {
  HISTORY_TOP_K,
  selectHistoryContext,
  tokenize,
  type BaselineCase,
} from '../../packages/baseline/src/index.ts';
import type { OracleRecord } from './aven-007-dataset.ts';

/**
 * AVEN-007 LEXICAL CONSTRUCTION DIAGNOSTICS (scorer-side tooling).
 *
 * These numbers describe how the naive lexical search interacts with the
 * dataset's construction, separately for development and held-out cases.
 * They exist to detect obvious systematic construction imbalance (for
 * example, a held-out split that is uniformly easier for BM25). They are NOT
 * model accuracy, NOT a B score and NOT a target: no model is run, and no
 * diagnostic value is optimized. Context IDs are diagnostic labels only.
 */
export interface SplitDiagnostics {
  readonly cases: number;
  readonly casesWithSupportingHistory: number;
  readonly supportingRecords: number;
  readonly supportingRecordsRetrieved: number;
  readonly casesRetrievingAnySupporting: number;
  readonly casesRetrievingEverySupporting: number;
  readonly casesWithSupportingRecordAtRank1: number;
  readonly meanSharedQueryTokensSupporting: number;
  readonly staleOrConflictingRecords: number;
  readonly staleOrConflictingRecordsRetrieved: number;
  readonly distractorRecords: number;
  readonly distractorRecordsWithAnySharedToken: number;
  readonly meanSharedQueryTokensDistractor: number;
  readonly distractorRecordsRetrieved: number;
  readonly corpusSize: Distribution;
  readonly positiveCandidates: Distribution;
  readonly casesWithMorePositiveCandidatesThanTopK: number;
  readonly selectedHistoryItems: Distribution;
}

export interface Distribution {
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly histogram: Readonly<Record<string, number>>;
}

export interface Aven007Diagnostics {
  readonly note: string;
  readonly development: SplitDiagnostics;
  readonly held_out: SplitDiagnostics;
  readonly repeatedHistoryTextsAcrossFamilies: number;
  readonly maxFamiliesSharingOneHistoryText: number;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const histogram: Record<string, number> = {};
  for (const v of sorted)
    histogram[String(v)] = (histogram[String(v)] ?? 0) + 1;
  const mid = sorted.length / 2;
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2
        ? sorted[Math.floor(mid)]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    min: sorted[0] ?? 0,
    median,
    max: sorted.at(-1) ?? 0,
    histogram,
  };
}

const shared = (request: string, text: string): number => {
  const q = new Set(tokenize(request));
  return new Set(tokenize(text).filter((t) => q.has(t))).size;
};
const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : round(xs.reduce((a, b) => a + b, 0) / xs.length);

function splitDiagnostics(
  cases: readonly BaselineCase[],
  oracle: ReadonlyMap<string, OracleRecord>,
): SplitDiagnostics {
  let casesWithSupporting = 0;
  let supporting = 0;
  let supportingRetrieved = 0;
  let anyRetrieved = 0;
  let everyRetrieved = 0;
  let rank1 = 0;
  let stale = 0;
  let staleRetrieved = 0;
  let distractor = 0;
  let distractorShared = 0;
  let distractorRetrieved = 0;
  let overTopK = 0;
  const supportingOverlap: number[] = [];
  const distractorOverlap: number[] = [];
  const corpus: number[] = [];
  const positives: number[] = [];
  const selected: number[] = [];
  for (const c of cases) {
    const row = oracle.get(c.caseId);
    if (!row) throw new Error(`no oracle row for ${c.caseId}`);
    const d = row.contextDiagnostics;
    const events = new Map<string, (typeof c.history)[number]>(
      c.history.map((h) => [h.eventId, h]),
    );
    const sup = d.supportingContextIds.filter((id) => events.has(id));
    const sta = d.staleOrConflictingContextIds.filter((id) => events.has(id));
    const dis = d.distractorContextIds.filter((id) => events.has(id));
    const selection = selectHistoryContext(c.ownerId, c.request, c.history);
    const got = selection.items.map((i) => i.eventId);
    // A record scores > 0 exactly when it shares a query token (IDF is always
    // positive), so this counts every positive BM25 candidate before top-K.
    const allPositive = c.history.filter((h) =>
      tokenize(h.text).some((t) => new Set(tokenize(c.request)).has(t)),
    ).length;
    corpus.push(c.history.length);
    positives.push(allPositive);
    selected.push(got.length);
    if (allPositive > HISTORY_TOP_K) overTopK += 1;
    if (sup.length > 0) {
      casesWithSupporting += 1;
      const hit = sup.filter((id) => got.includes(id)).length;
      supporting += sup.length;
      supportingRetrieved += hit;
      if (hit > 0) anyRetrieved += 1;
      if (hit === sup.length) everyRetrieved += 1;
      if (got[0] !== undefined && sup.includes(got[0])) rank1 += 1;
      for (const id of sup)
        supportingOverlap.push(shared(c.request, events.get(id)!.text));
    }
    stale += sta.length;
    staleRetrieved += sta.filter((id) => got.includes(id)).length;
    for (const id of dis) {
      const overlap = shared(c.request, events.get(id)!.text);
      distractor += 1;
      distractorOverlap.push(overlap);
      if (overlap > 0) distractorShared += 1;
      if (got.includes(id)) distractorRetrieved += 1;
    }
  }
  return {
    cases: cases.length,
    casesWithSupportingHistory: casesWithSupporting,
    supportingRecords: supporting,
    supportingRecordsRetrieved: supportingRetrieved,
    casesRetrievingAnySupporting: anyRetrieved,
    casesRetrievingEverySupporting: everyRetrieved,
    casesWithSupportingRecordAtRank1: rank1,
    meanSharedQueryTokensSupporting: mean(supportingOverlap),
    staleOrConflictingRecords: stale,
    staleOrConflictingRecordsRetrieved: staleRetrieved,
    distractorRecords: distractor,
    distractorRecordsWithAnySharedToken: distractorShared,
    meanSharedQueryTokensDistractor: mean(distractorOverlap),
    distractorRecordsRetrieved: distractorRetrieved,
    corpusSize: distribution(corpus),
    positiveCandidates: distribution(positives),
    casesWithMorePositiveCandidatesThanTopK: overTopK,
    selectedHistoryItems: distribution(selected),
  };
}

export function computeAven007Diagnostics(
  cases: readonly BaselineCase[],
  oracle: readonly OracleRecord[],
): Aven007Diagnostics {
  const byId = new Map(oracle.map((o) => [o.caseId, o]));
  const families = new Map<string, Set<string>>();
  for (const c of cases)
    for (const h of c.history)
      families.set(
        h.text,
        (families.get(h.text) ?? new Set()).add(c.scenarioFamilyId),
      );
  const sharing = [...families.values()].map((s) => s.size);
  return {
    note: 'Lexical construction diagnostics of the naive history search over the dataset. Not model accuracy, not a B score, not a target. No model was run.',
    development: splitDiagnostics(
      cases.filter((c) => c.split === 'development'),
      byId,
    ),
    held_out: splitDiagnostics(
      cases.filter((c) => c.split === 'held_out'),
      byId,
    ),
    repeatedHistoryTextsAcrossFamilies: sharing.filter((n) => n > 1).length,
    maxFamiliesSharingOneHistoryText: Math.max(0, ...sharing),
  };
}
