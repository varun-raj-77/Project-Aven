import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { ExecutionIdSchema, VerificationIdSchema } from './ids.ts';
import {
  OwnerStatementProvenanceSchema,
  SystemGeneratedProvenanceSchema,
  ToolResultProvenanceSchema,
} from './provenance.ts';
import { ModelConfigurationSchema } from './runtime.ts';

export const ObservableVerificationEvidenceSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('state_observation'),
      reference: EvidenceReferenceSchema,
      provenance: ToolResultProvenanceSchema,
      observation: NonEmptyTextSchema,
    }),
    z.strictObject({
      kind: z.literal('deterministic_check'),
      reference: EvidenceReferenceSchema,
      provenance: SystemGeneratedProvenanceSchema,
      checkId: NonEmptyTextSchema,
      checkVersion: NonEmptyTextSchema,
    }),
    z.strictObject({
      kind: z.literal('owner_confirmation'),
      reference: EvidenceReferenceSchema,
      provenance: OwnerStatementProvenanceSchema,
    }),
  ],
);
export const VerificationMethodSchema = z.strictObject({
  kind: z.enum([
    'state_comparison',
    'deterministic_assertion',
    'owner_confirmation',
  ]),
  identifier: NonEmptyTextSchema,
  version: NonEmptyTextSchema,
});
const verification = {
  kind: z.literal('verification_result'),
  ...OwnerRecordShape,
  id: VerificationIdSchema,
  executionId: ExecutionIdSchema,
  verifiedAt: TimestampSchema,
};
export const VerificationResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...verification,
      status: z.literal('VERIFIED'),
      method: VerificationMethodSchema,
      evidence: z.array(ObservableVerificationEvidenceSchema).min(1),
    }),
    z.strictObject({
      ...verification,
      status: z.literal('FAILED'),
      method: VerificationMethodSchema,
      evidence: z.array(ObservableVerificationEvidenceSchema).min(1),
      failure: NonEmptyTextSchema,
    }),
    z.strictObject({
      ...verification,
      status: z.literal('INCONCLUSIVE'),
      method: z.union([
        VerificationMethodSchema,
        z.strictObject({
          kind: z.literal('model_assessment'),
          model: ModelConfigurationSchema,
        }),
      ]),
      evidence: z.array(ObservableVerificationEvidenceSchema),
      reason: NonEmptyTextSchema,
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.status === 'VERIFIED') {
      const required = {
        state_comparison: 'state_observation',
        deterministic_assertion: 'deterministic_check',
        owner_confirmation: 'owner_confirmation',
      } as const;
      if (!v.evidence.some((e) => e.kind === required[v.method.kind]))
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: 'Successful verification needs evidence matching its method',
        });
    }
    for (const e of v.evidence) {
      if (
        e.kind === 'owner_confirmation' &&
        (e.provenance.ownerId !== v.ownerId ||
          e.provenance.sourceEventId !== e.reference.eventId)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message:
            'Owner verification evidence must match the owner and source event',
        });
    }
  });
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
