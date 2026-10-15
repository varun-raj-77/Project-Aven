// All owners, identifiers, texts and records in this file are SYNTHETIC.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, type EventInput } from '@aven/ledger';
import { openStorage, type Storage } from '@aven/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalText, digestOfCanonicalText } from '../src/canonical.ts';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
} from '../src/index.ts';
import {
  readProposalEvents,
  recordActionProposal,
  type ProposalEventRecord,
} from '../src/ledger/index.ts';
import { expectedRecordingEvent } from '../src/ledger/record.ts';
import { READ_SQL } from '../src/ledger/stored.ts';
import * as L from './ledger-fixtures.ts';

type Json = Record<string, unknown>;

const directories: string[] = [];
const open: Storage[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven011-history-'));
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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The protocol-v1 digest of any payload, without the v1 size limits. */
function digestOf(payload: unknown): string {
  const text = canonicalText(payload);
  return text === undefined ? 'e'.repeat(64) : digestOfCanonicalText(text);
}

/**
 * Test setup only: appends an `action_proposed` event directly through the
 * frozen Ledger, as any code with storage access could, so that the reader
 * sees histories the recorder itself never writes. `change` edits the event
 * the recorder would have written for `base`; the declared digest defaults
 * to the protocol-v1 digest of the (edited) payload.
 */
function plant(
  storage: Storage,
  change: (event: Json) => void,
  options: { digest?: string; evidence?: unknown[]; base?: Json } = {},
): Json {
  const event = clone(
    expectedRecordingEvent(options.base ?? L.request()).event,
  ) as unknown as Json;
  change(event);
  createLedger(storage, String(event.ownerId) as never).appendEvent(
    event as unknown as EventInput,
    {
      proposalDigest: {
        algorithm: 'sha256',
        value: options.digest ?? digestOf(event.payload),
      },
      ...(options.evidence ? { evidence: options.evidence as never } : {}),
    },
  );
  return event;
}

const payloadOf = (event: Json) => event.payload as Json;
const read = (storage: Storage, filter: unknown = {}, owner = L.ownerId) =>
  readProposalEvents(storage, owner, filter);
const only = (storage: Storage): ProposalEventRecord => {
  const { records } = read(storage);
  expect(records).toHaveLength(1);
  return records[0]!;
};

function expectFailure(run: () => unknown, code: ActionProposalErrorCode) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ActionProposalError);
  expect(thrown).toMatchObject({ code, outcome: 'not_written' });
  expect((thrown as Error).cause).toBeUndefined();
}

const CONFORMING = { status: 'conforming', reasons: [] };
const NOT_EVALUATED = { status: 'not_evaluated', reasons: [] };

describe('readProposalEvents: recorded proposals', () => {
  it('returns one record per recorded event with the documented fields', () => {
    const storage = track(L.world());
    const request = L.request();
    const receipt = recordActionProposal(storage, request);
    const page = read(storage);
    expect(Object.keys(page).sort()).toEqual([
      'nextCursor',
      'records',
      'throughSequence',
    ]);
    const record = page.records[0]!;
    expect(Object.keys(record).sort()).toEqual(
      [
        'declaredDigest',
        'digest',
        'envelopeTask',
        'eventFormat',
        'eventId',
        'evidenceIds',
        'occurredAt',
        'origin',
        'priorApprovalCitations',
        'proposal',
        'proposalFormat',
        'protocol',
        'provenance',
        'recordedAt',
        'sequence',
      ].sort(),
    );
    expect(record).toEqual({
      sequence: receipt.sequence,
      eventId: 'event_proposal',
      occurredAt: L.occurredAt,
      recordedAt: receipt.recordedAt,
      envelopeTask: { sessionId: L.sessionId, taskId: L.taskId },
      evidenceIds: [],
      provenance: request.provenance,
      origin: 'declared_unauthenticated',
      proposal: request.proposal,
      declaredDigest: receipt.binding.proposalDigest,
      protocol: 'v1',
      digest: 'agrees',
      proposalFormat: CONFORMING,
      eventFormat: CONFORMING,
      priorApprovalCitations: [],
    });
    expect(page.nextCursor).toBeNull();
    const frozen = (value: unknown): boolean =>
      value === null ||
      typeof value !== 'object' ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(page)).toBe(true);
  });

  it('returns every re-recording of one proposal as its own record', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    // A second event for the identical payload, with another origin.
    plant(storage, (e) => {
      e.id = 'event_again';
      e.provenance = L.systemGenerated();
    });
    const records = read(storage).records;
    expect(records.map((r) => r.eventId)).toEqual([
      'event_proposal',
      'event_again',
    ]);
    expect(records.map((r) => r.provenance.kind)).toEqual([
      'model_inference',
      'system_generated',
    ]);
    expect(records[0]!.sequence).toBeLessThan(records[1]!.sequence);
    expect(records.every((r) => r.digest === 'agrees')).toBe(true);
    expect(records[0]!.proposal).toEqual(records[1]!.proposal);
  });

  it('reports prior-approval citations unverified, never judged', () => {
    const storage = track(L.world());
    const first = recordActionProposal(storage, L.request());
    L.syntheticApproval(
      storage,
      first.binding,
      'approval_synthetic',
      'event_approval',
    );
    // The cited approval is bound to ANOTHER proposal; it is not evaluated.
    recordActionProposal(
      storage,
      L.request({
        eventId: 'event_second',
        proposal: L.proposalFor({
          proposalId: 'proposal_second',
          priorApprovalIds: ['approval_synthetic'],
        }),
      }),
    );
    const second = read(storage).records[1]!;
    expect(second.priorApprovalCitations).toEqual([
      { approvalId: 'approval_synthetic', status: 'cited_unverified' },
    ]);
    expect(second.eventFormat).toEqual(CONFORMING);
    expect(second.proposalFormat).toEqual(CONFORMING);
  });

  it('labels a forged authority-looking origin as declared and unauthenticated', () => {
    const storage = track(L.world());
    recordActionProposal(
      storage,
      L.request({
        provenance: {
          ...L.systemGenerated(),
          component: '@aven/root',
          version: 'ALLOW',
        },
      }),
    );
    const record = only(storage);
    expect(record.origin).toBe('declared_unauthenticated');
    expect(record.eventFormat).toEqual(CONFORMING);
    expect(record.digest).toBe('agrees');
    // A record is evidence of recording, never of permission.
    for (const key of ['decision', 'allowed', 'approved', 'authority'])
      expect(Object.hasOwn(record, key)).toBe(false);
  });
});

describe('readProposalEvents: classifications of directly appended events', () => {
  it('reports an unsupported creation stamp without evaluating anything', () => {
    for (const creation of [
      { component: 'synthetic-direct-writer', version: '1' },
      {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
        runtime: { identifier: 'synthetic-runtime', version: '1' },
      },
    ]) {
      const storage = track(L.world());
      plant(storage, (e) => {
        (payloadOf(e).metadata as Json).creation = creation;
      });
      const record = only(storage);
      expect(record.protocol).toBe('unsupported');
      expect(record.digest).toBe('not_evaluated');
      expect(record.proposalFormat).toEqual(NOT_EVALUATED);
      expect(record.eventFormat).toEqual(NOT_EVALUATED);
    }
  });

  it('reports a declared digest that disagrees with the payload', () => {
    const storage = track(L.world());
    plant(storage, () => {}, { digest: 'd'.repeat(64) });
    const record = only(storage);
    expect(record.digest).toBe('disagrees');
    expect(record.declaredDigest).toEqual({
      algorithm: 'sha256',
      value: 'd'.repeat(64),
    });
    // Format and digest are independent findings.
    expect(record.proposalFormat).toEqual(CONFORMING);
    expect(record.eventFormat).toEqual(CONFORMING);
  });

  it('reports ill-formed Unicode in the proposal and skips its digest', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      (payloadOf(e).consequences as Json).description = 'Synthetic \uD800';
    });
    const record = only(storage);
    expect(record.digest).toBe('not_evaluated');
    expect(record.proposalFormat).toEqual({
      status: 'nonconforming',
      reasons: ['proposal_ill_formed_unicode'],
    });
    expect(record.eventFormat).toEqual(CONFORMING);
    expect(record.proposal.consequences.description).toBe('Synthetic \uD800');
  });

  it('reports size limits without letting them affect the digest', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      (payloadOf(e).consequences as Json).description = 'x'.repeat(20_001);
    });
    const record = only(storage);
    expect(record.proposalFormat).toEqual({
      status: 'nonconforming',
      reasons: ['proposal_limits_exceeded'],
    });
    expect(record.digest).toBe('agrees');
  });

  it('reports a record version other than 1', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      (payloadOf(e).metadata as Json).recordVersion = 2;
    });
    const record = only(storage);
    expect(record.proposalFormat).toEqual({
      status: 'nonconforming',
      reasons: ['proposal_record_version_not_1'],
    });
    expect(record.digest).toBe('agrees');
  });

  it('reports operations outside the v1 recording format', () => {
    for (const authority of [
      {
        operation: 'promote_learning',
        resource: { kind: 'learned_state', identifier: 'learned_x' },
      },
      {
        operation: 'rollback_learning',
        resource: { kind: 'document', identifier: 'synthetic-doc' },
      },
      {
        operation: 'modify',
        resource: { kind: 'learned_state', identifier: 'learned_x' },
      },
    ]) {
      const storage = track(L.world());
      plant(storage, (e) => {
        payloadOf(e).requestedAuthority = [authority];
      });
      expect(only(storage).proposalFormat).toEqual({
        status: 'nonconforming',
        reasons: ['proposal_operation_not_in_v1_format'],
      });
    }
    // Reading learned state stays within the format.
    const storage = track(L.world());
    plant(storage, (e) => {
      payloadOf(e).requestedAuthority = [
        {
          operation: 'read',
          resource: { kind: 'learned_state', identifier: 'learned_x' },
        },
      ];
    });
    expect(only(storage).proposalFormat).toEqual(CONFORMING);
  });

  it('reports a missing envelope task', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      delete e.task;
    });
    const record = only(storage);
    expect(record.envelopeTask).toBeNull();
    expect(record.eventFormat).toEqual({
      status: 'nonconforming',
      reasons: ['event_task_missing'],
    });
  });

  it('reports origins outside the v1 recording format', () => {
    for (const provenance of [
      {
        kind: 'explicit_owner_statement',
        ownerId: L.ownerId,
        sourceEventId: 'event_proposal',
      },
      {
        kind: 'tool_result',
        toolId: 'synthetic-tool',
        sourceEventId: L.source.eventId,
        trust: 'potentially_untrusted',
      },
      {
        kind: 'external_content',
        source: 'synthetic-source',
        capturedAt: '2026-10-14T08:30:00Z',
        trust: 'untrusted',
      },
    ]) {
      const storage = track(L.world());
      plant(storage, (e) => {
        e.provenance = provenance;
      });
      const record = only(storage);
      expect(record.provenance).toEqual(provenance);
      expect(record.origin).toBe('declared_unauthenticated');
      expect(record.eventFormat).toEqual({
        status: 'nonconforming',
        reasons: ['event_origin_kind_unsupported'],
      });
    }
  });

  it('reports ill-formed Unicode and size limits in the event origin separately', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      e.provenance = { ...L.systemGenerated(), component: 'synthetic \uDC00' };
    });
    plant(storage, (e) => {
      e.id = 'event_long';
      e.provenance = {
        ...L.systemGenerated(),
        component: 'c'.repeat(20_001),
      };
    });
    const [unicode, long] = read(storage).records;
    expect(unicode!.eventFormat).toEqual({
      status: 'nonconforming',
      reasons: ['event_provenance_ill_formed_unicode'],
    });
    expect(long!.eventFormat).toEqual({
      status: 'nonconforming',
      reasons: ['event_provenance_limits_exceeded'],
    });
    // The proposal itself is unaffected by its event's origin.
    for (const record of [unicode!, long!]) {
      expect(record.proposalFormat).toEqual(CONFORMING);
      expect(record.digest).toBe('agrees');
    }
  });

  it('reports evidence recorded with the event', () => {
    const storage = track(L.world());
    plant(
      storage,
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
    );
    const record = only(storage);
    expect(record.evidenceIds).toEqual(['evidence_attached']);
    expect(record.eventFormat).toEqual({
      status: 'nonconforming',
      reasons: ['event_evidence_present'],
    });
  });

  it('reports evidence stored against the event afterwards (test-only tampering)', () => {
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
    const record = only(storage);
    expect(record.evidenceIds).toEqual([]);
    expect(record.eventFormat).toEqual({
      status: 'nonconforming',
      reasons: ['event_evidence_present'],
    });
  });

  it('reports event metadata other than the v1 recording metadata', () => {
    // The frozen contract itself refuses any other event schema or record
    // version, so only the creation stamp and creation time can differ.
    for (const change of [
      (m: Json) => {
        m.creation = { component: 'synthetic-direct-writer', version: '1' };
      },
      (m: Json) => {
        m.createdAt = '2026-10-14T09:00:04Z';
      },
      (m: Json) => {
        // The same instant written differently is still not the v1 form.
        m.createdAt = '2026-10-14T14:30:05+05:30';
      },
    ]) {
      const storage = track(L.world());
      plant(storage, (e) => change(e.metadata as Json));
      expect(only(storage).eventFormat).toEqual({
        status: 'nonconforming',
        reasons: ['event_metadata_not_v1'],
      });
    }
  });

  it('orders the event and proposal times exactly (sub-millisecond, offsets)', () => {
    const base = (createdAt: string, occurredAt: string) =>
      L.request({ proposal: L.proposalFor({ createdAt }), occurredAt });
    const cases: [string, string, boolean][] = [
      ['2026-01-14T09:00:00.0009Z', '2026-01-14T09:00:00.0001Z', true],
      ['2026-01-14T09:00:00.0001Z', '2026-01-14T09:00:00.0009Z', false],
      ['2026-01-15T00:30:00.25+01:00', '2026-01-14T23:30:00.2499999Z', true],
      ['2026-01-15T00:30:00.25+01:00', '2026-01-14T23:30:00.250Z', false],
    ];
    for (const [createdAt, occurredAt, before] of cases) {
      const storage = track(L.world());
      plant(
        storage,
        (e) => {
          e.occurredAt = occurredAt;
          (e.metadata as Json).createdAt = occurredAt;
        },
        { base: base(createdAt, createdAt) },
      );
      expect(only(storage).eventFormat).toEqual(
        before
          ? {
              status: 'nonconforming',
              reasons: ['event_occurs_before_proposal_creation'],
            }
          : CONFORMING,
      );
    }
  });

  it('reports every applicable reason together, in a fixed order', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      const p = payloadOf(e);
      (p.consequences as Json).description = `${'y'.repeat(20_001)}\uD800`;
      (p.metadata as Json).recordVersion = 2;
      p.requestedAuthority = [
        {
          operation: 'revoke_learning',
          resource: { kind: 'learned_state', identifier: 'learned_x' },
        },
      ];
      delete e.task;
      e.provenance = {
        kind: 'tool_result',
        toolId: `synthetic \uDC00${'t'.repeat(20_001)}`,
        sourceEventId: L.source.eventId,
        trust: 'potentially_untrusted',
      };
      (e.metadata as Json).creation = { component: 'other', version: '1' };
      e.occurredAt = '2026-10-14T08:59:59.9999999Z';
      (e.metadata as Json).createdAt = e.occurredAt;
    });
    const record = only(storage);
    expect(record.digest).toBe('not_evaluated');
    expect(record.proposalFormat).toEqual({
      status: 'nonconforming',
      reasons: [
        'proposal_ill_formed_unicode',
        'proposal_limits_exceeded',
        'proposal_record_version_not_1',
        'proposal_operation_not_in_v1_format',
      ],
    });
    expect(record.eventFormat.reasons).toEqual([
      'event_task_missing',
      'event_origin_kind_unsupported',
      'event_provenance_ill_formed_unicode',
      'event_provenance_limits_exceeded',
      'event_metadata_not_v1',
      'event_occurs_before_proposal_creation',
    ]);
  });
});

describe('readProposalEvents: paging is the Ledger paging', () => {
  /** A mixed history: proposals in several tasks, other events, two owners. */
  function history(storage: Storage) {
    let n = 0;
    const propose = (sessionId: string, taskId: string, owner = L.ownerId) => {
      n += 1;
      recordActionProposal(
        storage,
        L.request({
          ownerId: owner,
          sessionId,
          taskId,
          eventId: `event_p${n}`,
          proposal: L.proposalFor(
            { proposalId: `proposal_p${n}`, sessionId, taskId },
            owner,
          ),
        }),
      );
    };
    const other = (owner = L.ownerId) => {
      n += 1;
      const id = `event_r${n}`;
      const provenance = {
        kind: 'explicit_owner_statement',
        ownerId: owner,
        sourceEventId: id,
      };
      createLedger(storage, owner as never).appendEvent({
        kind: 'experience_event',
        ownerId: owner,
        metadata: {
          schemaVersion: 1,
          recordVersion: 1,
          createdAt: '2026-10-14T08:00:00Z',
          creation: { component: 'synthetic-test-setup', version: '1' },
        },
        id,
        task: { sessionId: L.sessionId, taskId: L.taskId },
        occurredAt: '2026-10-14T08:00:00Z',
        evidenceIds: [],
        eventType: 'owner_request',
        payload: {
          instruction: 'Synthetic request.',
          task: { sessionId: L.sessionId, taskId: L.taskId },
        },
        provenance,
      } as unknown as EventInput);
    };
    for (let round = 0; round < 3; round += 1) {
      propose(L.sessionId, L.taskId);
      other();
      propose(L.sessionId, L.otherTask);
      propose(L.secondSession, L.secondTask);
      other(L.otherOwner);
      propose(L.sessionId, L.taskId, L.otherOwner);
    }
  }

  it('matches listEvents exactly for every filter and limit combination', () => {
    const storage = track(L.world());
    history(storage);
    const ledger = createLedger(storage, L.ownerId as never);
    const max = ledger.listEvents({ limit: 1000 }).throughSequence;
    let compared = 0;
    for (const sessionId of [
      undefined,
      L.sessionId,
      L.secondSession,
      'session_none',
    ])
      for (const taskId of [undefined, L.taskId, L.otherTask, L.secondTask])
        for (const afterSequence of [undefined, 0, 5, max])
          for (const throughSequence of [undefined, 0, 9, max, max + 50])
            for (const limit of [undefined, 1, 2, 3, 1000]) {
              const filter = Object.fromEntries(
                Object.entries({
                  sessionId,
                  taskId,
                  afterSequence,
                  throughSequence,
                  limit,
                }).filter(([, v]) => v !== undefined),
              );
              const page = read(storage, filter);
              const expected = ledger.listEvents({
                ...filter,
                eventType: 'action_proposed',
              });
              expect(page.records.map((r) => r.sequence)).toEqual(
                expected.events.map((e) => e.sequence),
              );
              expect(page.records.map((r) => r.eventId)).toEqual(
                expected.events.map((e) => e.event.id),
              );
              expect(page.throughSequence).toBe(expected.throughSequence);
              expect(page.nextCursor).toEqual(expected.nextCursor);
              compared += 1;
            }
    expect(compared).toBe(4 * 4 * 4 * 5 * 5);
  });

  it('pages through every record once, in sequence order, with the same filter', () => {
    const storage = track(L.world());
    history(storage);
    const all = read(storage, { limit: 1000 }).records;
    expect(all).toHaveLength(9);
    for (const limit of [1, 2, 4]) {
      const seen: number[] = [];
      let cursor: { afterSequence: number; throughSequence: number } | null =
        null;
      do {
        const page: ReturnType<typeof read> = read(storage, {
          limit,
          ...(cursor ?? {}),
        });
        seen.push(...page.records.map((r) => r.sequence));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(seen).toEqual(all.map((r) => r.sequence));
    }
    expect(
      all.map((r) => r.sequence).every((s, i, a) => i === 0 || s > a[i - 1]!),
    ).toBe(true);
  });

  it('orders by sequence only, never by any timestamp', () => {
    const storage = track(L.world());
    plant(
      storage,
      (e) => {
        e.id = 'event_late';
      },
      { base: L.request({ occurredAt: '2026-10-14T09:30:00Z' }) },
    );
    plant(storage, (e) => {
      e.id = 'event_early';
      e.occurredAt = '2026-10-14T09:00:00Z';
      (e.metadata as Json).createdAt = e.occurredAt;
      (payloadOf(e) as Json).id = 'proposal_early';
    });
    expect(read(storage).records.map((r) => r.eventId)).toEqual([
      'event_late',
      'event_early',
    ]);
  });

  it("returns only the requested owner's records", () => {
    const storage = track(L.world());
    history(storage);
    const mine = read(storage, { limit: 1000 }).records;
    const theirs = read(storage, { limit: 1000 }, L.otherOwner).records;
    expect(mine.every((r) => r.proposal.ownerId === L.ownerId)).toBe(true);
    expect(theirs.every((r) => r.proposal.ownerId === L.otherOwner)).toBe(true);
    expect(theirs).toHaveLength(3);
  });
});

describe('readProposalEvents: read-only and query_only', () => {
  it('writes nothing and issues only SELECT statements', () => {
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
    read(storage);
    read(storage, { taskId: L.taskId, limit: 1 });
    expect(exec).not.toHaveBeenCalled();
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql.trimStart()).toMatch(/^SELECT /);
    vi.restoreAllMocks();
    expect(L.dump(storage)).toBe(before);
  });

  it('reads through a query_only connection to a file database', () => {
    const path = file();
    const writer = track(L.world(path));
    const receipt = recordActionProposal(writer, L.request());
    writer.sqlite.close();
    const reader = track(openStorage(path));
    reader.sqlite.pragma('query_only = ON');
    expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
    const record = only(reader);
    expect(record.sequence).toBe(receipt.sequence);
    expect(record.digest).toBe('agrees');
    // The connection really refuses writes.
    expect(() =>
      reader.sqlite.prepare('DELETE FROM owners WHERE 0').run(),
    ).toThrow();
  });
});

describe('readProposalEvents: fails closed with no partial page', () => {
  it('rejects malformed owners and filters as invalid_request', () => {
    const storage = track(L.world());
    for (const owner of ['', 'Owner Synthetic', 7, null])
      expectFailure(
        () => readProposalEvents(storage, owner),
        'invalid_request',
      );
    for (const filter of [
      null,
      'filter',
      [],
      { eventType: 'action_proposed' },
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { afterSequence: -1 },
      { throughSequence: Number.MAX_SAFE_INTEGER + 1 },
      { sessionId: 'not-a-session' },
      { extra: true },
      new Proxy({}, {}),
    ])
      expectFailure(() => read(storage, filter), 'invalid_request');
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'limit', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expectFailure(() => read(storage, accessor), 'invalid_request');
    expect(reads).toBe(0);
  });

  it('reports a missing owner as unknown_binding', () => {
    const storage = track(L.world());
    expectFailure(() => read(storage, {}, 'owner_missing'), 'unknown_binding');
  });

  it('reports an open transaction or a failing read as storage_failure', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    storage.sqlite.exec('BEGIN');
    expectFailure(() => read(storage), 'storage_failure');
    expect(storage.sqlite.inTransaction).toBe(true);
    storage.sqlite.exec('ROLLBACK');

    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql === READ_SQL.projection) throw new Error('synthetic failure');
      return prepare(sql);
    }) as never);
    expectFailure(() => read(storage), 'storage_failure');
  });

  /** A valid record first, then the corrupted one: nothing is returned. */
  function corrupted(tamper: (storage: Storage) => void) {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    recordActionProposal(
      storage,
      L.request({
        eventId: 'event_second',
        proposal: L.proposalFor({ proposalId: 'proposal_second' }),
      }),
    );
    tamper(storage);
    expectFailure(() => read(storage), 'invalid_history');
    // A page holding both records fails; no partial page is returned.
    expectFailure(() => read(storage, { limit: 2 }), 'invalid_history');
    return storage;
  }

  it('fails on a projection that differs from its event payload (test-only tampering)', () => {
    const storage = corrupted((s) => {
      s.sqlite.exec('DROP TRIGGER action_proposals_no_update');
      const row = s.sqlite
        .prepare(
          'SELECT record_json FROM action_proposals WHERE owner_id = ? AND record_id = ?',
        )
        .get(L.ownerId, 'proposal_second') as { record_json: string };
      const tampered = JSON.parse(row.record_json) as Json;
      (tampered.consequences as Json).description = 'Tampered.';
      s.sqlite
        .prepare(
          'UPDATE action_proposals SET record_json = ? WHERE owner_id = ? AND record_id = ?',
        )
        .run(JSON.stringify(tampered), L.ownerId, 'proposal_second');
    });
    // The record before the corrupted one is still readable on its own.
    expect(read(storage, { limit: 1 }).records).toHaveLength(1);
  });

  /** Test-only: rewrites one stored projection with the frozen trigger lifted. */
  function rewriteProjection(
    storage: Storage,
    proposalId: string,
    edit: (projection: Json) => void,
  ) {
    const db = storage.sqlite;
    db.exec('DROP TRIGGER IF EXISTS action_proposals_no_update');
    const row = db
      .prepare(
        'SELECT record_json FROM action_proposals WHERE owner_id = ? AND record_id = ?',
      )
      .get(L.ownerId, proposalId) as { record_json: string };
    const projection = JSON.parse(row.record_json) as Json;
    edit(projection);
    db.prepare(
      'UPDATE action_proposals SET record_json = ? WHERE owner_id = ? AND record_id = ?',
    ).run(JSON.stringify(projection), L.ownerId, proposalId);
  }

  it('fails on a projection missing an optional member of its payload', () => {
    const storage = track(L.world());
    plant(storage, (e) => {
      (payloadOf(e).metadata as Json).creation = {
        component: 'synthetic-direct-writer',
        version: '1',
        runtime: { identifier: 'synthetic-runtime', version: '1' },
      };
    });
    expect(only(storage).protocol).toBe('unsupported');
    rewriteProjection(storage, 'proposal_synthetic', (projection) => {
      delete ((projection.metadata as Json).creation as Json).runtime;
    });
    expectFailure(() => read(storage), 'invalid_history');
  });

  it('fails on a projection whose arrays differ in length from the payload', () => {
    const authority = (identifier: string) => ({
      operation: 'draft',
      resource: { kind: 'sandbox_resource', identifier },
    });
    for (const edit of [
      (projection: Json) => {
        projection.requestedAuthority = [authority('synthetic-a')];
      },
      (projection: Json) => {
        projection.requestedAuthority = [
          authority('synthetic-a'),
          authority('synthetic-b'),
          authority('synthetic-c'),
        ];
      },
    ]) {
      const storage = track(L.world());
      recordActionProposal(
        storage,
        L.request({
          proposal: L.proposalFor({
            requestedAuthority: [
              authority('synthetic-a'),
              authority('synthetic-b'),
            ],
          }),
        }),
      );
      rewriteProjection(storage, 'proposal_synthetic', edit);
      expectFailure(() => read(storage), 'invalid_history');
    }
  });

  it('fails on a page row that is not a proposal event', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    const sourceJson = (
      prepare(
        'SELECT record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
      ).get(L.ownerId, L.source.eventId) as { record_json: string }
    ).record_json;
    // Test-only: the frozen page read hands back an owner_request event.
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (
        !sql.startsWith('SELECT sequence, record_json FROM experience_events')
      )
        return statement;
      return {
        all: (...values: unknown[]) =>
          (statement.all(...values) as Json[]).map((row) => ({
            ...row,
            record_json: sourceJson,
          })),
      };
    }) as never);
    expectFailure(() => read(storage), 'invalid_history');
  });

  it('fails on a missing projection (test-only tampering)', () => {
    corrupted((s) => {
      s.sqlite.exec('DROP TRIGGER action_proposals_no_delete');
      s.sqlite.pragma('foreign_keys = OFF');
      s.sqlite
        .prepare(
          'DELETE FROM action_proposals WHERE owner_id = ? AND record_id = ?',
        )
        .run(L.ownerId, 'proposal_second');
      s.sqlite.pragma('foreign_keys = ON');
    });
  });

  it('fails on a stored event that fails frozen validation', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    // Test-only: hand the frozen Ledger page read one unparseable row.
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (
        !sql.startsWith('SELECT sequence, record_json FROM experience_events')
      )
        return statement;
      return {
        all: (...values: unknown[]) =>
          (statement.all(...values) as Json[]).map((row) => ({
            ...row,
            record_json: '{"kind":"experience_event"}',
          })),
      };
    }) as never);
    expectFailure(() => read(storage), 'invalid_history');
  });

  it('fails on a projection row with an unusable declared digest', () => {
    const storage = track(L.world());
    recordActionProposal(storage, L.request());
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    for (const proposal_digest of [
      undefined,
      7,
      'D'.repeat(64),
      'd'.repeat(63),
    ]) {
      vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        const statement = prepare(sql);
        if (sql !== READ_SQL.projection) return statement;
        return {
          get: (...values: unknown[]) => ({
            ...(statement.get(...values) as Json),
            proposal_digest,
          }),
        };
      }) as never);
      expectFailure(() => read(storage), 'invalid_history');
      vi.restoreAllMocks();
    }
    expect(only(storage).digest).toBe('agrees');
  });
});
