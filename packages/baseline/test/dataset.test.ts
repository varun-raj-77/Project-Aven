import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BaselineCaseSchema,
  BaselineError,
  createBaselineHarness,
  createBaselineRunRecord,
  loadBaselineCases,
  parseAllBaselineCasesForValidation,
  selectBaselineCases,
  toBaselineInput,
  type BaselineCase,
} from '../src/index.ts';
import { scripted } from './fixtures.ts';

/**
 * Oracle-leakage and held-out-access tests. TEST code may read the
 * scorer-only oracle to prove that none of it reaches a model request; the
 * production baseline never reads it (see boundaries.test.ts).
 */
const dir = new URL('../../../evals/aven-007/', import.meta.url);
const casesText = readFileSync(new URL('cases.jsonl', dir), 'utf8');
const oracle = readFileSync(new URL('oracle.jsonl', dir), 'utf8')
  .trimEnd()
  .split('\n')
  .map(
    (line) =>
      JSON.parse(line) as {
        caseId: string;
        behavior: {
          expectedBehaviorClass: string;
          requiredBehavior: string[];
          forbiddenBehavior: string[];
          acceptableAlternatives: string[];
          scorerNotes: string;
        };
        contextDiagnostics: { role: string };
      },
  );
const all = parseAllBaselineCasesForValidation(casesText);

describe('ordinary loading is development-only (research discipline, not security)', () => {
  it('loadBaselineCases returns development cases when options are omitted or undefined', () => {
    for (const loaded of [
      loadBaselineCases(casesText),
      loadBaselineCases(casesText, undefined),
      loadBaselineCases(casesText, {}),
    ]) {
      expect(loaded).toHaveLength(48);
      expect(loaded.every((c) => c.split === 'development')).toBe(true);
    }
  });

  it('loadBaselineCases reaches held-out cases only with an explicit option', () => {
    const held = loadBaselineCases(casesText, { split: 'held_out' });
    expect(held).toHaveLength(16);
    expect(held.every((c) => c.split === 'held_out')).toBe(true);
    expect(loadBaselineCases(casesText, { includeHeldOut: true })).toHaveLength(
      64,
    );
    expect(
      loadBaselineCases(casesText, { includeHeldOut: false }),
    ).toHaveLength(48);
  });

  it('loadBaselineCases rejects null, malformed or contradictory options and bad text', () => {
    for (const options of [
      null,
      'held_out',
      [],
      { all: true },
      { split: 'all' },
      { includeHeldOut: 1 },
      { includeHeldOut: true, split: 'development' },
    ])
      expect(
        () =>
          loadBaselineCases(
            casesText,
            options as unknown as Parameters<typeof loadBaselineCases>[1],
          ),
        JSON.stringify(options),
      ).toThrow(BaselineError);
    for (const text of [null, undefined, 42, ''])
      expect(() => loadBaselineCases(text as unknown as string)).toThrow(
        BaselineError,
      );
  });

  it('exposes all splits only through the explicitly named raw validation parser', async () => {
    expect(all).toHaveLength(64);
    expect(all.some((c) => c.split === 'held_out')).toBe(true);
    const api = await import('../src/index.ts');
    expect(Object.keys(api)).not.toContain('parseBaselineCases');
    expect(Object.keys(api)).toContain('parseAllBaselineCasesForValidation');
  });

  it('selectBaselineCases returns development cases only by default', () => {
    const selected = selectBaselineCases(all);
    expect(selected).toHaveLength(48);
    expect(selected.every((c) => c.split === 'development')).toBe(true);
  });

  it('requires an explicit option to reach held-out cases', () => {
    expect(selectBaselineCases(all, { split: 'held_out' })).toHaveLength(16);
    expect(
      selectBaselineCases(all, { split: 'held_out' }).every(
        (c) => c.split === 'held_out',
      ),
    ).toBe(true);
    expect(selectBaselineCases(all, { includeHeldOut: true })).toHaveLength(64);
    expect(selectBaselineCases(all, { includeHeldOut: false })).toHaveLength(
      48,
    );
    expect(selectBaselineCases(all, { split: 'development' })).toHaveLength(48);
  });

  it('rejects contradictory or unknown selection options', () => {
    for (const options of [
      { includeHeldOut: true, split: 'development' },
      { heldOut: true },
      { split: 'final' },
      { includeHeldOut: 'yes' },
    ])
      expect(() =>
        selectBaselineCases(
          all,
          options as Parameters<typeof selectBaselineCases>[1],
        ),
      ).toThrow(BaselineError);
  });
});

describe('case parsing fails closed', () => {
  it('rejects malformed lines, duplicates, blank lines and merged oracle fields', () => {
    const [first] = casesText.split('\n');
    const merged = JSON.stringify({
      ...(JSON.parse(first!) as object),
      expectedBehaviorClass: 'apply_preference',
    });
    for (const bad of [
      '',
      '\n',
      `${first}\n${first}\n`,
      `${first}\n\n${first}\n`,
      '{not json}\n',
      `${merged}\n`,
    ])
      expect(() => parseAllBaselineCasesForValidation(bad)).toThrow(
        BaselineError,
      );
  });

  it('passes only owner, request, profile and history to prompt assembly', () => {
    const c = all[0]!;
    expect(Object.keys(toBaselineInput(c)).sort()).toEqual([
      'history',
      'ownerId',
      'profile',
      'request',
    ]);
  });
});

describe('no oracle leakage into model input', () => {
  const SENTINEL = 'SENTINEL-ORACLE-7f3a9c';

  it('never sends any oracle text, label or case bookkeeping to the runtime, for any case in either condition', async () => {
    const runtime = scripted();
    const harness = createBaselineHarness({ runtime });
    for (const c of selectBaselineCases(all, { includeHeldOut: true }))
      for (const condition of ['fresh', 'naive_personalized'] as const)
        await harness.run(condition, toBaselineInput(c), { caseId: c.caseId });
    expect(runtime.requests).toHaveLength(128);
    const sent = JSON.stringify(runtime.requests);
    for (const o of oracle) {
      for (const text of [
        o.behavior.expectedBehaviorClass,
        ...o.behavior.requiredBehavior,
        ...o.behavior.forbiddenBehavior,
        ...o.behavior.acceptableAlternatives,
        o.behavior.scorerNotes,
        o.contextDiagnostics.role,
      ])
        expect(sent, `${o.caseId}: ${text}`).not.toContain(
          JSON.stringify(text).slice(1, -1),
        );
      expect(sent).not.toContain(o.caseId);
    }
    for (const c of all) {
      expect(sent).not.toContain(c.scenarioFamilyId);
      expect(sent).not.toContain(c.category);
    }
    expect(sent).not.toContain('held_out');
  });

  it('keeps sentinel strings planted in every oracle field out of runtime messages', async () => {
    const runtime = scripted();
    const harness = createBaselineHarness({ runtime });
    for (const [i, o] of oracle.entries()) {
      const planted = {
        behavior: {
          expectedBehaviorClass: `${SENTINEL}-class-${i}`,
          requiredBehavior: [`${SENTINEL}-req-${i}`],
          forbiddenBehavior: [`${SENTINEL}-forbid-${i}`],
          acceptableAlternatives: [`${SENTINEL}-alt-${i}`],
          scorerNotes: `${SENTINEL}-notes-${i}`,
        },
        contextDiagnostics: {
          role: `${SENTINEL}-role-${i}`,
          supportingContextIds: [`${SENTINEL}-sup-${i}`],
          staleOrConflictingContextIds: [`${SENTINEL}-stale-${i}`],
          distractorContextIds: [`${SENTINEL}-dis-${i}`],
        },
        mustRetrieveEventIds: [`${SENTINEL}-control-${i}`],
      };
      const c = all.find((x) => x.caseId === o.caseId)!;
      // Accidental merge of oracle data into a case: strict parsing rejects it
      // before any runtime call...
      const mergedCase = { ...c, ...planted };
      expect(BaselineCaseSchema.safeParse(mergedCase).success).toBe(false);
      await expect(
        harness.run(
          'naive_personalized',
          mergedCase as unknown as Parameters<typeof harness.run>[1],
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      // ...and the explicit field projection drops it.
      const projected = toBaselineInput(mergedCase as unknown as BaselineCase);
      await harness.run('naive_personalized', projected);
      await harness.run('fresh', projected);
    }
    expect(runtime.requests).toHaveLength(oracle.length * 2);
    expect(JSON.stringify(runtime.requests)).not.toContain(SENTINEL);
  });

  it('keeps oracle data out of traces and run records', async () => {
    const harness = createBaselineHarness({ runtime: scripted() });
    const c = all[0]!;
    const trace = await harness.run('naive_personalized', toBaselineInput(c), {
      caseId: c.caseId,
    });
    const runRecord = createBaselineRunRecord(trace, {
      caseId: c.caseId,
      datasetId: 'AVEN-007-DATASET-001',
      datasetVersion: '2.0.0',
      executionKind: 'mechanics_validation',
    });
    const o = oracle[0]!;
    const serialized = JSON.stringify([trace, runRecord]);
    for (const text of [
      o.behavior.expectedBehaviorClass,
      o.behavior.scorerNotes,
      ...o.behavior.requiredBehavior,
    ])
      expect(serialized).not.toContain(text);
  });
});
