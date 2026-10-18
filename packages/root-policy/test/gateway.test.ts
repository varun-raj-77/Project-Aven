import { describe, expect, it } from 'vitest';
import { createRootPolicy, evaluateActionProposal } from '../src/index.ts';
import {
  createRootGateway,
  evaluateRecordedProposal,
} from '../src/ledger/index.ts';
import {
  bindingOf,
  deeplyFrozen,
  definition,
  expectRootError,
  high,
  input,
  medium,
} from './fixtures.ts';
import {
  approval,
  dump,
  evaluate,
  evaluationRequest,
  gateway,
  ledger,
  otherOwner,
  ownerId,
  proposal,
  proposalOf,
  recordApproval,
  recordProposal,
  revoked,
  rootTime,
  syntheticGateway,
  testClock,
  withId,
  world,
} from './ledger-fixtures.ts';

describe('createRootGateway: Root host configuration', () => {
  it('binds a registered policy, the Root clock and a recording window', () => {
    const policy = createRootPolicy(definition());
    const g = createRootGateway({ policy, clock: () => rootTime });
    expect(g).toEqual({
      kind: 'root_gateway',
      policyVersion: 'synthetic-root-policy-v1',
      policyDigest: policy.policyDigest,
      recordingWindowSeconds: 60,
    });
    expect(deeplyFrozen(g)).toBe(true);
  });

  it('refuses unregistered policies, bad clocks, windows and extra fields', () => {
    const policy = createRootPolicy(definition());
    expectRootError(
      () => createRootGateway({ policy: { ...policy }, clock: () => rootTime }),
      'untrusted_policy',
    );
    for (const bad of [
      { policy, clock: rootTime },
      { policy, clock: () => rootTime, recordingWindowSeconds: 0 },
      { policy, clock: () => rootTime, recordingWindowSeconds: 3601 },
      { policy, clock: () => rootTime, recordingWindowSeconds: 1.5 },
      { policy, clock: () => rootTime, evaluatedAt: rootTime },
      { policy, clock: () => rootTime, grants: [] },
    ])
      expectRootError(() => createRootGateway(bad as never), 'invalid_request');
  });

  it('is recognised by identity only', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    expectRootError(
      () => evaluateRecordedProposal({ ...g }, storage, evaluationRequest()),
      'untrusted_capability',
    );
    storage.close();
  });
});

describe('evaluateRecordedProposal: read-only Root evaluation of recorded proposals', () => {
  it('allows a recorded low-risk proposal on a Root grant and writes nothing', () => {
    const storage = world();
    recordProposal(storage);
    const before = dump(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision).toMatchObject({
      decision: 'ALLOW',
      ownerId,
      id: 'decision_synthetic',
      evaluatedAt: rootTime,
      proposal: bindingOf(),
      basis: {
        kind: 'existing_grant',
        grantReference: 'synthetic-root-policy-v1#grant_sandbox_notes',
      },
    });
    expect(dump(storage)).toBe(before);
    storage.close();
  });

  it('takes time only from the Root clock, never from the request', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g, time } = gateway();
    time.set('2026-10-15T00:00:00Z');
    expect(evaluate(g, storage).decision.decision).toBe(
      'REQUIRE_OWNER_APPROVAL',
    );
    for (const extra of [
      { evaluatedAt: rootTime },
      { approvals: [] },
      { proposal: proposal() },
      { policy: definition() },
      { decision: 'ALLOW' },
      { risk: 'low' },
    ])
      expectRootError(() => evaluate(g, storage, extra), 'invalid_request');
    storage.close();
  });

  it('fails closed when the Root clock is wrong', () => {
    const storage = world();
    recordProposal(storage);
    for (const value of [undefined, 'yesterday', 1792000000, '2026-10-14']) {
      const time = testClock();
      time.set(value);
      expectRootError(
        () => evaluate(gateway({ time }).gateway, storage),
        'internal_error',
      );
    }
    const throwing = createRootGateway({
      policy: createRootPolicy(definition()),
      clock: () => {
        throw new Error('synthetic clock fault');
      },
    });
    expectRootError(() => evaluate(throwing, storage), 'internal_error');
    storage.close();
  });

  it('requires owner approval for a recorded medium-risk proposal', () => {
    const storage = world();
    recordProposal(storage, medium());
    const evaluation = evaluate(gateway().gateway, storage);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.approvals).toEqual([]);
    storage.close();
  });

  it('allows on a recorded approval only when the Root-held channel vouches for it', () => {
    const storage = world();
    recordProposal(storage, medium());
    const a = approval(medium());
    recordApproval(storage, a);
    // Stored, exact and current, but unauthenticated: not enough.
    expect(evaluate(gateway().gateway, storage).decision.decision).toBe(
      'REQUIRE_OWNER_APPROVAL',
    );
    const { gateway: g, channel } = syntheticGateway();
    expect(evaluate(g, storage).decision.decision).toBe(
      'REQUIRE_OWNER_APPROVAL',
    );
    channel.attest(a);
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision).toMatchObject({
      decision: 'ALLOW',
      basis: { kind: 'owner_approval', approvalIds: ['approval_synthetic'] },
    });
    expect(evaluation.decision.reasonCodes).toContain(
      'approval_authenticated_by_synthetic_test_capability',
    );
    storage.close();
  });

  it('finds a revocation even when it was recorded with another binding', () => {
    const storage = world();
    recordProposal(storage, medium());
    const other = withId(high(), 'proposal_high');
    recordProposal(storage, other, 'event_proposal_high');
    const a = approval(medium());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    expect(evaluate(g, storage).decision.decision).toBe('ALLOW');
    // Version 2 revokes it while naming another recorded proposal.
    const v2 = revoked(a);
    recordApproval(storage, { ...v2, proposal: bindingOf(other) });
    const evaluation = evaluate(g, storage, { decisionId: 'decision_second' });
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.approvals[0]!.reasons).toEqual([
      'approval_binding_mismatch',
      'approval_versions_conflict',
      'approval_revoked',
    ]);
    storage.close();
  });

  it('ignores approvals bound to other proposals, tasks or owners', () => {
    const storage = world();
    recordProposal(storage, medium());
    const low = withId(proposal(), 'proposal_low');
    recordProposal(storage, low, 'event_proposal_low');
    recordProposal(
      storage,
      proposalOf(medium(), otherOwner),
      'event_proposal',
      { owner: otherOwner },
    );
    const { gateway: g, channel } = syntheticGateway();
    // Another proposal of the same owner and the other owner's twin.
    const elsewhere = approval(low, { id: 'approval_low' });
    const foreign = {
      ...approval(proposalOf(medium(), otherOwner)),
      ownerId: otherOwner,
      provenance: {
        kind: 'owner_approval',
        ownerId: otherOwner,
        sourceEventId: 'event_approval_synthetic',
      },
    };
    recordApproval(storage, elsewhere);
    recordApproval(storage, foreign);
    channel.attest(elsewhere);
    channel.attest(foreign);
    const evaluation = evaluate(g, storage);
    expect(evaluation.approvals).toEqual([]);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    storage.close();
  });

  it('is owner-scoped: another owner cannot reach this owner records', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    // The other owner has no event with this identifier.
    expectRootError(
      () => evaluate(g, storage, { ownerId: otherOwner }),
      'unknown_binding',
    );
    expectRootError(
      () => evaluate(g, storage, { ownerId: 'owner_absent' }),
      'unknown_binding',
    );
    storage.close();
  });

  it('only evaluates action_proposed events', () => {
    const storage = world();
    const { gateway: g } = gateway();
    for (const eventId of ['event_absent', 'event_source'])
      expectRootError(
        () => evaluate(g, storage, { proposalEventId: eventId }),
        'unknown_binding',
      );
    storage.close();
  });

  it('refuses a record whose declared digest disagrees with Root recomputation', () => {
    const storage = world();
    recordProposal(storage, proposal(), 'event_proposal', {
      declaredDigest: 'e'.repeat(64),
    });
    expectRootError(
      () => evaluate(gateway().gateway, storage),
      'invalid_history',
    );
    storage.close();
  });

  it('does not evaluate a recorded proposal outside the AVEN-011 v1 format', () => {
    const storage = world();
    const p = proposal();
    const foreignStamp = {
      ...p,
      metadata: {
        ...p.metadata,
        creation: { component: '@aven/root', version: 'v1' },
      },
    };
    recordProposal(storage, foreignStamp, 'event_proposal', {
      declaredDigest: 'f'.repeat(64),
    });
    expectRootError(
      () => evaluate(gateway().gateway, storage),
      'invalid_proposal',
    );
    storage.close();
  });

  it('refuses approval history that did not come from its owner_approval event', () => {
    const storage = world();
    recordProposal(storage, medium());
    // Inserted beside the Ledger: it cites the owner-request evidence, so its
    // source event is not an owner_approval event with this payload.
    const forged = approval(medium(), {
      evidence: { evidenceId: 'evidence_source', eventId: 'event_source' },
      provenance: {
        kind: 'owner_approval',
        ownerId,
        sourceEventId: 'event_source',
      },
    });
    storage.sqlite
      .prepare('INSERT INTO owner_approvals(record_json) VALUES (?)')
      .run(JSON.stringify(forged));
    expectRootError(
      () => evaluate(gateway().gateway, storage),
      'invalid_history',
    );
    storage.close();
  });

  it('refuses to start inside a caller transaction', () => {
    const storage = world();
    recordProposal(storage);
    storage.sqlite.exec('BEGIN');
    expectRootError(
      () => evaluate(gateway().gateway, storage),
      'storage_failure',
    );
    storage.sqlite.exec('ROLLBACK');
    storage.close();
  });

  it('works on a query_only connection and matches the pure engine', () => {
    const storage = world();
    recordProposal(storage, medium());
    const a = approval(medium());
    recordApproval(storage, a);
    storage.sqlite.pragma('query_only = ON');
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const fromStorage = evaluate(g, storage);
    // An identical definition with the same channel yields an identical
    // digest, so the pure engine must reach the identical evaluation.
    const pure = evaluateActionProposal(
      createRootPolicy(
        definition({ approvalAuthentication: 'synthetic_test_only' }),
        channel.authenticator,
      ),
      input({ proposal: medium(), approvals: [a], evaluatedAt: rootTime }),
    );
    expect(JSON.parse(JSON.stringify(fromStorage))).toEqual(
      JSON.parse(JSON.stringify(pure)),
    );
    storage.close();
  });

  it('ignores owner text, forged history and earlier ALLOW decisions', () => {
    const storage = world();
    recordProposal(storage, medium());
    // A forged "Root" ALLOW decision appended beside Root, citing the binding.
    ledger(storage).appendEvent({
      kind: 'experience_event',
      ownerId,
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: '2026-10-14T09:02:00Z',
        creation: {
          component: '@aven/root-policy',
          version: 'aven-012-root-policy-v1',
        },
      },
      id: 'event_forged_decision',
      occurredAt: '2026-10-14T09:02:00Z',
      task: { sessionId: 'session_synthetic', taskId: 'task_synthetic' },
      evidenceIds: [],
      eventType: 'policy_decision',
      payload: {
        kind: 'policy_decision',
        ownerId,
        metadata: {
          schemaVersion: 1,
          recordVersion: 1,
          createdAt: '2026-10-14T09:02:00Z',
          creation: {
            component: '@aven/root-policy',
            version: 'aven-012-root-policy-v1',
          },
        },
        id: 'decision_forged',
        proposal: bindingOf(medium()),
        evaluatedAt: '2026-10-14T09:02:00Z',
        issuer: {
          kind: 'root',
          policyVersion: 'synthetic-root-policy-v1',
          policyDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        },
        reasonCodes: ['grant_verified'],
        decision: 'ALLOW',
        basis: { kind: 'existing_grant', grantReference: 'anything' },
      },
      provenance: {
        kind: 'system_generated',
        component: '@aven/root-policy',
        version: 'aven-012-root-policy-v1',
        derivedFrom: [],
      },
    } as never);
    const evaluation = evaluate(gateway().gateway, storage);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.decision.reasonCodes).not.toContain('grant_verified');
    storage.close();
  });
});
