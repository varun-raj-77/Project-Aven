// Synthetic data only; reuse frozen AVEN-002 examples without changing them.
import * as c from '@aven/contracts';
import { migrate, openStorage, type Storage } from '@aven/storage';
import * as f from '../../contracts/test/fixtures.ts';
import {
  createLedger,
  type EventInput,
  type EvidenceInput,
  type Ledger,
} from '../src/index.ts';
export { f };

export function fresh(filename = ':memory:') {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  identities(storage);
  return { storage, ledger: createLedger(storage, f.owner) };
}
export function identities(s: Storage, suffix = 'synthetic') {
  s.sqlite
    .prepare('INSERT INTO owners VALUES (?, ?)')
    .run(`owner_${suffix}`, f.time);
  s.sqlite
    .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run(`owner_${suffix}`, `session_${suffix}`, f.time);
  s.sqlite
    .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
    .run(`owner_${suffix}`, `task_${suffix}`, `session_${suffix}`, f.time);
}
export function input(value: c.ExperienceEvent): EventInput {
  const { recordedAt: _time, ...result } = value;
  return result;
}
export function request(id = 'event_source', suffix = 'synthetic'): EventInput {
  const ownerId = c.OwnerIdSchema.parse(`owner_${suffix}`);
  const task = c.TaskBindingSchema.parse({
    sessionId: `session_${suffix}`,
    taskId: `task_${suffix}`,
  });
  return input(
    c.ExperienceEventSchema.parse({
      kind: 'experience_event',
      ...f.base,
      ownerId,
      id,
      task,
      occurredAt: f.time,
      recordedAt: f.later,
      evidenceIds: [],
      eventType: 'owner_request',
      payload: { instruction: 'Synthetic request', task },
      provenance: { ...f.ownerProvenance, ownerId, sourceEventId: id },
    }),
  );
}
export function evidence(
  value: c.EvidenceRecord = f.recordedEvidence,
): EvidenceInput {
  const { recordedAt: _time, ...result } = value;
  return result;
}
export function source(ledger: Ledger) {
  return ledger.appendEvent(
    { ...request(), evidenceIds: [f.evidence.evidenceId] },
    { evidence: [evidence()] },
  );
}
export function event(
  id: string,
  eventType: c.ExperienceEvent['eventType'],
  payload: unknown,
  provenance: c.Provenance = f.system,
): EventInput {
  return input(
    c.ExperienceEventSchema.parse({
      ...request(id),
      recordedAt: f.later,
      eventType,
      payload,
      provenance,
    }),
  );
}
export function correction() {
  const ref = c.EvidenceReferenceSchema.parse({
    eventId: 'event_correction',
    evidenceId: 'evidence_correction',
  });
  const provenance = { ...f.correction.provenance, sourceEventId: ref.eventId };
  const payload = c.OwnerCorrectionSchema.parse({
    ...f.correction,
    evidence: ref,
    provenance,
    target: { kind: 'event', eventId: f.evidence.eventId },
  });
  return {
    event: {
      ...event(ref.eventId, 'owner_correction', payload, provenance),
      evidenceIds: [ref.evidenceId],
    },
    evidence: evidence({
      ...f.recordedEvidence,
      id: ref.evidenceId,
      eventId: ref.eventId,
      provenance,
      content: { kind: 'recorded_text', text: payload.correctedInstruction },
    }),
  };
}
export function authority(ledger: Ledger) {
  ledger.appendEvent(
    event('event_proposal', 'action_proposed', f.proposal, f.inference),
    { proposalDigest: f.digest },
  );
  const ref = c.EvidenceReferenceSchema.parse({
    eventId: 'event_approval',
    evidenceId: 'evidence_approval',
  });
  const provenance = { ...f.approval.provenance, sourceEventId: ref.eventId };
  ledger.appendEvent(
    {
      ...event(
        ref.eventId,
        'owner_approval',
        { ...f.approval, provenance, evidence: ref },
        provenance,
      ),
      evidenceIds: [ref.evidenceId],
    },
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
  ledger.appendEvent(
    event('event_policy', 'policy_decision', {
      ...f.policy,
      basis: { kind: 'owner_approval', approvalIds: [f.approval.id] },
    }),
  );
  ledger.appendEvent(
    event('event_execution', 'tool_execution', f.execution, {
      ...f.tool,
      sourceEventId: c.EventIdSchema.parse('event_execution'),
    }),
  );
}
