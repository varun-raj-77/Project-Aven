import { describe, expect, it } from 'vitest';
import { LedgerError } from '@aven/ledger';
import {
  ROOT_POLICY_CONFIG,
  RootPolicyError,
  createRootPolicy,
  evaluateActionProposal,
} from '../src/index.ts';
import {
  recordRootDecision,
  reconcileRootDecisionRecording,
} from '../src/ledger/index.ts';
import { ledgerFailure } from '../src/ledger/record.ts';
import { READ_SQL } from '../src/ledger/stored.ts';
import {
  bindingOf,
  clone,
  deeplyFrozen,
  definition,
  high,
  input,
  medium,
} from './fixtures.ts';
import {
  approval,
  counts,
  delta,
  dump,
  evaluate,
  faultyCommit,
  gateway,
  otherOwner,
  ownerId,
  proposal,
  proposalOf,
  recordApproval,
  recordProposal,
  revoked,
  rootTime,
  sessionId,
  syntheticGateway,
  taskId,
  world,
} from './ledger-fixtures.ts';

function expectFailure(
  run: () => unknown,
  code: string,
  outcome: 'not_written' | 'rolled_back' | 'unknown' = 'not_written',
) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RootPolicyError);
  expect((thrown as RootPolicyError).code).toBe(code);
  expect((thrown as RootPolicyError).outcome).toBe(outcome);
  expect((thrown as Error).cause).toBeUndefined();
}

const storedEvent = (storage: ReturnType<typeof world>, eventId: string) =>
  JSON.parse(
    (
      storage.sqlite
        .prepare(
          'SELECT record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
        )
        .get(ownerId, eventId) as { record_json: string }
    ).record_json,
  ) as Record<string, unknown>;

describe('recordRootDecision: one frozen policy_decision event', () => {
  it('records a grant-based ALLOW as exactly one event and one projection', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    const before = counts(storage);
    const receipt = recordRootDecision(g, storage, evaluation, {
      eventId: 'event_decision',
    });
    expect(receipt).toMatchObject({
      outcome: 'recorded',
      ownerId,
      eventId: 'event_decision',
      decisionId: 'decision_synthetic',
      decision: 'ALLOW',
      binding: bindingOf(),
      evaluatedAt: rootTime,
    });
    expect(deeplyFrozen(receipt)).toBe(true);
    expect(delta(before, counts(storage))).toEqual({
      experience_events: 1,
      policy_decisions: 1,
      record_keys: 2,
      record_versions: 2,
      // The event's task, session and proposal binding, and the
      // projection's proposal binding.
      record_references: 4,
    });
    const { recordedAt, ...event } = storedEvent(storage, 'event_decision');
    expect(recordedAt).toBe(receipt.recordedAt);
    expect(event).toEqual({
      kind: 'experience_event',
      ownerId,
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: rootTime,
        creation: {
          component: '@aven/root-policy',
          version: 'aven-012-root-policy-v1',
        },
      },
      id: 'event_decision',
      occurredAt: rootTime,
      task: { sessionId, taskId },
      evidenceIds: [],
      eventType: 'policy_decision',
      payload: clone(evaluation.decision),
      provenance: {
        kind: 'system_generated',
        component: '@aven/root-policy',
        version: 'aven-012-root-policy-v1',
        derivedFrom: [],
      },
    });
    storage.close();
  });

  it.each([
    ['REQUIRE_OWNER_APPROVAL', () => medium()],
    ['DENY', () => ({ ...proposal(), toolId: 'synthetic-unknown' })],
  ])('records a %s decision the same way', (decision, build) => {
    const storage = world();
    recordProposal(storage, build());
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision.decision).toBe(decision);
    expect(
      recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' })
        .decision,
    ).toBe(decision);
    storage.close();
  });

  it('derives an approval-based ALLOW from the approval evidence it relied on', () => {
    const storage = world();
    recordProposal(storage, high());
    const a = approval(high());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision.decision).toBe('ALLOW');
    recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' });
    expect(storedEvent(storage, 'event_decision').provenance).toEqual({
      kind: 'system_generated',
      component: '@aven/root-policy',
      version: 'aven-012-root-policy-v1',
      derivedFrom: [
        {
          evidenceId: 'evidence_approval_synthetic',
          eventId: 'event_approval_synthetic',
        },
      ],
    });
    storage.close();
  });

  it('records only evaluations this gateway produced from this storage', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    const pure = evaluateActionProposal(
      createRootPolicy(definition()),
      input({ evaluatedAt: rootTime }),
    );
    const before = dump(storage);
    for (const untrusted of [
      pure,
      clone(evaluation),
      { ...evaluation },
      {
        ...evaluation,
        decision: { ...evaluation.decision, decision: 'ALLOW' },
      },
    ])
      expectFailure(
        () =>
          recordRootDecision(g, storage, untrusted as never, {
            eventId: 'event_decision',
          }),
        'untrusted_evaluation',
      );
    // Another gateway with the same policy, or another connection.
    expectFailure(
      () =>
        recordRootDecision(gateway().gateway, storage, evaluation, {
          eventId: 'event_decision',
        }),
      'untrusted_evaluation',
    );
    expectFailure(
      () =>
        recordRootDecision(g, { ...storage }, evaluation, {
          eventId: 'event_decision',
        }),
      'untrusted_evaluation',
    );
    expect(dump(storage)).toBe(before);
    storage.close();
  });

  it('refuses an evaluation outside the recording window of the Root clock', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g, time } = gateway({ window: 30 });
    const evaluation = evaluate(g, storage);
    time.set('2026-10-14T09:05:30.000001Z');
    expectFailure(
      () =>
        recordRootDecision(g, storage, evaluation, {
          eventId: 'event_decision',
        }),
      'stale_evaluation',
    );
    time.set('2026-10-14T09:04:59Z');
    expectFailure(
      () =>
        recordRootDecision(g, storage, evaluation, {
          eventId: 'event_decision',
        }),
      'stale_evaluation',
    );
    time.set('2026-10-14T09:05:30Z');
    expect(
      recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' })
        .outcome,
    ).toBe('recorded');
    storage.close();
  });

  it('never records an approval basis revoked after the evaluation', () => {
    const storage = world();
    recordProposal(storage, medium());
    const a = approval(medium());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision.decision).toBe('ALLOW');
    recordApproval(storage, revoked(a));
    const before = dump(storage);
    expectFailure(
      () =>
        recordRootDecision(g, storage, evaluation, {
          eventId: 'event_decision',
        }),
      'stale_evaluation',
    );
    expect(dump(storage)).toBe(before);
    storage.close();
  });

  it('refuses reused decision and event identifiers without writing', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    recordRootDecision(g, storage, evaluate(g, storage), {
      eventId: 'event_decision',
    });
    const before = dump(storage);
    // Same decision identifier under a new event.
    expectFailure(
      () =>
        recordRootDecision(g, storage, evaluate(g, storage), {
          eventId: 'event_decision_2',
        }),
      'identifier_collision',
    );
    // New decision identifier under a used event identifier.
    for (const eventId of ['event_decision', 'event_source', 'event_proposal'])
      expectFailure(
        () =>
          recordRootDecision(
            g,
            storage,
            evaluate(g, storage, { decisionId: 'decision_other' }),
            { eventId },
          ),
        'identifier_collision',
      );
    expect(dump(storage)).toBe(before);
    storage.close();
  });

  it('refuses malformed requests and caller transactions without writing', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    for (const bad of [
      {},
      { eventId: 'decision_x' },
      { eventId: 'event_x', decision: 'ALLOW' },
      null,
    ])
      expectFailure(
        () => recordRootDecision(g, storage, evaluation, bad as never),
        'invalid_request',
      );
    storage.sqlite.exec('BEGIN');
    expectFailure(
      () =>
        recordRootDecision(g, storage, evaluation, {
          eventId: 'event_decision',
        }),
      'storage_failure',
    );
    storage.sqlite.exec('ROLLBACK');
    expect(
      recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' })
        .outcome,
    ).toBe('recorded');
    storage.close();
  });

  it('reports a COMMIT failure as unknown; reconciliation settles it', () => {
    const storage = world();
    recordProposal(storage);
    const faulty = faultyCommit(storage, 'fail');
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, faulty);
    expectFailure(
      () =>
        recordRootDecision(g, faulty, evaluation, {
          eventId: 'event_decision',
        }),
      'storage_failure',
      'unknown',
    );
    expect(
      reconcileRootDecisionRecording(storage, evaluation, {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'not_recorded' });
    storage.close();
  });

  it('reports a COMMIT that took effect and then failed as unknown; reconciled as recorded', () => {
    const storage = world();
    recordProposal(storage);
    const faulty = faultyCommit(storage, 'after');
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, faulty);
    expectFailure(
      () =>
        recordRootDecision(g, faulty, evaluation, {
          eventId: 'event_decision',
        }),
      'storage_failure',
      'unknown',
    );
    expect(
      reconcileRootDecisionRecording(storage, clone(evaluation), {
        eventId: 'event_decision',
      }),
    ).toMatchObject({ status: 'recorded' });
    storage.close();
  });

  it('records nothing that executes, approves or changes owner state', () => {
    const storage = world();
    recordProposal(storage, high());
    const a = approval(high());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const before = counts(storage);
    recordRootDecision(g, storage, evaluate(g, storage), {
      eventId: 'event_decision',
    });
    const changed = delta(before, counts(storage));
    for (const table of [
      'tool_executions',
      'verification_results',
      'owner_approvals',
      'learned_owner_state',
      'active_task_state',
      'learning_candidates',
      'lifecycle_records',
      'evaluations',
      'corrections',
      'action_proposals',
    ])
      expect(changed[table]).toBeUndefined();
    storage.close();
  });
});

describe('ledgerFailure: the frozen Ledger outcome mapping', () => {
  const mapped = (code: string, rollback: string) =>
    ledgerFailure(new LedgerError(code as never, 'x', rollback as never));
  it.each([
    ['transaction_active', 'not_started', 'storage_failure', 'not_written'],
    ['storage_failure', 'not_started', 'storage_failure', 'not_written'],
    ['invalid_event', 'not_started', 'ledger_rejected', 'not_written'],
    ['invalid_reference', 'not_started', 'ledger_rejected', 'not_written'],
    ['cross_owner_reference', 'not_started', 'internal_error', 'not_written'],
    ['duplicate_event', 'rolled_back', 'identifier_collision', 'rolled_back'],
    ['invalid_reference', 'rolled_back', 'ledger_rejected', 'rolled_back'],
    ['invalid_event', 'rolled_back', 'ledger_rejected', 'rolled_back'],
    ['unknown_owner', 'rolled_back', 'unknown_binding', 'rolled_back'],
    ['unknown_session', 'rolled_back', 'unknown_binding', 'rolled_back'],
    ['unknown_task', 'rolled_back', 'unknown_binding', 'rolled_back'],
    ['integrity_failure', 'rolled_back', 'storage_failure', 'rolled_back'],
    ['invalid_input', 'rolled_back', 'internal_error', 'rolled_back'],
    ['cross_owner_reference', 'rolled_back', 'internal_error', 'rolled_back'],
    ['storage_failure', 'rolled_back', 'storage_failure', 'unknown'],
    ['something_new', 'rolled_back', 'internal_error', 'unknown'],
    ['storage_failure', 'failed', 'storage_failure', 'unknown'],
    ['storage_failure', 'mystery', 'internal_error', 'unknown'],
  ])('%s with rollback %s -> %s / %s', (code, rollback, out, outcome) => {
    expect(mapped(code, rollback)).toEqual({ code: out, outcome });
  });

  it('treats a non-Ledger error as unknown', () => {
    expect(ledgerFailure(new Error('x'))).toEqual({
      code: 'internal_error',
      outcome: 'unknown',
    });
  });
});

/**
 * Independent review finding F1 (2026-10-17): the recorder's approval
 * recheck read at most 65 versions and treated that incomplete history as
 * proof of no revocation, so a revocation already committed at version 66
 * was recorded as an ALLOW basis. These regressions pin the corrected,
 * fail-closed behavior: more than 64 versions is refused (`invalid_history`),
 * any revoked version or any version set other than the evaluated one is
 * refused (`stale_evaluation`), and a refusal writes nothing.
 */
describe('recordRootDecision: complete approval history before an approval-based ALLOW (F1)', () => {
  const SLOW = { timeout: 120_000 };

  /** Appends versions 2..last of approval `a`, each with its own event and evidence; `revokeLast` revokes the last one. */
  function appendVersions(
    storage: ReturnType<typeof world>,
    a: ReturnType<typeof approval>,
    last: number,
    revokeLast: boolean,
    owner = ownerId,
  ) {
    for (let version = 2; version <= last; version += 1) {
      const eventId = `event_revision_${version}`;
      const next = clone(a) as Record<string, unknown> & typeof a;
      next.metadata = { ...a.metadata, recordVersion: version };
      next.evidence = { eventId, evidenceId: `evidence_revision_${version}` };
      next.provenance = {
        kind: 'owner_approval',
        ownerId: owner,
        sourceEventId: eventId,
      };
      if (revokeLast && version === last)
        (next as Record<string, unknown>).lifecycle = {
          status: 'revoked',
          revokedAt: '2026-10-14T09:02:00Z',
          revocationEventId: eventId,
          reason: 'Synthetic revocation at the history boundary.',
        };
      recordApproval(storage, next);
    }
  }

  /** A high-risk proposal, an attested approval and an approval-based ALLOW evaluation. */
  function allowed() {
    const storage = world();
    recordProposal(storage, high());
    const a = approval(high());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const evaluation = evaluate(g, storage);
    expect(evaluation.decision).toMatchObject({
      decision: 'ALLOW',
      basis: { kind: 'owner_approval' },
    });
    expect(evaluation.approvals[0]!.versions).toEqual([1]);
    return { storage, a, g, evaluation };
  }

  const decisionsOf = (storage: ReturnType<typeof world>, owner = ownerId) =>
    (
      storage.sqlite
        .prepare(
          'SELECT count(*) AS n FROM policy_decisions WHERE owner_id = ?',
        )
        .get(owner) as { n: number }
    ).n;
  const versionsOf = (storage: ReturnType<typeof world>, id: string) =>
    (
      storage.sqlite
        .prepare(
          'SELECT count(*) AS n FROM owner_approvals WHERE owner_id = ? AND record_id = ?',
        )
        .get(ownerId, id) as { n: number }
    ).n;

  it.each([
    [2, 'stale_evaluation'],
    [64, 'stale_evaluation'],
    [65, 'invalid_history'],
    [66, 'invalid_history'],
    [67, 'invalid_history'],
    [80, 'invalid_history'],
  ] as const)(
    'refuses a revocation committed at version %i before recording (%s) and writes nothing',
    (last, code) => {
      const { storage, a, g, evaluation } = allowed();
      try {
        appendVersions(storage, a, last, true);
        expect(versionsOf(storage, a.id)).toBe(last);
        const before = dump(storage);
        expectFailure(
          () =>
            recordRootDecision(g, storage, evaluation, {
              eventId: 'event_decision',
            }),
          code,
        );
        expect(decisionsOf(storage)).toBe(0);
        expect(dump(storage)).toBe(before);
      } finally {
        storage.close();
      }
    },
    120_000,
  );

  it(
    'refuses the independently reproduced version-66 attack without writing a decision',
    SLOW,
    () => {
      // Exactly the reviewer's reproduction: issued versions 2-65 and a revoked
      // version 66, all committed through the frozen Ledger before recording,
      // with the original evaluation, gateway, storage and an in-window clock.
      const { storage, a, g, evaluation } = allowed();
      try {
        appendVersions(storage, a, 66, true);
        let receipt: unknown;
        let thrown: unknown;
        try {
          receipt = recordRootDecision(g, storage, evaluation, {
            eventId: 'event_independent_decision',
          });
        } catch (error) {
          thrown = error;
        }
        expect(receipt).toBeUndefined();
        expect(thrown).toBeInstanceOf(RootPolicyError);
        expect((thrown as RootPolicyError).code).toBe('invalid_history');
        expect((thrown as RootPolicyError).outcome).toBe('not_written');
        expect(decisionsOf(storage)).toBe(0);
        // The Ledger itself was never asked to append.
        expect(
          storage.sqlite
            .prepare(
              "SELECT count(*) AS n FROM experience_events WHERE owner_id = ? AND event_type = 'policy_decision'",
            )
            .get(ownerId),
        ).toEqual({ n: 0 });
      } finally {
        storage.close();
      }
    },
  );

  it.each([
    [2, 'stale_evaluation'],
    [64, 'stale_evaluation'],
    [65, 'invalid_history'],
    [66, 'invalid_history'],
  ] as const)(
    'refuses issued history that grew to %i versions after evaluation (%s)',
    (last, code) => {
      const { storage, a, g, evaluation } = allowed();
      try {
        appendVersions(storage, a, last, false);
        expectFailure(
          () =>
            recordRootDecision(g, storage, evaluation, {
              eventId: 'event_decision',
            }),
          code,
        );
        expect(decisionsOf(storage)).toBe(0);
      } finally {
        storage.close();
      }
    },
    120_000,
  );

  it(
    'records an ALLOW over exactly 64 issued versions when nothing changed since evaluation',
    SLOW,
    () => {
      const storage = world();
      try {
        recordProposal(storage, high());
        const a = approval(high());
        recordApproval(storage, a);
        appendVersions(storage, a, 64, false);
        const { gateway: g, channel } = syntheticGateway();
        channel.attest(a);
        const evaluation = evaluate(g, storage);
        expect(evaluation.decision.decision).toBe('ALLOW');
        expect(evaluation.approvals[0]!.versions).toHaveLength(64);
        expect(
          recordRootDecision(g, storage, evaluation, {
            eventId: 'event_decision',
          }).decision,
        ).toBe('ALLOW');
        expect(decisionsOf(storage)).toBe(1);
      } finally {
        storage.close();
      }
    },
  );

  it(
    'never evaluates an approval whose history already exceeds 64 versions',
    SLOW,
    () => {
      const storage = world();
      try {
        recordProposal(storage, high());
        const a = approval(high());
        recordApproval(storage, a);
        appendVersions(storage, a, 65, false);
        const { gateway: g, channel } = syntheticGateway();
        channel.attest(a);
        expectFailure(() => evaluate(g, storage), 'invalid_history');
      } finally {
        storage.close();
      }
    },
  );

  it(
    'reads only this owner history: another owner with 66 versions of the same identifier changes nothing',
    SLOW,
    () => {
      const { storage, g, evaluation } = allowed();
      try {
        const twin = proposalOf(high(), otherOwner);
        recordProposal(storage, twin, 'event_proposal', { owner: otherOwner });
        const foreign = {
          ...approval(twin),
          ownerId: otherOwner,
          provenance: {
            kind: 'owner_approval',
            ownerId: otherOwner,
            sourceEventId: 'event_approval_synthetic',
          },
        } as ReturnType<typeof approval>;
        recordApproval(storage, foreign);
        appendVersions(storage, foreign, 66, true, otherOwner);
        expect(
          recordRootDecision(g, storage, evaluation, {
            eventId: 'event_decision',
          }).decision,
        ).toBe('ALLOW');
        expect(decisionsOf(storage)).toBe(1);
        expect(decisionsOf(storage, otherOwner)).toBe(0);
      } finally {
        storage.close();
      }
    },
  );

  it('keeps the approval statement bound at exactly one row beyond the v1 limit', () => {
    expect(READ_SQL.approvalVersions).toMatch(
      new RegExp(
        `ORDER BY record_version LIMIT ${ROOT_POLICY_CONFIG.limits.maxApprovalRecords + 1}$`,
      ),
    );
  });
});

/**
 * Independent review finding F2 (2026-10-17): the recording window is an
 * entry-time check of the evaluation's age. It does not bound the time from
 * the precheck through the Ledger append, and it does not close the race
 * with a revocation committed after the precheck. This witness pins that
 * actual behavior so documentation cannot overstate it.
 */
describe('recordRootDecision: the recording window is an entry-time age check only (F2)', () => {
  it('records even when Root time advances beyond the window during the storage prechecks', () => {
    const storage = world();
    try {
      recordProposal(storage);
      const { gateway: g, time } = gateway({ window: 1 });
      let armed = false;
      const sqlite = new Proxy(storage.sqlite, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              if (armed) {
                armed = false;
                time.set('2026-10-14T09:07:00Z');
              }
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const view = { ...storage, sqlite } as typeof storage;
      const evaluation = evaluate(g, view);
      expect(evaluation.decision.evaluatedAt).toBe(rootTime);
      // Entry is within the one-second window; then 120 seconds "pass"
      // during the first precheck read.
      armed = true;
      const receipt = recordRootDecision(g, view, evaluation, {
        eventId: 'event_window_witness',
      });
      expect(time.clock()).toBe('2026-10-14T09:07:00Z');
      expect(receipt.outcome).toBe('recorded');
      // The recorded decision still carries the evaluation time, not the
      // append time: it is a claim about one evaluation, not current authority.
      expect(receipt.evaluatedAt).toBe(rootTime);
    } finally {
      storage.close();
    }
  });
});
