import { z } from 'zod';
import {
  EvidenceReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TaskBindingSchema,
  TimestampSchema,
} from './common.ts';
import { ApprovalIdSchema, EventIdSchema } from './ids.ts';
import { ProposalBindingSchema } from './actions.ts';
import { OwnerApprovalProvenanceSchema } from './provenance.ts';

export const OwnerApprovalSchema = z
  .strictObject({
    kind: z.literal('owner_approval'),
    ...OwnerRecordShape,
    id: ApprovalIdSchema,
    proposal: ProposalBindingSchema,
    bounds: TaskBindingSchema,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    evidence: EvidenceReferenceSchema,
    provenance: OwnerApprovalProvenanceSchema,
    lifecycle: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('issued') }),
      z.strictObject({
        status: z.literal('revoked'),
        revokedAt: TimestampSchema,
        revocationEventId: EventIdSchema,
        reason: NonEmptyTextSchema,
      }),
    ]),
  })
  .superRefine((v, ctx) => {
    if (Date.parse(v.expiresAt) <= Date.parse(v.issuedAt))
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Expiry must follow issuance',
      });
    if (
      v.lifecycle.status === 'revoked' &&
      Date.parse(v.lifecycle.revokedAt) < Date.parse(v.issuedAt)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle'],
        message: 'Revocation cannot precede issuance',
      });
    if (
      v.ownerId !== v.provenance.ownerId ||
      v.evidence.eventId !== v.provenance.sourceEventId
    )
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'Approval owner and source event must match its evidence',
      });
  });
export type OwnerApproval = z.infer<typeof OwnerApprovalSchema>;
