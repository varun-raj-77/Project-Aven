/**
 * SYNTHETIC fixtures for the AVEN-010 patch 3 recorder tests. Every owner,
 * session, task, event, evidence, learned item and text is invented; frozen
 * AVEN-002 contract fixtures are reused and re-owned per owner. These helpers
 * set up test databases only. The few raw snapshot rows (owner state that a
 * correction may target) are test setup: production code never writes them,
 * and AVEN-010 has no owner-state writer.
 */
import * as c from '@aven/contracts';
import { createLedger, type EventInput } from '@aven/ledger';
import {
  migrate,
  openStorage,
  serializeContract,
  type Storage,
} from '@aven/storage';
import * as f from '../../contracts/test/fixtures.ts';
import type {
  CorrectionIdPrefix,
  CorrectionRecordingOptions,
} from '../src/ledger/index.ts';

export { f };
export const A = 'owner_alpha';
export const B = 'owner_beta';
export const SESSION = 'session_synthetic';
export const TASK = 'task_synthetic';
export const OTHER_TASK = 'task_other';
export const SECOND_SESSION = 'session_second';
export const SECOND_TASK = 'task_second';
/** Identities that exist ONLY for owner B. */
export const FOREIGN = Object.freeze({
  session: 'session_foreign',
  task: 'task_foreign',
  event: 'event_foreign',
  evidence: 'evidence_foreign',
  learned: 'learned_foreign',
});
/** A fixed occurrence clock, far from the Ledger's recording clock. */
export const CLOCK = '2026-01-01T00:00:00.000Z';

type Json = Record<string, unknown>;

/** A frozen fixture value re-owned by `owner` (exact owner-ID text only). */
export function as<T>(owner: string, value: T): T {
  return JSON.parse(
    JSON.stringify(value).replaceAll(`"${f.owner}"`, JSON.stringify(owner)),
  ) as T;
}

const unrecorded = ({ recordedAt: _r, ...rest }: Json) => rest;

function insertIdentities(storage: Storage, owner: string, foreign: boolean) {
  const db = storage.sqlite;
  db.prepare('INSERT INTO owners VALUES (?, ?)').run(owner, f.time);
  const sessions: [string, string[]][] = [
    [SESSION, [TASK, OTHER_TASK]],
    [SECOND_SESSION, [SECOND_TASK]],
    ...(foreign
      ? ([[FOREIGN.session, [FOREIGN.task]]] as [string, string[]][])
      : []),
  ];
  for (const [session, tasks] of sessions) {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      owner,
      session,
      f.time,
    );
    for (const task of tasks)
      db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
        owner,
        task,
        session,
        f.time,
      );
  }
}

/** One owner-request event with one owner-statement evidence, via the Ledger. */
function ownerRequest(
  storage: Storage,
  owner: string,
  eventId: string,
  evidenceId: string,
) {
  const provenance = {
    kind: 'explicit_owner_statement',
    ownerId: owner,
    sourceEventId: eventId,
  };
  const event = c.ExperienceEventSchema.parse(
    as(owner, {
      kind: 'experience_event',
      ownerId: f.owner,
      metadata: f.metadata,
      id: eventId,
      task: f.task,
      occurredAt: f.time,
      recordedAt: f.later,
      evidenceIds: [evidenceId],
      eventType: 'owner_request',
      payload: {
        instruction: 'Synthetic request to draft a note',
        task: f.task,
      },
      provenance,
    }),
  );
  createLedger(storage, c.OwnerIdSchema.parse(owner)).appendEvent(
    unrecorded(event as unknown as Json) as unknown as EventInput,
    {
      evidence: [
        unrecorded(
          as(owner, {
            ...f.recordedEvidence,
            id: evidenceId,
            eventId,
            provenance,
          }) as unknown as Json,
        ) as never,
      ],
    },
  );
}

/** Test-only snapshot rows a correction may target (observed, no transition). */
function ownerState(
  storage: Storage,
  owner: string,
  durableId: string,
  evidence: { evidenceId: string; eventId: string },
) {
  const signals = { ...f.signals, supportingEvidence: [evidence] };
  const durable = c.DurableOwnerStateSchema.parse(
    as(owner, {
      ...f.trusted,
      id: durableId,
      provenance: { ...f.inference, derivedFrom: [evidence] },
      evidence: signals,
      lifecycle: { status: 'observed' },
    }),
  );
  storage.sqlite
    .prepare('INSERT INTO learned_owner_state(record_json) VALUES (?)')
    .run(serializeContract('learned_owner_state', durable));
}

function activeTask(storage: Storage, owner: string) {
  const state = c.ActiveTaskStateSchema.parse(as(owner, f.activeTask));
  storage.sqlite
    .prepare('INSERT INTO active_task_state(record_json) VALUES (?)')
    .run(serializeContract('active_task_state', state));
}

/**
 * Two owners with the same session/task/event/evidence/learned IDs, plus
 * identities only owner B has (FOREIGN). Owner A's targets: event
 * `event_source`, evidence `evidence_source`, durable `learned_synthetic` v1,
 * active task `learned_task` v1.
 */
export function world(filename = ':memory:'): Storage {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  for (const [owner, foreign] of [
    [A, false],
    [B, true],
  ] as const) {
    insertIdentities(storage, owner, foreign);
    ownerRequest(storage, owner, f.evidence.eventId, f.evidence.evidenceId);
    ownerState(storage, owner, f.learnedRef.learnedItemId, f.evidence);
    activeTask(storage, owner);
  }
  ownerRequest(storage, B, FOREIGN.event, FOREIGN.evidence);
  ownerState(storage, B, FOREIGN.learned, {
    evidenceId: FOREIGN.evidence,
    eventId: FOREIGN.event,
  });
  return storage;
}

export function submission(overrides: Json = {}): Json {
  return {
    ownerId: A,
    sessionId: SESSION,
    taskId: TASK,
    category: 'communication',
    target: { kind: 'event', eventId: f.evidence.eventId },
    originalBehavior: 'Synthetic: the draft used long paragraphs.',
    correctedInstruction:
      'Synthetic: keep this draft to three short bullet points.',
    immediateApplicability: 'current_task',
    durableScopeHint: {
      kind: 'unknown',
      reason: 'Synthetic: durable scope has not been evaluated.',
    },
    ...overrides,
  };
}

/** Deterministic options: a fixed clock and sequential synthetic IDs. */
export function options(
  overrides: Partial<Record<CorrectionIdPrefix, string>> = {},
  start = 1,
): CorrectionRecordingOptions & {
  readonly generateId: (p: CorrectionIdPrefix) => string;
} {
  let n = start;
  const counters: Record<CorrectionIdPrefix, number> = {
    event: 0,
    evidence: 0,
  };
  return {
    now: () => new Date(CLOCK),
    generateId: (prefix) => {
      counters[prefix] += 1;
      const fixed = overrides[prefix];
      if (fixed !== undefined && counters[prefix] === 1) return fixed;
      const id = `${prefix}_corr_${n}`;
      if (prefix === 'evidence') n += 1;
      return id;
    },
  };
}

/** Rows in a stable order, whatever the table's shape. */
const stable = (rows: unknown[]): string[] =>
  rows.map((row) => JSON.stringify(row)).sort();

const ORDERED_TABLES = (storage: Storage) =>
  (
    storage.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);

/** Every row of every table, in a stable order. */
export function snapshot(storage: Storage): Record<string, string[]> {
  return Object.fromEntries(
    ORDERED_TABLES(storage).map((name) => [
      name,
      stable(storage.sqlite.prepare(`SELECT * FROM "${name}"`).all()),
    ]),
  );
}

/** Every row of every owner-bearing table that belongs to `owner`. */
export function ownerRows(
  storage: Storage,
  owner: string,
): Record<string, string[]> {
  return Object.fromEntries(
    ORDERED_TABLES(storage)
      .filter((name) =>
        (
          storage.sqlite.prepare(`PRAGMA table_xinfo("${name}")`).all() as {
            name: string;
          }[]
        ).some((column) => column.name === 'owner_id'),
      )
      .map((name) => [
        name,
        stable(
          storage.sqlite
            .prepare(`SELECT * FROM "${name}" WHERE owner_id = ?`)
            .all(owner),
        ),
      ]),
  );
}

export const count = (storage: Storage, table: string, owner = A): number =>
  (
    storage.sqlite
      .prepare(`SELECT count(*) AS n FROM "${table}" WHERE owner_id = ?`)
      .get(owner) as { n: number }
  ).n;

export function rowJson(
  storage: Storage,
  table: string,
  id: string,
  owner = A,
): string | undefined {
  return (
    storage.sqlite
      .prepare(
        `SELECT record_json FROM "${table}" WHERE owner_id = ? AND record_id = ?`,
      )
      .get(owner, id) as { record_json: string } | undefined
  )?.record_json;
}

/**
 * Wraps a Storage so every prepared statement's SQL and bound values are
 * observed, without changing behavior. Used to prove which owner a call reads.
 */
export function observed(storage: Storage) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = storage.sqlite;
  const sqlite = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(s, k) {
              const value = Reflect.get(s, k, s) as unknown;
              if (typeof value !== 'function') return value;
              if (k === 'get' || k === 'all' || k === 'run' || k === 'iterate')
                return (...values: unknown[]) => {
                  calls.push({ sql, values });
                  return (value as (...a: unknown[]) => unknown).apply(
                    s,
                    values,
                  );
                };
              return (value as (...a: unknown[]) => unknown).bind(s);
            },
          });
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { storage: { ...storage, sqlite } as Storage, calls };
}
