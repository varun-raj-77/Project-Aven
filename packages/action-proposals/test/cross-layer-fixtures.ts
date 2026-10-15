/**
 * SYNTHETIC fixtures for the AVEN-011 Patch 5 cross-layer campaign
 * (`cross-layer.test.ts`). Every owner, identifier, text and record is
 * invented. The scenario database is built only through the real
 * constructor, the real recorder and, where a history the recorder never
 * writes is needed, the frozen Ledger directly (labelled test setup).
 *
 * `replayInFreshProcess` is also the entry point of a separate Node process
 * started by the test: it opens the scenario database on a `query_only`
 * connection, runs the read pipeline and prints one JSON object. It writes
 * nothing. This module imports no test framework so that it can run there.
 */
import {
  createLedger,
  LedgerError,
  type EventInput,
  type StoredEvent,
} from '@aven/ledger';
import { migrate, openStorage, type Storage } from '@aven/storage';
import { canonicalText, digestOfCanonicalText } from '../src/canonical.ts';
import {
  ActionProposalError,
  constructActionProposal,
  inspectActionProposal,
} from '../src/index.ts';
import {
  readProposalEvents,
  reconcileActionProposalRecording,
  recordActionProposal,
  type ProposalEventRecord,
} from '../src/ledger/index.ts';
import { expectedRecordingEvent } from '../src/ledger/record.ts';
import { draft, vectorFile } from './fixtures.ts';
import * as L from './ledger-fixtures.ts';

export { L };
type Json = Record<string, unknown>;

export const A = L.ownerId;
export const B = L.otherOwner;

/** Every table's rows, as text, plus SQLite's own sequence table. */
export const logicalState = (storage: Storage): string => L.dump(storage);

/** Rows changed by this connection since it was opened. */
export const totalChanges = (storage: Storage): number =>
  (
    storage.sqlite.prepare('SELECT total_changes() AS n').get() as {
      n: number;
    }
  ).n;

/** The protocol-v1 digest of any payload, without the v1 size limits. */
export function digestOf(payload: unknown): string {
  const text = canonicalText(payload);
  return text === undefined ? 'e'.repeat(64) : digestOfCanonicalText(text);
}

/** A constructed proposal for `owner` with caller-chosen identifiers. */
export function proposal(n: number, owner = A, overrides: Json = {}): Json {
  return JSON.parse(
    JSON.stringify(
      constructActionProposal(
        draft({
          ownerId: owner,
          proposalId: `proposal_x${n}`,
          ...overrides,
        }),
      ).proposal,
    ),
  ) as Json;
}

/** A recording request for proposal `n`; every value is caller-supplied. */
export function requestFor(
  n: number,
  owner = A,
  overrides: Json = {},
  proposalOverrides: Json = {},
): Json {
  const sessionId = (proposalOverrides.sessionId as string) ?? L.sessionId;
  const taskId = (proposalOverrides.taskId as string) ?? L.taskId;
  return L.request({
    ownerId: owner,
    sessionId,
    taskId,
    eventId: `event_x${n}`,
    proposal: proposal(n, owner, proposalOverrides),
    ...overrides,
  });
}

/**
 * Test setup only: appends an `action_proposed` event directly through the
 * frozen Ledger, as any code with storage access could. `change` edits the
 * event the recorder would have written for `base`.
 */
export function appendDirect(
  storage: Storage,
  base: Json,
  change: (event: Json) => void = () => {},
  digest?: string,
): void {
  const event = JSON.parse(
    JSON.stringify(expectedRecordingEvent(base).event),
  ) as Json;
  change(event);
  createLedger(storage, String(event.ownerId) as never).appendEvent(
    event as unknown as EventInput,
    {
      proposalDigest: {
        algorithm: 'sha256',
        value: digest ?? digestOf(event.payload),
      },
    },
  );
}

/** A synthetic owner-request event (an event type that is not a proposal). */
export function ownerRequest(storage: Storage, owner: string, id: string) {
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
      createdAt: L.setupTime,
      creation: { component: 'synthetic-test-setup', version: '1' },
    },
    id,
    task: { sessionId: L.sessionId, taskId: L.taskId },
    occurredAt: L.setupTime,
    evidenceIds: [],
    eventType: 'owner_request',
    payload: {
      instruction: 'Synthetic request.',
      task: { sessionId: L.sessionId, taskId: L.taskId },
    },
    provenance,
  } as unknown as EventInput);
}

/** The requests the scenario records; reconciled again in the replay. */
export function scenarioRequests(): Json[] {
  return [
    requestFor(1),
    requestFor(2, A, { provenance: L.systemGenerated() }),
    requestFor(3, A, {}, { taskId: L.otherTask }),
    requestFor(4, A, {}, { sessionId: L.secondSession, taskId: L.secondTask }),
    requestFor(5, B),
    requestFor(6, B, { provenance: L.systemGenerated() }),
  ];
}

/** Requests that were never recorded; the replay must report not_recorded. */
export const absentRequests = (): Json[] => [requestFor(90), requestFor(91, B)];

/**
 * The SYNTHETIC scenario: two owners, recorded proposals in several tasks,
 * interleaved owner requests, one re-recording with another origin, and
 * directly appended events the recorder never writes (an unsupported stamp,
 * a disagreeing digest, ill-formed Unicode and an unsupported origin).
 */
export function buildScenario(filename: string): Storage {
  const storage = L.world(filename);
  const requests = scenarioRequests();
  for (const [i, request] of requests.entries()) {
    recordActionProposal(storage, request);
    if (i % 2 === 0) ownerRequest(storage, A, `event_request${i}`);
  }
  // A second event for proposal 1's identical payload, another origin.
  appendDirect(storage, requests[0]!, (e) => {
    e.id = 'event_x1_again';
    e.provenance = L.systemGenerated();
  });
  appendDirect(storage, requestFor(20), (e) => {
    ((e.payload as Json).metadata as Json).creation = {
      component: 'synthetic-direct-writer',
      version: '1',
    };
  });
  appendDirect(storage, requestFor(21), () => {}, 'd'.repeat(64));
  appendDirect(storage, requestFor(22), (e) => {
    ((e.payload as Json).consequences as Json).description = 'Bad \uD800';
  });
  appendDirect(storage, requestFor(23), (e) => {
    e.provenance = {
      kind: 'tool_result',
      toolId: 'synthetic-tool',
      sourceEventId: L.source.eventId,
      trust: 'potentially_untrusted',
    };
  });
  return storage;
}

/** Every record of an owner, paging with `limit` and the same filter. */
export function allRecords(
  storage: Storage,
  owner: string,
  limit = 3,
): ProposalEventRecord[] {
  const records: ProposalEventRecord[] = [];
  let cursor: { afterSequence: number; throughSequence: number } | null = null;
  do {
    const page: ReturnType<typeof readProposalEvents> = readProposalEvents(
      storage,
      owner,
      { limit, ...(cursor ?? {}) },
    );
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return records;
}

/** A process-independent text form of reader and reconciliation results. */
export function comparable(value: unknown): string {
  return JSON.stringify(value);
}

/** What the read pipeline reports for the scenario, in a stable form. */
export function readPipeline(storage: Storage) {
  const outcome = (run: () => unknown) => {
    try {
      return run();
    } catch (error) {
      return error instanceof ActionProposalError
        ? { error: error.code, outcome: error.outcome }
        : { error: 'unexpected' };
    }
  };
  return {
    records: Object.fromEntries(
      [A, B].map((owner) => [owner, outcome(() => allRecords(storage, owner))]),
    ),
    reconciliations: [...scenarioRequests(), ...absentRequests()].map(
      (request) =>
        outcome(() => reconcileActionProposalRecording(storage, request)),
    ),
  };
}

/**
 * Fresh-process entry: opens `filename` on a `query_only` connection, runs
 * the read pipeline and prints one JSON object. Writes nothing.
 */
export function replayInFreshProcess(filename: string): void {
  const storage = openStorage(filename);
  try {
    storage.sqlite.pragma('query_only = ON');
    const changesBefore = totalChanges(storage);
    const stateBefore = logicalState(storage);
    const pipeline = comparable(readPipeline(storage));
    process.stdout.write(
      JSON.stringify({
        pid: process.pid,
        queryOnly: storage.sqlite.pragma('query_only', { simple: true }),
        changesBefore,
        changesAfter: totalChanges(storage),
        stateUnchanged: logicalState(storage) === stateBefore,
        pipeline,
      }),
    );
  } finally {
    storage.sqlite.close();
  }
}

/** Constructs, inspects, records, reconciles and reads one proposal. */
export function endToEnd(storage: Storage, request: Json) {
  const constructed = constructActionProposal(
    draft({
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      proposalId: (request.proposal as Json).id,
      createdAt: ((request.proposal as Json).metadata as Json).createdAt,
    }),
  );
  const inspection = inspectActionProposal(constructed);
  const receipt = recordActionProposal(storage, request);
  const reconciliation = reconcileActionProposalRecording(storage, request);
  const record = readProposalEvents(storage, request.ownerId, {
    afterSequence: receipt.sequence - 1,
    throughSequence: receipt.sequence,
  }).records[0];
  return { constructed, inspection, receipt, reconciliation, record };
}

/** The stored event of `eventId` for `owner` (frozen Ledger read). */
export const storedEvent = (
  storage: Storage,
  owner: string,
  eventId: string,
): StoredEvent | undefined =>
  createLedger(storage, owner as never).getEvent(eventId as never);

/**
 * Test setup only: tries to append a SYNTHETIC tool-execution record that
 * cites a proposal binding and a decision identifier. The frozen schema
 * requires a matching recorded Root ALLOW decision; nothing AVEN-011 writes
 * is one. Returns the Ledger's error, or undefined if it was accepted.
 */
export function tryExecution(
  storage: Storage,
  binding: unknown,
  decisionId: string,
  eventId: string,
): LedgerError | undefined {
  const provenance = {
    kind: 'tool_result',
    toolId: 'synthetic-sandbox-tool',
    sourceEventId: eventId,
    trust: 'potentially_untrusted',
  };
  try {
    createLedger(storage, A as never).appendEvent({
      kind: 'experience_event',
      ownerId: A,
      metadata: {
        schemaVersion: 1,
        recordVersion: 1,
        createdAt: '2026-10-14T09:50:00Z',
        creation: { component: 'synthetic-test-setup', version: '1' },
      },
      id: eventId,
      task: { sessionId: L.sessionId, taskId: L.taskId },
      occurredAt: '2026-10-14T09:50:00Z',
      evidenceIds: [],
      eventType: 'tool_execution',
      payload: {
        kind: 'execution_result',
        ownerId: A,
        metadata: {
          schemaVersion: 1,
          recordVersion: 1,
          createdAt: '2026-10-14T09:50:00Z',
          creation: { component: 'synthetic-test-setup', version: '1' },
        },
        id: `execution_${eventId.slice('event_'.length)}`,
        policy: { decisionId, proposal: binding, decision: 'ALLOW' },
        toolId: 'synthetic-sandbox-tool',
        attempted: true,
        startedAt: '2026-10-14T09:50:00Z',
        endedAt: '2026-10-14T09:50:01Z',
        outcome: {
          status: 'succeeded',
          returned: {
            locator: 'synthetic:result',
            digest: { algorithm: 'sha256', value: 'f'.repeat(64) },
          },
        },
      },
      provenance,
    } as unknown as EventInput);
    return undefined;
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
}

/** The independent golden vectors (`digest-vectors.json`). */
export const vectors = vectorFile;
export const VECTOR = Object.freeze({
  owner: 'owner_vector',
  session: 'session_vector',
  task: 'task_vector',
});

/**
 * A database holding only the golden vectors' SYNTHETIC identities, so that
 * their proposals can be recorded unchanged. Identity rows are test setup.
 */
export function vectorWorld(filename = ':memory:'): Storage {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  const db = storage.sqlite;
  db.prepare('INSERT INTO owners VALUES (?, ?)').run(VECTOR.owner, L.setupTime);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
    VECTOR.owner,
    VECTOR.session,
    L.setupTime,
  );
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
    VECTOR.owner,
    VECTOR.task,
    VECTOR.session,
    L.setupTime,
  );
  return storage;
}

/** A recording request for a golden vector's proposal, unchanged. */
export function vectorRequest(proposal: unknown, eventId: string): Json {
  return {
    ownerId: VECTOR.owner,
    sessionId: VECTOR.session,
    taskId: VECTOR.task,
    proposal,
    eventId,
    occurredAt: '2026-10-14T10:00:00Z',
    provenance: {
      kind: 'system_generated',
      component: 'synthetic-orchestrator',
      version: '1',
      derivedFrom: [],
    },
  };
}
