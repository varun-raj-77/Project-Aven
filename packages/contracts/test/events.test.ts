import { describe, expect, it } from 'vitest';
import * as c from '../src/index.ts';
import * as f from './fixtures.ts';

const envelope = {
  kind: 'experience_event',
  ...f.base,
  id: 'event_source',
  occurredAt: f.time,
  recordedAt: f.later,
  task: f.task,
  evidenceIds: [f.evidence.evidenceId],
};
const records = [
  {
    eventType: 'owner_request',
    payload: { instruction: 'Prepare a synthetic draft', task: f.task },
    provenance: f.ownerProvenance,
  },
  {
    eventType: 'assistant_response',
    payload: {
      response: 'Synthetic response',
      task: f.task,
      citedEvidence: [f.evidence],
    },
    provenance: f.inference,
  },
  {
    eventType: 'owner_correction',
    payload: f.correction,
    provenance: f.correction.provenance,
  },
  {
    eventType: 'action_proposed',
    payload: f.proposal,
    provenance: f.inference,
  },
  { eventType: 'policy_decision', payload: f.policy, provenance: f.system },
  {
    eventType: 'owner_approval',
    payload: f.approval,
    provenance: f.approval.provenance,
  },
  { eventType: 'tool_execution', payload: f.execution, provenance: f.tool },
  { eventType: 'verification', payload: f.verification, provenance: f.system },
  {
    eventType: 'learning_candidate_created',
    payload: f.candidate,
    provenance: f.inference,
  },
  {
    eventType: 'learning_candidate_evaluated',
    payload: f.evaluation,
    provenance: f.system,
  },
  {
    eventType: 'learning_promoted',
    payload: f.promotion,
    provenance: f.system,
  },
  {
    eventType: 'learning_rejected',
    payload: f.rejection,
    provenance: f.system,
  },
  {
    eventType: 'learning_superseded',
    payload: f.supersession,
    provenance: f.system,
  },
  {
    eventType: 'learning_revoked',
    payload: f.revocation,
    provenance: f.system,
  },
  {
    eventType: 'learning_rolled_back',
    payload: f.rollback,
    provenance: f.system,
  },
];

describe('append-only historical event representations', () => {
  it.each(records)(
    'round trips $eventType with its typed payload',
    (record) => {
      const id =
        'eventId' in record.payload ? record.payload.eventId : envelope.id;
      const input = { ...envelope, id, ...record };
      const parsed = c.ExperienceEventSchema.parse(input);
      expect(
        c.ExperienceEventSchema.parse(
          JSON.parse(JSON.stringify(parsed)) as unknown,
        ),
      ).toEqual(input);
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );
  it('rejects event/payload substitution', () => {
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        eventType: 'policy_decision',
        payload: f.proposal,
        provenance: f.system,
      }).success,
    ).toBe(false);
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        eventType: 'verification',
        payload: f.execution,
        provenance: f.system,
      }).success,
    ).toBe(false);
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        eventType: 'unknown',
        payload: {},
        provenance: f.system,
      }).success,
    ).toBe(false);
  });
  it('rejects owner/provenance/transition mismatches', () => {
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        ownerId: 'owner_other',
        eventType: 'owner_correction',
        payload: f.correction,
        provenance: f.correction.provenance,
      }).success,
    ).toBe(false);
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        eventType: 'owner_request',
        payload: { instruction: 'Fake owner request', task: f.task },
        provenance: f.inference,
      }).success,
    ).toBe(false);
    expect(
      c.ExperienceEventSchema.safeParse({
        ...envelope,
        eventType: 'learning_promoted',
        payload: f.promotion,
        provenance: f.system,
      }).success,
    ).toBe(false);
  });
  it('requires new historical events instead of updating a record version', () => {
    const request = {
      ...envelope,
      eventType: 'owner_request',
      payload: { instruction: 'Synthetic request', task: f.task },
      provenance: f.ownerProvenance,
    };
    expect(
      c.ExperienceEventSchema.safeParse({
        ...request,
        metadata: { ...f.metadata, recordVersion: 2 },
      }).success,
    ).toBe(false);
    expect(
      c.ExperienceEventSchema.safeParse({ ...request, id: 'event_other' })
        .success,
    ).toBe(false);
  });
});
