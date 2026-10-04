import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TaskBindingSchema,
} from './common.ts';
import { EventIdSchema, SessionIdSchema } from './ids.ts';
import { OwnerCorrectionProvenanceSchema } from './provenance.ts';
import { ScopeSchema } from './scope.ts';

export const CorrectionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), eventId: EventIdSchema }),
  z.strictObject({
    kind: z.literal('evidence'),
    reference: EvidenceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('owner_state'),
    reference: LearnedItemReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('unidentified'),
    description: NonEmptyTextSchema,
  }),
]);
export const OwnerCorrectionSchema = z
  .strictObject({
    kind: z.literal('owner_correction'),
    ...OwnerRecordShape,
    evidence: EvidenceReferenceSchema,
    provenance: OwnerCorrectionProvenanceSchema,
    category: z.enum([
      'fact',
      'scope',
      'preference',
      'intent',
      'procedure',
      'communication',
      'permission',
    ]),
    target: CorrectionTargetSchema,
    originalBehavior: NonEmptyTextSchema,
    correctedInstruction: NonEmptyTextSchema,
    immediateApplicability: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('current_task'),
        task: TaskBindingSchema,
      }),
      z.strictObject({
        kind: z.literal('current_session'),
        sessionId: SessionIdSchema,
      }),
      z.strictObject({ kind: z.literal('unspecified') }),
    ]),
    durableScopeHint: ScopeSchema,
  })
  .superRefine((v, ctx) => {
    if (
      v.ownerId !== v.provenance.ownerId ||
      v.evidence.eventId !== v.provenance.sourceEventId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'Correction owner and source event must match its evidence',
      });
    }
  });
export type OwnerCorrection = z.infer<typeof OwnerCorrectionSchema>;
