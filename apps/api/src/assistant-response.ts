import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  EventIdSchema,
  EvidenceIdSchema,
  EvidenceReferenceSchema,
  ModelCallIdSchema,
  ModelInferenceProvenanceSchema,
  ModelResponseMetadataSchema,
  OwnerIdSchema,
  SessionIdSchema,
  TaskBindingSchema,
  TaskIdSchema,
  type EventId,
  type EvidenceId,
  type ModelConfiguration,
  type ModelResponseMetadata,
  type OwnerId,
  type SessionId,
  type TaskId,
} from '@aven/contracts';
import {
  createLedger,
  type EventInput,
  type EvidenceInput,
} from '@aven/ledger';
import {
  invokeModelRuntime,
  InvokeOptionsSchema,
  isModelRuntimeErrorCode,
  ModelRuntimeError,
  ModelRuntimeRequestSchema,
  type FinishReason,
  type ModelRuntime,
  type ModelRuntimeErrorCode,
  type ModelRuntimeResult,
} from '@aven/runtime';
import type { Storage } from '@aven/storage';
import { ApiError } from './errors.ts';
import { createIdentityStore } from './identity-store.ts';

/**
 * AVEN-006 separate in-process path for successful model output.
 *
 * It is NOT reachable over HTTP and never touches the AVEN-005 owner-message
 * path: it records only `assistant_response` events with `model_inference`
 * provenance. `metadata.creation.component` differs from the owner channel's
 * `@aven/api` marker so the two origins stay distinguishable in history.
 */
export const ASSISTANT_RESPONSE_COMPONENT = '@aven/api/assistant-response';
export const ASSISTANT_RESPONSE_VERSION = '0.1.0';
export const MAX_DERIVED_FROM = 1000;

export type ResponseIdPrefix = 'event' | 'evidence' | 'modelcall';
export interface AssistantResponseServiceOptions {
  /** The injected, replaceable runtime. Selection is explicit; there is no router. */
  readonly runtime: ModelRuntime;
  /** Clock for request/occurrence times. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Identifier suffix allocation. Defaults to random UUIDs. Output is revalidated. */
  readonly generateId?: (prefix: ResponseIdPrefix) => string;
}

/**
 * `stage` says how far the attempt got; `recorded` is always false on failure.
 * - validation: nothing was invoked and nothing was written.
 * - invocation: the runtime was (or may have been) invoked; nothing was written.
 * - recording: output was generated and accepted, but it was NOT durably
 *   recorded. It must not be presented as a recorded response.
 */
export type AssistantResponseStage = 'validation' | 'invocation' | 'recording';
export type AssistantResponseErrorCode =
  ModelRuntimeErrorCode | 'binding_not_found' | 'recording_failure';

const messages: Record<AssistantResponseErrorCode, string> = {
  invalid_request: 'The response request is malformed',
  binding_not_found: 'The owner, session or task does not exist',
  runtime_unavailable: 'The model runtime is unavailable; nothing was recorded',
  runtime_timeout: 'The model runtime timed out; nothing was recorded',
  runtime_aborted: 'The model invocation was cancelled; nothing was recorded',
  runtime_failure: 'The model runtime failed; nothing was recorded',
  malformed_runtime_result:
    'The model runtime returned a malformed result; nothing was recorded',
  recording_failure:
    'The response could not be durably recorded; it was not acknowledged',
};

export class AssistantResponseError extends Error {
  readonly code: AssistantResponseErrorCode;
  readonly stage: AssistantResponseStage;
  readonly recorded = false as const;
  constructor(
    code: AssistantResponseErrorCode,
    stage: AssistantResponseStage,
    cause?: unknown,
  ) {
    super(messages[code], { cause });
    this.name = 'AssistantResponseError';
    this.code = code;
    this.stage = stage;
  }
}

/** Returned only after the Ledger append has committed. */
export interface AssistantResponseReceipt {
  readonly recorded: true;
  readonly ownerId: OwnerId;
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly eventId: EventId;
  readonly evidenceId: EvidenceId;
  readonly eventType: 'assistant_response';
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  /** Model output: data, never owner input, permission or learned state. */
  readonly text: string;
  readonly runtime: { readonly identifier: string; readonly version: string };
  readonly model: ModelConfiguration;
  readonly finishReason: FinishReason | null;
  /** Not persisted (no frozen field); observability for this call only. */
  readonly requestedAt: string;
  /** Frozen AVEN-002 response metadata; not persisted in AVEN-006. */
  readonly response: ModelResponseMetadata;
}

const GenerateInputSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  /** Already-assembled model input. This path performs no retrieval. */
  request: ModelRuntimeRequestSchema,
  /** Recorded evidence the caller declares the input was derived from. */
  derivedFrom: z
    .array(EvidenceReferenceSchema)
    .max(MAX_DERIVED_FROM)
    .refine(
      (refs) => new Set(refs.map((r) => r.evidenceId)).size === refs.length,
      'Duplicate lineage reference',
    ),
  sourceCoverage: ModelInferenceProvenanceSchema.shape.sourceCoverage,
});
export type GenerateResponseInput = z.input<typeof GenerateInputSchema>;
export type GenerateResponseOptions = z.input<typeof InvokeOptionsSchema>;

const NOT_FOUND = new Set([
  'owner_not_found',
  'session_not_found',
  'task_not_found',
]);

/**
 * Invokes the injected runtime and records successful output.
 *
 * Order: validate input → verify owner/session/task and lineage (read-only) →
 * invoke → accept a strictly validated result → append exactly one
 * `assistant_response` (+ one evidence record) through the Ledger.
 * Failed, cancelled, timed-out or malformed invocations write nothing. Model
 * invocation is not transactional with SQLite: if the append fails after a
 * successful invocation the call fails with `recording_failure` and the output
 * is not acknowledged. No retry, idempotency or exactly-once invocation.
 */
export function createAssistantResponseService(
  storage: Storage,
  options: AssistantResponseServiceOptions,
) {
  const { runtime } = options;
  const now = options.now ?? (() => new Date());
  const generate =
    options.generateId ??
    ((prefix: ResponseIdPrefix) => `${prefix}_${randomUUID()}`);
  const identities = createIdentityStore(storage);

  function timestamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime()))
      throw new Error('Invalid clock value');
    return value.toISOString();
  }
  function allocate<S extends z.ZodType>(
    prefix: ResponseIdPrefix,
    schema: S,
  ): z.output<S> {
    return schema.parse(generate(prefix));
  }
  function fail(
    code: AssistantResponseErrorCode,
    stage: AssistantResponseStage,
    cause?: unknown,
  ): never {
    throw new AssistantResponseError(code, stage, cause);
  }

  async function generateResponse(
    input: unknown,
    invokeOptions: unknown = {},
  ): Promise<AssistantResponseReceipt> {
    // Validation: nothing is invoked or written on any failure here.
    const parsed = GenerateInputSchema.safeParse(input);
    if (!parsed.success) fail('invalid_request', 'validation', parsed.error);
    const settings = InvokeOptionsSchema.safeParse(invokeOptions);
    if (!settings.success)
      fail('invalid_request', 'validation', settings.error);
    const { ownerId, sessionId, taskId, request, derivedFrom, sourceCoverage } =
      parsed.data;
    let requestedAt: string;
    try {
      identities.requireTask(ownerId, sessionId, taskId);
      // Read-only lineage pre-check; the Ledger re-verifies every reference at append.
      const history = createLedger(storage, ownerId);
      for (const ref of derivedFrom) {
        const source = history.getEvent(ref.eventId);
        if (!source?.evidence.some((e) => e.id === ref.evidenceId))
          fail('invalid_request', 'validation');
      }
      requestedAt = timestamp();
    } catch (error) {
      if (error instanceof AssistantResponseError) throw error;
      if (error instanceof ApiError && NOT_FOUND.has(error.code))
        fail('binding_not_found', 'validation', error);
      // Storage/clock unavailable before invocation: nothing generated or written.
      fail('recording_failure', 'validation', error);
    }

    // Invocation: the runtime generates; it receives no storage or Ledger.
    let result: ModelRuntimeResult;
    try {
      result = await invokeModelRuntime(runtime, request, settings.data);
    } catch (error) {
      fail(
        error instanceof ModelRuntimeError &&
          isModelRuntimeErrorCode(error.code)
          ? error.code
          : 'runtime_failure',
        'invocation',
        error,
      );
    }
    const signal = settings.data.signal;
    if (signal?.aborted)
      fail('runtime_aborted', 'invocation', signal.reason as unknown);

    // Recording: synchronous from here, so cancellation cannot interleave.
    try {
      const eventId = allocate('event', EventIdSchema);
      const evidenceId = allocate('evidence', EvidenceIdSchema);
      const callId = allocate('modelcall', ModelCallIdSchema);
      const occurredAt = timestamp();
      const task = TaskBindingSchema.parse({ sessionId, taskId });
      const reportedRuntime = {
        identifier: result.runtime.identifier,
        version: result.runtime.version,
      };
      const model = { ...result.model };
      const metadata = {
        schemaVersion: 1 as const,
        recordVersion: 1 as const,
        createdAt: occurredAt,
        creation: {
          component: ASSISTANT_RESPONSE_COMPONENT,
          version: ASSISTANT_RESPONSE_VERSION,
          runtime: reportedRuntime,
        },
      };
      // Model-generated output. Owner input that informed it is lineage
      // (`derivedFrom`), never a reason to claim owner-statement provenance.
      const provenance = {
        kind: 'model_inference' as const,
        model,
        derivedFrom: derivedFrom.map((r) => ({
          evidenceId: r.evidenceId,
          eventId: r.eventId,
        })),
        sourceCoverage,
      };
      const event: EventInput = {
        kind: 'experience_event',
        ownerId,
        metadata,
        id: eventId,
        occurredAt,
        task,
        evidenceIds: [evidenceId],
        eventType: 'assistant_response',
        // No citation extraction: the model's text is not parsed for claims.
        payload: { response: result.text, task, citedEvidence: [] },
        provenance,
      };
      const evidence: EvidenceInput = {
        kind: 'recorded_evidence',
        ownerId,
        metadata,
        id: evidenceId,
        eventId,
        provenance,
        content: { kind: 'recorded_text', text: result.text },
      };
      // Built and validated before the append so nothing can fail after COMMIT.
      const response = ModelResponseMetadataSchema.parse({
        kind: 'model_response_metadata',
        ownerId,
        metadata,
        callId,
        model,
        completedAt: occurredAt,
        status: 'completed',
        ...(result.usage ? { usage: result.usage } : {}),
      });
      const stored = createLedger(storage, ownerId).appendEvent(event, {
        evidence: [evidence],
      });
      return Object.freeze({
        recorded: true as const,
        ownerId,
        sessionId,
        taskId,
        eventId,
        evidenceId,
        eventType: 'assistant_response' as const,
        sequence: stored.sequence,
        occurredAt: stored.event.occurredAt,
        recordedAt: stored.event.recordedAt,
        text: result.text,
        runtime: reportedRuntime,
        model,
        finishReason: result.finishReason ?? null,
        requestedAt,
        response,
      });
    } catch (error) {
      fail('recording_failure', 'recording', error);
    }
  }

  return Object.freeze({ generateResponse });
}
export type AssistantResponseService = ReturnType<
  typeof createAssistantResponseService
>;
