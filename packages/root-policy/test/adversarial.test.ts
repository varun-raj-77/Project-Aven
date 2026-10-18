// AVEN-012 Patch 4: the cross-layer adversarial campaign (tests only). All
// data is SYNTHETIC; hostile texts are deliberate. It exercises the pure
// engine, the gateway and the recorder together on file-backed SQLite and in
// a fresh query_only process, and checks Root's invariants over a seeded
// sweep of generated proposals, approvals, policies and clocks. Nothing here
// executes a tool or changes owner state.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PolicyDecisionSchema,
  type ActionProposal,
  type OwnerApproval,
} from '@aven/contracts';
import { openStorage, type Storage } from '@aven/storage';
import {
  ROOT_DENY_ALL_POLICY_DEFINITION,
  ROOT_V1_REFERENCE_RISK_TABLE,
  RootPolicyError,
  createRootPolicy,
  evaluateActionProposal,
  revalidateProposal,
  type RootEvaluation,
  type RootPolicy,
} from '../src/index.ts';
import {
  createRootGateway,
  evaluateRecordedProposal,
  recordRootDecision,
  reconcileRootDecisionRecording,
} from '../src/ledger/index.ts';
import { createSyntheticApprovalChannel } from '../src/testing/index.ts';
import {
  A,
  B,
  SCENARIO_TIME,
  buildScenario,
  rootPipeline,
  scenarioApprovals,
  scenarioRoot,
  seeded,
} from './adversarial-fixtures.ts';
import {
  approval,
  bindingOf,
  clone,
  definition,
  expectRootError,
  high,
  input,
  medium,
  ownerId,
  proposal,
  proposalFor,
  revoked,
  sessionId,
  taskId,
} from './fixtures.ts';
import {
  counts,
  delta,
  dump,
  evaluate,
  faultyCommit,
  gateway,
  ledger,
  otherTask,
  recordApproval,
  recordProposal,
  syntheticGateway,
  testClock,
  withId,
  world,
} from './ledger-fixtures.ts';

const opened: Storage[] = [];
const dirs: string[] = [];
const track = (storage: Storage) => {
  opened.push(storage);
  return storage;
};
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven012-adversarial-'));
  dirs.push(dir);
  return join(dir, 'aven.sqlite');
}
afterEach(() => {
  for (const storage of opened.splice(0))
    try {
      storage.close();
    } catch {
      // already closed
    }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Tables no AVEN-012 path may ever touch. */
const UNTOUCHED = [
  'tool_executions',
  'verification_results',
  'learned_owner_state',
  'active_task_state',
  'learning_candidates',
  'no_useful_lessons',
  'lifecycle_records',
  'evaluations',
  'corrections',
];

// File-backed SQLite and a child Node process are slow on loaded Windows
// runners; these tests carry explicit timeouts instead of the 5 s default.
const SLOW = { timeout: 120_000 };

describe('the scenario end to end, file-backed and in a fresh process', () => {
  it('decides every scenario proposal as the policy requires', SLOW, () => {
    const storage = track(buildScenario(file()));
    const pipeline = rootPipeline(storage);
    expect(
      pipeline.map((r) => [r.owner, r.eventId, r.decision ?? r.error]),
    ).toEqual([
      [A, 'event_low', 'ALLOW'],
      [A, 'event_medium', 'ALLOW'],
      [A, 'event_high', 'ALLOW'],
      [A, 'event_unknown', 'DENY'],
      [A, 'event_conflict', 'DENY'],
      [A, 'event_injected', 'REQUIRE_OWNER_APPROVAL'],
      [A, 'event_cites', 'REQUIRE_OWNER_APPROVAL'],
      [B, 'event_medium', 'REQUIRE_OWNER_APPROVAL'],
      [A, 'event_absent', 'unknown_binding'],
      [A, 'event_source', 'unknown_binding'],
    ]);
    const byEvent = (owner: string, eventId: string) =>
      pipeline.find((r) => r.owner === owner && r.eventId === eventId)!;
    expect(byEvent(A, 'event_low').basis).toMatchObject({
      kind: 'existing_grant',
    });
    expect(byEvent(A, 'event_medium')).toMatchObject({
      basis: { kind: 'owner_approval', approvalIds: ['approval_medium_ok'] },
      approvals: [
        ['approval_medium_ok', 'verified'],
        ['approval_medium_revoked', 'rejected'],
        ['approval_medium_unattested', 'rejected'],
      ],
    });
    expect(byEvent(A, 'event_high').reasonCodes).toContain(
      'declared_risk_not_authority',
    );
    expect(byEvent(A, 'event_cites').reasonCodes).toContain(
      'cited_approvals_not_authority',
    );
    expect(byEvent(B, 'event_medium').approvals).toEqual([
      ['approval_medium_ok', 'rejected'],
    ]);
  });

  it(
    'replays the whole pipeline in a separate query_only process without writing',
    SLOW,
    () => {
      const path = file();
      const storage = buildScenario(path);
      const inProcess = JSON.stringify(rootPipeline(storage));
      const before = dump(storage);
      storage.close();
      const fixtures = new URL('./adversarial-fixtures.ts', import.meta.url);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { replayInFreshProcess } from ${JSON.stringify(fixtures.href)};
         replayInFreshProcess(process.argv[1]);`,
          path,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      const replay = JSON.parse(output) as {
        pid: number;
        queryOnly: number;
        changesBefore: number;
        changesAfter: number;
        stateUnchanged: boolean;
        pipeline: string;
      };
      expect(replay.pid).not.toBe(process.pid);
      expect(replay.queryOnly).toBe(1);
      expect(replay.changesAfter).toBe(replay.changesBefore);
      expect(replay.stateUnchanged).toBe(true);
      expect(replay.pipeline).toBe(inProcess);
      expect(dump(track(openStorage(path)))).toBe(before);
    },
  );

  it(
    'records every scenario decision on a second connection and reconciles each',
    SLOW,
    () => {
      const path = file();
      const writer = track(buildScenario(path));
      const { gateway: g } = scenarioRoot();
      const reader = track(openStorage(path));
      const before = counts(writer);
      const receipts = Object.entries({
        event_low: 'ALLOW',
        event_medium: 'ALLOW',
        event_high: 'ALLOW',
        event_unknown: 'DENY',
        event_conflict: 'DENY',
        event_injected: 'REQUIRE_OWNER_APPROVAL',
        event_cites: 'REQUIRE_OWNER_APPROVAL',
      }).map(([eventId, expected], i) => {
        const evaluation = evaluateRecordedProposal(g, writer, {
          ownerId: A,
          proposalEventId: eventId,
          decisionId: `decision_${i}`,
        });
        const receipt = recordRootDecision(g, writer, evaluation, {
          eventId: `event_decision_${i}`,
        });
        expect(receipt.decision).toBe(expected);
        expect(
          reconcileRootDecisionRecording(reader, evaluation, {
            eventId: `event_decision_${i}`,
          }),
        ).toEqual({
          status: 'recorded',
          sequence: receipt.sequence,
          recordedAt: receipt.recordedAt,
        });
        return receipt;
      });
      const changed = delta(before, counts(writer));
      expect(changed.experience_events).toBe(receipts.length);
      expect(changed.policy_decisions).toBe(receipts.length);
      for (const table of [...UNTOUCHED, 'owner_approvals', 'action_proposals'])
        expect(changed[table]).toBeUndefined();
      for (const table of UNTOUCHED) expect(counts(writer)[table]).toBe(0);
    },
  );
});

describe('forged, unverified and replayed approvals', () => {
  it('never allows on a stored approval the Root-held channel did not vouch for', () => {
    const storage = track(world());
    recordProposal(storage, high());
    const a = approval(high());
    recordApproval(storage, a);
    // Every look-alike of a capability is refused at policy creation.
    const { channel } = syntheticGateway();
    for (const forged of [
      { ...channel.authenticator },
      { kind: 'synthetic_test_only', notice: channel.authenticator.notice },
    ])
      expectRootError(
        () =>
          createRootPolicy(
            definition({ approvalAuthentication: 'synthetic_test_only' }),
            forged,
          ),
        'untrusted_capability',
      );
    // A channel that attested a near-identical approval (one field changed).
    const near = syntheticGateway();
    near.channel.attest({ ...a, expiresAt: '2026-10-14T10:01:00.000001Z' });
    near.channel.attest({ ...a, id: 'approval_other' });
    near.channel.attest({
      ...a,
      proposal: {
        ...a.proposal,
        parametersDigest: { algorithm: 'sha256', value: 'd'.repeat(64) },
      },
    });
    const evaluation = evaluate(near.gateway, storage);
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.approvals[0]!.reasons).toEqual([
      'approval_not_authenticated',
    ]);
  });

  it('never accepts an approval of one proposal for another (replay across proposals)', () => {
    const { policy, channel } = (() => {
      const c = createSyntheticApprovalChannel();
      return {
        channel: c,
        policy: createRootPolicy(
          definition({ approvalAuthentication: 'synthetic_test_only' }),
          c.authenticator,
        ),
      };
    })();
    const original = medium();
    const a = approval(original);
    channel.attest(a);
    // A re-proposal differing in any single field gets a new digest.
    const variants = [
      withId(original, 'proposal_again'),
      { ...original, action: 'edit_document' },
      {
        ...original,
        consequences: { ...original.consequences, description: 'Again.' },
      },
      { ...original, priorApprovalIds: ['approval_synthetic'] },
      {
        ...original,
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'synthetic:parameters-2',
            digest: { algorithm: 'sha256', value: 'b'.repeat(64) },
          },
        },
      },
      {
        ...original,
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'synthetic:parameters',
            digest: { algorithm: 'sha256', value: 'c'.repeat(64) },
          },
        },
      },
    ];
    let allowed = 0;
    for (const variant of variants) {
      const evaluation = evaluateActionProposal(
        policy,
        input({ proposal: variant, approvals: [a] }),
      );
      if (evaluation.decision.decision === 'ALLOW') allowed += 1;
      if (
        evaluation.binding.proposalDigest.value !==
        a.proposal.proposalDigest.value
      )
        expect(evaluation.approvals[0]!.reasons).toContain(
          'approval_binding_mismatch',
        );
    }
    // The unchanged action string is the identical proposal; all others fail.
    expect(allowed).toBe(1);
  });

  it('rejects stale, expired, not-yet-valid and revoked approvals at Root time', () => {
    const storage = track(world());
    recordProposal(storage, medium());
    const a = approval(medium());
    recordApproval(storage, a);
    const time = testClock();
    const { channel, gateway: g } = (() => {
      const c = createSyntheticApprovalChannel();
      c.attest(a);
      return {
        channel: c,
        gateway: createRootGateway({
          policy: createRootPolicy(
            definition({
              approvalAuthentication: 'synthetic_test_only',
              approvalMaxAgeSeconds: 1800,
            }),
            c.authenticator,
          ),
          clock: time.clock,
        }),
      };
    })();
    expect(channel.authenticator.kind).toBe('synthetic_test_only');
    const at = (t: string) => {
      time.set(t);
      return evaluate(g, storage).approvals[0]!.reasons;
    };
    expect(at('2026-10-14T09:05:00Z')).toEqual([]);
    expect(at('2026-10-14T09:00:30Z')).toEqual(['approval_not_yet_valid']);
    expect(at('2026-10-14T09:31:00.5Z')).toEqual(['approval_stale']);
    expect(at('2026-10-14T10:01:00Z')).toEqual([
      'approval_expired',
      'approval_stale',
    ]);
    recordApproval(storage, revoked(a));
    expect(at('2026-10-14T09:05:00Z')).toEqual(['approval_revoked']);
  });
});

describe('declared risk is never authority', () => {
  const consequential = [
    ['synthetic-mail', 'send_message', 'send', 'message'],
    ['synthetic-docs', 'publish_document', 'publish', 'document'],
    ['synthetic-files', 'delete_file', 'delete', 'file'],
    ['synthetic-docs', 'edit_document', 'modify', 'document'],
  ] as const;
  const catalogued = createRootPolicy(
    definition({
      actions: [
        ...definition().actions,
        {
          toolId: 'synthetic-docs',
          action: 'publish_document',
          operation: 'publish',
          resourceKind: 'document',
          reversibility: 'irreversible',
        },
        {
          toolId: 'synthetic-files',
          action: 'delete_file',
          operation: 'delete',
          resourceKind: 'file',
          reversibility: 'irreversible',
        },
      ],
      // An owner-scoped grant on every low-risk action of the catalog.
      grants: [
        ...definition().grants,
        {
          grantId: 'grant_owner_wide',
          ownerId,
          toolId: 'synthetic-sandbox-tool',
          action: 'draft',
          resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
          scope: { kind: 'owner' },
          validFrom: '2026-10-01T00:00:00Z',
          validUntil: '2026-11-01T00:00:00Z',
        },
      ],
    }),
  );

  it.each(consequential)(
    '%s/%s declared low and reversible still requires an owner',
    (toolId, action, operation, kind) => {
      for (const consequences of [
        { risk: 'low', reversibility: 'reversible' },
        { risk: 'low', reversibility: 'irreversible' },
        { risk: 'medium', reversibility: 'reversible' },
      ]) {
        const evaluation = evaluateActionProposal(
          catalogued,
          input({
            proposal: proposalFor(
              toolId,
              action,
              operation,
              { kind, identifier: 'synthetic-target' },
              consequences,
            ),
          }),
        );
        expect(evaluation.decision.decision).not.toBe('ALLOW');
        expect(['medium', 'high']).toContain(
          evaluation.classification.rootRisk,
        );
        expect(
          evaluation.classification.effectiveRisk === 'high' ||
            evaluation.classification.rootRisk === 'medium',
        ).toBe(true);
      }
    },
  );

  it('denies all high risk when the policy denies high risk, whatever is declared', () => {
    const strict = createRootPolicy(definition({ highRisk: 'deny' }));
    for (const risk of ['low', 'medium', 'high', 'unknown']) {
      const evaluation = evaluateActionProposal(
        strict,
        input({
          proposal: {
            ...high(),
            consequences: { ...high().consequences, risk },
          },
        }),
      );
      expect(evaluation.decision.decision).toBe('DENY');
    }
  });
});

describe('cross-owner and cross-task references', () => {
  it('keeps owners apart: identical identifiers never cross', () => {
    const storage = track(buildScenario());
    const { gateway: g } = scenarioRoot();
    const ofB = evaluateRecordedProposal(g, storage, {
      ownerId: B,
      proposalEventId: 'event_medium',
      decisionId: 'decision_b',
    });
    // Owner A's attested approval with the same identifier does not count.
    expect(ofB.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(ofB.decision.ownerId).toBe(B);
    for (const proposalEventId of ['event_low', 'event_high', 'event_cites'])
      expectRootError(
        () =>
          evaluateRecordedProposal(g, storage, {
            ownerId: B,
            proposalEventId,
            decisionId: 'decision_b',
          }),
        'unknown_binding',
      );
    // Owner A's grant never serves owner B.
    const twin = { ...proposal(), ownerId: B };
    expect(
      evaluateActionProposal(
        createRootPolicy(definition()),
        input({ ownerId: B, proposal: twin }),
      ).decision.decision,
    ).toBe('REQUIRE_OWNER_APPROVAL');
  });

  it('keeps tasks apart: a task grant or approval never serves another task', () => {
    const p = createRootPolicy(definition());
    const elsewhere = { ...proposal(), task: { sessionId, taskId: otherTask } };
    expect(
      evaluateActionProposal(
        p,
        input({ taskId: otherTask, proposal: elsewhere }),
      ).decision.decision,
    ).toBe('REQUIRE_OWNER_APPROVAL');
    // The frozen storage refuses to store an approval bounded to another
    // task than its proposal; the pure engine rejects one if handed it.
    const storage = track(world());
    recordProposal(storage, medium());
    const crossTask = approval(medium(), {
      bounds: { sessionId, taskId: otherTask },
    });
    expect(() => recordApproval(storage, crossTask)).toThrow();
    const { policy, channel } = (() => {
      const c = createSyntheticApprovalChannel();
      return {
        channel: c,
        policy: createRootPolicy(
          definition({ approvalAuthentication: 'synthetic_test_only' }),
          c.authenticator,
        ),
      };
    })();
    channel.attest(crossTask);
    const evaluation = evaluateActionProposal(
      policy,
      input({ proposal: medium(), approvals: [crossTask] }),
    );
    expect(evaluation.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(evaluation.approvals[0]!.reasons).toEqual([
      'approval_scope_mismatch',
    ]);
  });

  it('never evaluates a proposal for another owner, session or task than its own', () => {
    const p = createRootPolicy(definition());
    for (const scope of [
      { ownerId: B },
      { sessionId: 'session_other' },
      { taskId: otherTask },
    ])
      expectRootError(
        () => evaluateActionProposal(p, input(scope)),
        'binding_mismatch',
      );
  });
});

describe('parameter and proposal digest mismatches', () => {
  it('binds the declared parameters digest and nothing else about parameters', () => {
    const evaluation = evaluateActionProposal(
      createRootPolicy(definition()),
      input(),
    );
    expect(evaluation.decision.proposal.parametersDigest).toEqual({
      algorithm: 'sha256',
      value: 'b'.repeat(64),
    });
    expect(evaluation.parameters.content).toBe('not_inspected');
    expect(evaluation.decision.reasonCodes).toContain(
      'parameters_bound_by_digest_only',
    );
    expect(evaluation.executionRequirement).toBe(
      'recheck_parameter_bytes_and_root_decision_at_execution',
    );
  });

  it('every single-leaf change of a proposal breaks an approval bound to it', () => {
    const { policy, channel } = (() => {
      const c = createSyntheticApprovalChannel();
      return {
        channel: c,
        policy: createRootPolicy(
          definition({ approvalAuthentication: 'synthetic_test_only' }),
          c.authenticator,
        ),
      };
    })();
    const original = medium();
    const a = approval(original);
    channel.attest(a);
    const leaves: (string | number)[][] = [];
    const walk = (value: unknown, path: (string | number)[]) => {
      if (typeof value === 'string' || typeof value === 'number')
        leaves.push(path);
      else if (Array.isArray(value))
        value.forEach((v, i) => walk(v, [...path, i]));
      else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    };
    walk(original, []);
    expect(leaves).toHaveLength(24);
    let checked = 0;
    let refused = 0;
    for (const path of leaves) {
      const mutated = clone(original) as Record<string | number, unknown>;
      let parent = mutated;
      for (const key of path.slice(0, -1))
        parent = parent[key] as Record<string | number, unknown>;
      const last = path.at(-1)!;
      parent[last] =
        typeof parent[last] === 'number'
          ? (parent[last] as number) + 1
          : `${String(parent[last])}x`;
      let evaluation: RootEvaluation;
      try {
        evaluation = evaluateActionProposal(
          policy,
          input({
            proposal: mutated,
            ownerId: (mutated as { ownerId: string }).ownerId,
            sessionId: (mutated.task as { sessionId: string }).sessionId,
            taskId: (mutated.task as { taskId: string }).taskId,
            approvals: [a],
          }),
        );
      } catch (error) {
        // Mutations outside the v1 format are not evaluated at all.
        expect(error).toBeInstanceOf(RootPolicyError);
        refused += 1;
        continue;
      }
      checked += 1;
      expect(evaluation.decision.decision).not.toBe('ALLOW');
    }
    // Ten single-leaf changes remain valid v1 proposals; none is allowed.
    expect([checked, refused]).toEqual([10, 14]);
  });

  it('refuses recorded proposals whose stored digest Root cannot reproduce', () => {
    const storage = track(world());
    recordProposal(storage, proposal(), 'event_proposal', {
      declaredDigest: bindingOf().proposalDigest.value.replace(/^./, (c) =>
        c === '0' ? '1' : '0',
      ),
    });
    expectRootError(
      () => evaluate(gateway().gateway, storage),
      'invalid_history',
    );
  });
});

describe('unknown and unsupported operation and resource combinations', () => {
  const OPERATIONS = [
    'read',
    'draft',
    'create',
    'modify',
    'delete',
    'send',
    'publish',
  ] as const;
  const KINDS = [
    'document',
    'file',
    'message',
    'sandbox_resource',
    'learned_state',
  ] as const;

  it('denies every combination Root has not catalogued', () => {
    const p = createRootPolicy(definition());
    let evaluated = 0;
    for (const operation of OPERATIONS)
      for (const kind of KINDS) {
        const target = { kind, identifier: 'synthetic-target' };
        const candidate = proposalFor(
          'synthetic-unlisted',
          operation,
          operation,
          target,
        );
        let decision: string;
        try {
          decision = evaluateActionProposal(p, input({ proposal: candidate }))
            .decision.decision;
        } catch (error) {
          // Learned-state changes are not even v1 proposals.
          expect((error as RootPolicyError).code).toBe('invalid_proposal');
          expect(kind).toBe('learned_state');
          continue;
        }
        evaluated += 1;
        expect(decision).toBe('DENY');
      }
    expect(evaluated).toBe(OPERATIONS.length * KINDS.length - 6);
  });

  it('cannot be configured to permit learning or learned-state changes', () => {
    for (const operation of [
      'promote_learning',
      'revoke_learning',
      'rollback_learning',
      'modify',
      'delete',
    ])
      expectRootError(
        () =>
          createRootPolicy(
            definition({
              riskTable: ROOT_V1_REFERENCE_RISK_TABLE.map((entry) =>
                entry.operation === operation &&
                entry.resourceKind === 'learned_state'
                  ? { ...entry, risk: 'low' }
                  : { ...entry },
              ),
            }),
          ),
        'invalid_policy',
      );
  });
});

describe('policy versions and the denial fallback', () => {
  it('an ALLOW recorded under one version grants nothing under the next', () => {
    const storage = track(world());
    recordProposal(storage);
    const v1 = gateway();
    const first = evaluate(v1.gateway, storage);
    recordRootDecision(v1.gateway, storage, first, {
      eventId: 'event_decision_v1',
    });
    expect(first.decision.decision).toBe('ALLOW');
    const v2 = gateway({
      policy: createRootPolicy(
        definition({ policyVersion: 'synthetic-root-policy-v2', grants: [] }),
      ),
    });
    const second = evaluate(v2.gateway, storage, { decisionId: 'decision_v2' });
    expect(second.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
    expect(second.decision.issuer.policyVersion).toBe(
      'synthetic-root-policy-v2',
    );
    const fallback = gateway({
      policy: createRootPolicy(ROOT_DENY_ALL_POLICY_DEFINITION),
    });
    const third = evaluate(fallback.gateway, storage, {
      decisionId: 'decision_fallback',
    });
    expect(third.decision.decision).toBe('DENY');
    // An evaluation of one version cannot be recorded through another.
    expectRootError(
      () =>
        recordRootDecision(fallback.gateway, storage, first, {
          eventId: 'event_decision_x',
        }),
      'untrusted_evaluation',
    );
  });

  it('a registered policy cannot be altered after creation', () => {
    const p = createRootPolicy(definition());
    expect(() => {
      (p.definition.grants as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (p as { policyVersion: string }).policyVersion =
        'synthetic-root-policy-v9';
    }).toThrow();
    expect(p.definition.grants).toHaveLength(1);
  });
});

describe('approval history at and beyond the v1 bound (independent finding F1)', () => {
  /** Appends versions 2..last of a scenario approval through the frozen Ledger. */
  function grow(
    storage: Storage,
    record: Record<string, unknown>,
    last: number,
    revokeLast: boolean,
  ) {
    for (let version = 2; version <= last; version += 1) {
      const eventId = `event_growth_${version}`;
      const next = clone(record) as Record<string, unknown>;
      next.metadata = {
        ...(record.metadata as Record<string, unknown>),
        recordVersion: version,
      };
      next.evidence = { eventId, evidenceId: `evidence_growth_${version}` };
      next.provenance = {
        kind: 'owner_approval',
        ownerId: A,
        sourceEventId: eventId,
      };
      if (revokeLast && version === last)
        next.lifecycle = {
          status: 'revoked',
          revokedAt: '2026-10-14T09:02:00Z',
          revocationEventId: eventId,
          reason: 'Synthetic revocation beyond the history bound.',
        };
      recordApproval(storage, next);
    }
  }
  const highApproval = () =>
    scenarioApprovals().records.find(
      (r) => r.id === 'approval_high_ok' && r.ownerId === A,
    )!;
  const decisions = (storage: Storage) =>
    (
      storage.sqlite
        .prepare(
          'SELECT count(*) AS n FROM policy_decisions WHERE owner_id = ?',
        )
        .get(A) as { n: number }
    ).n;

  it.each([
    [
      'revoked version 66 committed after evaluation',
      66,
      true,
      'invalid_history',
    ],
    [
      'revoked version 64 committed after evaluation',
      64,
      true,
      'stale_evaluation',
    ],
    ['issued history grown to 2 versions', 2, false, 'stale_evaluation'],
    ['issued history grown to 65 versions', 65, false, 'invalid_history'],
  ] as const)(
    'refuses %s on file-backed storage and writes no decision',
    (_name, last, revokeLast, code) => {
      const storage = track(buildScenario(file()));
      const { gateway: g } = scenarioRoot();
      const evaluation = evaluateRecordedProposal(g, storage, {
        ownerId: A,
        proposalEventId: 'event_high',
        decisionId: 'decision_history',
      });
      expect(evaluation.decision).toMatchObject({
        decision: 'ALLOW',
        basis: { kind: 'owner_approval', approvalIds: ['approval_high_ok'] },
      });
      grow(storage, highApproval(), last, revokeLast);
      const before = decisions(storage);
      let thrown: unknown;
      try {
        recordRootDecision(g, storage, evaluation, {
          eventId: 'event_history_decision',
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as RootPolicyError).code).toBe(code);
      expect((thrown as RootPolicyError).outcome).toBe('not_written');
      expect(decisions(storage)).toBe(before);
      // A fresh evaluation of a revoked or overflowing history never allows;
      // an intact, merely longer issued history may be evaluated anew.
      let again: string;
      try {
        again = evaluateRecordedProposal(g, storage, {
          ownerId: A,
          proposalEventId: 'event_high',
          decisionId: 'decision_history_again',
        }).decision.decision;
      } catch (error) {
        again = (error as RootPolicyError).code;
      }
      if (revokeLast || last > 64) expect(again).not.toBe('ALLOW');
      else expect(again).toBe('ALLOW');
    },
    120_000,
  );
});

describe('duplicate decision identifiers and storage failures', () => {
  it('never reuses a decision or event identifier, and writes nothing when refused', () => {
    const storage = track(buildScenario());
    const { gateway: g } = scenarioRoot();
    const evaluation = evaluateRecordedProposal(g, storage, {
      ownerId: A,
      proposalEventId: 'event_low',
      decisionId: 'decision_once',
    });
    recordRootDecision(g, storage, evaluation, { eventId: 'event_once' });
    const before = dump(storage);
    for (const [decisionId, eventId] of [
      ['decision_once', 'event_twice'],
      ['decision_twice', 'event_once'],
      ['decision_twice', 'event_medium'],
    ] as const) {
      const again = evaluateRecordedProposal(g, storage, {
        ownerId: A,
        proposalEventId: 'event_low',
        decisionId,
      });
      let thrown: unknown;
      try {
        recordRootDecision(g, storage, again, { eventId });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as RootPolicyError).code).toBe('identifier_collision');
      expect((thrown as RootPolicyError).outcome).toBe('not_written');
    }
    expect(dump(storage)).toBe(before);
  });

  it('reports read failures as storage failures, never as decisions', () => {
    const storage = track(buildScenario());
    const { gateway: g } = scenarioRoot();
    const broken = {
      ...storage,
      sqlite: new Proxy(storage.sqlite, {
        get(target, key) {
          if (key === 'prepare')
            return () => {
              throw new Error('synthetic read fault');
            };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    } as Storage;
    expectRootError(
      () =>
        evaluateRecordedProposal(g, broken, {
          ownerId: A,
          proposalEventId: 'event_low',
          decisionId: 'decision_x',
        }),
      'storage_failure',
    );
  });

  it(
    'a recording on a read-only connection fails with an unknown outcome and reconciles to not_recorded',
    SLOW,
    () => {
      const path = file();
      track(buildScenario(path)).close();
      const readOnly = track(openStorage(path));
      readOnly.sqlite.pragma('query_only = ON');
      const { gateway: g } = scenarioRoot();
      const evaluation = evaluateRecordedProposal(g, readOnly, {
        ownerId: A,
        proposalEventId: 'event_low',
        decisionId: 'decision_ro',
      });
      let thrown: unknown;
      try {
        recordRootDecision(g, readOnly, evaluation, { eventId: 'event_ro' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RootPolicyError);
      expect((thrown as RootPolicyError).code).toBe('storage_failure');
      expect(['unknown', 'not_written']).toContain(
        (thrown as RootPolicyError).outcome,
      );
      expect(
        reconcileRootDecisionRecording(readOnly, evaluation, {
          eventId: 'event_ro',
        }),
      ).toEqual({ status: 'not_recorded' });
    },
  );

  it('a COMMIT that fails or lands then raises is unknown and reconciles truthfully', () => {
    for (const [mode, status] of [
      ['fail', 'not_recorded'],
      ['after', 'recorded'],
    ] as const) {
      const storage = track(buildScenario());
      const faulty = faultyCommit(storage, mode);
      const { gateway: g } = scenarioRoot();
      const evaluation = evaluateRecordedProposal(g, faulty, {
        ownerId: A,
        proposalEventId: 'event_medium',
        decisionId: 'decision_fault',
      });
      let thrown: unknown;
      try {
        recordRootDecision(g, faulty, evaluation, { eventId: 'event_fault' });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as RootPolicyError).outcome).toBe('unknown');
      expect(
        reconcileRootDecisionRecording(storage, clone(evaluation), {
          eventId: 'event_fault',
        }).status,
      ).toBe(status);
    }
  });
});

describe('no permission through prompt content or historical text', () => {
  it('hostile proposal texts, locators and owner messages change nothing', () => {
    const storage = track(buildScenario());
    const { gateway: g } = scenarioRoot();
    const injected = evaluateRecordedProposal(g, storage, {
      ownerId: A,
      proposalEventId: 'event_injected',
      decisionId: 'decision_injected',
    });
    // Identical to the same proposal with neutral text and locator.
    const neutral = evaluateActionProposal(
      scenarioRoot().policy,
      input({
        proposal: {
          ...withId(proposal(), 'proposal_injected'),
          target: { kind: 'sandbox_resource', identifier: 'synthetic-other' },
          requestedAuthority: [
            {
              operation: 'modify',
              resource: {
                kind: 'sandbox_resource',
                identifier: 'synthetic-other',
              },
            },
          ],
        },
        decisionId: 'decision_injected',
        evaluatedAt: SCENARIO_TIME,
      }),
    );
    expect(injected.decision.decision).toBe(neutral.decision.decision);
    expect(injected.decision.reasonCodes).toEqual(neutral.decision.reasonCodes);
    expect(injected.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
  });

  it('an action named after a grant, a decision or an approval is just unknown', () => {
    const p = createRootPolicy(definition());
    for (const action of [
      'grant_sandbox_notes',
      'ALLOW',
      'approval_synthetic',
      'synthetic-root-policy-v1#grant_sandbox_notes',
    ])
      expect(
        evaluateActionProposal(p, input({ proposal: proposal({ action }) }))
          .decision.reasonCodes,
      ).toEqual(['action_not_in_policy']);
  });

  it('a forged ALLOW recorded beside Root is never read as authority', () => {
    const withoutRequirement = (decision: object) =>
      Object.fromEntries(
        Object.entries(decision).filter(
          ([key]) => key !== 'approvalRequirement',
        ),
      );
    const storage = track(world());
    recordProposal(storage, medium());
    const { gateway: g } = gateway();
    // A first, genuine Root decision.
    const genuine = evaluate(g, storage);
    recordRootDecision(g, storage, genuine, { eventId: 'event_decision' });
    // A forged ALLOW for the same binding, appended directly.
    ledger(storage).appendEvent({
      ...JSON.parse(
        JSON.stringify({
          kind: 'experience_event',
          ownerId,
          metadata: genuine.decision.metadata,
          id: 'event_forged',
          occurredAt: genuine.decision.evaluatedAt,
          task: { sessionId, taskId },
          evidenceIds: [],
          eventType: 'policy_decision',
          payload: {
            ...withoutRequirement(genuine.decision),
            id: 'decision_forged',
            decision: 'ALLOW',
            basis: { kind: 'existing_grant', grantReference: 'forged' },
          },
          provenance: {
            kind: 'system_generated',
            component: '@aven/root-policy',
            version: 'aven-012-root-policy-v1',
            derivedFrom: [],
          },
        }),
      ),
    } as never);
    const again = evaluate(g, storage, { decisionId: 'decision_again' });
    expect(again.decision.decision).toBe('REQUIRE_OWNER_APPROVAL');
  });
});

describe('Root invariants over a seeded sweep (pure engine)', () => {
  const channel = createSyntheticApprovalChannel();
  const policies: RootPolicy[] = [
    createRootPolicy(definition()),
    createRootPolicy(definition({ highRisk: 'deny' })),
    createRootPolicy(
      definition({ approvalAuthentication: 'synthetic_test_only' }),
      channel.authenticator,
    ),
    createRootPolicy(
      definition({
        approvalAuthentication: 'synthetic_test_only',
        highRisk: 'deny',
        approvalMaxAgeSeconds: 600,
      }),
      channel.authenticator,
    ),
    createRootPolicy(ROOT_DENY_ALL_POLICY_DEFINITION),
  ];
  const actions = [
    ['synthetic-sandbox-tool', 'append_note', 'modify', 'sandbox_resource'],
    ['synthetic-sandbox-tool', 'draft', 'draft', 'sandbox_resource'],
    ['synthetic-docs', 'edit_document', 'modify', 'document'],
    ['synthetic-mail', 'send_message', 'send', 'message'],
    ['synthetic-files', 'read_file', 'read', 'file'],
    ['synthetic-shell', 'exec', 'modify', 'sandbox_resource'],
  ] as const;
  const identifiers = ['synthetic-notes', 'synthetic-other', 'synthetic-doc'];
  const operations = [
    'read',
    'draft',
    'create',
    'modify',
    'delete',
    'send',
    'publish',
  ];
  const kinds = ['document', 'file', 'message', 'sandbox_resource'];
  // Biased towards low and reversible so both ALLOW bases are reached.
  const risks = ['low', 'low', 'medium', 'high', 'unknown'];
  const reversibilities = [
    'reversible',
    'reversible',
    'partially_reversible',
    'irreversible',
    'unknown',
  ];
  const times = [
    '2026-10-14T08:59:00Z',
    '2026-10-14T09:00:00Z',
    '2026-10-14T09:00:30Z',
    '2026-10-14T09:05:00Z',
    '2026-10-14T09:20:00Z',
    '2026-10-14T10:00:59Z',
    '2026-10-14T10:01:00Z',
    '2026-10-15T00:00:00Z',
  ];

  /** An independent oracle for "this approval may support an ALLOW". */
  function oracleVerifies(
    a: OwnerApproval,
    all: OwnerApproval[],
    p: ActionProposal,
    at: string,
    maxAge: number,
    attested: Set<OwnerApproval>,
  ): boolean {
    const versions = all.filter((x) => x.id === a.id);
    const binding = revalidateProposal(p, {
      ownerId: p.ownerId,
      sessionId: p.task.sessionId,
      taskId: p.task.taskId,
    }).binding;
    const t = (s: string) => {
      const [date, rest] = s.split('T');
      return Date.parse(`${date}T${rest}`);
    };
    return (
      versions.every(
        (v) =>
          v.ownerId === p.ownerId &&
          JSON.stringify(v.proposal) === JSON.stringify(binding) &&
          v.bounds.sessionId === p.task.sessionId &&
          v.bounds.taskId === p.task.taskId &&
          v.lifecycle.status === 'issued' &&
          v.issuedAt === versions[0]!.issuedAt &&
          v.expiresAt === versions[0]!.expiresAt,
      ) &&
      t(a.issuedAt) >= t(p.metadata.createdAt) &&
      t(a.issuedAt) <= t(at) &&
      t(at) < t(a.expiresAt) &&
      t(a.issuedAt) + maxAge * 1000 >= t(at) &&
      [...attested].some(
        (x) =>
          x.id === a.id &&
          JSON.stringify(x.proposal) === JSON.stringify(a.proposal) &&
          x.issuedAt === a.issuedAt &&
          x.expiresAt === a.expiresAt &&
          x.ownerId === a.ownerId &&
          JSON.stringify(x.bounds) === JSON.stringify(a.bounds),
      )
    );
  }

  it(
    'holds every invariant on 2,500 generated cases',
    { timeout: 300_000 },
    () => {
      const rng = seeded(20261015);
      const attested = new Set<OwnerApproval>();
      const tally: Record<string, number> = {};
      for (let i = 0; i < 2500; i += 1) {
        const [toolId, action, operation, kind] = rng.pick(actions);
        const target = {
          kind: rng.chance(0.85) ? kind : rng.pick(kinds),
          identifier: rng.pick(identifiers),
        };
        const requested = rng.chance(0.8)
          ? [{ operation, resource: { ...target } }]
          : [
              {
                operation: rng.pick(operations),
                resource: {
                  kind: rng.pick(kinds),
                  identifier: rng.pick(identifiers),
                },
              },
              ...(rng.chance(0.5)
                ? [{ operation, resource: { ...target } }]
                : []),
            ];
        const task = rng.chance(0.85) ? taskId : otherTask;
        const candidate = {
          ...proposal(),
          id: `proposal_${rng.int(4)}`,
          task: { sessionId, taskId: task },
          toolId,
          action,
          target,
          requestedAuthority: requested,
          consequences: {
            risk: rng.pick(risks),
            reversibility: rng.pick(reversibilities),
            description: 'Synthetic generated case.',
          },
          priorApprovalIds: rng.chance(0.3) ? ['approval_cited'] : [],
        } as unknown as ActionProposal;
        const approvals: OwnerApproval[] = [];
        for (let k = rng.int(3); k > 0; k -= 1) {
          const bound = rng.chance(0.7)
            ? candidate
            : ({ ...candidate, id: 'proposal_elsewhere' } as ActionProposal);
          let record = approval(bound as never, {
            id: `approval_${rng.int(3)}`,
            issuedAt: rng.pick([
              '2026-10-14T08:30:00Z',
              '2026-10-14T09:01:00Z',
              '2026-10-14T09:04:00Z',
            ]),
            expiresAt: rng.pick([
              '2026-10-14T09:10:00Z',
              '2026-10-14T10:01:00Z',
            ]),
            bounds: { sessionId, taskId: task },
          }) as unknown as OwnerApproval;
          if (rng.chance(0.15))
            record = revoked(record as never, '2026-10-14T09:10:00Z') as never;
          if (
            approvals.some(
              (x) =>
                x.id === record.id &&
                x.metadata.recordVersion === record.metadata.recordVersion,
            )
          )
            continue;
          approvals.push(record);
          if (rng.chance(0.6)) {
            channel.attest(record);
            attested.add(record);
          }
        }
        const policy = rng.pick(policies);
        const evaluatedAt = rng.pick(times);
        const request = input({
          taskId: task,
          proposal: candidate,
          evaluatedAt,
          decisionId: `decision_${i}`,
          approvals,
        });
        let evaluation: RootEvaluation;
        try {
          evaluation = evaluateActionProposal(policy, request);
        } catch (error) {
          expect(error).toBeInstanceOf(RootPolicyError);
          tally.error = (tally.error ?? 0) + 1;
          continue;
        }
        const d = evaluation.decision;
        tally[d.decision] = (tally[d.decision] ?? 0) + 1;
        // I1: a valid frozen decision, issued by the registered policy.
        expect(PolicyDecisionSchema.safeParse(d).success).toBe(true);
        expect(d.issuer).toEqual({
          kind: 'root',
          policyVersion: policy.policyVersion,
          policyDigest: policy.policyDigest,
        });
        expect(d.id).toBe(`decision_${i}`);
        // I2: deterministic.
        expect(evaluateActionProposal(policy, request)).toEqual(evaluation);
        const catalogued = policy.definition.actions.some(
          (a) => a.toolId === toolId && a.action === action,
        );
        // I3: anything not catalogued is DENY.
        if (!catalogued) expect(d.decision).toBe('DENY');
        // I4: the effective risk is never below Root's classification.
        const order = { low: 0, medium: 1, high: 2 } as const;
        const root = evaluation.classification.rootRisk;
        if (
          evaluation.classification.effectiveRisk !== null &&
          root !== null &&
          root !== 'forbidden' &&
          root !== 'unclassified'
        )
          expect(
            order[evaluation.classification.effectiveRisk],
          ).toBeGreaterThanOrEqual(order[root]);
        if (d.decision !== 'ALLOW') continue;
        // I5: a grant only ever allows low effective risk, with a real grant.
        if (d.basis.kind === 'existing_grant') {
          expect(evaluation.classification.effectiveRisk).toBe('low');
          const reference = d.basis.grantReference;
          const grant = policy.definition.grants.find(
            (g) => `${policy.policyVersion}#${g.grantId}` === reference,
          );
          expect(grant).toBeDefined();
          expect(grant!.ownerId).toBe(candidate.ownerId);
          expect(grant!.resource).toEqual(candidate.target);
          tally.grant = (tally.grant ?? 0) + 1;
        } else {
          // I6: approval-based ALLOW needs Root-held authentication and every
          // relied-on approval must pass the independent oracle.
          expect(policy.approvalAuthentication).toBe('synthetic_test_only');
          for (const id of d.basis.approvalIds) {
            const a = approvals.find((x) => x.id === id)!;
            expect(
              oracleVerifies(
                a,
                approvals,
                candidate,
                evaluatedAt,
                policy.definition.approvalMaxAgeSeconds,
                attested,
              ),
            ).toBe(true);
          }
          if (evaluation.classification.effectiveRisk === 'high')
            expect(policy.definition.highRisk).toBe('require_owner_approval');
          tally.approval = (tally.approval ?? 0) + 1;
        }
      }
      // The sweep reached every outcome and both ALLOW bases.
      for (const key of [
        'ALLOW',
        'DENY',
        'REQUIRE_OWNER_APPROVAL',
        'grant',
        'approval',
      ])
        expect(tally[key] ?? 0).toBeGreaterThan(0);
    },
  );
});
