import { z } from 'zod';
import {
  ImmutableArtifactReferenceSchema,
  NonEmptyTextSchema,
  OwnerRecordShape,
  TimestampSchema,
} from './common.ts';
import { ExecutionIdSchema } from './ids.ts';
import { PolicyDecisionReferenceSchema } from './policy.ts';

export const ExecutionFailureSchema = z.strictObject({
  code: NonEmptyTextSchema,
  message: NonEmptyTextSchema,
  retryability: z.enum(['retryable', 'not_retryable', 'unknown']),
});
export const ToolOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('succeeded'),
    returned: ImmutableArtifactReferenceSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    error: ExecutionFailureSchema,
    partialOutput: ImmutableArtifactReferenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('unknown'),
    reason: NonEmptyTextSchema,
    partialOutput: ImmutableArtifactReferenceSchema.optional(),
  }),
]);
const execution = {
  kind: z.literal('execution_result'),
  ...OwnerRecordShape,
  id: ExecutionIdSchema,
  policy: PolicyDecisionReferenceSchema,
  toolId: NonEmptyTextSchema,
};
export const ExecutionResultSchema = z.discriminatedUnion('attempted', [
  z.strictObject({
    ...execution,
    attempted: z.literal(false),
    recordedAt: TimestampSchema,
    reason: z.enum([
      'policy_denied',
      'approval_required',
      'cancelled',
      'precondition_failed',
    ]),
    detail: NonEmptyTextSchema,
  }),
  z
    .strictObject({
      ...execution,
      attempted: z.literal(true),
      startedAt: TimestampSchema,
      endedAt: TimestampSchema,
      outcome: ToolOutcomeSchema,
    })
    .refine(
      (v) => Date.parse(v.endedAt) >= Date.parse(v.startedAt),
      'Execution cannot end before it starts',
    ),
]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
