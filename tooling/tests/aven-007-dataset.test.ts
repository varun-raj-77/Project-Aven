import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_CONFIG_V2,
  DATASET_CATEGORIES,
  loadBaselineCases,
  parseAllBaselineCasesForValidation,
  selectHistoryContext,
} from '../../packages/baseline/src/index.ts';
import {
  AVEN_007_DATASET_ID,
  BMechanicsControlsSchema,
  DatasetManifestSchema,
  parseOracle,
  REVIEWED_V1,
  sha256Hex,
  validateAven007Dataset,
  type DatasetManifest,
  type ValidationInput,
} from '../scripts/aven-007-dataset.ts';
import { computeAven007Diagnostics } from '../scripts/aven-007-diagnostics.ts';

/**
 * AVEN-007 dataset v2 integrity (research discipline, not security). The
 * held-out split is FROZEN but NOT SECRET. Every validator rule is exercised
 * with a deliberate mutation so a weakened validator fails here. No test
 * below sets a target for B's retrieval or any score.
 */
const dir = new URL('../../evals/aven-007/', import.meta.url);
const text = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const bytes = (f: string) => readFileSync(new URL(f, dir));
const BASE: ValidationInput = {
  casesText: text('cases.jsonl'),
  oracleText: text('oracle.jsonl'),
  controlsText: text('b-mechanics-controls.json'),
  constructionText: text('construction.json'),
  diagnosticsText: text('diagnostics.json'),
  manifest: JSON.parse(text('manifest.json')) as unknown,
  archive: {
    cases: bytes('reviewed-v1/cases.jsonl'),
    oracle: bytes('reviewed-v1/oracle.jsonl'),
    manifest: bytes('reviewed-v1/manifest.json'),
  },
};
const manifest = BASE.manifest as DatasetManifest;
const cases = parseAllBaselineCasesForValidation(BASE.casesText);
const oracle = parseOracle(BASE.oracleText);
const controls = BMechanicsControlsSchema.parse(JSON.parse(BASE.controlsText));
const caseById = new Map(cases.map((c) => [c.caseId, c]));
const oracleById = new Map(oracle.map((o) => [o.caseId, o]));

type Row = Record<string, unknown>;
const lines = (t: string) => t.trimEnd().split('\n');
const join = (rows: string[]) => `${rows.join('\n')}\n`;
const mapRows = (t: string, fn: (row: Row, i: number) => Row | null) =>
  join(
    lines(t)
      .map((l, i) => fn(JSON.parse(l) as Row, i))
      .filter((r): r is Row => r !== null)
      .map((r) => JSON.stringify(r)),
  );

/** Validates a mutation with manifest hashes refreshed, so each mutation is
 * caught by its own rule rather than only by the hash check. */
function problemsFor(change: Partial<ValidationInput>) {
  const input = { ...BASE, ...change };
  const m = structuredClone(input.manifest) as DatasetManifest;
  m.files['cases.jsonl'].sha256 = sha256Hex(input.casesText);
  m.files['oracle.jsonl'].sha256 = sha256Hex(input.oracleText);
  m.files['b-mechanics-controls.json'].sha256 = sha256Hex(input.controlsText);
  m.files['construction.json'].sha256 = sha256Hex(input.constructionText);
  m.files['diagnostics.json'].sha256 = sha256Hex(input.diagnosticsText);
  return validateAven007Dataset({ ...input, manifest: m });
}
const has = (problems: string[], pattern: RegExp) =>
  problems.some((p) => pattern.test(p));

describe('AVEN-007-DATASET-001 v2 is valid as built', () => {
  it('passes every structural, oracle, control, archive and manifest check', () => {
    expect(validateAven007Dataset(BASE)).toEqual([]);
  });

  it('keeps 64 cases: 48 development and 16 held-out (25%) across 32 families', () => {
    expect(cases).toHaveLength(64);
    expect(cases.filter((c) => c.split === 'development')).toHaveLength(48);
    expect(cases.filter((c) => c.split === 'held_out')).toHaveLength(16);
    expect(new Set(cases.map((c) => c.scenarioFamilyId)).size).toBe(32);
    expect(manifest.datasetId).toBe(AVEN_007_DATASET_ID);
    expect(manifest.datasetVersion).toBe('2.0.0');
    expect(manifest.splitPolicy.heldOutShare).toBe(0.25);
  });

  it('balances 8 categories at 6 development + 2 held-out cases (3 + 1 families) each', () => {
    for (const category of DATASET_CATEGORIES) {
      const inCategory = cases.filter((c) => c.category === category);
      expect(inCategory.filter((c) => c.split === 'development')).toHaveLength(
        6,
      );
      expect(inCategory.filter((c) => c.split === 'held_out')).toHaveLength(2);
    }
  });

  it('never lets a family cross the development/held-out boundary', () => {
    const splits = new Map<string, Set<string>>();
    for (const c of cases)
      splits.set(
        c.scenarioFamilyId,
        (splits.get(c.scenarioFamilyId) ?? new Set()).add(c.split),
      );
    expect([...splits.values()].every((s) => s.size === 1)).toBe(true);
  });

  it('records not_run, no results, synthetic data, BASELINE_CONFIG_V2 and the EXP-001 separation', () => {
    const parsed = DatasetManifestSchema.parse(manifest);
    expect(parsed.execution).toMatchObject({
      status: 'not_run',
      results: null,
    });
    expect(parsed.dataProvenance).toBe('synthetic');
    expect(parsed.containsRealOwnerData).toBe(false);
    expect(parsed.splitPolicy.heldOutSecret).toBe(false);
    expect(parsed.splitPolicy.heldOutRole).toBe(
      'aven007_baseline_asset_not_promotion_eval_not_exp001_final_held_out',
    );
    expect(parsed.splitPolicy.exp001Relationship).toBe(
      'separate_asset_no_automatic_reuse_exp001_unchanged',
    );
    expect(parsed.baseline.configuration).toEqual(
      JSON.parse(JSON.stringify(BASELINE_CONFIG_V2)),
    );
    expect(parsed.baseline.configVersion).toBe('aven-007-baseline-config-v2');
    expect(parsed.baseline.tokenizerVersion).toBe('aven-007-tokenizer-v2');
    expect(parsed.baseline.promptVersion).toBe('aven-007-baseline-prompt-v1');
  });

  it('keeps model-visible inputs and every scorer-only file separate', () => {
    const caseKeys = new Set(
      lines(BASE.casesText).flatMap((l) => Object.keys(JSON.parse(l) as Row)),
    );
    expect([...caseKeys].sort()).toEqual(
      [
        'caseId',
        'category',
        'history',
        'ownerId',
        'profile',
        'request',
        'scenarioFamilyId',
        'split',
      ].sort(),
    );
    expect(BASE.casesText).not.toMatch(
      /expectedBehaviorClass|requiredBehavior|forbiddenBehavior|contextDiagnostics|mustRetrieve|designedSupportingOverlap/,
    );
  });
});

describe('reviewed v1 is preserved byte-for-byte and cannot drift silently', () => {
  it('matches the pinned reviewed-v1 hashes and the manifest supersedes record', () => {
    expect(sha256Hex(BASE.archive.cases)).toBe(
      '162a879729293a28bad2afdec54936b66d0ad05aec56315afeed3295c1184cc8',
    );
    expect(sha256Hex(BASE.archive.oracle)).toBe(
      '5798eb24b68cffbc00ad40d9a76fd88ab8b7c83fd0a92800d19f18c0b388ff58',
    );
    expect(sha256Hex(BASE.archive.manifest)).toBe(
      'd6dc4bcdf3fbcb480f45222d2dc14aeaf7c3a8b0f4d4f60951570f8ba03f4205',
    );
    expect(manifest.supersedes).toMatchObject({
      casesSha256: REVIEWED_V1.casesSha256,
      oracleSha256: REVIEWED_V1.oracleSha256,
      manifestSha256: REVIEWED_V1.manifestSha256,
      status: 'superseded_pre_freeze_after_independent_review',
    });
    expect(readdirSync(new URL('reviewed-v1/', dir)).sort()).toEqual([
      'README.md',
      'cases.jsonl',
      'manifest.json',
      'oracle.jsonl',
    ]);
  });

  it('fails on any change to the archive or to the record of it', () => {
    const flipped = Buffer.from(BASE.archive.cases);
    flipped[100] = flipped[100]! ^ 1;
    expect(
      has(
        problemsFor({ archive: { ...BASE.archive, cases: flipped } }),
        /archived reviewed-v1 cases\.jsonl/,
      ),
    ).toBe(true);
    expect(
      has(
        problemsFor({
          archive: { ...BASE.archive, manifest: `${text('manifest.json')}` },
        }),
        /archived reviewed-v1 manifest\.json/,
      ),
    ).toBe(true);
    const record = structuredClone(manifest);
    (record.supersedes as Row)['casesSha256'] = 'b'.repeat(64);
    expect(
      has(problemsFor({ manifest: record }), /manifest\.json is malformed/),
    ).toBe(true);
  });

  it('is never what the ordinary loader or the current dataset uses', () => {
    expect(BASE.casesText).not.toBe(String(BASE.archive.cases));
    expect(
      has(
        problemsFor({ casesText: String(BASE.archive.cases) }),
        /identical to the superseded v1/,
      ),
    ).toBe(true);
    // Production baseline source never names an evals path (see the baseline
    // boundary tripwires); only the dataset checker reads reviewed-v1/.
    const checker = readFileSync(
      new URL('../scripts/check-aven-007-dataset.ts', import.meta.url),
      'utf8',
    );
    expect(checker).toContain("bytes('reviewed-v1/cases.jsonl')");
    expect(loadBaselineCases(BASE.casesText).length).toBe(48);
  });
});

describe('oracle contract: behavior is primary, context IDs are diagnostic only (M3)', () => {
  it('separates behavior from diagnostics and keeps raw IDs out of behavior', () => {
    for (const o of oracle) {
      expect(o.contextDiagnostics.role).toBe(
        'diagnostic_only_not_behavioral_requirement',
      );
      expect(JSON.stringify(o.behavior)).not.toMatch(/event_|pentry_/);
    }
  });

  it('labels every profile entry and history record exactly once', () => {
    for (const o of oracle) {
      const c = caseById.get(o.caseId)!;
      const ids = [
        ...c.profile.entries.map((e) => e.id),
        ...c.history.map((h) => h.eventId),
      ].sort();
      const d = o.contextDiagnostics;
      expect(
        [
          ...d.supportingContextIds,
          ...d.staleOrConflictingContextIds,
          ...d.distractorContextIds,
        ].sort(),
      ).toEqual(ids);
    }
  });

  it('labels superseded evidence as stale-or-conflicting, not as irrelevant (cs-01, cs-02, cs-03)', () => {
    for (const id of [
      'aven007-cs-01-v1',
      'aven007-cs-01-v2',
      'aven007-cs-02-v1',
      'aven007-cs-02-v2',
      'aven007-cs-03-v1',
      'aven007-cs-03-v2',
    ])
      expect(
        oracleById.get(id)!.contextDiagnostics.staleOrConflictingContextIds,
        id,
      ).not.toHaveLength(0);
  });

  it('fails when behavior requires an exact raw context ID, or labels drift', () => {
    const requiresId = mapRows(BASE.oracleText, (row, i) => {
      if (i !== 0) return row;
      const behavior = row['behavior'] as Row;
      return {
        ...row,
        behavior: {
          ...behavior,
          requiredBehavior: ['Must retrieve event_syn_pa01_v1_01'],
        },
      };
    });
    expect(
      has(problemsFor({ oracleText: requiresId }), /reference raw context IDs/),
    ).toBe(true);
    const unlabeled = mapRows(BASE.oracleText, (row, i) => {
      if (i !== 0) return row;
      const d = row['contextDiagnostics'] as Row;
      return {
        ...row,
        contextDiagnostics: { ...d, distractorContextIds: [] },
      };
    });
    expect(
      has(problemsFor({ oracleText: unlabeled }), /has no diagnostic label/),
    ).toBe(true);
    const v1Shape = mapRows(BASE.oracleText, (row, i) =>
      i === 0 ? { ...row, expectedRelevantContextIds: [] } : row,
    );
    expect(
      has(problemsFor({ oracleText: v1Shape }), /oracle\.jsonl does not parse/),
    ).toBe(true);
  });
});

describe('variant-specific, defensible behavioral requirements (H2 and LOW findings)', () => {
  const required = (id: string) =>
    oracleById.get(id)!.behavior.requiredBehavior.join(' | ');

  it('dp-03 cases contain a genuine arithmetic inconsistency and the oracle cites the right numbers', () => {
    const v1 = caseById.get('aven007-dp-03-v1')!.request;
    const m1 =
      /(three) cohorts of (\d+) students each, reaching (\d+) students/.exec(
        v1,
      );
    expect(m1).not.toBeNull();
    expect(3 * Number(m1![2])).not.toBe(Number(m1![3]));
    expect(required('aven007-dp-03-v1')).toContain(String(3 * Number(m1![2])));
    const v2 = caseById.get('aven007-dp-03-v2')!.request;
    const m2 =
      /budget of ([\d,]+) covers (\d+) months of instruction at ([\d,]+) per month/.exec(
        v2,
      );
    expect(m2).not.toBeNull();
    const n = (s: string) => Number(s.replace(/,/g, ''));
    const product = n(m2![2]!) * n(m2![3]!);
    expect(product).not.toBe(n(m2![1]!));
    expect(required('aven007-dp-03-v2')).toContain(
      product.toLocaleString('en-US'),
    );
    // The reviewed v1 wording that was not necessarily inconsistent is gone.
    expect(BASE.casesText).not.toContain('all of year two');
  });

  it('pr-02 totals are arithmetically correct for each variant', () => {
    const totals: Record<string, number[]> = {
      'aven007-pr-02-v1': [34.5, 412, 96.2],
      'aven007-pr-02-v2': [58, 249, 12.4],
    };
    for (const [id, amounts] of Object.entries(totals)) {
      for (const a of amounts)
        expect(caseById.get(id)!.request).toContain(
          String(a).replace(/\.(\d)$/, '.$10'),
        );
      const total = amounts.reduce((x, y) => x + y, 0).toFixed(2);
      expect(required(id)).toContain(total);
    }
  });

  it('keeps each variant scored against its own request', () => {
    expect(required('aven007-cs-02-v2')).not.toMatch(/pace/i);
    expect(required('aven007-cs-02-v1')).toMatch(/pace/i);
    expect(required('aven007-pr-03-v1')).toMatch(/NaN/);
    expect(required('aven007-pr-03-v1')).not.toMatch(/division/i);
    expect(required('aven007-pr-03-v2')).toMatch(/division/i);
    expect(required('aven007-pr-03-v2')).not.toMatch(/NaN/);
    expect(required('aven007-pr-01-v2')).toContain('Upcoming');
    expect(required('aven007-pr-01-v1')).toContain('Next week');
  });

  it('does not assume a season for time-zone conversions without a date (ca-04)', () => {
    for (const id of ['aven007-ca-04-v1', 'aven007-ca-04-v2']) {
      const b = oracleById.get(id)!.behavior;
      expect(b.requiredBehavior.join(' ')).not.toMatch(/summer|winter/i);
      expect(b.acceptableAlternatives.join(' ')).toMatch(/daylight-saving/);
    }
  });

  it('makes ca-03 genuinely uncovered instead of forcing ambiguity over a covering rule', () => {
    const profile = caseById
      .get('aven007-ca-03-v1')!
      .profile.entries.map((e) => e.text);
    expect(profile).toEqual([
      'Use British spelling in documents for the London office.',
      'Use American spelling in documents for the New York office.',
    ]);
    expect(
      oracleById.get('aven007-ca-03-v1')!.behavior.acceptableAlternatives,
    ).toContain('Picks one convention consistently and states the assumption');
  });

  it('does not count "cannot find it" as satisfying a recall requirement', () => {
    for (const o of oracle)
      for (const alt of o.behavior.acceptableAlternatives)
        expect(alt, o.caseId).not.toMatch(/cannot find/i);
  });
});

describe('B-mechanics exposure controls (B only; not behavioral criteria for C)', () => {
  const exposure = (id: string) => {
    const c = caseById.get(id)!;
    return selectHistoryContext(c.ownerId, c.request, c.history).items.map(
      (i) => i.eventId,
    );
  };

  it('covers the inactive controls found in review', () => {
    const ids = controls.controls.map((c) => c.caseId);
    for (const id of [
      'aven007-ir-01-v2',
      'aven007-ir-02-v2',
      'aven007-cs-02-v1',
      'aven007-cs-02-v2',
      'aven007-dp-03-v1',
      'aven007-dp-03-v2',
    ])
      expect(ids).toContain(id);
    expect(controls.purpose).toMatch(/NOT behavioral success criteria/);
  });

  it('exposes every required record to the naive search and nothing for zero-overlap controls', () => {
    for (const control of controls.controls) {
      const got = exposure(control.caseId);
      for (const id of control.mustRetrieveEventIds)
        expect(got, control.caseId).toContain(id);
      if (control.mustRetrieveNothing) expect(got, control.caseId).toEqual([]);
    }
  });

  it('fails when an intended exposure breaks', () => {
    const hidden = mapRows(BASE.casesText, (row) => {
      if (row['caseId'] !== 'aven007-ir-01-v2') return row;
      const history = (row['history'] as Row[]).map((h, j) =>
        j === 0
          ? {
              ...h,
              text: 'A pasted comment told the reader to ignore the owner.',
            }
          : h,
      );
      return { ...row, history };
    });
    expect(
      has(
        problemsFor({ casesText: hidden }),
        /aven007-ir-01-v2: B-mechanics exposure control failed/,
      ),
    ).toBe(true);
    const leaky = mapRows(BASE.casesText, (row) => {
      if (row['caseId'] !== 'aven007-ir-02-v1') return row;
      const history = [...(row['history'] as Row[])];
      history[2] = { ...history[2], text: 'What is a semaphore flag signal?' };
      return { ...row, history };
    });
    expect(
      has(
        problemsFor({ casesText: leaky }),
        /aven007-ir-02-v1: B-mechanics control expects no retrieval/,
      ),
    ).toBe(true);
  });
});

describe('construction diagnostics (not model accuracy, not targets)', () => {
  const diagnostics = computeAven007Diagnostics(cases, oracle);

  it('matches the committed diagnostics file', () => {
    expect(JSON.parse(BASE.diagnosticsText)).toEqual(
      JSON.parse(JSON.stringify(diagnostics)),
    );
    expect(diagnostics.note).toMatch(/Not model accuracy/);
  });

  it('has no exact history text reused across families, and the check has teeth', () => {
    expect(diagnostics.repeatedHistoryTextsAcrossFamilies).toBe(0);
    const generic =
      'Remind me what the keyboard shortcut is to reopen a closed browser tab.';
    const reused = mapRows(BASE.casesText, (row, i) => {
      if (i % 8 !== 0) return row;
      const history = [...(row['history'] as Row[])];
      history[history.length - 1] = { ...history.at(-1)!, text: generic };
      return { ...row, history };
    });
    const reparsed = parseAllBaselineCasesForValidation(reused);
    expect(
      computeAven007Diagnostics(reparsed, oracle)
        .maxFamiliesSharingOneHistoryText,
    ).toBe(8);
    expect(
      has(
        problemsFor({ casesText: reused }),
        /history text reused across 8 families/,
      ),
    ).toBe(true);
  });

  it('gives both splits a mix of designed overlap levels and top-K competition', () => {
    const construction = JSON.parse(BASE.constructionText) as {
      cases: {
        split: string;
        designedSupportingOverlap: string;
        topKCompetitionRecords: number;
      }[];
    };
    for (const split of ['development', 'held_out']) {
      const rows = construction.cases.filter((c) => c.split === split);
      for (const level of ['high', 'partial', 'low'])
        expect(
          rows.some((r) => r.designedSupportingOverlap === level),
          `${split} ${level}`,
        ).toBe(true);
      expect(
        rows.some((r) => r.topKCompetitionRecords > 0),
        split,
      ).toBe(true);
    }
    expect(
      diagnostics.development.casesWithMorePositiveCandidatesThanTopK,
    ).toBeGreaterThan(0);
    expect(
      diagnostics.held_out.casesWithMorePositiveCandidatesThanTopK,
    ).toBeGreaterThan(0);
  });

  it('is not uniformly easier in held-out (the reviewed v1 imbalance tripwire)', () => {
    // v1: every held-out case with relevant history retrieved all of it while
    // development did not. This is an imbalance tripwire, not a target.
    const h = diagnostics.held_out;
    expect(h.casesRetrievingEverySupporting).toBeLessThan(
      h.casesWithSupportingHistory,
    );
  });
});

describe('the validator fails closed on every mutation', () => {
  it('detects a changed byte through the manifest hash', () => {
    expect(
      has(
        validateAven007Dataset({
          ...BASE,
          casesText: BASE.casesText.replace('Larkspur', 'Larkspar'),
        }),
        /cases\.jsonl SHA-256/,
      ),
    ).toBe(true);
    expect(
      has(
        validateAven007Dataset({
          ...BASE,
          controlsText: BASE.controlsText.replace('B-mechanics', 'B mechanics'),
        }),
        /b-mechanics-controls\.json SHA-256/,
      ),
    ).toBe(true);
  });

  it('detects a family paraphrase leaking across the development/held-out boundary', () => {
    const leaked = mapRows(BASE.casesText, (row) =>
      row['caseId'] === 'aven007-pa-01-v2'
        ? { ...row, split: 'held_out' }
        : row,
    );
    const problems = problemsFor({ casesText: leaked });
    expect(has(problems, /aven007-pa-01: family crosses/)).toBe(true);
    expect(has(problems, /held-out cases: expected 16, found 17/)).toBe(true);
  });

  it('detects missing, extra, duplicated or reordered rows', () => {
    const dropOracle = mapRows(BASE.oracleText, (row, i) =>
      i === 5 ? null : row,
    );
    expect(
      has(problemsFor({ oracleText: dropOracle }), /oracle missing for/),
    ).toBe(true);
    const reordered = join([
      lines(BASE.oracleText)[1]!,
      lines(BASE.oracleText)[0]!,
      ...lines(BASE.oracleText).slice(2),
    ]);
    expect(has(problemsFor({ oracleText: reordered }), /oracle order/)).toBe(
      true,
    );
    const duplicate = join([
      lines(BASE.casesText)[0]!,
      ...lines(BASE.casesText),
    ]);
    expect(has(problemsFor({ casesText: duplicate }), /does not parse/)).toBe(
      true,
    );
  });

  it('detects foreign owners, non-synthetic owners and personal-identifier-like strings', () => {
    const foreign = mapRows(BASE.casesText, (row, i) => {
      if (i !== 0) return row;
      const history = (row['history'] as Row[]).map((h, j) =>
        j === 0 ? { ...h, ownerId: 'owner_syn_someoneelse' } : h,
      );
      return { ...row, history };
    });
    expect(has(problemsFor({ casesText: foreign }), /has another owner/)).toBe(
      true,
    );
    const email = BASE.casesText.replace(
      'Larkspur Analytics who asked',
      'Larkspur Analytics (person@example.org) who asked',
    );
    expect(
      has(problemsFor({ casesText: email }), /personal-identifier-like/),
    ).toBe(true);
  });

  it('detects silent configuration or prompt drift, fabricated results and secrecy claims', () => {
    const drifted = structuredClone(manifest) as DatasetManifest & {
      baseline: { configuration: { history: { k1: number } } };
    };
    drifted.baseline.configuration.history.k1 = 1.5;
    expect(
      has(problemsFor({ manifest: drifted }), /baseline configuration differs/),
    ).toBe(true);
    const prompt = structuredClone(manifest);
    prompt.baseline.promptSha256 = 'a'.repeat(64);
    expect(has(problemsFor({ manifest: prompt }), /prompt hash/)).toBe(true);
    const stop = structuredClone(manifest);
    stop.baseline.stopwordsSha256 = REVIEWED_V1.stopwordsSha256;
    expect(has(problemsFor({ manifest: stop }), /stopword hash/)).toBe(true);
    for (const change of [
      { execution: { status: 'completed', results: null, note: 'x' } },
      { execution: { status: 'not_run', results: { B: 0.9 }, note: 'x' } },
      { splitPolicy: { ...manifest.splitPolicy, heldOutSecret: true } },
      {
        splitPolicy: {
          ...manifest.splitPolicy,
          exp001Relationship: 'exp001_final_held_out',
        },
      },
    ])
      expect(
        has(
          problemsFor({ manifest: { ...manifest, ...change } }),
          /manifest\.json is malformed/,
        ),
      ).toBe(true);
  });
});
