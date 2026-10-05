import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as c from '@aven/contracts';
import { openStorage, serializeContract, type Storage } from '@aven/storage';
import {
  createLedger,
  LedgerError,
  type AppendOptions,
  type EventInput,
  type HistoryFilter,
} from '../src/index.ts';
import {
  authority,
  correction,
  event,
  evidence,
  f,
  fresh,
  identities,
  request,
  source,
} from './fixtures.ts';

const opened: Storage[] = [];
const directories: string[] = [];
function setup(filename?: string) {
  const result = fresh(filename);
  opened.push(result.storage);
  return result;
}
function filename() {
  const dir = mkdtempSync(join(tmpdir(), 'aven004-synthetic-'));
  directories.push(dir);
  return join(dir, 'history.sqlite');
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const s of opened.splice(0)) if (s.sqlite.open) s.close();
  for (const dir of directories.splice(0)) {
    const target = resolve(dir);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('aven004-synthetic-')
    )
      throw new Error('Unsafe synthetic test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function error(fn: () => unknown, code: string, rollback?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect(e).toMatchObject({ code, ...(rollback ? { rollback } : {}) });
    return;
  }
  throw new Error(`Expected ${code}`);
}
function count(s: Storage, table: string) {
  return (
    s.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
function snapshot(s: Storage) {
  return [
    'experience_events',
    'evidence',
    'corrections',
    'record_keys',
    'record_versions',
    'record_references',
    'sqlite_sequence',
  ].map((table) => s.sqlite.prepare(`SELECT * FROM ${table}`).all());
}

describe('append boundary and historical identity', () => {
  it('commits a contract-valid event/evidence with assigned recording time and canonical sequence', () => {
    const { ledger, storage } = setup();
    const before = Date.now();
    const result = source(ledger);
    expect(result.sequence).toBe(1);
    expect(result.event.id).toBe(f.evidence.eventId);
    expect(Date.parse(result.event.recordedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.event.recordedAt)).toBeLessThanOrEqual(Date.now());
    expect(result.evidence[0]?.recordedAt).toBe(result.event.recordedAt);
    expect(c.ExperienceEventSchema.parse(result.event)).toEqual(result.event);
    expect(ledger.getEvent(result.event.id)).toEqual(result);
    expect(count(storage, 'record_references')).toBeGreaterThan(0);
    expect(storage.sqlite.inTransaction).toBe(false);
  });
  it('returns independent decoded results; caller mutation cannot rewrite history', () => {
    const { ledger } = setup();
    const original = request();
    const result = ledger.appendEvent(original);
    if (original.eventType === 'owner_request')
      original.payload.instruction = 'Caller changed';
    if (result.event.eventType === 'owner_request')
      result.event.payload.instruction = 'Result changed';
    expect(ledger.getEvent(result.event.id)?.event.payload).toMatchObject({
      instruction: 'Synthetic request',
    });
  });
  it('rejects both identical and changed duplicate IDs without changing any historical bytes', () => {
    const { ledger, storage } = setup();
    const input = request();
    ledger.appendEvent(input);
    const before = snapshot(storage);
    error(() => ledger.appendEvent(input), 'duplicate_event', 'rolled_back');
    error(
      () =>
        ledger.appendEvent({ ...input, occurredAt: '2026-10-03T00:00:00Z' }),
      'duplicate_event',
    );
    expect(snapshot(storage)).toEqual(before);
  });
  it('exposes neither mutation methods nor storage handles', () => {
    const { ledger } = setup();
    expect(Object.keys(ledger).sort()).toEqual([
      'appendEvent',
      'getEvent',
      'inspectIntegrity',
      'listEvents',
      'ownerId',
      'replayEvents',
    ]);
    expect(Object.isFrozen(ledger)).toBe(true);
  });
  it.each([
    'UPDATE experience_events SET record_json = record_json',
    'DELETE FROM experience_events',
    'DELETE FROM record_references',
  ])('retains direct storage protections: %s', (sql) => {
    const { ledger, storage } = setup();
    source(ledger);
    const before = snapshot(storage);
    expect(() => storage.sqlite.exec(sql)).toThrow(/Immutable/);
    expect(snapshot(storage)).toEqual(before);
  });
  it('retains replacement and upsert protection', () => {
    const { ledger, storage } = setup();
    const stored = ledger.appendEvent(request());
    for (const sql of [
      'INSERT OR REPLACE INTO experience_events(record_json) VALUES (?)',
      'INSERT INTO experience_events(record_json) VALUES (?) ON CONFLICT DO UPDATE SET record_json = excluded.record_json',
    ])
      expect(() =>
        storage.sqlite.prepare(sql).run(JSON.stringify(stored.event)),
      ).toThrow();
    expect(ledger.getEvent(stored.event.id)).toEqual(stored);
  });
  it.each([
    { sequence: 99 },
    { recordedAt: f.later },
    { recordedAt: undefined },
    { payload: { instruction: 'Missing task' } },
    { eventType: 'unknown' },
    { occurredAt: '2999-01-01T00:00:00Z' },
    { provenance: f.inference },
    { metadata: { ...f.metadata, recordVersion: 2 } },
  ])(
    'rejects invalid contracts or caller recording metadata before opening a transaction %#',
    (change) => {
      const { ledger, storage } = setup();
      const before = snapshot(storage);
      error(
        () => ledger.appendEvent({ ...request(), ...change } as EventInput),
        'invalid_event',
        'not_started',
      );
      expect(snapshot(storage)).toEqual(before);
    },
  );
  it('rejects malformed evidence and incomplete evidence sets', () => {
    const { ledger, storage } = setup();
    error(
      () =>
        ledger.appendEvent({
          ...request(),
          evidenceIds: [f.evidence.evidenceId],
        }),
      'invalid_reference',
    );
    error(
      () => ledger.appendEvent(request(), { evidence: [evidence()] }),
      'invalid_reference',
    );
    error(
      () =>
        ledger.appendEvent(
          {
            ...request(),
            evidenceIds: [f.evidence.evidenceId, f.evidence.evidenceId],
          },
          { evidence: [evidence()] },
        ),
      'invalid_reference',
    );
    error(
      () =>
        ledger.appendEvent(request(), {
          evidence: [f.recordedEvidence as never],
        }),
      'invalid_event',
    );
    expect(count(storage, 'experience_events')).toBe(0);
  });
  it('requires an explicit digest only when recording a proposal', () => {
    const { ledger } = setup();
    source(ledger);
    error(
      () =>
        ledger.appendEvent(
          event('event_proposal', 'action_proposed', f.proposal, f.inference),
        ),
      'invalid_input',
    );
    error(
      () =>
        ledger.appendEvent(request('event_extra'), {
          proposalDigest: f.digest,
        }),
      'invalid_input',
    );
  });
});

describe('owner-bounded reads and canonical pagination', () => {
  it('isolates owners, including equal EventId values in the frozen owner namespace', () => {
    const { ledger, storage } = setup();
    identities(storage, 'other');
    const other = createLedger(storage, c.OwnerIdSchema.parse('owner_other'));
    ledger.appendEvent(request());
    other.appendEvent(request('event_source', 'other'));
    const privateEvent = other.appendEvent(request('event_private', 'other'));
    expect(ledger.getEvent(privateEvent.event.id)).toBeUndefined();
    expect(ledger.listEvents().events.map((e) => e.sequence)).toEqual([1]);
    expect(other.listEvents().events.map((e) => e.sequence)).toEqual([2, 3]);
    expect([...ledger.replayEvents()]).toHaveLength(1);
  });
  it('orders owner, session and task history including payload-only bindings', () => {
    const { ledger, storage } = setup();
    storage.sqlite
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(f.owner, 'session_second', f.time);
    storage.sqlite
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
      .run(f.owner, 'task_second', 'session_second', f.time);
    ledger.appendEvent(request('event_z'));
    const { task: _task, ...noEnvelope } = request('event_a');
    ledger.appendEvent(noEnvelope);
    const binding = c.TaskBindingSchema.parse({
      sessionId: 'session_second',
      taskId: 'task_second',
    });
    ledger.appendEvent({
      ...request('event_b'),
      task: binding,
      payload: { instruction: 'Synthetic second session', task: binding },
      eventType: 'owner_request',
      provenance: {
        ...f.ownerProvenance,
        sourceEventId: c.EventIdSchema.parse('event_b'),
      },
    });
    expect(ledger.listEvents().events.map((e) => e.event.id)).toEqual([
      'event_z',
      'event_a',
      'event_b',
    ]);
    expect(
      ledger
        .listEvents({ sessionId: f.task.sessionId })
        .events.map((e) => e.sequence),
    ).toEqual([1, 2]);
    expect(
      ledger
        .listEvents({ taskId: f.task.taskId })
        .events.map((e) => e.sequence),
    ).toEqual([1, 2]);
    expect(
      ledger.listEvents({ sessionId: f.task.sessionId, taskId: binding.taskId })
        .events,
    ).toEqual([]);
  });
  it('uses correction applicability and approval bounds when the envelope binding is absent', () => {
    const { ledger, storage } = setup();
    storage.sqlite
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(f.owner, 'session_second', f.time);
    source(ledger); // 1: envelope binding
    function unbound(
      eventId: string,
      evidenceId: string,
      immediateApplicability: unknown,
    ) {
      const change = correction();
      const ref = c.EvidenceReferenceSchema.parse({ eventId, evidenceId });
      const provenance = {
        ...change.event.provenance,
        sourceEventId: ref.eventId,
      };
      const { task: _task, ...envelope } = event(
        eventId,
        'owner_correction',
        {
          ...change.event.payload,
          evidence: ref,
          provenance,
          immediateApplicability,
        },
        provenance,
      );
      return ledger.appendEvent(
        { ...envelope, evidenceIds: [ref.evidenceId] },
        {
          evidence: [
            evidence({
              ...f.recordedEvidence,
              id: ref.evidenceId,
              eventId: ref.eventId,
              provenance,
            }),
          ],
        },
      );
    }
    unbound('event_task_correction', 'evidence_task_correction', {
      kind: 'current_task',
      task: f.task,
    }); // 2
    unbound('event_session_correction', 'evidence_session_correction', {
      kind: 'current_session',
      sessionId: 'session_second',
    }); // 3
    ledger.appendEvent(
      event('event_proposal', 'action_proposed', f.proposal, f.inference),
      { proposalDigest: f.digest },
    ); // 4: envelope binding
    const ref = c.EvidenceReferenceSchema.parse({
      eventId: 'event_approval',
      evidenceId: 'evidence_approval',
    });
    const provenance = { ...f.approval.provenance, sourceEventId: ref.eventId };
    const { task: _task, ...approval } = event(
      ref.eventId,
      'owner_approval',
      { ...f.approval, provenance, evidence: ref },
      provenance,
    );
    ledger.appendEvent(
      { ...approval, evidenceIds: [ref.evidenceId] },
      {
        evidence: [
          evidence({
            ...f.recordedEvidence,
            id: ref.evidenceId,
            eventId: ref.eventId,
            provenance,
          }),
        ],
      },
    ); // 5: payload bounds only
    const sequences = (filter: HistoryFilter) =>
      ledger.listEvents(filter).events.map((e) => e.sequence);
    expect(sequences({})).toEqual([1, 2, 3, 4, 5]);
    expect(sequences({ sessionId: f.task.sessionId })).toEqual([1, 2, 4, 5]);
    expect(sequences({ taskId: f.task.taskId })).toEqual([1, 2, 4, 5]);
    expect(
      sequences({ sessionId: c.SessionIdSchema.parse('session_second') }),
    ).toEqual([3]);
    expect(ledger.inspectIntegrity().ok).toBe(true);
  });
  it('filters event types and exclusive/inclusive sequence bounds independently of timestamps', () => {
    const { ledger } = setup();
    source(ledger);
    ledger.appendEvent({ ...request('event_later'), occurredAt: f.later });
    ledger.appendEvent({ ...request('event_earlier'), occurredAt: f.time });
    ledger.appendEvent(
      event(
        'event_response',
        'assistant_response',
        {
          task: f.task,
          response: 'Synthetic response',
          citedEvidence: [f.evidence],
        },
        f.inference,
      ),
    );
    expect(
      ledger
        .listEvents({ afterSequence: 1, throughSequence: 3 })
        .events.map((e) => e.sequence),
    ).toEqual([2, 3]);
    expect(
      ledger
        .listEvents({ eventType: 'assistant_response' })
        .events.map((e) => e.sequence),
    ).toEqual([4]);
    expect(
      ledger
        .listEvents({ eventType: 'owner_request', afterSequence: 1 })
        .events.map((e) => e.sequence),
    ).toEqual([2, 3]);
    expect(ledger.listEvents({ throughSequence: 0 }).events).toEqual([]);
  });
  it('paginates gaps without skipping, duplicating or including later appends', () => {
    const { ledger, storage } = setup();
    identities(storage, 'other');
    const other = createLedger(storage, c.OwnerIdSchema.parse('owner_other'));
    for (let i = 0; i < 7; i++) {
      ledger.appendEvent(request(`event_page${i}`));
      other.appendEvent(request(`event_gap${i}`, 'other'));
    }
    let page = ledger.listEvents({ limit: 2 });
    const seen = [...page.events];
    ledger.appendEvent(request('event_after_boundary'));
    while (page.nextCursor) {
      page = ledger.listEvents({ limit: 2, ...page.nextCursor });
      seen.push(...page.events);
    }
    expect(seen.map((e) => e.sequence)).toEqual([1, 3, 5, 7, 9, 11, 13]);
    expect(new Set(seen.map((e) => e.event.id)).size).toBe(7);
  });
  it.each([
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { afterSequence: -1 },
    { throughSequence: Infinity },
    { eventType: 'bad' },
    { ownerId: 'owner_other' },
    { sql: '1=1' },
  ])('rejects invalid filters %#', (filter) => {
    const { ledger } = setup();
    error(() => ledger.listEvents(filter as HistoryFilter), 'invalid_input');
    error(() => ledger.replayEvents(filter as HistoryFilter), 'invalid_input');
  });
  it('reports missing owners for writes and reads; exact missing events are undefined', () => {
    const { ledger, storage } = setup();
    expect(
      ledger.getEvent(c.EventIdSchema.parse('event_missing')),
    ).toBeUndefined();
    const missing = createLedger(
      storage,
      c.OwnerIdSchema.parse('owner_missing'),
    );
    error(
      () => missing.appendEvent(request('event_missing', 'missing')),
      'unknown_owner',
      'rolled_back',
    );
    error(() => missing.listEvents(), 'unknown_owner');
    error(() => ledger.getEvent('invalid' as c.EventId), 'invalid_input');
  });
});

describe('corrections, provenance and authority', () => {
  it('appends an explicit correction without changing original bytes or creating owner state', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const before = storage.sqlite
      .prepare('SELECT record_json FROM experience_events WHERE sequence = 1')
      .get();
    const change = correction();
    const stored = ledger.appendEvent(change.event, {
      evidence: [change.evidence],
    });
    expect(stored.event.provenance.kind).toBe('explicit_owner_correction');
    expect(stored.event.payload).toEqual(change.event.payload);
    expect(
      storage.sqlite
        .prepare('SELECT record_json FROM experience_events WHERE sequence = 1')
        .get(),
    ).toEqual(before);
    expect(ledger.listEvents().events).toHaveLength(2);
    expect(count(storage, 'corrections')).toBe(1);
    for (const table of [
      'learned_owner_state',
      'active_task_state',
      'learning_candidates',
    ])
      expect(count(storage, table)).toBe(0);
  });
  it('preserves model derivation, cited evidence, source coverage and untrusted evidence', () => {
    const { ledger } = setup();
    source(ledger);
    const response = event(
      'event_response',
      'assistant_response',
      {
        task: f.task,
        response: 'Synthetic inference',
        citedEvidence: [f.evidence],
      },
      f.inference,
    );
    const id = c.EvidenceIdSchema.parse('evidence_external');
    const stored = ledger.appendEvent(
      { ...response, evidenceIds: [id] },
      {
        evidence: [
          evidence({
            ...f.recordedEvidence,
            id,
            eventId: response.id,
            provenance: f.external,
          }),
        ],
      },
    );
    expect(ledger.getEvent(response.id)).toEqual(stored);
    expect(stored.event.provenance).toEqual(f.inference);
    expect(stored.evidence[0]?.provenance).toEqual(f.external);
  });
  it('preserves proposal/policy/approval bindings and keeps execution separate from verification', () => {
    const { ledger, storage } = setup();
    source(ledger);
    authority(ledger);
    expect(count(storage, 'verification_results')).toBe(0);
    const execution = ledger.listEvents({ eventType: 'tool_execution' })
      .events[0];
    expect(execution?.event.payload).toEqual(f.execution);
    expect(execution?.event.provenance).toMatchObject({
      kind: 'tool_result',
      trust: 'potentially_untrusted',
    });
    const verified = ledger.appendEvent(
      event('event_verification', 'verification', f.verification),
    );
    expect(verified.event.eventType).toBe('verification');
    expect(verified.event.payload).toEqual(f.verification);
    const refs = storage.sqlite
      .prepare(
        "SELECT target_kind, target_id FROM record_references WHERE source_kind = 'experience_events' AND source_id = 'event_policy'",
      )
      .all();
    expect(refs).toContainEqual({
      target_kind: 'owner_approvals',
      target_id: f.approval.id,
    });
    expect(refs).toContainEqual({
      target_kind: 'action_proposals',
      target_id: f.proposal.id,
    });
    expect(ledger.inspectIntegrity().ok).toBe(true);
  });
  it('rejects owner-origin evidence attached to a model inference event', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const response = event(
      'event_response',
      'assistant_response',
      { task: f.task, response: 'Synthetic inference', citedEvidence: [] },
      f.inference,
    );
    const id = c.EvidenceIdSchema.parse('evidence_laundered');
    const before = snapshot(storage);
    error(
      () =>
        ledger.appendEvent(
          { ...response, evidenceIds: [id] },
          {
            evidence: [
              evidence({
                ...f.recordedEvidence,
                id,
                eventId: response.id,
                provenance: {
                  ...f.ownerProvenance,
                  sourceEventId: response.id,
                },
              }),
            ],
          },
        ),
      'invalid_reference',
      'not_started',
    );
    expect(snapshot(storage)).toEqual(before);
  });
  it('rejects new owner-origin evidence on an event whose declared owner origin is an earlier event', () => {
    const { ledger, storage } = setup();
    source(ledger);
    // A proposal may declare that it derives from the earlier owner statement...
    const proposal = event(
      'event_proposal',
      'action_proposed',
      f.proposal,
      f.ownerProvenance,
    );
    const id = c.EvidenceIdSchema.parse('evidence_minted');
    const before = snapshot(storage);
    // ...but cannot mint new evidence claiming the owner stated this event's content.
    error(
      () =>
        ledger.appendEvent(
          { ...proposal, evidenceIds: [id] },
          {
            proposalDigest: f.digest,
            evidence: [
              evidence({
                ...f.recordedEvidence,
                id,
                eventId: proposal.id,
                content: { kind: 'recorded_text', text: 'Synthetic generated' },
                provenance: {
                  ...f.ownerProvenance,
                  sourceEventId: proposal.id,
                },
              }),
            ],
          },
        ),
      'invalid_reference',
      'not_started',
    );
    expect(snapshot(storage)).toEqual(before);
    // The declared derivation itself is recorded exactly as supplied, not reinterpreted.
    const stored = ledger.appendEvent(proposal, { proposalDigest: f.digest });
    expect(stored.event.provenance).toEqual(f.ownerProvenance);
    expect(stored.evidence).toEqual([]);
  });
  it('types every foreign owner claim as a cross-owner reference before writing', () => {
    const { ledger, storage } = setup();
    identities(storage, 'other');
    const other = c.OwnerIdSchema.parse('owner_other');
    const before = snapshot(storage);
    const base = request();
    const cases: [EventInput, AppendOptions | undefined][] = [
      [
        {
          ...base,
          provenance: { ...f.ownerProvenance, ownerId: other },
        } as EventInput,
        undefined,
      ],
      [
        { ...base, evidenceIds: [f.evidence.evidenceId] },
        { evidence: [evidence({ ...f.recordedEvidence, ownerId: other })] },
      ],
      [
        { ...base, evidenceIds: [f.evidence.evidenceId] },
        {
          evidence: [
            evidence({
              ...f.recordedEvidence,
              provenance: { ...f.ownerProvenance, ownerId: other },
            }),
          ],
        },
      ],
    ];
    for (const [input, options] of cases)
      error(
        () => ledger.appendEvent(input, options),
        'cross_owner_reference',
        'not_started',
      );
    expect(snapshot(storage)).toEqual(before);
  });
  it('keeps recording timestamps out of canonical ordering even when the local clock reverses', () => {
    const { ledger } = setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-05T15:00:00Z'));
      const first = ledger.appendEvent(request('event_first'));
      vi.setSystemTime(new Date('2026-10-05T14:00:00Z'));
      const second = ledger.appendEvent(request('event_second'));
      const third = ledger.appendEvent(request('event_third'));
      expect(first.event.recordedAt > second.event.recordedAt).toBe(true);
      expect(second.event.recordedAt).toBe(third.event.recordedAt);
      expect([...ledger.replayEvents()].map((e) => e.sequence)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('records failed execution successfully without claiming action success or verification', () => {
    const { ledger } = setup();
    source(ledger);
    authority(ledger);
    const failed = {
      ...f.execution,
      id: c.ExecutionIdSchema.parse('execution_failed'),
      outcome: {
        status: 'failed',
        error: {
          code: 'SYNTHETIC_FAILURE',
          message: 'Synthetic failure',
          retryability: 'not_retryable',
        },
      },
    };
    const stored = ledger.appendEvent(
      event('event_failed', 'tool_execution', failed, {
        ...f.tool,
        sourceEventId: c.EventIdSchema.parse('event_failed'),
      }),
    );
    expect(stored.event.payload).toMatchObject({
      outcome: { status: 'failed' },
    });
    expect(ledger.listEvents({ eventType: 'verification' }).events).toEqual([]);
  });
  it('records candidate/evaluation and all five learning lifecycle events without deriving owner state', () => {
    const { ledger, storage } = setup();
    source(ledger);
    authority(ledger);
    ledger.appendEvent(
      event(
        'event_candidate',
        'learning_candidate_created',
        f.candidate,
        f.inference,
      ),
    );
    ledger.appendEvent(
      event('event_evaluation', 'learning_candidate_evaluated', f.evaluation),
    );
    // Owner-state prerequisites belong to their future component; explicitly seeded here.
    for (const version of [1, 2])
      storage.sqlite
        .prepare('INSERT INTO learned_owner_state(record_json) VALUES (?)')
        .run(
          serializeContract('learned_owner_state', {
            ...f.trusted,
            metadata: { ...f.metadata, recordVersion: version },
            lifecycle: { status: 'observed' },
          }),
        );
    const before = storage.sqlite
      .prepare('SELECT * FROM learned_owner_state')
      .all();
    for (const [type, payload] of [
      ['learning_promoted', f.promotion],
      ['learning_rejected', f.rejection],
      ['learning_superseded', f.supersession],
      ['learning_revoked', f.revocation],
      ['learning_rolled_back', f.rollback],
    ] as const)
      expect(
        ledger.appendEvent(event(payload.eventId, type, payload)).event.payload,
      ).toEqual(payload);
    expect(
      storage.sqlite.prepare('SELECT * FROM learned_owner_state').all(),
    ).toEqual(before);
    expect(ledger.inspectIntegrity().ok).toBe(true);
  });
  it('allows only identical existing payload projections; conflicts roll back the new event', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const proposal = event(
      'event_proposal',
      'action_proposed',
      f.proposal,
      f.inference,
    );
    ledger.appendEvent(proposal, { proposalDigest: f.digest });
    ledger.appendEvent(
      { ...proposal, id: c.EventIdSchema.parse('event_reobserved') },
      { proposalDigest: f.digest },
    );
    expect(count(storage, 'action_proposals')).toBe(1);
    error(
      () =>
        ledger.appendEvent(
          event(
            'event_conflict',
            'action_proposed',
            { ...f.proposal, action: 'changed' },
            f.inference,
          ),
          { proposalDigest: f.digest },
        ),
      'invalid_reference',
      'rolled_back',
    );
    error(
      () =>
        ledger.appendEvent(
          { ...proposal, id: c.EventIdSchema.parse('event_digest') },
          { proposalDigest: { ...f.digest, value: 'b'.repeat(64) } },
        ),
      'invalid_reference',
    );
    expect(
      ledger.getEvent(c.EventIdSchema.parse('event_conflict')),
    ).toBeUndefined();
  });
});

describe('failure atomicity, storage lifecycle and read-only replay', () => {
  it('rejects cross-owner envelope, session, task and source references', () => {
    const { ledger, storage } = setup();
    identities(storage, 'other');
    const other = createLedger(storage, c.OwnerIdSchema.parse('owner_other'));
    other.appendEvent(request('event_private', 'other'));
    error(
      () => ledger.appendEvent(request('event_wrong', 'other')),
      'cross_owner_reference',
      'not_started',
    );
    const input = request('event_wrong');
    for (const [binding, code] of [
      [
        { ...f.task, sessionId: c.SessionIdSchema.parse('session_other') },
        'invalid_reference',
      ],
      [
        { ...f.task, taskId: c.TaskIdSchema.parse('task_other') },
        'unknown_task',
      ],
    ] as const)
      error(
        () =>
          ledger.appendEvent({
            ...input,
            task: binding,
            eventType: 'owner_request',
            payload: { instruction: 'Synthetic', task: binding },
            provenance: { ...f.ownerProvenance, sourceEventId: input.id },
          }),
        code,
      );
    const change = correction();
    error(
      () =>
        ledger.appendEvent(
          {
            ...change.event,
            eventType: 'owner_correction',
            payload: {
              ...f.correction,
              ...change.event.payload,
              target: { kind: 'event', eventId: 'event_private' },
            },
          } as EventInput,
          { evidence: [change.evidence] },
        ),
      'invalid_reference',
    );
    expect(ledger.listEvents().events).toEqual([]);
  });
  it('reports an unknown session and incorrect same-owner task/session pairing', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const change = correction();
    error(
      () =>
        ledger.appendEvent(
          {
            ...change.event,
            eventType: 'owner_correction',
            payload: {
              ...f.correction,
              ...change.event.payload,
              immediateApplicability: {
                kind: 'current_session',
                sessionId: 'session_missing',
              },
            },
          } as EventInput,
          { evidence: [change.evidence] },
        ),
      'unknown_session',
    );
    storage.sqlite
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(f.owner, 'session_second', f.time);
    const task = { ...f.task, sessionId: cStringSession('session_second') };
    error(
      () =>
        ledger.appendEvent({
          ...request('event_wrong'),
          task,
          eventType: 'owner_request',
          payload: { instruction: 'Synthetic', task },
          provenance: {
            ...f.ownerProvenance,
            sourceEventId: cStringEvent('event_wrong'),
          },
        }),
      'invalid_reference',
    );
  });
  it('rolls back all event/evidence/catalog/projection artifacts on deferred commit failure', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const before = snapshot(storage);
    const change = correction();
    const invalid = event(
      'event_correction',
      'owner_correction',
      {
        ...change.event.payload,
        target: { kind: 'event', eventId: 'event_missing' },
      },
      change.event.provenance,
    );
    error(
      () =>
        ledger.appendEvent(
          { ...invalid, evidenceIds: change.event.evidenceIds },
          { evidence: [change.evidence] },
        ),
      'invalid_reference',
      'rolled_back',
    );
    expect(snapshot(storage)).toEqual(before);
    expect(storage.sqlite.inTransaction).toBe(false);
    expect(ledger.appendEvent(request('event_next')).sequence).toBe(2);
  });
  it('rejects reuse of an existing evidence ID by a new event and leaves no artifacts', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const before = snapshot(storage);
    const id = c.EventIdSchema.parse('event_reuse');
    error(
      () =>
        ledger.appendEvent(
          { ...request(id), evidenceIds: [f.evidence.evidenceId] },
          {
            evidence: [
              evidence({
                ...f.recordedEvidence,
                eventId: id,
                provenance: { ...f.ownerProvenance, sourceEventId: id },
              }),
            ],
          },
        ),
      'invalid_reference',
      'rolled_back',
    );
    expect(snapshot(storage)).toEqual(before);
    expect(ledger.getEvent(f.evidence.eventId)?.evidence).toHaveLength(1);
    expect(ledger.appendEvent(request(id)).sequence).toBe(2);
  });
  it('rolls back when a projection trigger fails midway through append', () => {
    const { ledger, storage } = setup();
    source(ledger);
    const before = snapshot(storage);
    storage.sqlite.exec(
      `CREATE TRIGGER synthetic_failure BEFORE INSERT ON corrections BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END;`,
    );
    const change = correction();
    error(
      () => ledger.appendEvent(change.event, { evidence: [change.evidence] }),
      'storage_failure',
      'rolled_back',
    );
    expect(snapshot(storage)).toEqual(before);
    storage.sqlite.exec('DROP TRIGGER synthetic_failure');
    expect(
      ledger.appendEvent(change.event, { evidence: [change.evidence] })
        .sequence,
    ).toBe(2);
  });
  it('rejects missing evidence pairs and exact authority digests with no partial event', () => {
    const { ledger, storage } = setup();
    source(ledger);
    authority(ledger);
    const before = snapshot(storage);
    error(
      () =>
        ledger.appendEvent(
          event('event_badpolicy', 'policy_decision', {
            ...f.policy,
            id: 'decision_bad',
            proposal: {
              ...f.binding,
              proposalDigest: { ...f.digest, value: 'b'.repeat(64) },
            },
          }),
        ),
      'invalid_reference',
      'rolled_back',
    );
    error(
      () =>
        ledger.appendEvent(
          event(
            'event_badsource',
            'assistant_response',
            {
              task: f.task,
              response: 'Synthetic',
              citedEvidence: [{ ...f.evidence, eventId: 'event_policy' }],
            },
            f.inference,
          ),
        ),
      'invalid_reference',
      'rolled_back',
    );
    expect(snapshot(storage)).toEqual(before);
  });
  it('rejects operations inside caller transactions without rolling back caller work', () => {
    const { ledger, storage } = setup();
    storage.sqlite.exec('BEGIN');
    error(
      () => ledger.appendEvent(request()),
      'transaction_active',
      'not_started',
    );
    error(() => ledger.listEvents(), 'transaction_active');
    error(() => ledger.getEvent(f.evidence.eventId), 'transaction_active');
    error(() => ledger.inspectIntegrity(), 'transaction_active');
    expect(storage.sqlite.inTransaction).toBe(true);
    storage.sqlite.exec('ROLLBACK');
  });
  it('maps closed storage and disabled constraints into observable storage failures', () => {
    const { ledger, storage } = setup();
    storage.sqlite.pragma('foreign_keys = OFF');
    error(
      () => ledger.appendEvent(request()),
      'storage_failure',
      'not_started',
    );
    storage.close();
    error(() => ledger.listEvents(), 'storage_failure');
    error(() => ledger.appendEvent(request()), 'storage_failure');
  });
  it('preserves all history and sequence across file reopen', () => {
    const path = filename();
    const { ledger, storage } = setup(path);
    source(ledger);
    const change = correction();
    ledger.appendEvent(change.event, { evidence: [change.evidence] });
    const before = [...ledger.replayEvents()];
    storage.close();
    const reopened = openStorage(path);
    opened.push(reopened);
    const next = createLedger(reopened, f.owner);
    expect([...next.replayEvents()]).toEqual(before);
    expect(next.appendEvent(request('event_next')).sequence).toBe(3);
    expect(next.inspectIntegrity().ok).toBe(true);
  });
  it('serializes interleaved two-connection writes and handles writer contention without artifacts', () => {
    const path = filename();
    const { ledger, storage } = setup(path);
    const second = openStorage(path);
    opened.push(second);
    const other = createLedger(second, f.owner);
    expect(ledger.appendEvent(request('event_one')).sequence).toBe(1);
    expect(other.appendEvent(request('event_two')).sequence).toBe(2);
    storage.sqlite.exec('BEGIN IMMEDIATE');
    second.sqlite.pragma('busy_timeout = 1');
    error(
      () => other.appendEvent(request('event_busy')),
      'storage_failure',
      'not_started',
    );
    storage.sqlite.exec('ROLLBACK');
    expect(other.getEvent(cStringEvent('event_busy'))).toBeUndefined();
    expect(ledger.appendEvent(request('event_three')).sequence).toBe(3);
    expect(other.appendEvent(request('event_busy')).sequence).toBe(4);
    error(() => ledger.appendEvent(request('event_busy')), 'duplicate_event');
    expect([...other.replayEvents()].map((e) => e.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });
  it('replays a finite snapshot using only reads, with no tool/model callbacks or network behavior', () => {
    const { ledger, storage } = setup();
    source(ledger);
    authority(ledger);
    const iterator = ledger.replayEvents({ limit: 1 });
    ledger.appendEvent(request('event_after_replay'));
    const before = snapshot(storage);
    const changes = storage.sqlite.prepare('SELECT total_changes() AS n').get();
    const fetch = vi.fn(() => {
      throw new Error('Unexpected network call');
    });
    vi.stubGlobal('fetch', fetch);
    storage.sqlite.pragma('query_only = ON');
    const replayed = [...iterator];
    expect(replayed.map((e) => e.event.eventType)).toEqual([
      'owner_request',
      'action_proposed',
      'owner_approval',
      'policy_decision',
      'tool_execution',
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(ledger.getEvent(f.evidence.eventId)).toEqual(replayed[0]);
    expect(ledger.inspectIntegrity().ok).toBe(true);
    expect(storage.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(
      changes,
    );
    expect(snapshot(storage)).toEqual(before);
  });
});

function cStringEvent(id: string) {
  return c.EventIdSchema.parse(id);
}
function cStringSession(id: string) {
  return c.SessionIdSchema.parse(id);
}
