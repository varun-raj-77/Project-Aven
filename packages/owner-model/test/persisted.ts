/**
 * SYNTHETIC persisted-world fixtures for AVEN-009 patch 7 tests. Every owner,
 * ID, text and digest is invented (they reuse the frozen AVEN-002 contract
 * fixtures, re-owned per owner). These helpers set up test databases only:
 * they are NOT an owner-state writer and production code never uses them.
 *
 * Ordinary owner-origin, authority and candidate events go through the
 * frozen Ledger API. Snapshots whose lifecycle points at a transition, and
 * those transition events, reference each other (the snapshot names the
 * event; the event names the snapshot), so the frozen storage tests' pattern
 * is used for them: one raw transaction with deferred foreign keys. The
 * Ledger refuses to append inside an outer transaction, which is why those
 * rows are not appended through it. Later rejection and rollback events go
 * through the Ledger again.
 */
import * as c from '@aven/contracts';
import { createLedger, type EventInput, type Ledger } from '@aven/ledger';
import {
  migrate,
  openStorage,
  serializeContract,
  type ContractName,
  type Storage,
} from '@aven/storage';
import * as f from '../../contracts/test/fixtures.ts';

export { f };
export const A = 'owner_persist_a';
export const B = 'owner_persist_b';
type Json = Record<string, unknown>;

/** A frozen fixture value re-owned by `owner` (exact owner-ID text only). */
export function as<T>(owner: string, value: T): T {
  return JSON.parse(
    JSON.stringify(value).replaceAll(`"${f.owner}"`, JSON.stringify(owner)),
  ) as T;
}

export function fresh(filename = ':memory:'): Storage {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  return storage;
}

export function identities(storage: Storage, owner: string): void {
  storage.sqlite.prepare('INSERT INTO owners VALUES (?, ?)').run(owner, f.time);
  storage.sqlite
    .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run(owner, f.task.sessionId, f.time);
  for (const taskId of [f.task.taskId, 'task_other'])
    storage.sqlite
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
      .run(owner, taskId, f.task.sessionId, f.time);
}

/** A full frozen experience event of `owner` (with a recording time). */
export function experience(
  owner: string,
  id: string,
  eventType: c.ExperienceEvent['eventType'],
  payload: unknown,
  provenance: unknown,
  evidenceIds: string[] = [],
): c.ExperienceEvent {
  return c.ExperienceEventSchema.parse(
    as(owner, {
      kind: 'experience_event',
      ownerId: f.owner,
      metadata: f.metadata,
      id,
      task: f.task,
      occurredAt: f.time,
      recordedAt: f.later,
      evidenceIds,
      eventType,
      payload,
      provenance,
    }),
  );
}
const unrecorded = ({ recordedAt: _r, ...rest }: Json) => rest;
const toInput = (event: c.ExperienceEvent) =>
  unrecorded(event as unknown as Json) as unknown as EventInput;

export const statement = (owner: string, sourceEventId = 'event_source') =>
  as(owner, {
    kind: 'explicit_owner_statement',
    ownerId: f.owner,
    sourceEventId,
  });
export const correctionOrigin = (
  owner: string,
  sourceEventId = 'event_correction',
) =>
  as(owner, {
    kind: 'explicit_owner_correction',
    ownerId: f.owner,
    sourceEventId,
  });
export const approvalOrigin = (
  owner: string,
  sourceEventId = 'event_approval',
) => as(owner, { kind: 'owner_approval', ownerId: f.owner, sourceEventId });

function evidenceRecord(
  owner: string,
  id: string,
  eventId: string,
  provenance: unknown,
) {
  return unrecorded(
    as(owner, {
      ...f.recordedEvidence,
      id,
      eventId,
      provenance,
    }) as unknown as Json,
  );
}

/** Owner-origin, authority and candidate history, through the Ledger. */
export function history(
  storage: Storage,
  owner: string,
  swapped = false,
): Ledger {
  const ledger = createLedger(storage, c.OwnerIdSchema.parse(owner));
  const append = (event: c.ExperienceEvent, options: Json = {}) =>
    ledger.appendEvent(toInput(event), options);
  append(
    experience(
      owner,
      'event_source',
      'owner_request',
      { instruction: 'Synthetic request', task: f.task },
      statement(owner),
      ['evidence_source'],
    ),
    {
      evidence: [
        evidenceRecord(
          owner,
          'evidence_source',
          'event_source',
          statement(owner),
        ),
      ],
    },
  );
  append(
    experience(
      owner,
      'event_proposal',
      'action_proposed',
      f.proposal,
      f.inference,
    ),
    { proposalDigest: f.digest },
  );
  const approvalRef = {
    eventId: 'event_approval',
    evidenceId: 'evidence_approval',
  };
  append(
    experience(
      owner,
      'event_approval',
      'owner_approval',
      {
        ...f.approval,
        provenance: approvalOrigin(f.owner),
        evidence: approvalRef,
      },
      approvalOrigin(owner),
      ['evidence_approval'],
    ),
    {
      evidence: [
        evidenceRecord(
          owner,
          'evidence_approval',
          'event_approval',
          approvalOrigin(owner),
        ),
      ],
    },
  );
  append(
    experience(
      owner,
      'event_policy',
      'policy_decision',
      {
        ...f.policy,
        basis: { kind: 'owner_approval', approvalIds: [f.approval.id] },
      },
      f.system,
    ),
  );
  append(
    experience(
      owner,
      'event_candidate',
      'learning_candidate_created',
      f.candidate,
      f.inference,
    ),
  );
  append(
    experience(
      owner,
      'event_evaluation',
      'learning_candidate_evaluated',
      f.evaluation,
      f.system,
    ),
  );
  const correctionRef = {
    eventId: 'event_correction',
    evidenceId: 'evidence_correction',
  };
  const correctionPayload = c.OwnerCorrectionSchema.parse(
    as(owner, {
      ...f.correction,
      evidence: correctionRef,
      provenance: correctionOrigin(f.owner),
      target: { kind: 'event', eventId: f.evidence.eventId },
    }),
  );
  const correction = () =>
    append(
      experience(
        owner,
        'event_correction',
        'owner_correction',
        correctionPayload,
        correctionOrigin(owner),
        ['evidence_correction'],
      ),
      {
        evidence: [
          {
            ...evidenceRecord(
              owner,
              'evidence_correction',
              'event_correction',
              correctionOrigin(owner),
            ),
            content: {
              kind: 'recorded_text',
              text: correctionPayload.correctedInstruction,
            },
          },
        ],
      },
    );
  const assistant = () =>
    append(
      experience(
        owner,
        'event_assistant',
        'assistant_response',
        { response: 'Synthetic response', task: f.task, citedEvidence: [] },
        f.inference,
      ),
    );
  if (swapped) {
    assistant();
    correction();
  } else {
    correction();
    assistant();
  }
  return ledger;
}

const ref = (learnedItemId: string, version = 1) => ({
  learnedItemId,
  version,
});

/** A durable snapshot of `owner` (fixture content, scope and signals). */
export function durable(
  owner: string,
  id: string,
  version: number,
  lifecycle: Json,
  provenance: unknown = statement(owner),
  ownerConfirmation: Json = { status: 'not_requested' },
): Json {
  return as(owner, {
    kind: 'durable_owner_state',
    ownerId: f.owner,
    metadata: { ...f.metadata, recordVersion: version },
    id,
    content: f.content,
    scope: f.scope,
    provenance,
    evidence: { ...f.signals, ownerConfirmation },
    lifecycle,
  });
}

/** An active-task-state snapshot of `owner`. */
export function task(
  owner: string,
  id: string,
  version: number,
  provenance: unknown,
  options: { taskId?: string; lifecycle?: Json } = {},
): Json {
  return as(owner, {
    kind: 'active_task_state',
    ownerId: f.owner,
    metadata: { ...f.metadata, recordVersion: version },
    id,
    task: {
      sessionId: f.task.sessionId,
      taskId: options.taskId ?? f.task.taskId,
    },
    objective: 'Synthetic task objective',
    openLoops: ['Synthetic loop', 'Synthetic loop'],
    sourceEvidence: [f.evidence],
    provenance,
    lifecycle: options.lifecycle ?? { status: 'active' },
  });
}

/** The durable and active snapshots of the standard synthetic world. */
export function snapshots(owner: string): Json[] {
  return [
    durable(
      owner,
      'learned_a',
      1,
      {
        status: 'trusted',
        evaluations: [f.evalRef],
        lastValidatedAt: f.time,
        candidate: f.candidateRef,
        promotionEventId: 'event_pro_a1',
      },
      statement(owner),
      {
        status: 'confirmed',
        evidence: f.evidence,
        provenance: statement(f.owner),
      },
    ),
    durable(
      owner,
      'learned_b',
      1,
      {
        status: 'superseded',
        supersededAt: f.later,
        replacement: ref('learned_b', 2),
        eventId: 'event_sup_b1',
      },
      correctionOrigin(owner),
      {
        status: 'disputed',
        evidence: {
          evidenceId: 'evidence_correction',
          eventId: 'event_correction',
        },
        provenance: correctionOrigin(f.owner),
      },
    ),
    durable(
      owner,
      'learned_b',
      2,
      { status: 'observed' },
      approvalOrigin(owner),
    ),
    durable(owner, 'learned_c', 1, { status: 'observed' }, f.inference),
    durable(owner, 'learned_c', 2, {
      status: 'revoked',
      revokedAt: f.later,
      reason: 'Synthetic regression',
      eventId: 'event_rev_c2',
      fallback: ref('learned_c', 1),
    }),
    durable(owner, 'learned_d', 1, {
      status: 'validated',
      evaluations: [f.evalRef],
      lastValidatedAt: f.time,
    }),
    task(owner, 'learned_t1', 1, statement(owner)),
    task(owner, 'learned_t2', 1, approvalOrigin(owner), {
      lifecycle: { status: 'closed', closedAt: f.later, outcome: 'completed' },
    }),
    task(owner, 'learned_t3', 1, correctionOrigin(owner), {
      taskId: 'task_other',
    }),
  ];
}

/** The recorded transitions backing the standard world's lifecycle claims. */
export function transitions(owner: string): c.LearningTransition[] {
  const common = {
    ownerId: f.owner,
    metadata: f.metadata,
    occurredAt: f.later,
  };
  return [
    {
      kind: 'learning_promotion',
      ...common,
      eventId: 'event_pro_a1',
      candidate: f.candidateRef,
      evaluations: [f.evalRef],
      trustedState: ref('learned_a'),
      authority: f.policyRef,
    },
    {
      kind: 'learning_supersession',
      ...common,
      eventId: 'event_sup_b1',
      previous: ref('learned_b'),
      replacement: ref('learned_b', 2),
      promotionEventId: 'event_pro_a1',
      authority: f.policyRef,
      reason: 'Synthetic replacement',
    },
    {
      kind: 'learning_revocation',
      ...common,
      eventId: 'event_rev_c2',
      revoked: ref('learned_c', 2),
      fallback: ref('learned_c'),
      authority: f.policyRef,
      reason: 'Synthetic regression',
      evidence: [f.evidence],
    },
  ].map((t) => c.LearningTransitionSchema.parse(as(owner, t)));
}

const EVENT_TYPE: Record<string, c.ExperienceEvent['eventType']> = {
  learning_promotion: 'learning_promoted',
  learning_rejection: 'learning_rejected',
  learning_supersession: 'learning_superseded',
  learning_revocation: 'learning_revoked',
  learning_rollback: 'learning_rolled_back',
};
export function transitionEvent(owner: string, t: c.LearningTransition) {
  return experience(owner, t.eventId, EVENT_TYPE[t.kind]!, t, f.system);
}

export function insert(storage: Storage, name: ContractName, value: unknown) {
  storage.sqlite
    .prepare(`INSERT INTO ${name} (record_json) VALUES (?)`)
    .run(serializeContract(name, value));
}

/** Snapshots and their transition events, atomically (deferred FKs). */
export function claims(
  storage: Storage,
  owner: string,
  options: {
    reverse?: boolean;
    records?: Json[];
    projections?: boolean;
    extraTransitions?: c.LearningTransition[];
  } = {},
): void {
  const rows: [ContractName, unknown][] = [];
  for (const record of options.records ?? snapshots(owner))
    rows.push([
      record['kind'] === 'durable_owner_state'
        ? 'learned_owner_state'
        : 'active_task_state',
      record,
    ]);
  for (const t of [
    ...transitions(owner),
    ...(options.extraTransitions ?? []),
  ]) {
    rows.push(['experience_events', transitionEvent(owner, t)]);
    if (options.projections !== false) rows.push(['lifecycle_records', t]);
  }
  if (options.reverse) rows.reverse();
  storage.sqlite.transaction(() => {
    for (const [name, value] of rows) insert(storage, name, value);
  })();
}

/** Unused rejection and rollback history, through the Ledger. */
export function inertHistory(ledger: Ledger, owner: string): void {
  ledger.appendEvent(
    toInput(
      transitionEvent(
        owner,
        c.LearningTransitionSchema.parse(as(owner, f.rejection)),
      ),
    ),
  );
  const rollback = c.LearningTransitionSchema.parse(
    as(owner, {
      kind: 'learning_rollback',
      ownerId: f.owner,
      metadata: f.metadata,
      eventId: 'event_rollback_c',
      occurredAt: f.later,
      from: ref('learned_c', 2),
      restore: ref('learned_c'),
      revocationEventId: 'event_rev_c2',
      authority: f.policyRef,
      reason: 'Synthetic rollback',
    }),
  );
  ledger.appendEvent(toInput(transitionEvent(owner, rollback)));
}

/** The complete standard world for one owner. */
export function world(
  storage: Storage,
  owner: string,
  options: { reverse?: boolean; inert?: boolean } = {},
): Ledger {
  identities(storage, owner);
  const ledger = history(storage, owner, options.reverse === true);
  claims(storage, owner, { reverse: options.reverse === true });
  if (options.inert !== false) inertHistory(ledger, owner);
  return ledger;
}

/**
 * Simulates damaged or legacy storage for fail-closed tests: rows inserted
 * while foreign keys are off. Frozen storage would reject them otherwise.
 */
export function corrupt(storage: Storage, rows: [ContractName, unknown][]) {
  storage.sqlite.pragma('foreign_keys = OFF');
  try {
    for (const [name, value] of rows) insert(storage, name, value);
  } finally {
    storage.sqlite.pragma('foreign_keys = ON');
  }
}
