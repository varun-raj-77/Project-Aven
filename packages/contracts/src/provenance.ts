import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  ImmutableArtifactReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  RecordMetadataSchema,
  TimestampSchema,
} from './common.ts';
import { EvidenceIdSchema, EventIdSchema, OwnerIdSchema } from './ids.ts';
import { ModelConfigurationSchema } from './runtime.ts';

const ownerOrigin = { ownerId: OwnerIdSchema, sourceEventId: EventIdSchema };
export const OwnerStatementProvenanceSchema = z.strictObject({
  kind: z.literal('explicit_owner_statement'),
  ...ownerOrigin,
});
export const OwnerCorrectionProvenanceSchema = z.strictObject({
  kind: z.literal('explicit_owner_correction'),
  ...ownerOrigin,
});
export const OwnerApprovalProvenanceSchema = z.strictObject({
  kind: z.literal('owner_approval'),
  ...ownerOrigin,
});
export const ModelInferenceProvenanceSchema = z.strictObject({
  kind: z.literal('model_inference'),
  model: ModelConfigurationSchema,
  derivedFrom: z.array(EvidenceReferenceSchema),
  // Empty lineage is explicit lack of sources, never independent corroboration.
  sourceCoverage: z.enum(['complete', 'partial', 'unknown']),
});
export const ToolResultProvenanceSchema = z.strictObject({
  kind: z.literal('tool_result'),
  toolId: NonEmptyTextSchema,
  sourceEventId: EventIdSchema,
  trust: z.literal('potentially_untrusted'),
});
export const ExternalContentProvenanceSchema = z.strictObject({
  kind: z.literal('external_content'),
  source: NonEmptyTextSchema,
  capturedAt: TimestampSchema,
  trust: z.literal('untrusted'),
});
export const SystemGeneratedProvenanceSchema = z.strictObject({
  kind: z.literal('system_generated'),
  component: NonEmptyTextSchema,
  version: NonEmptyTextSchema,
  derivedFrom: z.array(EvidenceReferenceSchema),
});
export const ProvenanceSchema = z.discriminatedUnion('kind', [
  OwnerStatementProvenanceSchema,
  OwnerCorrectionProvenanceSchema,
  OwnerApprovalProvenanceSchema,
  ModelInferenceProvenanceSchema,
  ToolResultProvenanceSchema,
  ExternalContentProvenanceSchema,
  SystemGeneratedProvenanceSchema,
]);

export const EvidenceRecordSchema = z
  .strictObject({
    kind: z.literal('recorded_evidence'),
    ...OwnerRecordShape,
    metadata: RecordMetadataSchema.extend({ recordVersion: z.literal(1) }),
    id: EvidenceIdSchema,
    eventId: EventIdSchema,
    recordedAt: TimestampSchema,
    provenance: ProvenanceSchema,
    content: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('recorded_text'),
        text: NonEmptyTextSchema,
      }),
      z.strictObject({
        kind: z.literal('artifact'),
        artifact: ImmutableArtifactReferenceSchema,
      }),
    ]),
  })
  .superRefine((v, ctx) => {
    if (
      'ownerId' in v.provenance &&
      (v.provenance.ownerId !== v.ownerId ||
        v.provenance.sourceEventId !== v.eventId)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'Owner evidence must match its source event and owner',
      });
    if (
      'derivedFrom' in v.provenance &&
      v.provenance.derivedFrom.some((ref) => ref.evidenceId === v.id)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'derivedFrom'],
        message: 'Evidence cannot derive from itself',
      });
  });
// These are assessments with citations, not probabilities or calculated truth scores.
export const EvidenceSignalsSchema = z
  .strictObject({
    support: z.enum(['unassessed', 'limited', 'corroborated', 'contested']),
    supportingEvidence: z.array(EvidenceReferenceSchema).min(1),
    counterexamples: z.array(EvidenceReferenceSchema),
    sourceIndependence: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unassessed') }),
      z.strictObject({
        status: z.literal('assessed'),
        rootSources: z.array(EvidenceReferenceSchema).min(1),
        assessmentEvidence: EvidenceReferenceSchema,
      }),
    ]),
    inferenceCertainty: z.enum([
      'not_applicable',
      'unassessed',
      'tentative',
      'supported',
      'disputed',
    ]),
    ownerConfirmation: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('not_requested') }),
      z.strictObject({ status: z.literal('pending') }),
      z.strictObject({
        status: z.literal('confirmed'),
        evidence: EvidenceReferenceSchema,
        provenance: OwnerStatementProvenanceSchema,
      }),
      z.strictObject({
        status: z.literal('disputed'),
        evidence: EvidenceReferenceSchema,
        provenance: OwnerCorrectionProvenanceSchema,
      }),
    ]),
  })
  .superRefine((v, ctx) => {
    const confirmation = v.ownerConfirmation;
    if (
      'evidence' in confirmation &&
      confirmation.evidence.eventId !== confirmation.provenance.sourceEventId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['ownerConfirmation'],
        message: 'Owner confirmation must cite its source event',
      });
    if (v.support === 'corroborated') {
      const sources = v.sourceIndependence;
      if (
        sources.status !== 'assessed' ||
        new Set(sources.rootSources.map((r) => r.evidenceId)).size < 2
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['support'],
          message:
            'Corroboration requires an explicit assessment of at least two distinct underlying sources',
        });
      }
    }
    if (v.support === 'contested' && v.counterexamples.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['counterexamples'],
        message: 'Contested support must cite counterevidence',
      });
    }
  });
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type EvidenceSignals = z.infer<typeof EvidenceSignalsSchema>;
