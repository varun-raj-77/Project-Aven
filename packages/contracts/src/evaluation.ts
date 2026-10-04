import { z } from 'zod';
import {
  CandidateReferenceSchema,
  EvidenceReferenceSchema,
  ImmutableArtifactReferenceSchema,
  LearnedItemReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { EvaluationIdSchema, EvaluationTestIdSchema } from './ids.ts';
import {
  ExternalContentProvenanceSchema,
  ModelInferenceProvenanceSchema,
  OwnerStatementProvenanceSchema,
  SystemGeneratedProvenanceSchema,
} from './provenance.ts';
import { ModelConfigurationSchema } from './runtime.ts';
import { PolicyOutcomeSchema } from './policy.ts';
import { ScopeSchema } from './scope.ts';

export const EvaluationOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('response'), text: NonEmptyTextSchema }),
  z.strictObject({ kind: z.literal('policy'), decision: PolicyOutcomeSchema }),
  z.strictObject({
    kind: z.literal('scope_application'),
    applied: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('artifact'),
    artifact: ImmutableArtifactReferenceSchema,
  }),
]);
export const EvaluationOracleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('owner_supplied'),
    expected: EvaluationOutcomeSchema,
    provenance: OwnerStatementProvenanceSchema,
    evidence: EvidenceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('deterministic'),
    expected: EvaluationOutcomeSchema,
    specification: ImmutableArtifactReferenceSchema,
    provenance: SystemGeneratedProvenanceSchema,
  }),
  z.strictObject({
    kind: z.literal('externally_verified'),
    expected: EvaluationOutcomeSchema,
    provenance: ExternalContentProvenanceSchema,
    verificationEvidence: z.array(EvidenceReferenceSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal('evaluator_model_judgment'),
    expected: EvaluationOutcomeSchema,
    provenance: ModelInferenceProvenanceSchema,
    authority: z.literal('advisory'),
  }),
  z.strictObject({ kind: z.literal('unresolved'), reason: NonEmptyTextSchema }),
]);
export const EvaluationTestDefinitionSchema = z
  .strictObject({
    kind: z.literal('evaluation_test'),
    ...OwnerRecordShape,
    id: EvaluationTestIdSchema,
    testType: z.enum([
      'historical_replay',
      'counterexample',
      'held_out',
      'scope_application',
      'scope_non_application',
      'permission',
      'regression',
    ]),
    split: z.enum(['development', 'promotion_eval', 'final_held_out']),
    scenarioGroup: NonEmptyTextSchema,
    input: ImmutableArtifactReferenceSchema,
    scope: ScopeSchema,
    oracle: EvaluationOracleSchema,
  })
  .superRefine((v, ctx) => {
    const oracle = v.oracle;
    if (
      oracle.kind === 'owner_supplied' &&
      (oracle.provenance.ownerId !== v.ownerId ||
        oracle.provenance.sourceEventId !== oracle.evidence.eventId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['oracle'],
        message:
          'Owner-supplied oracle must match the test owner and cited source event',
      });
    }
  })
  .refine(
    (v) => v.testType !== 'held_out' || v.split !== 'development',
    'Held-out tests must identify a promotion or final held-out split',
  );
export const ScorerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('deterministic'),
    identifier: NonEmptyTextSchema,
    version: NonEmptyTextSchema,
    specification: ImmutableArtifactReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('human'),
    evaluatorId: NonEmptyTextSchema,
    rubric: ImmutableArtifactReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('model'),
    model: ModelConfigurationSchema,
    rubric: ImmutableArtifactReferenceSchema,
  }),
]);
export const EvaluationResultSchema = z
  .strictObject({
    kind: z.literal('evaluation_result'),
    ...OwnerRecordShape,
    id: EvaluationIdSchema,
    test: EvaluationTestDefinitionSchema,
    subject: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('candidate'),
        reference: CandidateReferenceSchema,
      }),
      z.strictObject({
        kind: z.literal('trusted_state'),
        reference: LearnedItemReferenceSchema,
      }),
      z.strictObject({
        kind: z.literal('baseline'),
        arm: z.enum(['A', 'B']),
        configuration: ImmutableArtifactReferenceSchema,
      }),
    ]),
    subjectModel: ModelConfigurationSchema,
    actual: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('observed'),
        outcome: EvaluationOutcomeSchema,
        evidence: z.array(EvidenceReferenceSchema).min(1),
      }),
      z.strictObject({
        status: z.literal('unavailable'),
        reason: NonEmptyTextSchema,
      }),
    ]),
    scorer: ScorerSchema,
    independence: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('unassessed') }),
      z.strictObject({
        status: z.literal('assessed'),
        relationship: z.enum([
          'independent',
          'same_generator',
          'partially_independent',
        ]),
        evidence: EvidenceReferenceSchema,
      }),
    ]),
    verdict: z.enum(['PASS', 'FAIL', 'INDETERMINATE']),
    conclusionBasis: z.literal('relative_to_declared_oracle'),
    scoredAt: TimestampSchema,
  })
  .superRefine((v, ctx) => {
    if (v.test.ownerId !== v.ownerId)
      ctx.addIssue({
        code: 'custom',
        path: ['test', 'ownerId'],
        message: 'Evaluation and test must have the same owner',
      });
    if (
      (v.test.oracle.kind === 'unresolved' ||
        v.actual.status === 'unavailable') &&
      v.verdict !== 'INDETERMINATE'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message:
          'Unresolved oracle or missing observation requires an indeterminate verdict',
      });
  });
export type EvaluationTestDefinition = z.infer<
  typeof EvaluationTestDefinitionSchema
>;
export type EvaluationOracle = z.infer<typeof EvaluationOracleSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
