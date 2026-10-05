import { z } from 'zod';
import {
  EventIdSchema,
  ExperienceEventSchema,
  OwnerIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  type EventId,
  type OwnerId,
} from '@aven/contracts';
import {
  deserializeContract,
  serializeContract,
  type Storage,
} from '@aven/storage';
import { failure, LedgerError } from './errors.ts';
import { inspect, type IntegrityReport } from './integrity.ts';
import {
  assertOwnerClaims,
  insertProjection,
  prepareAppend,
  type AppendOptions,
  type EventInput,
  type StoredEvent,
} from './records.ts';

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const filterSchema = z.strictObject({
  sessionId: SessionIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  eventType: z
    .enum(
      ExperienceEventSchema.unwrap().options.map(
        (s) => s.shape.eventType.value,
      ),
    )
    .optional(),
  afterSequence: sequence.optional(),
  throughSequence: sequence.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type HistoryFilter = z.infer<typeof filterSchema>;
export interface EventPage {
  readonly events: readonly StoredEvent[];
  readonly throughSequence: number;
  readonly nextCursor: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  } | null;
}
export interface Ledger {
  readonly ownerId: OwnerId;
  appendEvent(input: EventInput, options?: AppendOptions): StoredEvent;
  getEvent(id: EventId): StoredEvent | undefined;
  listEvents(filter?: HistoryFilter): EventPage;
  replayEvents(filter?: HistoryFilter): IterableIterator<StoredEvent>;
  inspectIntegrity(): IntegrityReport;
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new LedgerError(
      'invalid_input',
      'Invalid Ledger argument',
      'not_started',
      result.error,
    );
  return result.data;
}

/** Storage lifecycle/migrations/identity provisioning remain the caller's responsibility. */
export function createLedger(storage: Storage, owner: OwnerId): Ledger {
  const ownerId = parse(OwnerIdSchema, owner);
  const db = storage.sqlite;

  function ready() {
    if (db.inTransaction)
      throw new LedgerError(
        'transaction_active',
        'Ledger operations require an independent transaction',
      );
  }
  function requireOwner() {
    if (!db.prepare('SELECT 1 FROM owners WHERE owner_id = ?').get(ownerId))
      throw new LedgerError('unknown_owner', 'Ledger owner does not exist');
  }
  function read<T>(fn: () => T): T {
    try {
      ready();
      return db
        .transaction(() => {
          requireOwner();
          return fn();
        })
        .deferred();
    } catch (error) {
      throw failure(error);
    }
  }
  function stored(row: { sequence: number; record_json: string }): StoredEvent {
    try {
      const event = deserializeContract('experience_events', row.record_json);
      if (
        event.ownerId !== ownerId ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence <= 0
      )
        throw new Error('Invalid owner or sequence');
      const evidence = (
        db
          .prepare(
            'SELECT record_json FROM evidence WHERE owner_id = ? AND event_id = ? ORDER BY record_id',
          )
          .all(ownerId, event.id) as { record_json: string }[]
      ).map((e) => deserializeContract('evidence', e.record_json));
      return { sequence: row.sequence, event, evidence };
    } catch (error) {
      throw new LedgerError(
        'integrity_failure',
        'Stored history failed validation',
        'not_started',
        error,
      );
    }
  }
  function bindings(json: string, kind: 'experience_events' | 'evidence') {
    // Invoke the existing frozen v1 projection; no second reference interpretation.
    let refs: { kind: string; id: string; session: string | null }[];
    try {
      refs = db
        .prepare(
          `SELECT json_extract(value, '$.targetKind') AS kind,
        json_extract(value, '$.targetId') AS id, json_extract(value, '$.sessionId') AS session
        FROM json_each(aven_references_v1(?, ?))`,
        )
        .all(kind, json) as typeof refs;
    } catch (cause) {
      throw new LedgerError(
        'invalid_reference',
        'Invalid v1 reference projection or nested owner claim',
        'not_started',
        cause,
      );
    }
    for (const ref of refs) {
      if (
        ref.kind === 'sessions' &&
        !db
          .prepare(
            'SELECT 1 FROM sessions WHERE owner_id = ? AND session_id = ?',
          )
          .get(ownerId, ref.id)
      )
        throw new LedgerError(
          'unknown_session',
          'Session does not exist for this owner',
        );
      if (ref.kind === 'tasks') {
        const task = db
          .prepare(
            'SELECT session_id FROM tasks WHERE owner_id = ? AND task_id = ?',
          )
          .get(ownerId, ref.id) as { session_id: string } | undefined;
        if (!task)
          throw new LedgerError(
            'unknown_task',
            'Task does not exist for this owner',
          );
        if (ref.session !== null && task.session_id !== ref.session)
          throw new LedgerError(
            'invalid_reference',
            'Task and session binding disagree',
          );
      }
    }
  }

  function appendEvent(
    input: EventInput,
    options: AppendOptions = {},
  ): StoredEvent {
    let began = false;
    try {
      ready();
      assertOwnerClaims(ownerId, input, options);
      // Reject invalid contracts before opening a write transaction. Revalidate the
      // copied input with the actual recording clock after obtaining the writer lock.
      const preflight = prepareAppend(input, options, new Date().toISOString());
      if (preflight.event.ownerId !== ownerId)
        throw new LedgerError(
          'cross_owner_reference',
          'Event must belong to this Ledger owner',
        );
      if (
        db.pragma('foreign_keys', { simple: true }) !== 1 ||
        db.pragma('recursive_triggers', { simple: true }) !== 1 ||
        db.pragma('ignore_check_constraints', { simple: true }) !== 0
      )
        throw new LedgerError(
          'storage_failure',
          'Required storage integrity checks are disabled',
        );
      db.exec('BEGIN IMMEDIATE');
      began = true;
      requireOwner();
      if (
        db
          .prepare(
            'SELECT 1 FROM experience_events WHERE owner_id = ? AND record_id = ?',
          )
          .get(ownerId, preflight.event.id)
      )
        throw new LedgerError(
          'duplicate_event',
          'Event ID already exists for this owner',
        );
      // New evidence IDs are also immutable owner-scoped identities; never reuse one.
      const existingEvidence = db.prepare(
        'SELECT 1 FROM evidence WHERE owner_id = ? AND record_id = ?',
      );
      if (preflight.evidence.some((e) => existingEvidence.get(ownerId, e.id)))
        throw new LedgerError(
          'invalid_reference',
          'Evidence ID already exists for this owner',
        );
      const { recordedAt: _time, ...copy } = preflight.event;
      const evidenceCopies = preflight.evidence.map(
        ({ recordedAt: _recorded, ...e }) => e,
      );
      const prepared = prepareAppend(
        copy,
        {
          evidence: evidenceCopies,
          ...(preflight.proposalDigest
            ? { proposalDigest: preflight.proposalDigest }
            : {}),
        },
        new Date().toISOString(),
      );
      const json = serializeContract('experience_events', prepared.event);
      bindings(json, 'experience_events');
      const evidenceJson = prepared.evidence.map((e) =>
        serializeContract('evidence', e),
      );
      for (const serialized of evidenceJson) bindings(serialized, 'evidence');
      const inserted = db
        .prepare(
          'INSERT INTO experience_events(record_json) VALUES (?) RETURNING sequence, record_json',
        )
        .get(json) as { sequence: number; record_json: string };
      for (const serialized of evidenceJson)
        db.prepare('INSERT INTO evidence(record_json) VALUES (?)').run(
          serialized,
        );
      insertProjection(storage, prepared.event, prepared.proposalDigest?.value);
      const result = stored(inserted);
      db.exec('COMMIT'); // Deferred reference checks must succeed before returning.
      return result;
    } catch (error) {
      if (!began) throw failure(error);
      try {
        if (db.inTransaction) db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new LedgerError(
          'storage_failure',
          'Rollback failed; discard this connection and inspect storage',
          'failed',
          new AggregateError([error, rollbackError]),
        );
      }
      throw failure(error, 'rolled_back');
    }
  }

  function getEvent(id: EventId): StoredEvent | undefined {
    const validId = parse(EventIdSchema, id);
    return read(() => {
      const row = db
        .prepare(
          'SELECT sequence, record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
        )
        .get(ownerId, validId) as
        { sequence: number; record_json: string } | undefined;
      return row ? stored(row) : undefined;
    });
  }

  function listEvents(filter: HistoryFilter = {}): EventPage {
    const f = parse(filterSchema, filter);
    return read(() => {
      const maximum = (
        db
          .prepare(
            'SELECT coalesce(max(sequence), 0) AS n FROM experience_events WHERE owner_id = ?',
          )
          .get(ownerId) as { n: number }
      ).n;
      const throughSequence = Math.min(f.throughSequence ?? maximum, maximum);
      const clauses = ['owner_id = ?', 'sequence > ?', 'sequence <= ?'];
      const values: (string | number)[] = [
        ownerId,
        f.afterSequence ?? 0,
        throughSequence,
      ];
      // Direct historical bindings, never arbitrary mentions, scope hints or source citations.
      if (f.sessionId) {
        clauses.push(`coalesce(session_id, json_extract(record_json, '$.payload.task.sessionId'),
          json_extract(record_json, '$.payload.bounds.sessionId'),
          json_extract(record_json, '$.payload.immediateApplicability.task.sessionId'),
          json_extract(record_json, '$.payload.immediateApplicability.sessionId')) = ?`);
        values.push(f.sessionId);
      }
      if (f.taskId) {
        clauses.push(`coalesce(task_id, json_extract(record_json, '$.payload.task.taskId'),
          json_extract(record_json, '$.payload.bounds.taskId'),
          json_extract(record_json, '$.payload.immediateApplicability.task.taskId')) = ?`);
        values.push(f.taskId);
      }
      if (f.eventType) {
        clauses.push('event_type = ?');
        values.push(f.eventType);
      }
      const limit = f.limit ?? 100;
      const rows = db
        .prepare(
          `SELECT sequence, record_json FROM experience_events WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...values, limit + 1) as {
        sequence: number;
        record_json: string;
      }[];
      const events = rows.slice(0, limit).map(stored);
      const last = events.at(-1);
      return {
        events,
        throughSequence,
        nextCursor:
          rows.length > limit && last
            ? { afterSequence: last.sequence, throughSequence }
            : null,
      };
    });
  }

  function replayEvents(
    filter: HistoryFilter = {},
  ): IterableIterator<StoredEvent> {
    const frozenFilter = parse(filterSchema, filter);
    const first = listEvents(frozenFilter); // Capture a finite boundary at API call time.
    return (function* () {
      let page = first;
      while (true) {
        yield* page.events;
        if (!page.nextCursor) return;
        page = listEvents({ ...frozenFilter, ...page.nextCursor });
      }
    })();
  }

  // No SQL handle, callbacks, mutators or executor is exposed on this object.
  return Object.freeze({
    ownerId,
    appendEvent,
    getEvent,
    listEvents,
    replayEvents,
    inspectIntegrity: () => read(() => inspect(storage, ownerId)),
  });
}
