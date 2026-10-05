// Synthetic persistence fixtures only. These helpers are not a storage/write API.
import * as c from '@aven/contracts';
import * as f from '../../contracts/test/fixtures.ts';
import {
  migrate,
  openStorage,
  serializeContract,
  type ContractName,
  type Storage,
} from '../src/index.ts';

export { f };
export function fresh(filename = ':memory:') {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  return storage;
}
export function identities(
  s: Storage,
  owner = f.owner as string,
  suffix = 'synthetic',
) {
  s.sqlite.prepare('INSERT INTO owners VALUES (?, ?)').run(owner, f.time);
  s.sqlite
    .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run(owner, `session_${suffix}`, f.time);
  s.sqlite
    .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
    .run(owner, `task_${suffix}`, `session_${suffix}`, f.time);
}
export function record(
  s: Storage,
  name: ContractName,
  value: unknown,
  extra?: string,
) {
  const json = serializeContract(name, value);
  if (name === 'action_proposals')
    return s.sqlite
      .prepare(
        'INSERT INTO action_proposals (record_json, proposal_digest) VALUES (?, ?)',
      )
      .run(json, extra ?? f.digest.value);
  if (name === 'no_useful_lessons')
    return s.sqlite
      .prepare(
        'INSERT INTO no_useful_lessons (record_json, storage_id) VALUES (?, ?)',
      )
      .run(json, extra ?? 'synthetic-no-lesson');
  return s.sqlite
    .prepare(`INSERT INTO ${name} (record_json) VALUES (?)`)
    .run(json);
}
export function event(id = 'event_source', occurredAt = f.time) {
  return c.ExperienceEventSchema.parse({
    kind: 'experience_event',
    ...f.base,
    id,
    occurredAt,
    recordedAt: f.later,
    task: f.task,
    evidenceIds: [],
    eventType: 'owner_request',
    payload: { instruction: 'Synthetic request only', task: f.task },
    provenance: { ...f.ownerProvenance, sourceEventId: id },
  });
}
export function base(s: Storage) {
  identities(s);
  s.sqlite.transaction(() => {
    record(s, 'experience_events', {
      ...event(),
      evidenceIds: [f.recordedEvidence.id],
    });
    record(s, 'evidence', f.recordedEvidence);
  })();
}
export function transitionEvent(value: c.LearningTransition) {
  const names = {
    learning_promotion: 'learning_promoted',
    learning_rejection: 'learning_rejected',
    learning_supersession: 'learning_superseded',
    learning_revocation: 'learning_revoked',
    learning_rollback: 'learning_rolled_back',
  } as const;
  return c.ExperienceEventSchema.parse({
    kind: 'experience_event',
    ...f.base,
    id: value.eventId,
    occurredAt: f.later,
    recordedAt: f.later,
    evidenceIds: [],
    eventType: names[value.kind],
    payload: value,
    provenance: f.system,
  });
}
export function graph(s: Storage) {
  base(s);
  s.sqlite.transaction(() => {
    record(s, 'action_proposals', f.proposal);
    record(s, 'policy_decisions', f.policy);
    record(s, 'learning_candidates', f.candidate);
    record(s, 'evaluations', f.evaluation);
    record(s, 'learned_owner_state', f.trusted);
    record(s, 'experience_events', transitionEvent(f.promotion));
    record(s, 'lifecycle_records', f.promotion);
  })();
}
