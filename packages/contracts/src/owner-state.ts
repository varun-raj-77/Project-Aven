import { z } from 'zod';
import {
  CandidateReferenceSchema,
  EvaluationReferenceSchema,
  EvidenceReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TaskBindingSchema,
  TimestampSchema,
} from './common.ts';
import { EventIdSchema, LearnedItemIdSchema } from './ids.ts';
import { EvidenceSignalsSchema, ProvenanceSchema } from './provenance.ts';
import { ScopeSchema } from './scope.ts';

export const LearnedContentSchema = z.discriminatedUnion('category', [
  z.strictObject({
    category: z.literal('fact'),
    subject: NonEmptyTextSchema,
    assertion: NonEmptyTextSchema,
  }),
  z.strictObject({
    category: z.literal('preference'),
    subject: NonEmptyTextSchema,
    desiredBehavior: NonEmptyTextSchema,
  }),
  z.strictObject({
    category: z.literal('episode'),
    summary: NonEmptyTextSchema,
    occurredAt: TimestampSchema,
    originalEvidence: z.array(EvidenceReferenceSchema).min(1),
  }),
  z.strictObject({
    category: z.literal('intent_pattern'),
    cue: NonEmptyTextSchema,
    interpretedIntent: NonEmptyTextSchema,
  }),
  z.strictObject({
    category: z.literal('procedure'),
    objective: NonEmptyTextSchema,
    steps: z
      .array(
        z.strictObject({
          instruction: NonEmptyTextSchema,
          precondition: NonEmptyTextSchema.optional(),
        }),
      )
      .min(1),
  }),
]);
const validation = {
  evaluations: z.array(EvaluationReferenceSchema).min(1),
  lastValidatedAt: TimestampSchema,
};
export const TrustedLifecycleSchema = z.strictObject({
  status: z.literal('trusted'),
  ...validation,
  candidate: CandidateReferenceSchema,
  promotionEventId: EventIdSchema,
});
export const LearnedLifecycleSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed') }),
  z.strictObject({ status: z.literal('validated'), ...validation }),
  TrustedLifecycleSchema,
  z.strictObject({
    status: z.literal('superseded'),
    supersededAt: TimestampSchema,
    replacement: LearnedItemReferenceSchema,
    eventId: EventIdSchema,
    lastValidatedAt: TimestampSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('revoked'),
    revokedAt: TimestampSchema,
    reason: NonEmptyTextSchema,
    eventId: EventIdSchema,
    fallback: LearnedItemReferenceSchema.optional(),
    lastValidatedAt: TimestampSchema.optional(),
  }),
]);
const durableShape = {
  kind: z.literal('durable_owner_state'),
  ...OwnerRecordShape,
  id: LearnedItemIdSchema,
  content: LearnedContentSchema,
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
  evidence: EvidenceSignalsSchema,
};
export const DurableOwnerStateSchema = z
  .strictObject({ ...durableShape, lifecycle: LearnedLifecycleSchema })
  .superRefine((v, ctx) => {
    if ('ownerId' in v.provenance && v.provenance.ownerId !== v.ownerId) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'Owner-origin state provenance must match the record owner',
      });
    }
    const confirmation = v.evidence.ownerConfirmation;
    if (
      'provenance' in confirmation &&
      confirmation.provenance.ownerId !== v.ownerId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'ownerConfirmation'],
        message: 'Owner confirmation must belong to the state owner',
      });
    }
    const lifecycle = v.lifecycle;
    const linked =
      lifecycle.status === 'superseded'
        ? lifecycle.replacement
        : lifecycle.status === 'revoked'
          ? lifecycle.fallback
          : undefined;
    if (
      linked?.learnedItemId === v.id &&
      linked.version === v.metadata.recordVersion
    )
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'An inactive version cannot replace or restore itself',
      });
  });
export const TrustedOwnerStateSchema = DurableOwnerStateSchema.safeExtend({
  lifecycle: TrustedLifecycleSchema,
});
export const ActiveTaskStateSchema = z
  .strictObject({
    kind: z.literal('active_task_state'),
    ...OwnerRecordShape,
    id: LearnedItemIdSchema,
    task: TaskBindingSchema,
    objective: NonEmptyTextSchema,
    openLoops: z.array(NonEmptyTextSchema),
    sourceEvidence: z.array(EvidenceReferenceSchema).min(1),
    provenance: ProvenanceSchema,
    lifecycle: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('active') }),
      z.strictObject({
        status: z.literal('closed'),
        closedAt: TimestampSchema,
        outcome: z.enum(['completed', 'cancelled']),
      }),
    ]),
  })
  .refine(
    (v) => !('ownerId' in v.provenance) || v.provenance.ownerId === v.ownerId,
    'Owner-origin task state must match the record owner',
  );
export const OwnerStateSchema = z.discriminatedUnion('kind', [
  DurableOwnerStateSchema,
  ActiveTaskStateSchema,
]);
export type LearnedContent = z.infer<typeof LearnedContentSchema>;
export type DurableOwnerState = z.infer<typeof DurableOwnerStateSchema>;
export type TrustedOwnerState = z.infer<typeof TrustedOwnerStateSchema>;
export type ActiveTaskState = z.infer<typeof ActiveTaskStateSchema>;
export type OwnerState = z.infer<typeof OwnerStateSchema>;
