import { describe, expect, it } from 'vitest';
import { APPROVAL_REASONS, evaluateActionProposal } from '../src/index.ts';
import {
  approval,
  clone,
  evaluatedAt,
  expectRootError,
  input,
  medium,
  policy,
  proposal,
  revoked,
  syntheticPolicy,
} from './fixtures.ts';

/** Evaluates the medium-risk proposal with the given approval records. */
function judge(
  records: unknown[],
  options: {
    attest?: unknown[];
    evaluatedAt?: string;
    overrides?: Record<string, unknown>;
  } = {},
) {
  const { policy: p, channel } = syntheticPolicy(options.overrides);
  for (const record of options.attest ?? records) channel.attest(record);
  return evaluateActionProposal(
    p,
    input({
      proposal: medium(),
      approvals: records,
      evaluatedAt: options.evaluatedAt ?? evaluatedAt,
    }),
  );
}

describe('approval verification: every condition is required', () => {
  it('verifies an exact, current, authenticated approval and allows on it', () => {
    const a = approval(medium());
    const evaluation = judge([a]);
    expect(evaluation.approvals).toEqual([
      {
        approvalId: 'approval_synthetic',
        versions: [1],
        status: 'verified',
        reasons: [],
        evidence: {
          evidenceId: 'evidence_approval_synthetic',
          eventId: 'event_approval_synthetic',
        },
      },
    ]);
    expect(evaluation.decision).toMatchObject({
      decision: 'ALLOW',
      basis: { kind: 'owner_approval', approvalIds: ['approval_synthetic'] },
    });
    expect(evaluation.decision.reasonCodes).toContain(
      'approval_authenticated_by_synthetic_test_capability',
    );
  });

  it('lists reasons in their fixed order', () => {
    expect(APPROVAL_REASONS).toEqual([
      'approval_owner_mismatch',
      'approval_binding_mismatch',
      'approval_scope_mismatch',
      'approval_versions_conflict',
      'approval_revoked',
      'approval_predates_proposal',
      'approval_not_yet_valid',
      'approval_expired',
      'approval_stale',
      'approval_authentication_unavailable',
      'approval_not_authenticated',
    ]);
  });

  const reasonsOf = (
    records: unknown[],
    options?: Parameters<typeof judge>[1],
  ) => {
    const evaluation = judge(records, options);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.decision.reasonCodes).toContain('approvals_rejected');
    return evaluation.approvals.map((finding) => finding.reasons);
  };

  it('rejects an approval bound to another proposal (replay across proposals)', () => {
    expect(reasonsOf([approval(proposal())])).toEqual([
      ['approval_binding_mismatch'],
    ]);
  });

  it('rejects an approval whose digest differs (stale proposal version)', () => {
    const a = approval(medium());
    a.proposal.proposalDigest.value = 'c'.repeat(64);
    expect(reasonsOf([a])).toEqual([['approval_binding_mismatch']]);
  });

  it('rejects an approval whose parameters digest differs', () => {
    const a = approval(medium());
    a.proposal.parametersDigest.value = 'd'.repeat(64);
    expect(reasonsOf([a])).toEqual([['approval_binding_mismatch']]);
  });

  it('rejects an approval bounded to another task (cross-task)', () => {
    const a = approval(medium(), {
      bounds: { sessionId: 'session_synthetic', taskId: 'task_other' },
    });
    expect(reasonsOf([a])).toEqual([['approval_scope_mismatch']]);
  });

  it('rejects an approval of another owner (cross-owner)', () => {
    const a = approval(medium());
    const foreign = {
      ...a,
      ownerId: 'owner_other',
      provenance: { ...a.provenance, ownerId: 'owner_other' },
    };
    expect(reasonsOf([foreign])).toEqual([['approval_owner_mismatch']]);
  });

  it('rejects a revoked approval even though version 1 was issued', () => {
    const a = approval(medium());
    expect(reasonsOf([a, revoked(a)], { attest: [a] })).toEqual([
      ['approval_revoked'],
    ]);
  });

  it('rejects an approval whose versions disagree on what they approve', () => {
    const a = approval(medium());
    const v2 = {
      ...revoked(a),
      lifecycle: { status: 'issued' },
      expiresAt: '2026-10-15T09:00:00Z',
    };
    expect(reasonsOf([a, v2], { attest: [a] })).toEqual([
      ['approval_versions_conflict'],
    ]);
  });

  it('rejects conflicting duplicates of one version but counts identical ones once', () => {
    const a = approval(medium());
    const twin = clone(a);
    expect(judge([a, twin]).approvals[0]!.status).toBe('verified');
    const conflicting = {
      ...clone(a),
      metadata: { ...a.metadata, createdAt: '2026-10-14T09:01:30Z' },
    };
    expect(reasonsOf([a, conflicting], { attest: [a] })).toEqual([
      ['approval_versions_conflict'],
    ]);
  });

  it('rejects an expired approval at and after its expiry instant', () => {
    const a = approval(medium());
    // A longer age limit isolates expiry from staleness.
    const overrides = { approvalMaxAgeSeconds: 7200 };
    for (const at of ['2026-10-14T10:01:00Z', '2026-10-14T10:01:00.000001Z'])
      expect(reasonsOf([a], { evaluatedAt: at, overrides })).toEqual([
        ['approval_expired'],
      ]);
    expect(
      judge([a], { evaluatedAt: '2026-10-14T10:00:59.999999Z', overrides })
        .approvals[0]!.status,
    ).toBe('verified');
  });

  it('rejects an approval issued after Root evaluates (not yet valid)', () => {
    const a = approval(medium());
    expect(reasonsOf([a], { evaluatedAt: '2026-10-14T09:00:30Z' })).toEqual([
      ['approval_not_yet_valid'],
    ]);
  });

  it('rejects an approval issued before the proposal existed (back-dated)', () => {
    const a = approval(medium(), {
      issuedAt: '2026-10-14T08:59:59.999Z',
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: '2026-10-14T08:59:59.999Z',
        creation: { component: 'synthetic-owner-interface', version: 'v1' },
      },
    });
    expect(reasonsOf([a])).toEqual([['approval_predates_proposal']]);
  });

  it('rejects an approval older than the policy maximum age (stale)', () => {
    const a = approval(medium(), { expiresAt: '2026-10-20T00:00:00Z' });
    expect(
      reasonsOf([a], {
        evaluatedAt: '2026-10-14T09:31:00.000001Z',
        overrides: { approvalMaxAgeSeconds: 1800 },
      }),
    ).toEqual([['approval_stale']]);
    expect(
      judge([a], {
        evaluatedAt: '2026-10-14T09:31:00Z',
        overrides: { approvalMaxAgeSeconds: 1800 },
      }).approvals[0]!.status,
    ).toBe('verified');
  });

  it('rejects an approval the synthetic channel never attested (forged record)', () => {
    const a = approval(medium());
    expect(reasonsOf([a], { attest: [] })).toEqual([
      ['approval_not_authenticated'],
    ]);
    // Another channel's attestation does not count for this policy.
    const elsewhere = syntheticPolicy();
    elsewhere.channel.attest(a);
    expect(reasonsOf([a], { attest: [] })).toEqual([
      ['approval_not_authenticated'],
    ]);
  });

  it('never verifies any approval without Root-trusted authentication', () => {
    const a = approval(medium());
    const evaluation = evaluateActionProposal(
      policy(),
      input({ proposal: medium(), approvals: [a] }),
    );
    expect(evaluation.approvals[0]!.reasons).toEqual([
      'approval_authentication_unavailable',
    ]);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.decision.reasonCodes).toEqual([
      'root_risk_medium',
      'parameters_bound_by_digest_only',
      'approvals_rejected',
      'approval_authentication_unavailable',
      'no_verified_owner_approval',
    ]);
  });

  it('reports every failed condition of one approval together', () => {
    const a = approval(proposal(), {
      bounds: { sessionId: 'session_other', taskId: 'task_other' },
      issuedAt: '2026-10-14T08:00:00Z',
      expiresAt: '2026-10-14T08:30:00Z',
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: '2026-10-14T08:00:00Z',
        creation: { component: 'synthetic-owner-interface', version: 'v1' },
      },
    });
    expect(reasonsOf([a], { attest: [] })).toEqual([
      [
        'approval_binding_mismatch',
        'approval_scope_mismatch',
        'approval_predates_proposal',
        'approval_expired',
        'approval_stale',
        'approval_not_authenticated',
      ],
    ]);
  });

  it('refuses malformed approval records and more than 64 records', () => {
    expectRootError(
      () =>
        evaluateActionProposal(
          policy(),
          input({ approvals: [{ kind: 'owner_approval' }] }),
        ),
      'invalid_request',
    );
    const a = approval(medium());
    expectRootError(
      () =>
        evaluateActionProposal(
          policy(),
          input({ approvals: Array.from({ length: 65 }, () => clone(a)) }),
        ),
      'invalid_request',
    );
  });
});
