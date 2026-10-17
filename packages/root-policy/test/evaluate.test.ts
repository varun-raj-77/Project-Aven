import { describe, expect, it } from 'vitest';
import { PolicyDecisionSchema } from '@aven/contracts';
import {
  ROOT_REASON_CODES,
  createRootPolicy,
  evaluateActionProposal,
} from '../src/index.ts';
import {
  approval,
  bindingOf,
  clone,
  deeplyFrozen,
  definition,
  evaluatedAt,
  expectRootError,
  high,
  input,
  medium,
  ownerId,
  policy,
  proposal,
  proposalFor,
  sessionId,
  syntheticPolicy,
  taskId,
} from './fixtures.ts';

const decide = (
  candidate: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  p = policy(),
) => evaluateActionProposal(p, input({ proposal: candidate, ...overrides }));

describe('evaluateActionProposal: the decision record', () => {
  it('returns a frozen, schema-valid AVEN-002 decision with Root issuer fields', () => {
    const p = policy();
    const evaluation = evaluateActionProposal(p, input());
    expect(deeplyFrozen(evaluation)).toBe(true);
    expect(PolicyDecisionSchema.parse(evaluation.decision)).toEqual(
      evaluation.decision,
    );
    expect(evaluation.decision).toEqual({
      kind: 'policy_decision',
      ownerId,
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: evaluatedAt,
        creation: {
          component: '@aven/root-policy',
          version: 'aven-012-root-policy-v1',
        },
      },
      id: 'decision_synthetic',
      proposal: bindingOf(),
      evaluatedAt,
      issuer: {
        kind: 'root',
        policyVersion: 'synthetic-root-policy-v1',
        policyDigest: p.policyDigest,
      },
      reasonCodes: [
        'root_risk_low',
        'parameters_bound_by_digest_only',
        'grant_verified',
      ],
      decision: 'ALLOW',
      basis: {
        kind: 'existing_grant',
        grantReference: 'synthetic-root-policy-v1#grant_sandbox_notes',
      },
    });
    expect(evaluation.executes).toBe(false);
    expect(evaluation.executionRequirement).toBe(
      'recheck_parameter_bytes_and_root_decision_at_execution',
    );
    expect(evaluation.parameters).toEqual({
      locator: 'synthetic:parameters',
      declaredDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
      content: 'not_inspected',
    });
  });

  it('is deterministic: the same input always gives the same evaluation', () => {
    const p = policy();
    const a = evaluateActionProposal(p, input());
    const b = evaluateActionProposal(p, clone(input()));
    expect(b).toEqual(a);
  });

  it('only ever emits reasons from the fixed vocabulary', () => {
    const cases = [
      decide(proposal()),
      decide(medium()),
      decide(high()),
      decide(proposal({ toolId: 'synthetic-unknown' })),
      decide(proposal({ priorApprovalIds: ['approval_cited'] })),
    ];
    for (const evaluation of cases)
      for (const reason of evaluation.decision.reasonCodes)
        expect(ROOT_REASON_CODES).toContain(reason);
  });

  it('refuses malformed requests before evaluating anything', () => {
    for (const bad of [
      input({ decisionId: 'proposal_synthetic' }),
      input({ decisionId: 'decision_' }),
      input({ evaluatedAt: '2026-10-14' }),
      input({ evaluatedAt: 1792000000 }),
      input({ ownerId: 'owner' }),
      input({ issuer: { kind: 'root' } }),
      input({ decision: 'ALLOW' }),
      input({ grants: [] }),
      { ...input(), policy: definition() },
    ])
      expectRootError(
        () => evaluateActionProposal(policy(), bad),
        'invalid_request',
      );
    expectRootError(
      () => evaluateActionProposal(policy(), new Proxy(input(), {})),
      'invalid_request',
    );
  });

  it('does not evaluate an invalid or foreign proposal at all', () => {
    expectRootError(
      () => decide(proposal({ kind: 'not_a_proposal' })),
      'invalid_proposal',
    );
    expectRootError(
      () => decide(proposal(), { taskId: 'task_other' }),
      'binding_mismatch',
    );
    expectRootError(
      () => decide(proposal({ ownerId: 'owner_other' })),
      'binding_mismatch',
    );
  });
});

describe('evaluateActionProposal: rules in order', () => {
  it('1. denies a proposal created after Root evaluates', () => {
    const evaluation = decide(proposal(), {
      evaluatedAt: '2026-10-14T08:59:59.999999Z',
    });
    expect(evaluation.decision.decision).toBe('DENY');
    expect(evaluation.decision.reasonCodes).toEqual([
      'proposal_created_after_evaluation',
    ]);
  });

  it('2. denies an action that is not in Root catalog (unknown tool or action)', () => {
    for (const candidate of [
      proposal({ toolId: 'synthetic-unknown' }),
      proposal({ action: 'append_note ' }),
      proposal({ action: 'APPEND_NOTE' }),
      proposal({ toolId: 'synthetic-sandbox-tool\u0000append_note' }),
    ]) {
      const evaluation = decide(candidate);
      expect(evaluation.decision.decision).toBe('DENY');
      expect(evaluation.decision.reasonCodes).toEqual(['action_not_in_policy']);
      expect(evaluation.classification.catalogued).toBe(false);
    }
  });

  it('3a. denies a target of another kind than the catalogued effect', () => {
    const target = { kind: 'document', identifier: 'synthetic-notes' };
    const evaluation = decide(
      proposal({
        target,
        requestedAuthority: [{ operation: 'modify', resource: target }],
      }),
    );
    expect(evaluation.decision.reasonCodes).toEqual(['target_kind_mismatch']);
    expect(evaluation.decision.decision).toBe('DENY');
  });

  it.each([
    [
      'a different operation (under-declared delete as modify)',
      [
        {
          operation: 'read',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        },
      ],
    ],
    [
      'another resource than the target',
      [
        {
          operation: 'modify',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-other' },
        },
      ],
    ],
    [
      'a second, broader request',
      [
        {
          operation: 'modify',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        },
        {
          operation: 'delete',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        },
      ],
    ],
    [
      'a duplicated request',
      [
        {
          operation: 'modify',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        },
        {
          operation: 'modify',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        },
      ],
    ],
  ])('3b. denies conflicting requested authority: %s', (_name, requested) => {
    const evaluation = decide(proposal({ requestedAuthority: requested }));
    expect(evaluation.decision.decision).toBe('DENY');
    expect(evaluation.decision.reasonCodes).toEqual([
      'requested_authority_mismatch',
    ]);
  });

  it('5. denies a forbidden or unclassified effect', () => {
    const forbidden = createRootPolicy(
      definition({
        riskTable: definition().riskTable.map((entry) =>
          entry.operation === 'modify' &&
          entry.resourceKind === 'sandbox_resource'
            ? { ...entry, risk: 'forbidden' }
            : entry,
        ),
        grants: [],
      }),
    );
    expect(decide(proposal(), {}, forbidden).decision.reasonCodes).toEqual([
      'operation_forbidden',
    ]);
  });

  it('6. never lowers Root risk from a declared low risk (high-risk action)', () => {
    const lying = proposalFor(
      'synthetic-mail',
      'send_message',
      'send',
      { kind: 'message', identifier: 'synthetic-message' },
      { risk: 'low', reversibility: 'reversible', description: 'Harmless.' },
    );
    const evaluation = decide(lying);
    expect(evaluation.classification).toMatchObject({
      rootRisk: 'high',
      effectiveRisk: 'high',
    });
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.decision.reasonCodes).toEqual([
      'root_risk_high',
      'declared_risk_not_authority',
      'parameters_bound_by_digest_only',
      'approval_authentication_unavailable',
      'no_verified_owner_approval',
    ]);
  });

  it('6. raises risk from a declared higher, unknown or less reversible consequence', () => {
    for (const [consequences, expected, reason] of [
      [{ risk: 'medium' }, 'medium', 'declared_risk_escalated'],
      [{ risk: 'high' }, 'high', 'declared_risk_escalated'],
      [{ risk: 'unknown' }, 'high', 'declared_risk_escalated'],
      [
        { reversibility: 'partially_reversible' },
        'medium',
        'declared_reversibility_escalated',
      ],
      [
        { reversibility: 'unknown' },
        'medium',
        'declared_reversibility_escalated',
      ],
    ] as const) {
      const declared: Record<string, unknown> = {
        risk: 'low',
        reversibility: 'reversible',
        description: 'Synthetic.',
      };
      const evaluation = decide(
        proposal({ consequences: { ...declared, ...consequences } }),
      );
      expect(evaluation.classification.effectiveRisk).toBe(expected);
      expect(evaluation.decision.reasonCodes).toContain(reason);
      // A Root grant never applies above low risk.
      expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
      expect(evaluation.decision.reasonCodes).toContain(
        'grants_limited_to_low_risk',
      );
    }
  });

  it('7. denies high risk when the policy denies high risk', () => {
    const strict = policy({ highRisk: 'deny' });
    const evaluation = decide(high(), {}, strict);
    expect(evaluation.decision.decision).toBe('DENY');
    expect(evaluation.decision.reasonCodes).toEqual([
      'root_risk_high',
      'parameters_bound_by_digest_only',
      'high_risk_denied_by_policy',
    ]);
    // An escalated low-risk action is denied the same way.
    const escalated = decide(
      proposal({
        consequences: {
          risk: 'unknown',
          reversibility: 'reversible',
          description: 'Synthetic.',
        },
      }),
      {},
      strict,
    );
    expect(escalated.decision.decision).toBe('DENY');
  });

  it('8. allows low risk only with a matching, current, in-scope Root grant', () => {
    expect(decide(proposal()).decision.decision).toBe('ALLOW');
    const require = (evaluation: ReturnType<typeof decide>) => {
      expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
      expect(evaluation.decision.reasonCodes).toContain('no_applicable_grant');
    };
    // Another resource identifier, owner, task, time or action.
    const other = { kind: 'sandbox_resource', identifier: 'synthetic-other' };
    require(
      decide(
        proposal({
          target: other,
          requestedAuthority: [{ operation: 'modify', resource: other }],
        }),
      ),
    );
    require(decide(proposal(), { evaluatedAt: '2026-10-15T00:00:00Z' }));
    require(
      decide(
        proposal({
          task: { sessionId, taskId: 'task_other' },
        }),
        { taskId: 'task_other' },
      ),
    );
    const draftTarget = {
      kind: 'sandbox_resource',
      identifier: 'synthetic-notes',
    };
    require(
      decide(
        proposalFor('synthetic-sandbox-tool', 'draft', 'draft', draftTarget),
      ),
    );
    const foreign = createRootPolicy(
      definition({
        grants: [{ ...definition().grants[0]!, ownerId: 'owner_other' }],
      }),
    );
    require(decide(proposal(), {}, foreign));
  });

  it('8. honours owner, session and task grant scopes exactly', () => {
    const scoped = (scope: Record<string, unknown>) =>
      createRootPolicy(
        definition({ grants: [{ ...definition().grants[0]!, scope }] }),
      );
    const inOtherTask = proposal({ task: { sessionId, taskId: 'task_other' } });
    const inOtherSession = proposal({
      task: { sessionId: 'session_other', taskId },
    });
    const run = (p: ReturnType<typeof scoped>, candidate = proposal()) => {
      const task = candidate.task as { sessionId: string; taskId: string };
      return evaluateActionProposal(p, input({ proposal: candidate, ...task }))
        .decision.decision;
    };
    const owner = scoped({ kind: 'owner' });
    const session = scoped({ kind: 'session', sessionId });
    const task = scoped({ kind: 'task', sessionId, taskId });
    expect([
      run(owner),
      run(owner, inOtherTask),
      run(owner, inOtherSession),
    ]).toEqual(['ALLOW', 'ALLOW', 'ALLOW']);
    expect([
      run(session),
      run(session, inOtherTask),
      run(session, inOtherSession),
    ]).toEqual(['ALLOW', 'ALLOW', 'REQUIRE_OWNER_APPROVAL']);
    expect([
      run(task),
      run(task, inOtherTask),
      run(task, inOtherSession),
    ]).toEqual(['ALLOW', 'REQUIRE_OWNER_APPROVAL', 'REQUIRE_OWNER_APPROVAL']);
  });

  it('8. applies grant windows exactly (validFrom inclusive, validUntil exclusive)', () => {
    const at = (time: string) =>
      decide(proposal(), { evaluatedAt: time }).decision.decision;
    expect(at('2026-10-14T09:00:00Z')).toBe('ALLOW');
    expect(at('2026-10-14T23:59:59.999999999Z')).toBe('ALLOW');
    expect(at('2026-10-15T00:00:00Z')).toBe('REQUIRE_OWNER_APPROVAL');
    const later = createRootPolicy(
      definition({
        grants: [
          {
            ...definition().grants[0]!,
            validFrom: '2026-10-14T09:05:00.000001Z',
          },
        ],
      }),
    );
    expect(decide(proposal(), {}, later).decision.decision).toBe(
      'REQUIRE_OWNER_APPROVAL',
    );
  });

  it('9. allows on a verified owner approval; 10. otherwise requires one', () => {
    const { policy: p, channel } = syntheticPolicy();
    const a = approval(medium());
    expect(decide(medium(), { approvals: [a] }, p).decision.decision).toBe(
      'REQUIRE_OWNER_APPROVAL',
    );
    channel.attest(a);
    const allowed = decide(medium(), { approvals: [a] }, p);
    expect(allowed.decision).toMatchObject({
      decision: 'ALLOW',
      basis: { kind: 'owner_approval', approvalIds: ['approval_synthetic'] },
      reasonCodes: [
        'root_risk_medium',
        'parameters_bound_by_digest_only',
        'owner_approval_verified',
        'approval_authenticated_by_synthetic_test_capability',
      ],
    });
    const required = decide(medium(), {}, p).decision;
    expect(required.decision).toBe('REQUIRE_OWNER_APPROVAL');
    if (required.decision !== 'REQUIRE_OWNER_APPROVAL') throw new Error();
    const binding = bindingOf(medium());
    expect(required.approvalRequirement).toContain(binding.proposalId);
    expect(required.approvalRequirement).toContain(
      binding.proposalDigest.value,
    );
    expect(required.approvalRequirement).toContain(
      binding.parametersDigest.value,
    );
    expect(required.approvalRequirement).toContain(
      'synthetic test capability, not owner authentication',
    );
  });

  it('allows high risk on a verified approval only when the policy permits approval', () => {
    const { policy: p, channel } = syntheticPolicy();
    const a = approval(high());
    channel.attest(a);
    expect(decide(high(), { approvals: [a] }, p).decision.decision).toBe(
      'ALLOW',
    );
    const strict = syntheticPolicy({ highRisk: 'deny' });
    strict.channel.attest(a);
    expect(
      decide(high(), { approvals: [a] }, strict.policy).decision.decision,
    ).toBe('DENY');
  });

  it('never allows because a proposal cites approval identifiers', () => {
    const cited = {
      ...medium(),
      priorApprovalIds: ['approval_synthetic', 'approval_other'],
    };
    for (const p of [policy(), syntheticPolicy().policy]) {
      const evaluation = decide(cited, {}, p);
      expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
      expect(evaluation.decision.reasonCodes[0]).toBe(
        'cited_approvals_not_authority',
      );
    }
  });

  it('prefers a grant for low risk and lists approvals in identifier order', () => {
    const { policy: p, channel } = syntheticPolicy();
    const a = approval(proposal());
    channel.attest(a);
    expect(decide(proposal(), { approvals: [a] }, p).decision).toMatchObject({
      decision: 'ALLOW',
      basis: { kind: 'existing_grant' },
    });
    const b = approval(medium(), { id: 'approval_b' });
    const c = approval(medium(), { id: 'approval_a' });
    channel.attest(b);
    channel.attest(c);
    expect(decide(medium(), { approvals: [b, c] }, p).decision).toMatchObject({
      basis: {
        kind: 'owner_approval',
        approvalIds: ['approval_a', 'approval_b'],
      },
    });
  });
});

describe('policy versions: no carry-over between versions', () => {
  it('a decision depends on the active policy alone, never on an earlier one', () => {
    const v1 = policy();
    const v2 = policy({
      policyVersion: 'synthetic-root-policy-v2',
      grants: [],
    });
    const first = evaluateActionProposal(v1, input());
    expect(first.decision.decision).toBe('ALLOW');
    const second = evaluateActionProposal(
      v2,
      input({ decisionId: 'decision_second' }),
    );
    expect(second.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(second.decision.issuer.policyVersion).toBe(
      'synthetic-root-policy-v2',
    );
    expect(second.decision.issuer.policyDigest).not.toEqual(
      first.decision.issuer.policyDigest,
    );
  });
});
