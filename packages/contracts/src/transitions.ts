import { z } from 'zod';
import {
  CandidateReferenceSchema,
  EvaluationReferenceSchema,
  EvidenceReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { EventIdSchema } from './ids.ts';
import { AllowDecisionReferenceSchema } from './policy.ts';

const transition = {
  ...OwnerRecordShape,
  eventId: EventIdSchema,
  occurredAt: TimestampSchema,
};
export const LearningPromotionSchema = z.strictObject({
  kind: z.literal('learning_promotion'),
  ...transition,
  candidate: CandidateReferenceSchema,
  evaluations: z.array(EvaluationReferenceSchema).min(1),
  trustedState: LearnedItemReferenceSchema,
  previousTrustedState: LearnedItemReferenceSchema.optional(),
  authority: AllowDecisionReferenceSchema,
});
export const LearningRejectionSchema = z.strictObject({
  kind: z.literal('learning_rejection'),
  ...transition,
  candidate: CandidateReferenceSchema,
  evaluations: z.array(EvaluationReferenceSchema),
  reason: NonEmptyTextSchema,
  evidence: z.array(EvidenceReferenceSchema).min(1),
});
export const LearningSupersessionSchema = z
  .strictObject({
    kind: z.literal('learning_supersession'),
    ...transition,
    previous: LearnedItemReferenceSchema,
    replacement: LearnedItemReferenceSchema,
    promotionEventId: EventIdSchema,
    authority: AllowDecisionReferenceSchema,
    reason: NonEmptyTextSchema,
  })
  .refine(
    (v) =>
      v.previous.learnedItemId !== v.replacement.learnedItemId ||
      v.previous.version !== v.replacement.version,
    'Cannot supersede a state version with itself',
  );
export const LearningRevocationSchema = z
  .strictObject({
    kind: z.literal('learning_revocation'),
    ...transition,
    revoked: LearnedItemReferenceSchema,
    fallback: LearnedItemReferenceSchema.optional(),
    authority: AllowDecisionReferenceSchema,
    reason: NonEmptyTextSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1),
  })
  .refine(
    (v) =>
      !v.fallback ||
      v.revoked.learnedItemId !== v.fallback.learnedItemId ||
      v.revoked.version !== v.fallback.version,
    'A revoked version cannot be its own fallback',
  );
export const LearningRollbackSchema = z
  .strictObject({
    kind: z.literal('learning_rollback'),
    ...transition,
    from: LearnedItemReferenceSchema,
    restore: LearnedItemReferenceSchema,
    revocationEventId: EventIdSchema,
    authority: AllowDecisionReferenceSchema,
    reason: NonEmptyTextSchema,
  })
  .refine(
    (v) =>
      v.from.learnedItemId !== v.restore.learnedItemId ||
      v.from.version !== v.restore.version,
    'Rollback must restore a different state version',
  );
export const LearningTransitionSchema = z.discriminatedUnion('kind', [
  LearningPromotionSchema,
  LearningRejectionSchema,
  LearningSupersessionSchema,
  LearningRevocationSchema,
  LearningRollbackSchema,
]);
export type LearningTransition = z.infer<typeof LearningTransitionSchema>;
export type LearningPromotion = z.infer<typeof LearningPromotionSchema>;
