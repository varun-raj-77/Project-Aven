import { describe, expect, it } from 'vitest';
import * as c from '../src/index.ts';
import * as f from './fixtures.ts';

describe('proposal, authority, execution, and verification remain separate', () => {
  it('rejects every neighboring substitution in the action chain', () => {
    expect(c.PolicyDecisionSchema.safeParse(f.proposal).success).toBe(false);
    expect(c.ExecutionResultSchema.safeParse(f.policy).success).toBe(false);
    expect(c.VerificationResultSchema.safeParse(f.execution).success).toBe(
      false,
    );
    expect(c.OwnerApprovalSchema.safeParse(f.trusted).success).toBe(false);
    expect(
      c.OwnerApprovalSchema.safeParse({
        ...f.trusted,
        content: {
          category: 'intent_pattern',
          cue: 'Go ahead',
          interpretedIntent: 'Owner probably wants this action',
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    'proposalId',
    'proposalVersion',
    'proposalDigest',
    'parametersDigest',
  ] as const)('requires exact approval and policy binding field %s', (key) => {
    const proposal = f.omit(f.binding, key);
    expect(
      c.OwnerApprovalSchema.safeParse({ ...f.approval, proposal }).success,
    ).toBe(false);
    expect(
      c.PolicyDecisionSchema.safeParse({ ...f.policy, proposal }).success,
    ).toBe(false);
  });
  it('retains exact proposal/version/digest/task/session binding through serialization', () => {
    const approval = c.OwnerApprovalSchema.parse(
      JSON.parse(JSON.stringify(f.approval)) as unknown,
    );
    expect(approval.proposal).toEqual(f.binding);
    expect(approval.bounds).toEqual(f.task);
    expect(
      c.OwnerApprovalSchema.safeParse({
        ...approval,
        proposal: { ...f.binding, proposalId: f.owner },
      }).success,
    ).toBe(false);
    expect(
      c.ProposalBindingSchema.safeParse({ ...f.binding, proposalVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      c.ProposalBindingSchema.safeParse({
        ...f.binding,
        parametersDigest: { ...f.digest, value: 'unhashed' },
      }).success,
    ).toBe(false);
  });
  it('requires immutable parameter content references and explicit requested authority', () => {
    expect(
      c.ActionProposalSchema.safeParse({
        ...f.proposal,
        parameters: { message: 'Mutable inline blob' },
      }).success,
    ).toBe(false);
    expect(
      c.ActionProposalSchema.safeParse({
        ...f.proposal,
        requestedAuthority: [],
      }).success,
    ).toBe(false);
    expect(
      c.ActionProposalSchema.safeParse({ ...f.proposal, allowed: true })
        .success,
    ).toBe(false);
  });
  it('requires explicit grants or approval references for ALLOW', () => {
    expect(
      c.PolicyDecisionSchema.safeParse(
        f.omit(f.policy, 'basis' as keyof typeof f.policy),
      ).success,
    ).toBe(false);
    expect(
      c.PolicyDecisionSchema.safeParse({
        ...f.policy,
        issuer: { kind: 'model', model: f.model },
      }).success,
    ).toBe(false);
    expect(
      c.PolicyDecisionSchema.safeParse({
        ...f.policy,
        basis: { kind: 'predicted_intent' },
      }).success,
    ).toBe(false);
    expect(
      c.PolicyDecisionSchema.parse({
        ...f.policy,
        basis: { kind: 'owner_approval', approvalIds: [f.approval.id] },
      }).decision,
    ).toBe('ALLOW');
  });
  it.each(['DENY', 'REQUIRE_OWNER_APPROVAL'] as const)(
    'represents %s separately from ALLOW',
    (decision) => {
      const base = f.omit(f.policy, 'basis' as keyof typeof f.policy);
      const value =
        decision === 'DENY'
          ? { ...base, decision }
          : {
              ...base,
              decision,
              approvalRequirement: 'Exact owner approval required',
            };
      expect(c.PolicyDecisionSchema.parse(value).decision).toBe(decision);
      expect(
        c.AllowDecisionReferenceSchema.safeParse({ ...f.policyRef, decision })
          .success,
      ).toBe(false);
    },
  );
  it('rejects inferred approval, mismatched owner, expiry reversal, and incomplete revocation', () => {
    expect(
      c.OwnerApprovalSchema.safeParse({
        ...f.approval,
        provenance: f.inference,
      }).success,
    ).toBe(false);
    expect(
      c.OwnerApprovalSchema.safeParse({ ...f.approval, ownerId: 'owner_other' })
        .success,
    ).toBe(false);
    expect(
      c.OwnerApprovalSchema.safeParse({ ...f.approval, expiresAt: f.time })
        .success,
    ).toBe(false);
    expect(
      c.OwnerApprovalSchema.safeParse({
        ...f.approval,
        lifecycle: { status: 'revoked' },
      }).success,
    ).toBe(false);
    expect(
      c.OwnerApprovalSchema.parse({
        ...f.approval,
        lifecycle: {
          status: 'revoked',
          revokedAt: f.later,
          revocationEventId: 'event_revoked',
          reason: 'Owner withdrew approval',
        },
      }).lifecycle.status,
    ).toBe('revoked');
  });
  it('represents non-attempt separately from attempted outcomes', () => {
    const notAttempted = {
      kind: 'execution_result',
      ...f.base,
      id: f.execution.id,
      policy: { ...f.policyRef, decision: 'DENY' },
      toolId: 'synthetic-tool',
      attempted: false,
      recordedAt: f.time,
      reason: 'policy_denied',
      detail: 'Denied by synthetic policy',
    };
    expect(c.ExecutionResultSchema.parse(notAttempted).attempted).toBe(false);
    expect(
      c.ExecutionResultSchema.safeParse({
        ...notAttempted,
        outcome: { status: 'succeeded', returned: f.artifact },
      }).success,
    ).toBe(false);
    expect(
      c.ExecutionResultSchema.safeParse({
        ...f.execution,
        endedAt: '2026-10-03T12:00:00Z',
      }).success,
    ).toBe(false);
  });
  it.each([
    { status: 'succeeded', returned: f.artifact },
    {
      status: 'failed',
      error: {
        code: 'SYNTHETIC_FAILURE',
        message: 'Fake failure',
        retryability: 'unknown',
      },
    },
    { status: 'unknown', reason: 'Fake tool disconnected' },
  ])(
    'records attempted tool outcome %# without claiming verification',
    (outcome) => {
      const result = c.ExecutionResultSchema.parse({ ...f.execution, outcome });
      expect(c.VerificationResultSchema.safeParse(result).success).toBe(false);
    },
  );
  it('can audit execution after a denial without relabeling the denial as permission', () => {
    const result = c.ExecutionResultSchema.parse({
      ...f.execution,
      policy: { ...f.policyRef, decision: 'DENY' },
    });
    expect(result.attempted).toBe(true);
    expect(result.policy.decision).toBe('DENY');
  });
  it('rejects model-only and evidence-free successful verification', () => {
    expect(
      c.VerificationResultSchema.safeParse({
        ...f.verification,
        method: { kind: 'model_assessment', model: f.model },
      }).success,
    ).toBe(false);
    expect(
      c.VerificationResultSchema.safeParse({ ...f.verification, evidence: [] })
        .success,
    ).toBe(false);
    expect(
      c.VerificationResultSchema.safeParse({
        ...f.verification,
        evidence: [
          {
            kind: 'model_says_it_worked',
            reference: f.evidence,
            provenance: f.inference,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      c.VerificationResultSchema.parse({
        ...f.verification,
        status: 'INCONCLUSIVE',
        method: { kind: 'model_assessment', model: f.model },
        evidence: [],
        reason: 'No independently observable outcome',
      }).status,
    ).toBe('INCONCLUSIVE');
  });
  it('represents failed verification even after reported tool success', () => {
    expect(
      c.VerificationResultSchema.parse({
        ...f.verification,
        status: 'FAILED',
        failure: 'Synthetic state differs from requested state',
      }).status,
    ).toBe('FAILED');
  });
  it('requires successful verification evidence to agree with its method and owner', () => {
    expect(
      c.VerificationResultSchema.safeParse({
        ...f.verification,
        method: {
          kind: 'owner_confirmation',
          identifier: 'synthetic-owner-check',
          version: '1',
        },
      }).success,
    ).toBe(false);
    const ownerVerification = {
      ...f.verification,
      method: {
        kind: 'owner_confirmation',
        identifier: 'synthetic-owner-check',
        version: '1',
      },
      evidence: [
        {
          kind: 'owner_confirmation',
          reference: f.evidence,
          provenance: f.ownerProvenance,
        },
      ],
    };
    expect(c.VerificationResultSchema.parse(ownerVerification).status).toBe(
      'VERIFIED',
    );
    expect(
      c.VerificationResultSchema.safeParse({
        ...ownerVerification,
        ownerId: 'owner_other',
      }).success,
    ).toBe(false);
  });
});
