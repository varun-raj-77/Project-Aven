/**
 * SYNTHETIC fixtures for the AVEN-011 Patch 3 recorder and reconciliation
 * tests. Every owner, session, task, event, evidence, approval, decision and
 * text is invented. These helpers set up test databases only: identity rows
 * and the source event are test setup, and the approval and policy-decision
 * helpers append synthetic records through the frozen Ledger to exercise
 * references. They are not Root, not an approval flow and not a decision.
 */
import * as c from '@aven/contracts';
import { createLedger, type EventInput } from '@aven/ledger';
import { migrate, openStorage, type Storage } from '@aven/storage';
import { constructActionProposal } from '../src/index.ts';
import { draft, ownerId, sessionId, taskId } from './fixtures.ts';

export { ownerId, sessionId, taskId };
/** A second owner with the same session, task and source identifiers. */
export const otherOwner = 'owner_other';
export const otherTask = 'task_other';
export const secondSession = 'session_second';
export const secondTask = 'task_second';
export const source = Object.freeze({
  evidenceId: 'evidence_source',
  eventId: 'event_source',
});
/** Fixed setup clock, before every proposal's creation time. */
export const setupTime = '2026-10-14T08:00:00Z';
export const occurredAt = '2026-10-14T09:00:05Z';
export const model = Object.freeze({
  providerId: 'synthetic-provider',
  modelId: 'synthetic-model',
  modelVersion: '1',
  configurationId: 'synthetic-config',
});

type Json = Record<string, unknown>;

export const inference = (): Json => ({
  kind: 'model_inference',
  model: { ...model },
  derivedFrom: [{ ...source }],
  sourceCoverage: 'complete',
});
export const systemGenerated = (): Json => ({
  kind: 'system_generated',
  component: 'synthetic-orchestrator',
  version: '1',
  derivedFrom: [{ ...source }],
});

const setupMetadata = {
  schemaVersion: 1,
  recordVersion: 1,
  createdAt: setupTime,
  creation: { component: 'synthetic-test-setup', version: '1' },
};

function ledger(storage: Storage, owner: string) {
  return createLedger(storage, c.OwnerIdSchema.parse(owner));
}

function identities(storage: Storage, owner: string) {
  const db = storage.sqlite;
  db.prepare('INSERT INTO owners VALUES (?, ?)').run(owner, setupTime);
  for (const [session, tasks] of [
    [sessionId, [taskId, otherTask]],
    [secondSession, [secondTask]],
  ] as const) {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
      owner,
      session,
      setupTime,
    );
    for (const task of tasks)
      db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(
        owner,
        task,
        session,
        setupTime,
      );
  }
}

/** One owner-request event with one owner-statement evidence record. */
function sourceEvent(storage: Storage, owner: string) {
  const provenance = {
    kind: 'explicit_owner_statement',
    ownerId: owner,
    sourceEventId: source.eventId,
  };
  ledger(storage, owner).appendEvent(
    {
      kind: 'experience_event',
      ownerId: owner,
      metadata: setupMetadata,
      id: source.eventId,
      task: { sessionId, taskId },
      occurredAt: setupTime,
      evidenceIds: [source.evidenceId],
      eventType: 'owner_request',
      payload: {
        instruction: 'Synthetic request to prepare a sandbox draft.',
        task: { sessionId, taskId },
      },
      provenance,
    } as unknown as EventInput,
    {
      evidence: [
        {
          kind: 'recorded_evidence',
          ownerId: owner,
          metadata: setupMetadata,
          id: source.evidenceId,
          eventId: source.eventId,
          provenance,
          content: { kind: 'recorded_text', text: 'Synthetic owner text.' },
        } as never,
      ],
    },
  );
}

/** Two owners with identical identifiers, migrated, on a fresh connection. */
export function world(filename = ':memory:'): Storage {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  for (const owner of [ownerId, otherOwner]) {
    identities(storage, owner);
    sourceEvent(storage, owner);
  }
  return storage;
}

/** A constructed v1 proposal (plain data) for `owner`. */
export function proposalFor(overrides: Json = {}, owner = ownerId): Json {
  return JSON.parse(
    JSON.stringify(
      constructActionProposal(draft({ ownerId: owner, ...overrides })).proposal,
    ),
  ) as Json;
}

/** A valid recording request; every value is caller-supplied. */
export function request(overrides: Json = {}): Json {
  return {
    ownerId,
    sessionId,
    taskId,
    proposal: proposalFor(),
    eventId: 'event_proposal',
    occurredAt,
    provenance: inference(),
    ...overrides,
  };
}

/** Row count of every table, `sqlite_sequence` included. */
export function counts(storage: Storage): Record<string, number> {
  const db = storage.sqlite;
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  return Object.fromEntries(
    tables.map((name) => [
      name,
      (
        db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}

/** Non-zero per-table differences. */
export function delta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0);
    if (d !== 0) out[name] = d;
  }
  return out;
}

/** The full logical content of a database, for unchanged-state checks. */
export function dump(storage: Storage): string {
  const db = storage.sqlite;
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  return JSON.stringify(
    tables.map((name) => [
      name,
      (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

export interface Binding {
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly proposalDigest: { algorithm: string; value: string };
  readonly parametersDigest: { algorithm: string; value: string };
}

/**
 * Test setup only: a synthetic owner-approval record bound to a recorded
 * proposal, appended through the frozen Ledger so that a later proposal can
 * cite it. Not an approval flow; nothing is authorized.
 */
export function syntheticApproval(
  storage: Storage,
  binding: Binding,
  approvalId: string,
  eventId: string,
  owner = ownerId,
) {
  const provenance = {
    kind: 'owner_approval',
    ownerId: owner,
    sourceEventId: eventId,
  };
  const evidenceId = eventId.replace('event_', 'evidence_');
  ledger(storage, owner).appendEvent(
    {
      kind: 'experience_event',
      ownerId: owner,
      metadata: setupMetadata,
      id: eventId,
      task: { sessionId, taskId },
      occurredAt: '2026-10-14T09:30:00Z',
      evidenceIds: [evidenceId],
      eventType: 'owner_approval',
      payload: {
        kind: 'owner_approval',
        ownerId: owner,
        metadata: setupMetadata,
        id: approvalId,
        proposal: binding,
        bounds: { sessionId, taskId },
        issuedAt: '2026-10-14T09:30:00Z',
        expiresAt: '2026-10-14T10:30:00Z',
        evidence: { evidenceId, eventId },
        provenance,
        lifecycle: { status: 'issued' },
      },
      provenance,
    } as unknown as EventInput,
    {
      evidence: [
        {
          kind: 'recorded_evidence',
          ownerId: owner,
          metadata: setupMetadata,
          id: evidenceId,
          eventId,
          provenance,
          content: { kind: 'recorded_text', text: 'Synthetic approval.' },
        } as never,
      ],
    },
  );
}

/**
 * Test setup only: a SYNTHETIC policy-decision record that cites a recorded
 * proposal's binding, to show the binding resolves in the frozen schema. It
 * is not Root, not a decision procedure and grants nothing.
 */
export function syntheticPolicyDecision(
  storage: Storage,
  binding: Binding,
  eventId: string,
) {
  const provenance = systemGenerated();
  ledger(storage, ownerId).appendEvent({
    kind: 'experience_event',
    ownerId,
    metadata: setupMetadata,
    id: eventId,
    task: { sessionId, taskId },
    occurredAt: '2026-10-14T09:40:00Z',
    evidenceIds: [],
    eventType: 'policy_decision',
    payload: {
      kind: 'policy_decision',
      ownerId,
      metadata: setupMetadata,
      id: 'decision_synthetic',
      proposal: binding,
      evaluatedAt: '2026-10-14T09:40:00Z',
      issuer: {
        kind: 'root',
        policyVersion: 'synthetic-policy-not-root',
        policyDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
      },
      reasonCodes: ['SYNTHETIC_TEST_ONLY'],
      decision: 'DENY',
    },
    provenance,
  } as unknown as EventInput);
}
