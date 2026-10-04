import { z } from 'zod';
import {
  NonEmptyTextSchema,
  OwnerRecordShape,
  TaskBindingSchema,
  TimestampSchema,
} from './common.ts';
import { ModelCallIdSchema } from './ids.ts';

export const ModelConfigurationSchema = z.strictObject({
  providerId: NonEmptyTextSchema,
  modelId: NonEmptyTextSchema,
  modelVersion: NonEmptyTextSchema,
  configurationId: NonEmptyTextSchema,
});
export const ModelRequestMetadataSchema = z.strictObject({
  kind: z.literal('model_request_metadata'),
  ...OwnerRecordShape,
  callId: ModelCallIdSchema,
  task: TaskBindingSchema,
  model: ModelConfigurationSchema,
  purpose: z.enum([
    'response',
    'intent_interpretation',
    'candidate_generation',
    'evaluation',
    'context_selection',
  ]),
  requestedAt: TimestampSchema,
});
export const UsageSchema = z
  .strictObject({
    // Token counts are provider-reported quantities, not comparable measures of quality.
    inputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    outputTokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    elapsedMilliseconds: z.number().nonnegative().finite().optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Omit usage if unavailable',
  );
export const ModelResponseMetadataSchema = z.strictObject({
  kind: z.literal('model_response_metadata'),
  ...OwnerRecordShape,
  callId: ModelCallIdSchema,
  model: ModelConfigurationSchema,
  completedAt: TimestampSchema,
  status: z.enum(['completed', 'failed', 'cancelled']),
  usage: UsageSchema.optional(),
});
export type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>;
export type ModelRequestMetadata = z.infer<typeof ModelRequestMetadataSchema>;
export type ModelResponseMetadata = z.infer<typeof ModelResponseMetadataSchema>;
