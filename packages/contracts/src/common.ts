import { z } from 'zod';
import {
  CandidateIdSchema,
  EvaluationIdSchema,
  EvidenceIdSchema,
  EventIdSchema,
  LearnedItemIdSchema,
  OwnerIdSchema,
  SessionIdSchema,
  TaskIdSchema,
} from './ids.ts';

export const NonEmptyTextSchema = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, 'Must contain non-whitespace text');
export const TimestampSchema = z.iso.datetime({ offset: true });
export const RecordVersionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const DigestSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  value: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ImmutableArtifactReferenceSchema = z.strictObject({
  locator: NonEmptyTextSchema,
  digest: DigestSchema,
});
export const RuntimeStampSchema = z.strictObject({
  identifier: NonEmptyTextSchema,
  version: NonEmptyTextSchema,
});
export const RecordMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  recordVersion: RecordVersionSchema,
  createdAt: TimestampSchema,
  creation: z.strictObject({
    component: NonEmptyTextSchema,
    version: NonEmptyTextSchema,
    runtime: RuntimeStampSchema.optional(),
  }),
});
export const OwnerRecordShape = {
  ownerId: OwnerIdSchema,
  metadata: RecordMetadataSchema,
};
export const TaskBindingSchema = z.strictObject({
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
});
export const EvidenceReferenceSchema = z.strictObject({
  evidenceId: EvidenceIdSchema,
  eventId: EventIdSchema,
});
export const LearnedItemReferenceSchema = z.strictObject({
  learnedItemId: LearnedItemIdSchema,
  version: RecordVersionSchema,
});
export const CandidateReferenceSchema = z.strictObject({
  candidateId: CandidateIdSchema,
  version: RecordVersionSchema,
});
export const EvaluationReferenceSchema = z.strictObject({
  evaluationId: EvaluationIdSchema,
  version: RecordVersionSchema,
});
export type RecordMetadata = z.infer<typeof RecordMetadataSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type LearnedItemReference = z.infer<typeof LearnedItemReferenceSchema>;
