import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_DIGEST_PROTOCOL, revalidateProposal } from '../src/index.ts';
import { canonicalText } from '../src/canonical.ts';
import {
  clone,
  context,
  deeplyFrozen,
  expectRootError,
  proposal,
  vectorFile,
} from './fixtures.ts';

const contextOf = (p: Record<string, unknown>) => ({
  ownerId: p.ownerId,
  sessionId: (p.task as { sessionId: string }).sessionId,
  taskId: (p.task as { taskId: string }).taskId,
});

describe('Root revalidation reproduces the AVEN-011 digest protocol v1', () => {
  it('uses the frozen protocol tag', () => {
    expect(vectorFile.protocol).toBe(PROPOSAL_DIGEST_PROTOCOL);
  });

  it.each(vectorFile.vectors.map((v) => [v.name, v] as const))(
    'golden vector %s: canonical text and digest',
    (_name, vector) => {
      expect(canonicalText(vector.proposal)).toBe(vector.canonical);
      const { binding } = revalidateProposal(
        clone(vector.proposal),
        contextOf(vector.proposal),
      );
      expect(binding.proposalDigest).toEqual({
        algorithm: 'sha256',
        value: vector.digest,
      });
      // Domain separation: the digest is not a plain SHA-256 of the text.
      expect(binding.proposalDigest.value).not.toBe(
        vector.plainSha256OfCanonical,
      );
      expect(
        createHash('sha256').update(vector.canonical, 'utf8').digest('hex'),
      ).toBe(vector.plainSha256OfCanonical);
      const artifact = (
        vector.proposal.parameters as {
          artifact: { digest: { value: string } };
        }
      ).artifact;
      expect(binding.parametersDigest.value).toBe(artifact.digest.value);
      expect(binding.proposalId).toBe(vector.proposal.id);
      expect(binding.proposalVersion).toBe(1);
    },
  );

  it.each(vectorFile.rejected.map((v) => [v.name, v] as const))(
    'rejected vector %s is not a valid proposal',
    (_name, vector) => {
      expectRootError(
        () => revalidateProposal(vector.proposal, contextOf(vector.proposal)),
        'invalid_proposal',
      );
    },
  );

  it('is deterministic and independent of key order', () => {
    const a = revalidateProposal(proposal(), context);
    const reversed = Object.fromEntries(Object.entries(proposal()).reverse());
    const b = revalidateProposal(reversed, context);
    expect(b.binding).toEqual(a.binding);
    expect(deeplyFrozen(a)).toBe(true);
  });

  it('changes the digest when any payload field changes', () => {
    const base = revalidateProposal(proposal(), context).binding;
    for (const changed of [
      proposal({ action: 'draft' }),
      proposal({ priorApprovalIds: ['approval_other'] }),
      proposal({
        consequences: {
          risk: 'high',
          reversibility: 'reversible',
          description: 'Append a synthetic note in the sandbox.',
        },
      }),
    ])
      expect(
        revalidateProposal(changed, context).binding.proposalDigest.value,
      ).not.toBe(base.proposalDigest.value);
  });
});

describe('Root revalidation applies the AVEN-011 v1 rules', () => {
  it('rejects another creation stamp, a runtime stamp or a later version', () => {
    const p = proposal();
    for (const creation of [
      {
        component: '@aven/root-policy',
        version: 'aven-011-action-proposals-v1',
      },
      { component: '@aven/action-proposals', version: 'v2' },
      {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
        runtime: { identifier: 'x', version: '1' },
      },
    ])
      expectRootError(
        () =>
          revalidateProposal(
            { ...p, metadata: { ...p.metadata, creation } },
            context,
          ),
        'invalid_proposal',
      );
    expectRootError(
      () =>
        revalidateProposal(
          { ...p, metadata: { ...p.metadata, recordVersion: 2 } },
          context,
        ),
      'invalid_proposal',
    );
  });

  it.each([
    ['promote_learning', 'learned_state'],
    ['revoke_learning', 'document'],
    ['rollback_learning', 'sandbox_resource'],
    ['modify', 'learned_state'],
    ['delete', 'learned_state'],
  ])('rejects %s on %s (learned state change)', (operation, kind) => {
    expectRootError(
      () =>
        revalidateProposal(
          proposal({
            requestedAuthority: [
              { operation, resource: { kind, identifier: 'synthetic-x' } },
            ],
          }),
          context,
        ),
      'invalid_proposal',
    );
  });

  it('accepts a read of learned state (still not a permission)', () => {
    const result = revalidateProposal(
      proposal({
        target: { kind: 'learned_state', identifier: 'synthetic-state' },
        requestedAuthority: [
          {
            operation: 'read',
            resource: { kind: 'learned_state', identifier: 'synthetic-state' },
          },
        ],
      }),
      context,
    );
    expect(result.proposal.target.kind).toBe('learned_state');
  });

  it('rejects a proposal of another owner, session or task', () => {
    for (const other of [
      { ...context, ownerId: 'owner_other' },
      { ...context, sessionId: 'session_other' },
      { ...context, taskId: 'task_other' },
    ])
      expectRootError(
        () => revalidateProposal(proposal(), other),
        'binding_mismatch',
      );
  });

  it('rejects a malformed context as a malformed request', () => {
    for (const bad of [
      null,
      {},
      { ...context, ownerId: 'not-an-owner' },
      { ...context, extra: 1 },
    ])
      expectRootError(
        () => revalidateProposal(proposal(), bad),
        'invalid_request',
      );
  });

  it('rejects contract violations and extra fields', () => {
    for (const bad of [
      proposal({ kind: 'policy_decision' }),
      proposal({ authority: 'ALLOW' }),
      proposal({ requestedAuthority: [] }),
      proposal({ id: 'decision_synthetic' }),
      proposal({ toolId: '   ' }),
      { ...proposal(), issuer: { kind: 'root' } },
    ])
      expectRootError(
        () => revalidateProposal(bad, context),
        'invalid_proposal',
      );
  });

  it('never runs caller code: getters, Proxies and prototypes are refused', () => {
    let invoked = 0;
    const getter = proposal();
    Object.defineProperty(getter, 'action', {
      enumerable: true,
      get() {
        invoked += 1;
        return 'append_note';
      },
    });
    const proxied = new Proxy(proposal(), {
      get(target, key, receiver) {
        invoked += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
      ownKeys(target) {
        invoked += 1;
        return Reflect.ownKeys(target);
      },
    });
    class Shaped {
      constructor() {
        Object.assign(this, proposal());
      }
    }
    for (const bad of [getter, proxied, new Shaped()])
      expectRootError(
        () => revalidateProposal(bad, context),
        'invalid_proposal',
      );
    expect(invoked).toBe(0);
  });

  it('enforces the v1 resource limits and well-formed Unicode', () => {
    expectRootError(
      () =>
        revalidateProposal(
          proposal({
            consequences: {
              risk: 'low',
              reversibility: 'reversible',
              description: 'x'.repeat(20001),
            },
          }),
          context,
        ),
      'invalid_proposal',
    );
    expectRootError(
      () =>
        revalidateProposal(
          proposal({
            consequences: {
              risk: 'low',
              reversibility: 'reversible',
              description: 'lone \ud800 surrogate',
            },
          }),
          context,
        ),
      'invalid_proposal',
    );
    expectRootError(
      () =>
        revalidateProposal(
          proposal({
            priorApprovalIds: Array.from(
              { length: 257 },
              (_, i) => `approval_${i}`,
            ),
          }),
          context,
        ),
      'invalid_proposal',
    );
  });
});
