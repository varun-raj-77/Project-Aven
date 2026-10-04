import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  RecordMetadataSchema,
  TaskBindingSchema,
  TimestampSchema,
} from './common.ts';
import { EvidenceIdSchema, EventIdSchema } from './ids.ts';
import { ActionProposalSchema } from './actions.ts';
import { OwnerApprovalSchema } from './approvals.ts';
import { OwnerCorrectionSchema } from './corrections.ts';
import { EvaluationResultSchema } from './evaluation.ts';
import { ExecutionResultSchema } from './execution.ts';
import { LearningCandidateSchema } from './learning.ts';
import { PolicyDecisionSchema } from './policy.ts';
import {
  ModelInferenceProvenanceSchema,
  OwnerApprovalProvenanceSchema,
  OwnerCorrectionProvenanceSchema,
  OwnerStatementProvenanceSchema,
  ProvenanceSchema,
  SystemGeneratedProvenanceSchema,
  ToolResultProvenanceSchema,
} from './provenance.ts';
import {
  LearningPromotionSchema,
  LearningRejectionSchema,
  LearningRevocationSchema,
  LearningRollbackSchema,
  LearningSupersessionSchema,
} from './transitions.ts';
import { VerificationResultSchema } from './verification.ts';

const eventShape = {
  kind: z.literal('experience_event'),
  ...OwnerRecordShape,
  metadata: RecordMetadataSchema.extend({ recordVersion: z.literal(1) }),
  id: EventIdSchema,
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
  task: TaskBindingSchema.optional(),
  evidenceIds: z.array(EvidenceIdSchema),
};
function event<K extends string, P extends z.ZodType, S extends z.ZodType>(
  eventType: K,
  payload: P,
  provenance: S,
) {
  return z.strictObject({
    ...eventShape,
    eventType: z.literal(eventType),
    payload,
    provenance,
  });
}
export const ExperienceEventSchema = z
  .discriminatedUnion('eventType', [
    event(
      'owner_request',
      z.strictObject({
        instruction: NonEmptyTextSchema,
        task: TaskBindingSchema,
      }),
      OwnerStatementProvenanceSchema,
    ),
    event(
      'assistant_response',
      z.strictObject({
        response: NonEmptyTextSchema,
        task: TaskBindingSchema,
        citedEvidence: z.array(EvidenceReferenceSchema),
      }),
      ModelInferenceProvenanceSchema,
    ),
    event(
      'owner_correction',
      OwnerCorrectionSchema,
      OwnerCorrectionProvenanceSchema,
    ),
    event('action_proposed', ActionProposalSchema, ProvenanceSchema),
    event(
      'policy_decision',
      PolicyDecisionSchema,
      SystemGeneratedProvenanceSchema,
    ),
    event('owner_approval', OwnerApprovalSchema, OwnerApprovalProvenanceSchema),
    event('tool_execution', ExecutionResultSchema, ToolResultProvenanceSchema),
    event(
      'verification',
      VerificationResultSchema,
      SystemGeneratedProvenanceSchema,
    ),
    event(
      'learning_candidate_created',
      LearningCandidateSchema,
      ProvenanceSchema,
    ),
    event(
      'learning_candidate_evaluated',
      EvaluationResultSchema,
      ProvenanceSchema,
    ),
    event(
      'learning_promoted',
      LearningPromotionSchema,
      SystemGeneratedProvenanceSchema,
    ),
    event('learning_rejected', LearningRejectionSchema, ProvenanceSchema),
    event(
      'learning_superseded',
      LearningSupersessionSchema,
      SystemGeneratedProvenanceSchema,
    ),
    event(
      'learning_revoked',
      LearningRevocationSchema,
      SystemGeneratedProvenanceSchema,
    ),
    event(
      'learning_rolled_back',
      LearningRollbackSchema,
      SystemGeneratedProvenanceSchema,
    ),
  ])
  .superRefine((v, ctx) => {
    if (
      [
        'owner_request',
        'owner_correction',
        'owner_approval',
        'tool_execution',
      ].includes(v.eventType) &&
      'sourceEventId' in v.provenance &&
      v.provenance.sourceEventId !== v.id
    )
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'sourceEventId'],
        message: 'Original evidence must reference this event',
      });
    if (
      (v.eventType === 'owner_correction' ||
        v.eventType === 'owner_approval') &&
      v.payload.provenance.sourceEventId !== v.id
    )
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'provenance'],
        message: 'Owner payload must reference this event',
      });
    if (Date.parse(v.recordedAt) < Date.parse(v.occurredAt))
      ctx.addIssue({
        code: 'custom',
        path: ['recordedAt'],
        message: 'Recording cannot precede occurrence',
      });
    if ('ownerId' in v.payload && v.payload.ownerId !== v.ownerId)
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'ownerId'],
        message: 'Event and payload owner must match',
      });
    if ('ownerId' in v.provenance && v.provenance.ownerId !== v.ownerId)
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'ownerId'],
        message: 'Owner provenance must match event owner',
      });
    if ('eventId' in v.payload && v.payload.eventId !== v.id)
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'eventId'],
        message: 'Transition must reference its recording event',
      });
    if (
      'task' in v.payload &&
      v.payload.task &&
      v.task &&
      (v.payload.task.taskId !== v.task.taskId ||
        v.payload.task.sessionId !== v.task.sessionId)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['task'],
        message: 'Envelope and payload task must match',
      });
    if (
      v.eventType === 'learning_candidate_evaluated' &&
      v.payload.subject.kind !== 'candidate'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'subject'],
        message: 'Candidate evaluation event requires a candidate subject',
      });
  })
  .readonly();
export type ExperienceEvent = z.infer<typeof ExperienceEventSchema>;
