import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { experimentManifestSchema } from '../scripts/experiment-schema.ts';

const manifest = experimentManifestSchema.parse(
  parse(
    readFileSync(
      new URL('../../experiments/EXP-001/manifest.yaml', import.meta.url),
      'utf8',
    ),
  ) as unknown,
);

describe('EXP-001 bootstrap discipline (not runtime security)', () => {
  it('keeps the checked-in experiment draft, not run, with no results or frozen artifacts', () => {
    expect(manifest.status).toBe('draft');
    expect(manifest.execution).toBe('not_run');
    expect(manifest.results).toBeNull();
    expect(
      Object.values(manifest.freeze).every((value) => value === null),
    ).toBe(true);
  });

  it('rejects a claimed freeze before concrete artifacts exist', () => {
    expect(
      experimentManifestSchema.safeParse({ ...manifest, status: 'frozen' })
        .success,
    ).toBe(false);
  });

  it('rejects weakening B to an unscoped profile without searchable history', () => {
    const changed = structuredClone(manifest);
    const input: unknown = {
      ...changed,
      arms: [
        changed.arms[0],
        { ...changed.arms[1], persistent_state: 'profile_only' },
        changed.arms[2],
      ],
    };
    expect(experimentManifestSchema.safeParse(input).success).toBe(false);
  });

  it('rejects replacing the primary comparator B with A', () => {
    expect(
      experimentManifestSchema.safeParse({
        ...manifest,
        metrics: { ...manifest.metrics, primary_comparison: 'C_minus_A' },
      }).success,
    ).toBe(false);
  });

  it.each([
    'prediction_grants_permission',
    'candidate_can_self_promote',
    'aven_can_modify_root',
  ] as const)('rejects granting authority through %s', (key) => {
    expect(
      experimentManifestSchema.safeParse({
        ...manifest,
        authority: { ...manifest.authority, [key]: true },
      }).success,
    ).toBe(false);
  });

  it('rejects held-out reuse for tuning or promotion', () => {
    expect(
      experimentManifestSchema.safeParse({
        ...manifest,
        dataset: {
          ...manifest.dataset,
          final_held_out_used_for_tuning_or_promotion: true,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects policy inequality between comparison arms', () => {
    expect(
      experimentManifestSchema.safeParse({
        ...manifest,
        fairness: { ...manifest.fairness, same_root_policy: false },
      }).success,
    ).toBe(false);
  });

  it('rejects fabricated scores in the protocol manifest', () => {
    expect(
      experimentManifestSchema.safeParse({
        ...manifest,
        results: { C_score: 0.99 },
      }).success,
    ).toBe(false);
  });

  it('rejects unrecognized metadata rather than silently dropping it', () => {
    expect(
      experimentManifestSchema.safeParse({ ...manifest, safety_proven: true })
        .success,
    ).toBe(false);
  });

  it('checks completeness and split arithmetic for a synthetic frozen metadata fixture', () => {
    // Placeholder hashes below are test data, never actual run or source artifacts.
    const hash = 'a'.repeat(64);
    const frozen = {
      ...manifest,
      status: 'frozen',
      dataset: { ...manifest.dataset, status: 'frozen' },
      freeze: {
        model: {
          provider: 'synthetic-test',
          model: 'fixture',
          version: 'fixture',
          sampling_sha256: hash,
        },
        dataset_sha256: hash,
        split_sha256: hash,
        policy_sha256: hash,
        scorer_sha256: hash,
        configuration_sha256: hash,
        protocol_sha256: hash,
        implementation_revision: 'synthetic-test-only',
        evaluator_identity: 'synthetic-test-only',
        analysis_plan: 'synthetic-test-only',
        resource_budget: 'synthetic-test-only',
        seed: 0,
        actual_split_counts: {
          development: 20,
          promotion_eval: 10,
          final_held_out: 10,
        },
      },
    };
    expect(experimentManifestSchema.safeParse(frozen).success).toBe(true);
    expect(
      experimentManifestSchema.safeParse({
        ...frozen,
        freeze: { ...frozen.freeze, policy_sha256: 'not-a-hash' },
      }).success,
    ).toBe(false);
    expect(
      experimentManifestSchema.safeParse({
        ...frozen,
        freeze: {
          ...frozen.freeze,
          actual_split_counts: {
            development: 30,
            promotion_eval: 9,
            final_held_out: 1,
          },
        },
      }).success,
    ).toBe(false);
  });
});
