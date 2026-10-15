// All owners, identifiers, texts and records in this file are SYNTHETIC.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, type EventInput } from '@aven/ledger';
import { openStorage, type Storage } from '@aven/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
} from '../src/index.ts';
import {
  reconcileActionProposalRecording,
  recordActionProposal,
} from '../src/ledger/index.ts';
import { expectedRecordingEvent } from '../src/ledger/record.ts';
import { READ_SQL } from '../src/ledger/stored.ts';
import * as L from './ledger-fixtures.ts';

const directories: string[] = [];
const open: Storage[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven011-reconcile-'));
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

const reconcile = (storage: Storage, overrides: Record<string, unknown> = {}) =>
  reconcileActionProposalRecording(storage, L.request(overrides));

/**
 * Test setup only: appends an `action_proposed` event directly through the
 * frozen Ledger, as any code with storage access could, to plant histories
 * the recorder itself would never write.
 */
function plant(
  storage: Storage,
  change: (event: Record<string, unknown>) => void,
  options: { digest?: string; evidence?: unknown[] } = {},
  base: Record<string, unknown> = L.request(),
) {
  const prepared = expectedRecordingEvent(base);
  const event = JSON.parse(JSON.stringify(prepared.event)) as Record<
    string,
    unknown
  >;
  change(event);
  createLedger(storage, L.ownerId as never).appendEvent(
    event as unknown as EventInput,
    {
      proposalDigest: {
        algorithm: 'sha256',
        value: options.digest ?? prepared.binding.proposalDigest.value,
      },
      ...(options.evidence ? { evidence: options.evidence as never } : {}),
    },
  );
}

function expectUnresolved(
  result: unknown,
  code: ActionProposalErrorCode,
): void {
  expect(result).toEqual({ status: 'unresolved', code });
  expect(Object.isFrozen(result)).toBe(true);
}

describe('reconcileActionProposalRecording: settled outcomes', () => {
  it('reports the recorded event with its sequence, time and binding', () => {
    const storage = track(L.world());
    const receipt = recordActionProposal(storage, L.request());
    const result = reconcile(storage);
    expect(result).toEqual({
      status: 'recorded',
      sequence: receipt.sequence,
      recordedAt: receipt.recordedAt,
      binding: receipt.binding,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === 'recorded')
      expect(Object.isFrozen(result.binding.parametersDigest)).toBe(true);
  });

  it('reports not_recorded, after which the identical request records', () => {
    const storage = track(L.world());
    const result = reconcile(storage);
    expect(result).toEqual({ status: 'not_recorded' });
    expect(Object.isFrozen(result)).toBe(true);
    const receipt = recordActionProposal(storage, L.request());
    expect(reconcile(storage)).toMatchObject({
      status: 'recorded',
      sequence: receipt.sequence,
    });
  });

  it('only reads: no exec, only SELECT statements, no change', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const before = L.dump(storage);
    const db = storage.sqlite;
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as never);
    const exec = vi.spyOn(db, 'exec');
    for (const overrides of [{}, { eventId: 'event_absent' }])
      reconcile(storage, overrides);
    expect(exec).not.toHaveBeenCalled();
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql.trimStart()).toMatch(/^SELECT /);
    vi.restoreAllMocks();
    expect(L.dump(storage)).toBe(before);
  });
});

describe('reconcileActionProposalRecording: conflicts', () => {
  const recorded = () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    return storage;
  };

  it('reports a conflict for each field of the event that differs', () => {
    const storage = recorded();
    for (const overrides of [
      { occurredAt: '2026-10-14T09:00:06Z' },
      { provenance: L.systemGenerated() },
      {
        provenance: {
          ...L.inference(),
          model: { ...L.model, modelVersion: '2' },
        },
      },
      { proposal: L.proposalFor({ action: 'summarize' }) },
      {
        proposal: L.proposalFor({
          consequences: {
            risk: 'low',
            reversibility: 'reversible',
            description: 'A different synthetic description.',
          },
        }),
      },
      { proposal: L.proposalFor({ createdAt: '2026-10-14T09:00:01Z' }) },
      {
        taskId: L.otherTask,
        proposal: L.proposalFor({ taskId: L.otherTask }),
      },
    ])
      expect(reconcile(storage, overrides)).toEqual({ status: 'conflict' });
  });

  it('reports a conflict for an event identifier of another event type', () => {
    const storage = recorded();
    expect(reconcile(storage, { eventId: L.source.eventId })).toEqual({
      status: 'conflict',
    });
  });

  it('reports a conflict when the proposal identifier is used by another event', () => {
    const storage = recorded();
    expect(reconcile(storage, { eventId: 'event_elsewhere' })).toEqual({
      status: 'conflict',
    });
  });

  it('reports a conflict for histories the recorder would not have written', () => {
    const variants: [
      string,
      (event: Record<string, unknown>) => void,
      { digest?: string; evidence?: unknown[] },
    ][] = [
      [
        'other creation metadata',
        (e) => {
          (e.metadata as Record<string, unknown>).creation = {
            component: 'synthetic-direct-writer',
            version: '1',
          };
        },
        {},
      ],
      [
        'other metadata time',
        (e) => {
          (e.metadata as Record<string, unknown>).createdAt =
            '2026-10-14T09:00:04Z';
        },
        {},
      ],
      ['other declared digest', () => {}, { digest: 'd'.repeat(64) }],
      [
        'attached evidence',
        (e) => {
          e.evidenceIds = ['evidence_attached'];
        },
        {
          evidence: [
            {
              kind: 'recorded_evidence',
              ownerId: L.ownerId,
              metadata: {
                schemaVersion: 1,
                recordVersion: 1,
                createdAt: L.occurredAt,
                creation: { component: 'synthetic-test-setup', version: '1' },
              },
              id: 'evidence_attached',
              eventId: 'event_proposal',
              provenance: L.inference(),
              content: { kind: 'recorded_text', text: 'Synthetic text.' },
            },
          ],
        },
      ],
    ];
    for (const [label, change, options] of variants) {
      const storage = track(L.world());
      plant(storage, change, options);
      expect(reconcile(storage), label).toEqual({ status: 'conflict' });
    }
  });
});

describe('reconcileActionProposalRecording: unresolved lookups', () => {
  it('is unresolved inside an open transaction and leaves it untouched', () => {
    const storage = track(L.world());
    storage.sqlite.exec('BEGIN');
    expectUnresolved(reconcile(storage), 'storage_failure');
    expect(storage.sqlite.inTransaction).toBe(true);
    storage.sqlite.exec('ROLLBACK');
  });

  it('is unresolved for an owner that does not exist', () => {
    const storage = track(L.world());
    expectUnresolved(
      reconcile(storage, {
        ownerId: 'owner_missing',
        proposal: L.proposalFor({}, 'owner_missing'),
      }),
      'unknown_binding',
    );
  });

  it('is unresolved, never a conflict, when a read fails', () => {
    for (const failing of [READ_SQL.owner, READ_SQL.projection]) {
      const storage = track(L.world());
      recordActionProposal(storage, L.request());
      const db = storage.sqlite;
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        if (sql === failing) throw new Error('synthetic read failure');
        return prepare(sql);
      }) as never);
      expectUnresolved(reconcile(storage), 'storage_failure');
      vi.restoreAllMocks();
    }
    const storage = track(L.world());
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql === READ_SQL.proposalInUse)
        throw new Error('synthetic read failure');
      return prepare(sql);
    }) as never);
    expectUnresolved(reconcile(storage), 'storage_failure');
  });

  it('reports a conflict for evidence stored against the event afterwards (test-only tampering)', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    // Test-only: an evidence row naming the event, inserted beside the Ledger.
    storage.sqlite.prepare('INSERT INTO evidence(record_json) VALUES (?)').run(
      JSON.stringify({
        kind: 'recorded_evidence',
        ownerId: L.ownerId,
        metadata: {
          schemaVersion: 1,
          recordVersion: 1,
          createdAt: L.occurredAt,
          creation: { component: 'synthetic-test-setup', version: '1' },
        },
        id: 'evidence_late',
        eventId: 'event_proposal',
        recordedAt: L.occurredAt,
        provenance: L.inference(),
        content: { kind: 'recorded_text', text: 'Synthetic late text.' },
      }),
    );
    expect(reconcile(storage)).toEqual({ status: 'conflict' });
  });

  it('is unresolved when stored history fails validation (test-only tampering)', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const db = storage.sqlite;
    // Test-only: lift the frozen immutability trigger to simulate corruption.
    db.exec('DROP TRIGGER action_proposals_no_update');
    const row = db
      .prepare(
        'SELECT record_json FROM action_proposals WHERE owner_id = ? AND record_id = ?',
      )
      .get(L.ownerId, 'proposal_synthetic') as { record_json: string };
    const tampered = JSON.parse(row.record_json) as {
      consequences: { description: string };
    };
    tampered.consequences.description = 'Tampered synthetic description.';
    db.prepare(
      'UPDATE action_proposals SET record_json = ? WHERE owner_id = ? AND record_id = ?',
    ).run(JSON.stringify(tampered), L.ownerId, 'proposal_synthetic');
    expectUnresolved(reconcile(storage), 'invalid_history');
  });

  it('is unresolved when the stored event itself fails validation', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    // Test-only: hand the frozen Ledger read an unparseable stored row.
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (
        !sql.startsWith('SELECT sequence, record_json FROM experience_events')
      )
        return statement;
      return {
        get: (...values: unknown[]) => ({
          ...(statement.get(...values) as { sequence: number }),
          record_json: '{"kind":"experience_event"}',
        }),
      };
    }) as never);
    expectUnresolved(reconcile(storage), 'invalid_history');
  });
});

describe('reconcileActionProposalRecording: exact timestamp order (Codex F1)', () => {
  it('never reports recorded for a stored event that precedes its proposal', () => {
    for (const [createdAt, occurredAt] of [
      // Same millisecond, and the same instant boundary through offsets.
      ['2026-01-14T09:00:00.0009Z', '2026-01-14T09:00:00.0001Z'],
      ['2026-01-15T00:30:00.25+01:00', '2026-01-14T23:30:00.2499999Z'],
    ]) {
      const storage = track(L.world());
      const proposal = L.proposalFor({ createdAt });
      // Test setup only: an event the recorder refuses, appended directly
      // through the frozen Ledger (whose own check is millisecond-based).
      plant(
        storage,
        (event) => {
          event.occurredAt = occurredAt;
          (event.metadata as Record<string, unknown>).createdAt = occurredAt;
        },
        {},
        L.request({ proposal, occurredAt: createdAt }),
      );
      const request = L.request({ proposal, occurredAt });
      const before = L.dump(storage);
      let thrown: unknown;
      try {
        reconcileActionProposalRecording(storage, request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ActionProposalError);
      expect(thrown).toMatchObject({
        code: 'timestamp_order',
        outcome: 'not_written',
      });
      expect(() => recordActionProposal(storage, request)).toThrow(
        ActionProposalError,
      );
      expect(L.dump(storage)).toBe(before);
    }
  });

  it('reconciles the identical request for an instant written with an offset', () => {
    const storage = track(L.world());
    const request = L.request({
      proposal: L.proposalFor({ createdAt: '2026-01-14T09:00:00.0001Z' }),
      occurredAt: '2026-01-14T14:30:00.0001+05:30',
    });
    const receipt = recordActionProposal(storage, request);
    expect(reconcileActionProposalRecording(storage, request)).toMatchObject({
      status: 'recorded',
      sequence: receipt.sequence,
    });
    // The same instant written differently is a different request.
    expect(
      reconcileActionProposalRecording(storage, {
        ...request,
        occurredAt: '2026-01-14T09:00:00.0001Z',
      }),
    ).toEqual({ status: 'conflict' });
  });
});

describe('reconcileActionProposalRecording: requests', () => {
  it('throws the recording error for a malformed request and reads nothing', () => {
    const storage = track(L.world());
    const prepare = vi.spyOn(storage.sqlite, 'prepare');
    for (const [request, code] of [
      [null, 'invalid_request'],
      [L.request({ eventId: 'bad' }), 'invalid_request'],
      [
        L.request({
          provenance: {
            kind: 'explicit_owner_statement',
            ownerId: L.ownerId,
            sourceEventId: 'event_proposal',
          },
        }),
        'unsupported_origin',
      ],
      [L.request({ occurredAt: '2026-10-14T08:00:00Z' }), 'timestamp_order'],
      [L.request({ taskId: L.otherTask }), 'binding_mismatch'],
    ] as const) {
      let thrown: unknown;
      try {
        reconcileActionProposalRecording(storage, request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ActionProposalError);
      expect(thrown).toMatchObject({ code, outcome: 'not_written' });
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('the unknown-outcome protocol', () => {
  /** COMMIT and ROLLBACK both fail: the old connection is left unusable. */
  function strand(storage: Storage, commit: 'throw' | 'run_then_throw') {
    const db = storage.sqlite;
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'COMMIT' && commit === 'run_then_throw') exec(sql);
      if (sql === 'COMMIT' || sql === 'ROLLBACK')
        throw new Error('synthetic I/O failure');
      return exec(sql);
    });
    let thrown: unknown;
    try {
      recordActionProposal(storage, L.request());
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();
    expect(thrown).toMatchObject({
      code: 'storage_failure',
      outcome: 'unknown',
    });
  }

  it('close, reopen, reconcile, then resubmit the identical request', () => {
    const path = file();
    const old = track(L.world(path));
    strand(old, 'throw');
    expect(old.sqlite.inTransaction).toBe(true);
    // The stranded connection cannot settle anything.
    expectUnresolved(reconcile(old), 'storage_failure');
    old.sqlite.close();

    const fresh = track(openStorage(path));
    expect(reconcile(fresh)).toEqual({ status: 'not_recorded' });
    const receipt = recordActionProposal(fresh, L.request());
    expect(reconcile(fresh)).toMatchObject({
      status: 'recorded',
      sequence: receipt.sequence,
    });
  });

  it('a committed but unconfirmed recording reconciles as recorded', () => {
    const path = file();
    const old = track(L.world(path));
    strand(old, 'run_then_throw');
    expect(old.sqlite.inTransaction).toBe(false);
    old.sqlite.close();

    const fresh = track(openStorage(path));
    const result = reconcile(fresh);
    expect(result).toMatchObject({ status: 'recorded' });
    // Resubmitting would be refused before any write.
    const before = L.dump(fresh);
    expect(() => recordActionProposal(fresh, L.request())).toThrow(
      ActionProposalError,
    );
    expect(L.dump(fresh)).toBe(before);
  });
});
