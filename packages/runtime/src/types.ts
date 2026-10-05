import { z } from 'zod';
import {
  ModelConfigurationSchema,
  NonEmptyTextSchema,
  RuntimeStampSchema,
  UsageSchema,
} from '@aven/contracts';

/**
 * One already-assembled model input message. `role` is the message's position
 * in the model conversation, not its provenance or authority: a `user` message
 * is not owner evidence and a `system` message grants nothing. Assembling input
 * (retrieval, ranking, personalization) belongs to later callers, not here.
 */
export const ModelInputMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant']),
  content: NonEmptyTextSchema,
});

export const MAX_MODEL_INPUT_MESSAGES = 1000;

/**
 * The stable provider-neutral request. It carries only model input. It has no
 * owner, session, task, permission, approval, Root, tool or learned-state field
 * and rejects unknown keys. Generation parameters are deliberately absent: they
 * belong to the runtime's configuration so that the reported `configurationId`
 * stays truthful for every invocation.
 */
export const ModelRuntimeRequestSchema = z.strictObject({
  messages: z
    .array(ModelInputMessageSchema)
    .min(1)
    .max(MAX_MODEL_INPUT_MESSAGES),
});

/**
 * Identity strings are short opaque identifiers. The secret-like pattern is a
 * regression tripwire against putting a credential where an identifier belongs;
 * it is not a secret scanner and not a security guarantee.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SECRET_LIKE =
  /api[-_]?key|secret|passw(?:or)?d|bearer|authori[sz]ation|credential|(?:^|[._:/@+-])sk-/i;
export function isReportableIdentifier(value: string): boolean {
  return IDENTIFIER.test(value) && !SECRET_LIKE.test(value);
}
function identifiersOnly(value: Record<string, string>, ctx: z.RefinementCtx) {
  for (const [key, text] of Object.entries(value))
    if (!isReportableIdentifier(text))
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'Runtime identity must be a short non-secret identifier',
      });
}

/** Frozen AVEN-002 `RuntimeStamp`, restricted to identifier-shaped values. */
export const ReportedRuntimeSchema =
  RuntimeStampSchema.superRefine(identifiersOnly);
/** Frozen AVEN-002 `ModelConfiguration`, restricted to identifier-shaped values. */
export const ReportedModelSchema =
  ModelConfigurationSchema.superRefine(identifiersOnly);

/**
 * What a runtime implementation returns for a successful invocation. Strict:
 * provider-specific fields (raw responses, headers, reasoning traces, tool
 * calls, credentials) are rejected rather than passed through. `runtime` and
 * `model` are declared by the implementation's configuration; Aven records
 * them as reported claims, not verified facts. `finishReason` and `usage` are
 * optional and must be omitted when the provider does not supply them.
 */
export const ModelRuntimeOutputSchema = z.strictObject({
  text: NonEmptyTextSchema,
  runtime: ReportedRuntimeSchema,
  model: ReportedModelSchema,
  finishReason: z
    .enum(['complete', 'output_limit', 'content_filter', 'other'])
    .optional(),
  usage: UsageSchema.optional(),
});

export type ModelInputMessage = z.infer<typeof ModelInputMessageSchema>;
export type ModelRuntimeRequest = z.infer<typeof ModelRuntimeRequestSchema>;
export type ModelRuntimeOutput = z.infer<typeof ModelRuntimeOutputSchema>;
export type FinishReason = NonNullable<ModelRuntimeOutput['finishReason']>;

/** A validated, normalized, immutable successful invocation result. */
export type ModelRuntimeResult = Readonly<
  { status: 'completed' } & ModelRuntimeOutput
>;

export interface ModelRuntimeInvocation {
  /** Aborted on caller cancellation or timeout; implementations should stop work. */
  readonly signal: AbortSignal;
}

/**
 * The Aven-owned, replaceable model runtime boundary. An implementation
 * generates text from already-assembled input. It owns no storage, Ledger,
 * owner state, Root, permissions or tools; its output is data, never authority.
 * Provider-specific request and response shapes stay inside the implementation.
 */
export interface ModelRuntime {
  invoke(
    request: ModelRuntimeRequest,
    invocation: ModelRuntimeInvocation,
  ): Promise<ModelRuntimeOutput>;
}
