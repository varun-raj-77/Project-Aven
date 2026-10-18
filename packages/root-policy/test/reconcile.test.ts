import { describe, expect, it } from 'vitest';
import {
  recordRootDecision,
  reconcileRootDecisionRecording,
} from '../src/ledger/index.ts';
import { clone, expectRootError, high } from './fixtures.ts';
import {
  approval,
  dump,
  evaluate,
  gateway,
  ledger,
  ownerId,
  recordApproval,
  recordProposal,
  syntheticGateway,
  world,
} from './ledger-fixtures.ts';

describe('reconcileRootDecisionRecording: read-only settlement', () => {
  it('reports recorded, with the Ledger sequence and recording time', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    const receipt = recordRootDecision(g, storage, evaluation, {
      eventId: 'event_decision',
    });
    const before = dump(storage);
    expect(
      reconcileRootDecisionRecording(storage, evaluation, {
        eventId: 'event_decision',
      }),
    ).toEqual({
      status: 'recorded',
      sequence: receipt.sequence,
      recordedAt: receipt.recordedAt,
    });
    // Plain data copied from the evaluation works the same way.
    expect(
      reconcileRootDecisionRecording(
        storage,
        JSON.parse(JSON.stringify(evaluation)),
        { eventId: 'event_decision' },
      ),
    ).toMatchObject({ status: 'recorded' });
    expect(dump(storage)).toBe(before);
    storage.close();
  });

  it('reconciles an approval-based ALLOW including its derivation', () => {
    const storage = world();
    recordProposal(storage, high());
    const a = approval(high());
    recordApproval(storage, a);
    const { gateway: g, channel } = syntheticGateway();
    channel.attest(a);
    const evaluation = evaluate(g, storage);
    recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' });
    expect(
      reconcileRootDecisionRecording(storage, clone(evaluation), {
        eventId: 'event_decision',
      }),
    ).toMatchObject({ status: 'recorded' });
    // Without the approval findings the expected derivation differs.
    const stripped = { ...clone(evaluation), approvals: [] };
    expect(
      reconcileRootDecisionRecording(storage, stripped, {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'conflict' });
    storage.close();
  });

  it('reports not_recorded when neither the event nor the decision exists', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    expect(
      reconcileRootDecisionRecording(storage, evaluate(g, storage), {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'not_recorded' });
    storage.close();
  });

  it('reports conflict for a different event or a decision recorded elsewhere', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g, time } = gateway();
    const first = evaluate(g, storage);
    recordRootDecision(g, storage, first, { eventId: 'event_decision' });
    // The event identifier holds another event.
    expect(
      reconcileRootDecisionRecording(storage, first, {
        eventId: 'event_source',
      }),
    ).toEqual({ status: 'conflict' });
    // The decision exists under another event identifier.
    expect(
      reconcileRootDecisionRecording(storage, first, {
        eventId: 'event_decision_elsewhere',
      }),
    ).toEqual({ status: 'conflict' });
    // A later evaluation (another time) of the same decision identifier.
    time.set('2026-10-14T09:06:00Z');
    expect(
      reconcileRootDecisionRecording(storage, evaluate(g, storage), {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'conflict' });
    storage.close();
  });

  it('is unresolved, never conflict, when it cannot look', () => {
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    storage.sqlite.exec('BEGIN');
    expect(
      reconcileRootDecisionRecording(storage, evaluation, {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'unresolved', code: 'storage_failure' });
    storage.sqlite.exec('ROLLBACK');
    const foreign = clone(evaluation) as {
      decision: { ownerId: string };
    };
    foreign.decision.ownerId = 'owner_absent';
    expect(
      reconcileRootDecisionRecording(storage, foreign, {
        eventId: 'event_decision',
      }),
    ).toEqual({ status: 'unresolved', code: 'unknown_binding' });
    storage.close();
  });

  it('refuses malformed input', () => {
    const storage = world();
    for (const [evaluation, request] of [
      [{}, { eventId: 'event_decision' }],
      [{ decision: { decision: 'ALLOW' } }, { eventId: 'event_decision' }],
      [null, { eventId: 'event_decision' }],
    ] as const)
      expectRootError(
        () =>
          reconcileRootDecisionRecording(storage, evaluation, request as never),
        'invalid_request',
      );
    recordProposal(storage);
    const { gateway: g } = gateway();
    expectRootError(
      () =>
        reconcileRootDecisionRecording(storage, evaluate(g, storage), {
          eventId: 'decision_wrong',
        }),
      'invalid_request',
    );
    storage.close();
  });

  it('documents the limit: an identical payload under a new event is accepted by the frozen Ledger', () => {
    // No exactly-once guarantee: bypassing Root's precheck (here, a direct
    // frozen-Ledger append racing a recording) re-observes the identical
    // decision under a second event identifier. It confers nothing new.
    const storage = world();
    recordProposal(storage);
    const { gateway: g } = gateway();
    const evaluation = evaluate(g, storage);
    recordRootDecision(g, storage, evaluation, { eventId: 'event_decision' });
    const stored = storage.sqlite
      .prepare(
        'SELECT record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
      )
      .get(ownerId, 'event_decision') as { record_json: string };
    const { recordedAt: _recordedAt, ...event } = JSON.parse(
      stored.record_json,
    ) as Record<string, unknown>;
    ledger(storage).appendEvent({
      ...event,
      id: 'event_decision_race',
    } as never);
    expect(
      (
        storage.sqlite
          .prepare(
            'SELECT count(*) AS n FROM policy_decisions WHERE owner_id = ?',
          )
          .get(ownerId) as { n: number }
      ).n,
    ).toBe(1);
    storage.close();
  });
});
