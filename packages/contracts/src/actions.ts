import { z } from 'zod';
import {
  DigestSchema,
  ImmutableArtifactReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  RecordVersionSchema,
  TaskBindingSchema,
} from './common.ts';
import { ActionProposalIdSchema, ApprovalIdSchema } from './ids.ts';

export const ProposalBindingSchema = z.strictObject({
  proposalId: ActionProposalIdSchema,
  proposalVersion: RecordVersionSchema,
  proposalDigest: DigestSchema,
  parametersDigest: DigestSchema,
});
export const ResourceTargetSchema = z.strictObject({
  kind: z.enum([
    'document',
    'file',
    'message',
    'sandbox_resource',
    'learned_state',
  ]),
  identifier: NonEmptyTextSchema,
});
export const RequestedAuthoritySchema = z.strictObject({
  operation: z.enum([
    'read',
    'draft',
    'create',
    'modify',
    'delete',
    'send',
    'publish',
    'promote_learning',
    'revoke_learning',
    'rollback_learning',
  ]),
  resource: ResourceTargetSchema,
});
export const ActionProposalSchema = z.strictObject({
  kind: z.literal('action_proposal'),
  ...OwnerRecordShape,
  id: ActionProposalIdSchema,
  task: TaskBindingSchema,
  toolId: NonEmptyTextSchema,
  action: NonEmptyTextSchema,
  parameters: z.strictObject({
    kind: z.literal('immutable_reference'),
    artifact: ImmutableArtifactReferenceSchema,
  }),
  target: ResourceTargetSchema,
  consequences: z.strictObject({
    risk: z.enum(['low', 'medium', 'high', 'unknown']),
    reversibility: z.enum([
      'reversible',
      'partially_reversible',
      'irreversible',
      'unknown',
    ]),
    description: NonEmptyTextSchema,
  }),
  requestedAuthority: z.array(RequestedAuthoritySchema).min(1),
  priorApprovalIds: z.array(ApprovalIdSchema),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export type ProposalBinding = z.infer<typeof ProposalBindingSchema>;
