import { describe, expect, it } from 'vitest';
import {
  ROOT_DENY_ALL_POLICY_DEFINITION,
  ROOT_POLICY_DIGEST_PROTOCOL,
  ROOT_V1_REFERENCE_RISK_TABLE,
  createRootPolicy,
  evaluateActionProposal,
} from '../src/index.ts';
import { canonicalText, taggedSha256 } from '../src/canonical.ts';
import { createSyntheticApprovalChannel } from '../src/testing/index.ts';
import {
  clone,
  deeplyFrozen,
  definition,
  expectRootError,
  input,
  ownerId,
  policy,
  sessionId,
  taskId,
} from './fixtures.ts';

const grant = (overrides: Record<string, unknown> = {}) => ({
  ...clone(definition().grants[0]!),
  ...overrides,
});

describe('createRootPolicy: Root-controlled configuration', () => {
  it('registers a frozen policy whose digest commits to the whole definition', () => {
    const d = definition();
    const p = createRootPolicy(d);
    expect(p.kind).toBe('root_policy');
    expect(p.policyVersion).toBe('synthetic-root-policy-v1');
    expect(p.approvalAuthentication).toBe('unavailable');
    expect(p.policyDigest).toEqual({
      algorithm: 'sha256',
      value: taggedSha256(ROOT_POLICY_DIGEST_PROTOCOL, canonicalText(d)!),
    });
    expect(deeplyFrozen(p)).toBe(true);
    expect(createRootPolicy(clone(d)).policyDigest).toEqual(p.policyDigest);
    // The caller's object is copied: later edits change nothing.
    d.grants.length = 0;
    expect(p.definition.grants).toHaveLength(1);
  });

  it('changes the digest when any rule, grant, bound or mode changes', () => {
    const base = policy().policyDigest.value;
    const variants = [
      definition({ policyVersion: 'synthetic-root-policy-v2' }),
      definition({ highRisk: 'deny' }),
      definition({ approvalMaxAgeSeconds: 60 }),
      definition({ grants: [] }),
      definition({ grants: [grant({ validUntil: '2026-10-14T12:00:00Z' })] }),
      definition({
        riskTable: clone(ROOT_V1_REFERENCE_RISK_TABLE).map((entry) =>
          entry.operation === 'read' && entry.resourceKind === 'file'
            ? { ...entry, risk: 'medium' }
            : entry,
        ),
      }),
    ];
    const digests = new Set(
      variants.map((v) => createRootPolicy(v).policyDigest.value),
    );
    expect(digests.size).toBe(variants.length);
    expect(digests.has(base)).toBe(false);
  });

  it('is recognised by identity only: copies and look-alikes are untrusted', () => {
    const p = policy();
    for (const forged of [
      clone(p),
      { ...p },
      Object.freeze({ ...p }),
      JSON.parse(JSON.stringify(p)),
      null,
      'synthetic-root-policy-v1',
    ])
      expectRootError(
        () => evaluateActionProposal(forged, input()),
        'untrusted_policy',
      );
    expect(evaluateActionProposal(p, input()).decision.decision).toBe('ALLOW');
  });

  it.each([
    ['unknown format', { format: 'aven-012-root-policy-definition-v2' }],
    ['extra field', { owner: ownerId }],
    ['bad version token', { policyVersion: 'Synthetic Policy' }],
    ['zero approval age', { approvalMaxAgeSeconds: 0 }],
    ['approval age above 30 days', { approvalMaxAgeSeconds: 2592001 }],
    ['unknown high-risk mode', { highRisk: 'allow' }],
    ['unknown authentication mode', { approvalAuthentication: 'password' }],
  ])('rejects a malformed definition: %s', (_name, overrides) => {
    expectRootError(() => policy(overrides), 'invalid_policy');
  });

  it('rejects definitions that are not inert plain data', () => {
    let invoked = 0;
    const d = definition();
    Object.defineProperty(d, 'grants', {
      enumerable: true,
      get() {
        invoked += 1;
        return [];
      },
    });
    expectRootError(() => createRootPolicy(d), 'invalid_policy');
    expectRootError(
      () => createRootPolicy(new Proxy(definition(), {})),
      'invalid_policy',
    );
    expect(invoked).toBe(0);
  });

  it.each([
    [
      'a duplicated risk classification',
      () => {
        const d = definition();
        d.riskTable.push({ ...d.riskTable[0]! });
        return d;
      },
    ],
    [
      'a learned-state change that is not forbidden',
      () =>
        definition({
          riskTable: clone(ROOT_V1_REFERENCE_RISK_TABLE).map((entry) =>
            entry.operation === 'modify' &&
            entry.resourceKind === 'learned_state'
              ? { ...entry, risk: 'low' }
              : entry,
          ),
        }),
    ],
    [
      'a learning-lifecycle operation that is not forbidden',
      () =>
        definition({
          riskTable: clone(ROOT_V1_REFERENCE_RISK_TABLE).map((entry) =>
            entry.operation === 'promote_learning' &&
            entry.resourceKind === 'document'
              ? { ...entry, risk: 'high' }
              : entry,
          ),
        }),
    ],
    [
      'a duplicated catalog entry',
      () => {
        const d = definition();
        d.actions.push({ ...d.actions[0]! });
        return d;
      },
    ],
    [
      'a catalogued learned-state change',
      () => {
        const d = definition();
        d.actions.push({
          toolId: 'synthetic-learner',
          action: 'promote',
          operation: 'promote_learning',
          resourceKind: 'learned_state',
          reversibility: 'reversible',
        });
        return d;
      },
    ],
    [
      'a catalogued action with an unclassified effect',
      () =>
        definition({
          riskTable: clone(ROOT_V1_REFERENCE_RISK_TABLE).filter(
            (entry) =>
              !(entry.operation === 'send' && entry.resourceKind === 'message'),
          ),
        }),
    ],
    [
      'an irreversible low-risk action',
      () => {
        const d = definition();
        d.actions.push({
          toolId: 'synthetic-sandbox-tool',
          action: 'shred',
          operation: 'modify',
          resourceKind: 'sandbox_resource',
          reversibility: 'irreversible',
        });
        return d;
      },
    ],
    [
      'a duplicated grant identifier',
      () => definition({ grants: [grant(), grant()] }),
    ],
    [
      'an empty grant window',
      () =>
        definition({
          grants: [grant({ validUntil: '2026-10-14T00:00:00Z' })],
        }),
    ],
    [
      'a reversed grant window',
      () =>
        definition({
          grants: [grant({ validUntil: '2026-10-13T00:00:00Z' })],
        }),
    ],
    [
      'a grant for an uncatalogued action',
      () => definition({ grants: [grant({ action: 'erase_everything' })] }),
    ],
    [
      'a grant for another resource kind',
      () =>
        definition({
          grants: [
            grant({
              resource: { kind: 'document', identifier: 'synthetic-notes' },
            }),
          ],
        }),
    ],
    [
      'a grant for a medium-risk action',
      () =>
        definition({
          grants: [
            grant({
              toolId: 'synthetic-docs',
              action: 'edit_document',
              resource: { kind: 'document', identifier: 'synthetic-doc' },
            }),
          ],
        }),
    ],
    [
      'a grant for a high-risk action',
      () =>
        definition({
          grants: [
            grant({
              toolId: 'synthetic-mail',
              action: 'send_message',
              resource: { kind: 'message', identifier: 'synthetic-message' },
            }),
          ],
        }),
    ],
    [
      'a grant without a scope',
      () => {
        const g = grant() as Record<string, unknown>;
        delete g.scope;
        return definition({ grants: [g] });
      },
    ],
    [
      'a wildcard-looking grant scope',
      () => definition({ grants: [grant({ scope: { kind: 'any' } })] }),
    ],
  ])('violates a Root invariant: %s', (_name, build) => {
    expectRootError(() => createRootPolicy(build()), 'invalid_policy');
  });

  it('accepts owner-, session- and task-scoped grants', () => {
    for (const scope of [
      { kind: 'owner' },
      { kind: 'session', sessionId },
      { kind: 'task', sessionId, taskId },
    ])
      expect(
        createRootPolicy(definition({ grants: [grant({ scope })] })).definition
          .grants[0]!.scope,
      ).toEqual(scope);
  });
});

describe('approval authentication capabilities', () => {
  it('requires the synthetic capability exactly when the definition declares it', () => {
    const channel = createSyntheticApprovalChannel();
    expectRootError(
      () =>
        createRootPolicy(
          definition({ approvalAuthentication: 'synthetic_test_only' }),
        ),
      'invalid_policy',
    );
    expectRootError(
      () => createRootPolicy(definition(), channel.authenticator),
      'invalid_policy',
    );
    const p = createRootPolicy(
      definition({ approvalAuthentication: 'synthetic_test_only' }),
      channel.authenticator,
    );
    expect(p.approvalAuthentication).toBe('synthetic_test_only');
  });

  it('refuses look-alike authenticators, recognising capabilities by identity', () => {
    const channel = createSyntheticApprovalChannel();
    for (const forged of [
      { ...channel.authenticator },
      clone(channel.authenticator),
      { kind: 'synthetic_test_only' },
      channel,
      channel.attest,
    ])
      expectRootError(
        () =>
          createRootPolicy(
            definition({ approvalAuthentication: 'synthetic_test_only' }),
            forged,
          ),
        'untrusted_capability',
      );
  });

  it('labels the synthetic capability as not owner authentication', () => {
    const { authenticator } = createSyntheticApprovalChannel();
    expect(authenticator).toEqual({
      kind: 'synthetic_test_only',
      notice: 'Synthetic test capability: not owner authentication',
    });
    expect(deeplyFrozen(authenticator)).toBe(true);
  });

  it('attests only well-formed approvals', () => {
    const { attest } = createSyntheticApprovalChannel();
    for (const bad of [null, {}, { kind: 'owner_approval' }])
      expectRootError(() => attest(bad), 'invalid_request');
  });
});

describe('reference risk table and the denial fallback', () => {
  it('classifies every operation and resource kind exactly once', () => {
    expect(ROOT_V1_REFERENCE_RISK_TABLE).toHaveLength(50);
    const keys = new Set(
      ROOT_V1_REFERENCE_RISK_TABLE.map(
        (e) => `${e.operation}/${e.resourceKind}`,
      ),
    );
    expect(keys.size).toBe(50);
    expect(deeplyFrozen(ROOT_V1_REFERENCE_RISK_TABLE)).toBe(true);
  });

  it('forbids every learned-state change and learning operation', () => {
    for (const entry of ROOT_V1_REFERENCE_RISK_TABLE) {
      const learning =
        ['promote_learning', 'revoke_learning', 'rollback_learning'].includes(
          entry.operation,
        ) ||
        (entry.resourceKind === 'learned_state' && entry.operation !== 'read');
      if (learning) expect(entry.risk).toBe('forbidden');
      else expect(entry.risk).not.toBe('forbidden');
    }
  });

  it('pins the classification of consequential operations', () => {
    const risk = (operation: string, kind: string) =>
      ROOT_V1_REFERENCE_RISK_TABLE.find(
        (e) => e.operation === operation && e.resourceKind === kind,
      )!.risk;
    expect(risk('read', 'document')).toBe('low');
    expect(risk('draft', 'message')).toBe('low');
    expect(risk('modify', 'sandbox_resource')).toBe('low');
    expect(risk('modify', 'document')).toBe('medium');
    expect(risk('delete', 'sandbox_resource')).toBe('medium');
    expect(risk('read', 'learned_state')).toBe('medium');
    for (const operation of ['delete', 'send', 'publish'])
      for (const kind of ['document', 'file', 'message'])
        expect(risk(operation, kind)).toBe('high');
    expect(risk('send', 'sandbox_resource')).toBe('high');
  });

  it('is a valid policy that denies every proposal', () => {
    const fallback = createRootPolicy(ROOT_DENY_ALL_POLICY_DEFINITION);
    expect(fallback.policyVersion).toBe('aven-012-deny-all-v1');
    const evaluation = evaluateActionProposal(fallback, input());
    expect(evaluation.decision.decision).toBe('DENY');
    expect(evaluation.decision.reasonCodes).toEqual(['action_not_in_policy']);
  });
});
