import { z } from 'zod';
import {
  DigestSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { ApprovalIdSchema, PolicyDecisionIdSchema } from './ids.ts';
import { ProposalBindingSchema } from './actions.ts';

export const PolicyOutcomeSchema = z.enum([
  'ALLOW',
  'DENY',
  'REQUIRE_OWNER_APPROVAL',
]);
export const PolicyDecisionReferenceSchema = z.strictObject({
  decisionId: PolicyDecisionIdSchema,
  proposal: ProposalBindingSchema,
  decision: PolicyOutcomeSchema,
});
export const AllowDecisionReferenceSchema =
  PolicyDecisionReferenceSchema.extend({ decision: z.literal('ALLOW') });
const decision = {
  kind: z.literal('policy_decision'),
  ...OwnerRecordShape,
  id: PolicyDecisionIdSchema,
  proposal: ProposalBindingSchema,
  evaluatedAt: TimestampSchema,
  issuer: z.strictObject({
    kind: z.literal('root'),
    policyVersion: NonEmptyTextSchema,
    policyDigest: DigestSchema,
  }),
  reasonCodes: z.array(NonEmptyTextSchema).min(1),
};
export const PolicyDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...decision,
    decision: z.literal('ALLOW'),
    basis: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('existing_grant'),
        grantReference: NonEmptyTextSchema,
      }),
      z.strictObject({
        kind: z.literal('owner_approval'),
        approvalIds: z.array(ApprovalIdSchema).min(1),
      }),
    ]),
  }),
  z.strictObject({ ...decision, decision: z.literal('DENY') }),
  z.strictObject({
    ...decision,
    decision: z.literal('REQUIRE_OWNER_APPROVAL'),
    approvalRequirement: NonEmptyTextSchema,
  }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
