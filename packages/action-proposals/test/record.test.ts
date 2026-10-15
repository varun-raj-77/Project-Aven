// All owners, identifiers, texts and records in this file are SYNTHETIC.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimestampSchema } from '@aven/contracts';
import { createLedger, LedgerError, type LedgerErrorCode } from '@aven/ledger';
import { openStorage, type Storage } from '@aven/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionProposalError,
  computeActionProposalDigest,
  validateActionProposal,
  type ActionProposalErrorCode,
  type ActionProposalOutcome,
} from '../src/index.ts';
import {
  reconcileActionProposalRecording,
  recordActionProposal,
} from '../src/ledger/index.ts';
import {
  compareTimestamps,
  expectedRecordingEvent,
  ledgerFailure,
  PRECHECK_SQL,
} from '../src/ledger/record.ts';
import { proposal as literalProposal } from './fixtures.ts';
import * as L from './ledger-fixtures.ts';

const PROPOSAL_ROWS = Object.freeze({
  action_proposals: 1,
  experience_events: 1,
  record_keys: 2,
  record_references: 8,
  record_versions: 2,
});

function caught(run: () => unknown): ActionProposalError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ActionProposalError);
    expect((error as Error).cause).toBeUndefined();
    return error as ActionProposalError;
  }
  throw new Error('expected an ActionProposalError');
}

function expectFailure(
  run: () => unknown,
  code: ActionProposalErrorCode,
  outcome: ActionProposalOutcome,
) {
  const error = caught(run);
  expect([error.code, error.outcome]).toEqual([code, outcome]);
}

/** Records every call to the connection methods the recorder could use. */
function trace(storage: Storage) {
  const db = storage.sqlite;
  const log: string[] = [];
  for (const method of ['prepare', 'exec', 'transaction', 'pragma'] as const) {
    const original = (db[method] as (...a: unknown[]) => unknown).bind(db);
    vi.spyOn(db, method).mockImplementation(((...args: unknown[]) => {
      log.push(`${method}:${String(args[0])}`);
      return original(...args);
    }) as never);
  }
  return log;
}

/** Replaces `exec` for the given statements; everything else runs normally. */
function failExec(
  storage: Storage,
  failing: Record<string, 'throw' | 'run_then_throw'>,
) {
  const db = storage.sqlite;
  const original = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    const mode = failing[sql];
    if (mode === 'run_then_throw') original(sql);
    if (mode !== undefined)
      throw Object.assign(new Error('synthetic I/O failure'), {
        code: 'SQLITE_IOERR',
      });
    return original(sql);
  });
}

const directories: string[] = [];
const open: Storage[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven011-record-'));
  directories.push(dir);
  return join(dir, 'aven.sqlite');
}
function track(storage: Storage): Storage {
  open.push(storage);
  return storage;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of open.splice(0))
    if (storage.sqlite.open) storage.sqlite.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('recordActionProposal: a successful recording', () => {
  it('appends exactly one action_proposed event and its frozen projection', () => {
    const storage = track(L.world());
    const before = L.counts(storage);
    const receipt = recordActionProposal(storage, L.request());
    expect(L.delta(before, L.counts(storage))).toEqual(PROPOSAL_ROWS);

    const expected = validateActionProposal(L.proposalFor(), {
      ownerId: L.ownerId,
      sessionId: L.sessionId,
      taskId: L.taskId,
    });
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'binding',
        'eventId',
        'occurredAt',
        'outcome',
        'ownerId',
        'recordedAt',
        'sequence',
      ].sort(),
    );
    expect(receipt).toMatchObject({
      outcome: 'recorded',
      ownerId: L.ownerId,
      eventId: 'event_proposal',
      occurredAt: L.occurredAt,
    });
    expect(receipt.binding).toEqual(expected.binding);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.binding.proposalDigest)).toBe(true);

    const stored = createLedger(storage, L.ownerId as never).getEvent(
      'event_proposal' as never,
    );
    expect(stored?.sequence).toBe(receipt.sequence);
    expect(stored?.event.recordedAt).toBe(receipt.recordedAt);
    expect(stored?.evidence).toEqual([]);
    // The event's own creation time is its occurrence time, not the proposal's.
    expect(stored?.event.metadata.createdAt).toBe(L.occurredAt);
    const { recordedAt: _r, ...event } = stored!.event;
    expect(event).toEqual(expectedRecordingEvent(L.request()).event);
    expect(stored?.event.payload).toEqual(expected.proposal);
    expect(stored?.event.metadata.creation).toEqual({
      component: '@aven/action-proposals',
      version: 'aven-011-action-proposals-v1',
    });

    const row = storage.sqlite
      .prepare(
        'SELECT proposal_digest, parameters_digest, session_id, task_id FROM action_proposals WHERE owner_id = ? AND record_id = ?',
      )
      .get(L.ownerId, 'proposal_synthetic');
    expect(row).toEqual({
      proposal_digest: expected.binding.proposalDigest.value,
      parameters_digest: expected.binding.parametersDigest.value,
      session_id: L.sessionId,
      task_id: L.taskId,
    });
    expect(storage.sqlite.pragma('integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      createLedger(storage, L.ownerId as never).inspectIntegrity().ok,
    ).toBe(true);
  });

  it('records a system_generated origin and keeps the declared origin verbatim', () => {
    const storage = track(L.world());
    const provenance = L.systemGenerated();
    recordActionProposal(storage, L.request({ provenance }));
    const stored = createLedger(storage, L.ownerId as never).getEvent(
      'event_proposal' as never,
    );
    expect(stored?.event.provenance).toEqual(provenance);
  });

  it('accepts an occurrence time equal to the proposal creation time', () => {
    const storage = track(L.world());
    const receipt = recordActionProposal(
      storage,
      L.request({ occurredAt: '2026-10-14T09:00:00Z' }),
    );
    expect(receipt.occurredAt).toBe('2026-10-14T09:00:00Z');
  });

  it('does not change its input and runs no caller code', () => {
    const storage = track(L.world());
    const request = L.request();
    const copy = JSON.parse(JSON.stringify(request)) as unknown;
    recordActionProposal(storage, request);
    expect(request).toEqual(copy);

    let reads = 0;
    const accessor = L.request();
    Object.defineProperty(accessor, 'eventId', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'event_accessor';
      },
    });
    const before = L.dump(storage);
    expectFailure(
      () => recordActionProposal(storage, accessor),
      'invalid_request',
      'not_written',
    );
    expect(reads).toBe(0);
    expect(L.dump(storage)).toBe(before);
  });

  it('cites a resolvable prior approval (synthetic test setup, not an approval flow)', () => {
    const storage = track(L.world());
    const first = recordActionProposal(storage, L.request());
    L.syntheticApproval(
      storage,
      first.binding,
      'approval_synthetic',
      'event_approval',
    );
    const before = L.counts(storage);
    const second = recordActionProposal(
      storage,
      L.request({
        eventId: 'event_second',
        proposal: L.proposalFor({
          proposalId: 'proposal_second',
          priorApprovalIds: ['approval_synthetic'],
        }),
      }),
    );
    // The cited approval adds one reference from the event and its projection.
    expect(L.delta(before, L.counts(storage))).toEqual({
      ...PROPOSAL_ROWS,
      record_references: 10,
    });
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('yields a binding the frozen schema resolves (SYNTHETIC record, not Root)', () => {
    const storage = track(L.world());
    const receipt = recordActionProposal(storage, L.request());
    L.syntheticPolicyDecision(storage, receipt.binding, 'event_decision');
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);

    const forged = {
      ...receipt.binding,
      proposalDigest: { algorithm: 'sha256', value: 'd'.repeat(64) },
    };
    const before = L.dump(storage);
    expect(() =>
      L.syntheticPolicyDecision(storage, forged, 'event_forged'),
    ).toThrow(LedgerError);
    expect(L.dump(storage)).toBe(before);
  });

  it('confers nothing: the receipt is a recording result only', () => {
    const storage = track(L.world());
    const receipt = recordActionProposal(storage, L.request());
    const text = JSON.stringify(receipt);
    for (const word of ['ALLOW', 'DENY', 'approved', 'decision', 'grant'])
      expect(text).not.toContain(word);
    const policyRows = storage.sqlite
      .prepare(
        'SELECT (SELECT count(*) FROM policy_decisions) + (SELECT count(*) FROM owner_approvals) + (SELECT count(*) FROM tool_executions) AS n',
      )
      .get() as { n: number };
    expect(policyRows.n).toBe(0);
  });
});

describe('recordActionProposal: rejections before the append', () => {
  const unchanged = (
    storage: Storage,
    request: unknown,
    code: ActionProposalErrorCode,
  ) => {
    const before = L.dump(storage);
    const log = trace(storage);
    expectFailure(
      () => recordActionProposal(storage, request),
      code,
      'not_written',
    );
    expect(log.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
    expect(log.filter((entry) => entry.startsWith('transaction:'))).toEqual([]);
    vi.restoreAllMocks();
    expect(L.dump(storage)).toBe(before);
  };

  it('rejects malformed requests as invalid_request', () => {
    const storage = track(L.world());
    const { eventId: _e, ...missing } = L.request();
    for (const request of [
      null,
      'request',
      [],
      missing,
      L.request({ extra: true }),
      L.request({ eventId: 'proposal_wrong_prefix' }),
      L.request({ occurredAt: '2026-10-14 09:00:05' }),
      L.request({ ownerId: 'Owner Synthetic' }),
      L.request({ proposal: 'proposal_synthetic' }),
      L.request({ proposal: { ...L.proposalFor(), extra: 1 } }),
      L.request({ provenance: { kind: 'model_inference' } }),
      L.request({ provenance: { kind: 'invented_origin' } }),
      L.request({ eventId: 'event_\uD800' }),
      L.request({ proposal: new Proxy(L.proposalFor(), {}) }),
    ])
      unchanged(storage, request, 'invalid_request');
  });

  it('enforces the explicit binding and the v1 proposal format', () => {
    const storage = track(L.world());
    unchanged(storage, L.request({ taskId: L.otherTask }), 'binding_mismatch');
    unchanged(
      storage,
      L.request({ ownerId: L.otherOwner }),
      'binding_mismatch',
    );
    unchanged(
      storage,
      L.request({
        proposal: literalProposal({
          metadata: {
            ...literalProposal().metadata,
            creation: { component: 'synthetic-direct', version: '1' },
          },
        }),
      }),
      'unsupported_proposal',
    );
    unchanged(
      storage,
      L.request({
        proposal: literalProposal({
          requestedAuthority: [
            {
              operation: 'promote_learning',
              resource: { kind: 'learned_state', identifier: 'learned_x' },
            },
          ],
        }),
      }),
      'operation_not_in_v1_format',
    );
  });

  it('accepts only model_inference and system_generated origins', () => {
    const storage = track(L.world());
    for (const provenance of [
      {
        kind: 'explicit_owner_statement',
        ownerId: L.ownerId,
        sourceEventId: 'event_proposal',
      },
      {
        kind: 'explicit_owner_correction',
        ownerId: L.ownerId,
        sourceEventId: 'event_proposal',
      },
      {
        kind: 'owner_approval',
        ownerId: L.ownerId,
        sourceEventId: 'event_proposal',
      },
      {
        kind: 'tool_result',
        toolId: 'synthetic-tool',
        sourceEventId: 'event_source',
        trust: 'potentially_untrusted',
      },
      {
        kind: 'external_content',
        source: 'synthetic-source',
        capturedAt: '2026-10-14T08:30:00Z',
        trust: 'untrusted',
      },
    ])
      unchanged(storage, L.request({ provenance }), 'unsupported_origin');
  });

  it('rejects an occurrence before the proposal creation time', () => {
    const storage = track(L.world());
    unchanged(
      storage,
      L.request({ occurredAt: '2026-10-14T08:59:59.999Z' }),
      'timestamp_order',
    );
  });

  it('rejects unknown owners and task bindings', () => {
    const storage = track(L.world());
    unchanged(
      storage,
      L.request({
        ownerId: 'owner_missing',
        proposal: L.proposalFor({}, 'owner_missing'),
      }),
      'unknown_binding',
    );
    // task_second exists, but in another session.
    unchanged(
      storage,
      L.request({
        taskId: L.secondTask,
        proposal: L.proposalFor({ taskId: L.secondTask }),
      }),
      'unknown_binding',
    );
    unchanged(
      storage,
      L.request({
        taskId: 'task_missing',
        proposal: L.proposalFor({ taskId: 'task_missing' }),
      }),
      'unknown_binding',
    );
  });

  it('rejects unresolved derivation evidence and prior approvals', () => {
    const storage = track(L.world());
    const derived = (ref: { evidenceId: string; eventId: string }) =>
      L.request({ provenance: { ...L.inference(), derivedFrom: [ref] } });
    unchanged(
      storage,
      derived({ evidenceId: 'evidence_missing', eventId: 'event_source' }),
      'unresolved_reference',
    );
    unchanged(
      storage,
      derived({ evidenceId: 'evidence_source', eventId: 'event_proposal' }),
      'unresolved_reference',
    );
    unchanged(
      storage,
      L.request({
        proposal: L.proposalFor({ priorApprovalIds: ['approval_missing'] }),
      }),
      'unresolved_reference',
    );
  });

  it("never resolves another owner's evidence or approval", () => {
    const storage = track(L.world());
    const foreign = recordActionProposal(
      storage,
      L.request({
        ownerId: L.otherOwner,
        proposal: L.proposalFor({}, L.otherOwner),
      }),
    );
    L.syntheticApproval(
      storage,
      foreign.binding,
      'approval_foreign',
      'event_foreign_approval',
      L.otherOwner,
    );
    unchanged(
      storage,
      L.request({
        provenance: {
          ...L.inference(),
          derivedFrom: [
            {
              evidenceId: 'evidence_foreign_approval',
              eventId: 'event_foreign_approval',
            },
          ],
        },
      }),
      'unresolved_reference',
    );
    unchanged(
      storage,
      L.request({
        proposal: L.proposalFor({ priorApprovalIds: ['approval_foreign'] }),
      }),
      'unresolved_reference',
    );
  });

  it('rejects a used event or proposal identifier', () => {
    const storage = track(L.world());
    unchanged(
      storage,
      L.request({ eventId: L.source.eventId }),
      'identifier_collision',
    );
    recordActionProposal(storage, L.request());
    unchanged(storage, L.request(), 'identifier_collision');
    unchanged(
      storage,
      L.request({ eventId: 'event_other' }),
      'identifier_collision',
    );
  });

  it('refuses to append inside an open transaction and leaves it open', () => {
    const storage = track(L.world());
    storage.sqlite.exec('BEGIN');
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'storage_failure',
      'not_written',
    );
    expect(storage.sqlite.inTransaction).toBe(true);
    storage.sqlite.exec('ROLLBACK');
  });

  it('maps a failing precheck read to storage_failure', () => {
    const storage = track(L.world());
    const db = storage.sqlite;
    const original = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql === PRECHECK_SQL.task) throw new Error('synthetic read failure');
      return original(sql);
    }) as never);
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'storage_failure',
      'not_written',
    );
  });
});

describe('ledgerFailure: the exhaustive outcome mapping', () => {
  const CODES: readonly LedgerErrorCode[] = [
    'invalid_input',
    'invalid_event',
    'unknown_owner',
    'unknown_session',
    'unknown_task',
    'cross_owner_reference',
    'invalid_reference',
    'duplicate_event',
    'transaction_active',
    'storage_failure',
    'integrity_failure',
  ];
  const NOT_STARTED: Partial<Record<string, ActionProposalErrorCode>> = {
    transaction_active: 'storage_failure',
    storage_failure: 'storage_failure',
    invalid_event: 'ledger_rejected',
    invalid_reference: 'ledger_rejected',
  };
  const ROLLED_BACK: Record<
    string,
    [ActionProposalErrorCode, ActionProposalOutcome]
  > = {
    duplicate_event: ['identifier_collision', 'rolled_back'],
    invalid_reference: ['ledger_rejected', 'rolled_back'],
    invalid_event: ['ledger_rejected', 'rolled_back'],
    unknown_owner: ['unknown_binding', 'rolled_back'],
    unknown_session: ['unknown_binding', 'rolled_back'],
    unknown_task: ['unknown_binding', 'rolled_back'],
    integrity_failure: ['storage_failure', 'rolled_back'],
    invalid_input: ['internal_error', 'rolled_back'],
    cross_owner_reference: ['internal_error', 'rolled_back'],
    storage_failure: ['storage_failure', 'unknown'],
    transaction_active: ['internal_error', 'unknown'],
  };

  it('covers every Ledger code under every rollback status', () => {
    const map = (code: string, rollback: string) =>
      ledgerFailure(
        new LedgerError(code as never, 'synthetic', rollback as never),
      );
    for (const code of [...CODES, 'novel_code']) {
      expect(map(code, 'not_started')).toEqual({
        code: NOT_STARTED[code] ?? 'internal_error',
        outcome: 'not_written',
      });
      const [rolledCode, rolledOutcome] = ROLLED_BACK[code] ?? [
        'internal_error',
        'unknown',
      ];
      expect(map(code, 'rolled_back')).toEqual({
        code: rolledCode,
        outcome: rolledOutcome,
      });
      expect(map(code, 'failed')).toEqual({
        code: 'storage_failure',
        outcome: 'unknown',
      });
      expect(map(code, 'novel_status')).toEqual({
        code: 'internal_error',
        outcome: 'unknown',
      });
    }
  });

  it('treats anything that is not a LedgerError as unknown', () => {
    for (const error of [
      new Error('x'),
      { code: 'duplicate_event', rollback: 'rolled_back' },
      undefined,
      'duplicate_event',
    ])
      expect(ledgerFailure(error)).toEqual({
        code: 'internal_error',
        outcome: 'unknown',
      });
  });
});

describe('recordActionProposal: failures inside the frozen append', () => {
  it('maps a Ledger contract rejection before its transaction to not_written', () => {
    const storage = track(L.world());
    const before = L.dump(storage);
    // The Ledger's recording clock precedes this occurrence time.
    const future = '2099-01-01T00:00:00Z';
    expectFailure(
      () => recordActionProposal(storage, L.request({ occurredAt: future })),
      'ledger_rejected',
      'not_written',
    );
    expect(L.dump(storage)).toBe(before);
  });

  it('maps a foreign-key failure at COMMIT to a confirmed rollback', () => {
    const storage = track(L.world());
    const db = storage.sqlite;
    const original = db.prepare.bind(db);
    // Fake only the precheck, so that the frozen deferred check decides.
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) =>
      sql === PRECHECK_SQL.evidence
        ? { get: () => ({ found: 1 }) }
        : original(sql)) as never);
    const before = L.dump(storage);
    expectFailure(
      () =>
        recordActionProposal(
          storage,
          L.request({
            provenance: {
              ...L.inference(),
              derivedFrom: [
                { evidenceId: 'evidence_missing', eventId: 'event_source' },
              ],
            },
          }),
        ),
      'ledger_rejected',
      'rolled_back',
    );
    vi.restoreAllMocks();
    expect(db.inTransaction).toBe(false);
    expect(L.dump(storage)).toBe(before);
  });

  it('reports a failed COMMIT as unknown even though the Ledger rolled back', () => {
    const storage = track(L.world());
    const before = L.dump(storage);
    failExec(storage, { COMMIT: 'throw' });
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'storage_failure',
      'unknown',
    );
    vi.restoreAllMocks();
    expect(L.dump(storage)).toBe(before);
    expect(reconcileActionProposalRecording(storage, L.request())).toEqual({
      status: 'not_recorded',
    });
  });

  it('reports unknown when COMMIT took effect but raised (Ledger says rolled_back)', () => {
    const storage = track(L.world());
    failExec(storage, { COMMIT: 'run_then_throw' });
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'storage_failure',
      'unknown',
    );
    vi.restoreAllMocks();
    // The frozen Ledger reports `rolled_back` here, but the event committed.
    expect(
      reconcileActionProposalRecording(storage, L.request()),
    ).toMatchObject({ status: 'recorded' });
  });

  it('reports a failed rollback as unknown and leaves the connection to discard', () => {
    const path = file();
    const storage = track(L.world(path));
    failExec(storage, { COMMIT: 'throw', ROLLBACK: 'throw' });
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'storage_failure',
      'unknown',
    );
    vi.restoreAllMocks();
    expect(storage.sqlite.inTransaction).toBe(true);
    storage.sqlite.close();
    const fresh = track(openStorage(path));
    expect(reconcileActionProposalRecording(fresh, L.request())).toEqual({
      status: 'not_recorded',
    });
  });

  it('raises internal_error with an unknown outcome when the returned event disagrees', () => {
    const storage = track(L.world());
    const db = storage.sqlite;
    const original = db.prepare.bind(db);
    const sourceJson = (
      original(
        'SELECT record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
      ).get(L.ownerId, L.source.eventId) as { record_json: string }
    ).record_json;
    // Swap the row the frozen INSERT ... RETURNING hands back to the Ledger.
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (!sql.startsWith('INSERT INTO experience_events')) return statement;
      return {
        get: (...values: unknown[]) => ({
          ...(statement.get(...values) as { sequence: number }),
          record_json: sourceJson,
        }),
      };
    }) as never);
    expectFailure(
      () => recordActionProposal(storage, L.request()),
      'internal_error',
      'unknown',
    );
    vi.restoreAllMocks();
    // The append itself committed; only the reconciliation can tell.
    expect(
      reconcileActionProposalRecording(storage, L.request()),
    ).toMatchObject({ status: 'recorded' });
  });
});

describe('recordActionProposal: commit boundary and concurrency', () => {
  it('touches no storage after COMMIT', () => {
    const storage = track(L.world());
    const log = trace(storage);
    recordActionProposal(storage, L.request());
    expect(log.at(-1)).toBe('exec:COMMIT');
    expect(
      log.filter((entry) => entry === 'exec:BEGIN IMMEDIATE'),
    ).toHaveLength(1);
    expect(log.filter((entry) => entry === 'exec:COMMIT')).toHaveLength(1);
  });

  /** Runs `first` on connection A in the window between B's precheck and lock. */
  function race(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ) {
    const path = file();
    const a = track(L.world(path));
    const b = track(openStorage(path));
    const original = b.sqlite.exec.bind(b.sqlite);
    let interleaved = false;
    vi.spyOn(b.sqlite, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !interleaved) {
        interleaved = true;
        recordActionProposal(a, L.request(first));
      }
      return original(sql);
    });
    const before = L.counts(a);
    let outcome: unknown;
    try {
      outcome = recordActionProposal(b, L.request(second));
    } catch (error) {
      outcome = error;
    }
    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    return { a, b, outcome, rows: L.delta(before, L.counts(a)) };
  }

  it('rolls back a duplicate event identifier found under the write lock', () => {
    const { b, outcome, rows } = race({}, {});
    expect(outcome).toBeInstanceOf(ActionProposalError);
    expect(outcome).toMatchObject({
      code: 'identifier_collision',
      outcome: 'rolled_back',
    });
    expect(rows).toEqual(PROPOSAL_ROWS);
    expect(reconcileActionProposalRecording(b, L.request())).toMatchObject({
      status: 'recorded',
    });
  });

  it('rolls back a different payload under a proposal identifier taken meanwhile', () => {
    const { outcome, rows } = race(
      {},
      {
        eventId: 'event_late',
        proposal: L.proposalFor({ action: 'summarize' }),
      },
    );
    expect(outcome).toMatchObject({
      code: 'ledger_rejected',
      outcome: 'rolled_back',
    });
    expect(rows).toEqual(PROPOSAL_ROWS);
  });

  it('documents the precheck race: an identical payload is re-observed', () => {
    const { a, outcome, rows } = race({}, { eventId: 'event_late' });
    expect(outcome).toMatchObject({ outcome: 'recorded' });
    // A second event re-observes the existing, identical proposal snapshot.
    expect(rows).toEqual({
      action_proposals: 1,
      experience_events: 2,
      record_keys: 3,
      record_references: 14,
      record_versions: 3,
    });
    expect(
      (
        a.sqlite
          .prepare(
            'SELECT count(*) AS n FROM action_proposals WHERE owner_id = ?',
          )
          .get(L.ownerId) as { n: number }
      ).n,
    ).toBe(1);
  });
});

describe('recordActionProposal: persistence and owner isolation', () => {
  it('survives a restart and refuses a replay of the same request', () => {
    const path = file();
    const first = track(L.world(path));
    const receipt = recordActionProposal(first, L.request());
    first.sqlite.close();

    const reopened = track(openStorage(path));
    expect(reconcileActionProposalRecording(reopened, L.request())).toEqual({
      status: 'recorded',
      sequence: receipt.sequence,
      recordedAt: receipt.recordedAt,
      binding: receipt.binding,
    });
    const before = L.dump(reopened);
    expectFailure(
      () => recordActionProposal(reopened, L.request()),
      'identifier_collision',
      'not_written',
    );
    expect(L.dump(reopened)).toBe(before);
    expect(reopened.sqlite.pragma('integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
  });

  it("keeps each owner's identifiers and rows separate", () => {
    const storage = track(L.world());
    const count = (owner: string) =>
      (
        storage.sqlite
          .prepare(
            'SELECT count(*) AS n FROM experience_events WHERE owner_id = ?',
          )
          .get(owner) as { n: number }
      ).n;
    const otherBefore = count(L.otherOwner);
    recordActionProposal(storage, L.request());
    expect(count(L.otherOwner)).toBe(otherBefore);
    expect(
      reconcileActionProposalRecording(
        storage,
        L.request({
          ownerId: L.otherOwner,
          proposal: L.proposalFor({}, L.otherOwner),
        }),
      ),
    ).toEqual({ status: 'not_recorded' });
    const other = recordActionProposal(
      storage,
      L.request({
        ownerId: L.otherOwner,
        proposal: L.proposalFor({}, L.otherOwner),
      }),
    );
    expect(other.eventId).toBe('event_proposal');
    expect(count(L.otherOwner)).toBe(otherBefore + 1);
  });
});

describe('expectedRecordingEvent: pure preparation', () => {
  it('is deterministic and reads no clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const first = expectedRecordingEvent(L.request());
      vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
      expect(expectedRecordingEvent(L.request())).toEqual(first);
      expect(JSON.stringify(first)).not.toContain('2030');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a maximum-size proposal beside a maximum-size origin', () => {
    const authority = Array.from({ length: 256 }, (_, i) => ({
      operation: 'draft',
      resource: { kind: 'sandbox_resource', identifier: `synthetic-${i}` },
    }));
    const approvals = Array.from({ length: 256 }, (_, i) => `approval_${i}`);
    const derivedFrom = Array.from({ length: 256 }, (_, i) => ({
      evidenceId: `evidence_${i}`,
      eventId: `event_${i}`,
    }));
    const prepared = expectedRecordingEvent(
      L.request({
        proposal: L.proposalFor({
          requestedAuthority: authority,
          priorApprovalIds: approvals,
        }),
        provenance: { ...L.inference(), derivedFrom },
      }),
    );
    expect(prepared.priorApprovalIds).toHaveLength(256);
    expect(prepared.derivedFrom).toHaveLength(256);
  });
});

describe('compareTimestamps: exact instant order (Codex F1)', () => {
  it.each([
    // Within one millisecond: sub-millisecond digits decide.
    ['2026-10-14T09:00:00.0009Z', '2026-10-14T09:00:00.0001Z', 1],
    ['2026-10-14T09:00:00.0001Z', '2026-10-14T09:00:00.0009Z', -1],
    ['2026-10-14T09:00:00.1Z', '2026-10-14T09:00:00.10000000000000000001Z', -1],
    // The same instant written the same way and differently.
    ['2026-10-14T09:00:00.0005Z', '2026-10-14T09:00:00.0005Z', 0],
    ['2026-10-14T09:00:00.5Z', '2026-10-14T09:00:00.500000000Z', 0],
    ['2026-10-14T09:00:00Z', '2026-10-14T09:00:00.000Z', 0],
    ['2026-10-14T09:00:00Z', '2026-10-14T14:30:00+05:30', 0],
    ['2026-10-14T09:00:00Z', '2026-10-14T04:00:00-05:00', 0],
    ['2026-10-14T09:00:00-00:00', '2026-10-14T09:00:00+00:00', 0],
    ['2026-10-14T09:00:00.25+00:00', '2026-10-14T09:00:00.250Z', 0],
    // Second, day, month, year and leap-day boundaries through offsets.
    ['2026-10-14T09:00:00.9999999Z', '2026-10-14T09:00:01-00:00', -1],
    ['2026-10-14T14:30:00.9999998+05:30', '2026-10-14T09:00:00.9999999Z', -1],
    ['2026-10-15T00:30:00+01:00', '2026-10-14T23:30:00Z', 0],
    ['2026-10-15T00:00:00+00:01', '2026-10-14T23:59:00Z', 0],
    ['2026-10-14T23:59:59.9999999999Z', '2026-10-15T00:00:00+00:00', -1],
    ['2026-10-14T20:00:00-04:00', '2026-10-15T00:00:00Z', 0],
    ['2026-11-01T00:00:00+00:01', '2026-10-31T23:59:00Z', 0],
    ['2027-01-01T09:59:59.999999+14:00', '2026-12-31T19:59:59.999999Z', 0],
    ['2024-03-01T00:00:00+00:01', '2024-02-29T23:59:00Z', 0],
    ['2024-02-29T23:59:59.999Z', '2024-03-01T00:00:00Z', -1],
    ['2000-02-29T12:00:00Z', '2000-03-01T00:00:00+12:00', 0],
    // The ends of the accepted range, across the year-0 era boundary.
    ['0000-01-01T00:00:00+00:01', '0000-01-01T00:00:00Z', -1],
    ['0000-03-01T00:00:00+23:59', '0000-02-29T00:01:00Z', 0],
    ['9999-12-31T23:59:59.999999999999-23:59', '0000-01-01T00:00:00+23:59', 1],
  ] as const)('%s vs %s is %d', (a, b, expected) => {
    expect(TimestampSchema.safeParse(a).success).toBe(true);
    expect(TimestampSchema.safeParse(b).success).toBe(true);
    expect(compareTimestamps(a, b)).toBe(expected);
    expect(compareTimestamps(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it('compares fractions of the full accepted length digit by digit', () => {
    const base = '2026-10-14T09:00:00.';
    const long = (digits: string) => `${base}${digits}Z`;
    const a = long(`${'0'.repeat(19_950)}1`);
    const b = long(`${'0'.repeat(19_950)}10000`);
    const c = long(`${'0'.repeat(19_951)}9`);
    expect(TimestampSchema.safeParse(a).success).toBe(true);
    expect(compareTimestamps(a, b)).toBe(0);
    expect(compareTimestamps(c, a)).toBe(-1);
    expect(
      compareTimestamps(long('0'.repeat(19_975)), `${base.slice(0, -1)}Z`),
    ).toBe(0);
  });

  it('returns undefined for strings outside the timestamp form', () => {
    for (const text of [
      '',
      '2026-10-14T09:00:00',
      '2026-10-14T09:00:00+0530',
      '2026-10-14T09:00:00.Z',
      '2026-10-14 09:00:00Z',
      '2026-10-14T09:00Z',
    ])
      expect(compareTimestamps(text, '2026-10-14T09:00:00Z')).toBeUndefined();
  });

  /** Deterministic generator (no Math.random), for reproducible cases. */
  function generator(seed: number) {
    let state = seed >>> 0;
    return (bound: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
  }
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const offsetText = (minutes: number) =>
    `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60), 2)}:${pad(Math.abs(minutes) % 60, 2)}`;
  /** The instant `ms` written in local time at `offset` minutes. */
  function render(ms: number, offset: number, fraction: string): string {
    const local = new Date(ms + offset * 60_000).toISOString();
    const text = `${local.slice(0, 19)}.${local.slice(20, 23)}${fraction}`;
    return offset === 0 && fraction === ''
      ? `${text}Z`
      : text + offsetText(offset);
  }
  // 0001-01-02 .. 9998-12-30 keeps every local rendering inside 0000..9999.
  const MIN = Date.parse('0001-01-02T00:00:00Z');
  const MAX = Date.parse('9998-12-30T00:00:00Z');

  it('agrees with exact millisecond order across the accepted range', () => {
    const next = generator(20261014);
    for (let i = 0; i < 2000; i += 1) {
      const t = MIN + next(MAX - MIN);
      // Half the pairs fall within one second of each other.
      const u = i % 2 === 0 ? t + next(2001) - 1000 : MIN + next(MAX - MIN);
      const a = render(t, next(2879) - 1439, '');
      const b = render(u, next(2879) - 1439, '');
      expect(TimestampSchema.safeParse(a).success).toBe(true);
      expect(TimestampSchema.safeParse(b).success).toBe(true);
      // Integer milliseconds are exact here; this is only an oracle.
      expect(compareTimestamps(a, b)).toBe(Math.sign(t - u) || 0);
    }
  });

  it('orders by every fraction digit and ignores the chosen offset', () => {
    const next = generator(71327884);
    for (let i = 0; i < 2000; i += 1) {
      const t = MIN + next(MAX - MIN);
      const digits = String(next(1_000_000)).padStart(6, '0');
      const extra = digits.slice(0, 1 + next(6)) + '0'.repeat(next(4));
      const a = render(t, next(2879) - 1439, extra);
      const b = render(t, next(2879) - 1439, extra);
      expect(TimestampSchema.safeParse(a).success).toBe(true);
      expect(compareTimestamps(a, b)).toBe(0);
      const later = render(t, next(2879) - 1439, `${extra}1`);
      expect(compareTimestamps(a, later)).toBe(-1);
      expect(compareTimestamps(later, b)).toBe(1);
    }
  });

  it('reads every string the frozen TimestampSchema accepts', () => {
    const next = generator(3761);
    for (let i = 0; i < 2000; i += 1) {
      const t = MIN + next(MAX - MIN);
      const fraction = '7'.repeat(next(30));
      const text = render(t, next(2879) - 1439, fraction);
      const minus = text.endsWith('+00:00')
        ? `${text.slice(0, -6)}-00:00`
        : text;
      for (const value of [text, minus]) {
        expect(TimestampSchema.safeParse(value).success).toBe(true);
        expect(compareTimestamps(value, value)).toBe(0);
      }
    }
  });
});

describe('recording and reconciliation respect exact timestamp order (Codex F1)', () => {
  // Past dates: the frozen Ledger refuses occurrences after its own clock.
  const recordWith = (createdAt: string, occurredAt: string) => {
    const storage = track(L.world());
    const proposal = L.proposalFor({ createdAt });
    const request = L.request({ proposal, occurredAt });
    return { storage, proposal, request };
  };

  const rejected = (createdAt: string, occurredAt: string) => {
    const { storage, request } = recordWith(createdAt, occurredAt);
    const before = L.dump(storage);
    const log = trace(storage);
    expectFailure(
      () => recordActionProposal(storage, request),
      'timestamp_order',
      'not_written',
    );
    expectFailure(
      () => reconcileActionProposalRecording(storage, request),
      'timestamp_order',
      'not_written',
    );
    expect(log).toEqual([]);
    vi.restoreAllMocks();
    expect(L.dump(storage)).toBe(before);
  };

  const accepted = (createdAt: string, occurredAt: string) => {
    const { storage, proposal, request } = recordWith(createdAt, occurredAt);
    const receipt = recordActionProposal(storage, request);
    expect(receipt.occurredAt).toBe(occurredAt);
    expect(receipt.binding.proposalDigest).toEqual(
      computeActionProposalDigest(proposal),
    );
    const stored = createLedger(storage, L.ownerId as never).getEvent(
      'event_proposal' as never,
    );
    // Every timestamp string is stored verbatim, never normalized.
    expect(stored?.event.occurredAt).toBe(occurredAt);
    expect(stored?.event.metadata.createdAt).toBe(occurredAt);
    expect(stored?.event.eventType).toBe('action_proposed');
    if (stored?.event.eventType === 'action_proposed')
      expect(stored.event.payload.metadata.createdAt).toBe(createdAt);
    expect(reconcileActionProposalRecording(storage, request)).toEqual({
      status: 'recorded',
      sequence: receipt.sequence,
      recordedAt: receipt.recordedAt,
      binding: receipt.binding,
    });
  };

  it('rejects an event earlier than the proposal within the same millisecond', () => {
    rejected('2026-01-14T09:00:00.0009Z', '2026-01-14T09:00:00.0001Z');
    rejected('2026-01-14T09:00:00.0000001Z', '2026-01-14T09:00:00Z');
  });

  it('records an event later than the proposal within the same millisecond', () => {
    accepted('2026-01-14T09:00:00.0001Z', '2026-01-14T09:00:00.0009Z');
  });

  it('records exactly equal instants', () => {
    accepted('2026-01-14T09:00:00.0005Z', '2026-01-14T09:00:00.0005Z');
  });

  it('records equal instants written with different fraction lengths', () => {
    accepted('2026-01-14T09:00:00.5Z', '2026-01-14T09:00:00.500000000Z');
    accepted('2026-01-14T09:00:00.500000000Z', '2026-01-14T09:00:00.5Z');
    accepted('2026-01-14T09:00:00Z', '2026-01-14T09:00:00.000Z');
  });

  it('records equal instants written with different UTC offsets', () => {
    accepted('2026-01-14T09:00:00Z', '2026-01-14T14:30:00+05:30');
    accepted('2026-01-14T14:30:00.25+05:30', '2026-01-14T04:00:00.250-05:00');
    accepted('2026-01-14T09:00:00+00:00', '2026-01-14T09:00:00-00:00');
  });

  it('orders across second and day boundaries written with offsets', () => {
    accepted('2026-01-14T09:00:00.9999999Z', '2026-01-14T09:00:01-00:00');
    rejected(
      '2026-01-14T09:00:00.9999999Z',
      '2026-01-14T14:30:00.9999998+05:30',
    );
    accepted('2026-01-15T00:30:00.25+01:00', '2026-01-14T23:30:00.2500001Z');
    rejected('2026-01-15T00:30:00.25+01:00', '2026-01-14T23:30:00.2499999Z');
    accepted('2025-12-31T23:59:59.9999999Z', '2026-01-01T00:00:00+00:00');
    rejected('2026-01-01T00:00:00+00:00', '2025-12-31T19:59:59.9999999-04:00');
    accepted('2024-02-29T23:59:00Z', '2024-03-01T00:00:00+00:01');
  });
});
