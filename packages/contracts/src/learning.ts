import { z } from 'zod';
import {
  EvaluationReferenceSchema,
  EvidenceReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { CandidateIdSchema, EventIdSchema } from './ids.ts';
import { LearnedContentSchema } from './owner-state.ts';
import {
  EvidenceSignalsSchema,
  ModelInferenceProvenanceSchema,
  SystemGeneratedProvenanceSchema,
} from './provenance.ts';
import { ScopeSchema } from './scope.ts';

export const LearningGenerationSchema = z.strictObject({
  generatedAt: TimestampSchema,
  generator: z.union([
    ModelInferenceProvenanceSchema,
    SystemGeneratedProvenanceSchema,
  ]),
});
export const LearningCandidateSchema = z
  .strictObject({
    kind: z.literal('learning_candidate'),
    ...OwnerRecordShape,
    id: CandidateIdSchema,
    proposedContent: LearnedContentSchema,
    proposedScope: ScopeSchema,
    evidence: EvidenceSignalsSchema,
    generation: LearningGenerationSchema,
    lifecycle: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('candidate') }),
      z.strictObject({
        status: z.literal('under_evaluation'),
        evaluations: z.array(EvaluationReferenceSchema).min(1),
      }),
      z.strictObject({
        status: z.literal('evaluated'),
        evaluations: z.array(EvaluationReferenceSchema).min(1),
      }),
      z.strictObject({
        status: z.literal('shadow'),
        evaluations: z.array(EvaluationReferenceSchema).min(1),
      }),
      z.strictObject({
        status: z.literal('rejected'),
        rejectionEventId: EventIdSchema,
        reason: NonEmptyTextSchema,
        evaluations: z.array(EvaluationReferenceSchema),
      }),
      z.strictObject({
        status: z.literal('promoted'),
        promotionEventId: EventIdSchema,
        state: LearnedItemReferenceSchema,
        evaluations: z.array(EvaluationReferenceSchema).min(1),
      }),
    ]),
  })
  .superRefine((v, ctx) => {
    const confirmation = v.evidence.ownerConfirmation;
    if (
      'provenance' in confirmation &&
      confirmation.provenance.ownerId !== v.ownerId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'ownerConfirmation'],
        message: 'Owner confirmation must belong to the candidate owner',
      });
    }
  });
export const LearningResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('candidate_generated'),
    candidate: LearningCandidateSchema,
  }),
  z.strictObject({
    kind: z.literal('no_useful_lesson'),
    ...OwnerRecordShape,
    consideredEvidence: z.array(EvidenceReferenceSchema).min(1),
    generation: LearningGenerationSchema,
    reason: NonEmptyTextSchema,
  }),
]);
export type LearningCandidate = z.infer<typeof LearningCandidateSchema>;
export type LearningResult = z.infer<typeof LearningResultSchema>;
