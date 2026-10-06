import type { ModelConfiguration, RuntimeStampSchema } from '@aven/contracts';
import {
  invokeModelRuntime,
  InvokeOptionsSchema,
  ModelRuntimeError,
  type FinishReason,
  type ModelInputMessage,
  type ModelRuntime,
  type ModelRuntimeErrorCode,
  type ModelRuntimeResult,
} from '@aven/runtime';
import type { z } from 'zod';
import {
  BASELINE_CONDITIONS,
  BASELINE_CONFIG_VERSION,
  type BaselineCondition,
} from './config.ts';
import { BaselineError } from './errors.ts';
import { selectHistoryContext } from './history-search.ts';
import { selectProfileContext } from './profile.ts';
import {
  assembleBaselineMessages,
  BASELINE_PROMPT_VERSION,
  type BaselineContextPayload,
} from './prompt.ts';
import { BaselineInputSchema, type BaselineInput } from './types.ts';

type RuntimeStamp = z.infer<typeof RuntimeStampSchema>;
type Usage = NonNullable<ModelRuntimeResult['usage']>;

/**
 * Inspectable record of the observable decisions behind one baseline run. It
 * contains only what the system chose and what the runtime reported; it never
 * contains hidden model reasoning (the AVEN-006 output contract rejects
 * reasoning fields). `runtimeStamp` and `modelConfiguration` are claims
 * reported by the runtime, not verified facts.
 */
export interface BaselineTrace {
  readonly condition: BaselineCondition;
  readonly ownerId: string;
  readonly caseId?: string;
  readonly baselineConfigVersion: string;
  readonly baselinePromptVersion: string;
  readonly profileEntryIdsIncluded: readonly string[];
  readonly profileEntryIdsOmittedForBudget: readonly string[];
  readonly retrievedHistoryEventIds: readonly string[];
  readonly historyScores: readonly {
    readonly eventId: string;
    readonly score: number;
  }[];
  readonly historyEventIdsOmittedForBudget: readonly string[];
  readonly historyEventIdsTruncated: readonly string[];
  readonly assembledMessages: readonly ModelInputMessage[];
  readonly status: 'completed' | 'failed';
  readonly responseText?: string;
  readonly finishReason?: FinishReason;
  readonly usage?: Usage;
  readonly runtimeStamp?: RuntimeStamp;
  readonly modelConfiguration?: ModelConfiguration;
  readonly errorCode?: ModelRuntimeErrorCode;
  readonly requestedAt?: string;
  readonly completedAt?: string;
}

export interface BaselineHarnessOptions {
  /** The one runtime both conditions use. Injected; never selected per condition. */
  readonly runtime: ModelRuntime;
  /** One timeout for every run of every condition. */
  readonly timeoutMs?: number;
  /** Optional clock for requested/completed timestamps; omitted when absent. */
  readonly clock?: () => Date;
}

export interface BaselineRunOptions {
  /** Per-run cancellation only; it does not change runtime or settings. */
  readonly signal?: AbortSignal;
  /** Dataset case identifier, carried into the trace only (never to the model). */
  readonly caseId?: string;
}

export interface BaselineHarness {
  run(
    condition: BaselineCondition,
    input: BaselineInput,
    options?: BaselineRunOptions,
  ): Promise<BaselineTrace>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

const EMPTY_SELECTION = {
  payload: { profile: [], history: [] } as BaselineContextPayload,
  profileOmitted: [] as readonly string[],
  scores: [] as readonly { eventId: string; score: number }[],
  historyOmitted: [] as readonly string[],
};

/**
 * Builds the personalization context. This is the ONLY place the two
 * conditions differ: A (fresh) gets empty profile and history; B
 * (naive_personalized) gets the budgeted editable profile plus the
 * deterministic lexical history search for the current request.
 */
function buildContext(condition: BaselineCondition, input: BaselineInput) {
  if (condition === 'fresh') return EMPTY_SELECTION;
  const profile = selectProfileContext(input.profile);
  const history = selectHistoryContext(
    input.ownerId,
    input.request,
    input.history,
  );
  return {
    payload: { profile: profile.included, history: history.items },
    profileOmitted: profile.omittedEntryIds,
    scores: history.scores,
    historyOmitted: history.omittedForBudgetEventIds,
  };
}

/**
 * Creates the A/B baseline harness. Runtime, timeout and clock are bound once
 * here, so both conditions receive the same injected runtime object, call path
 * (`invokeModelRuntime`), request shape (`{ messages }` only), timeout and
 * error semantics. That is all the harness controls. It cannot guarantee that
 * a custom or misbehaving runtime uses the same provider or model settings on
 * every call; real-model paired runs should compare the `runtimeStamp` and
 * `modelConfiguration` each trace reports. The harness is stateless: it
 * persists nothing, learns nothing and never edits a profile.
 */
export function createBaselineHarness(
  options: BaselineHarnessOptions,
): BaselineHarness {
  const { runtime, timeoutMs, clock } = options;
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.invoke !== 'function'
  )
    throw new BaselineError('invalid_harness_configuration');
  if (clock !== undefined && typeof clock !== 'function')
    throw new BaselineError('invalid_harness_configuration');
  const settings = InvokeOptionsSchema.safeParse(
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (!settings.success)
    throw new BaselineError('invalid_harness_configuration', settings.error);
  const now = () => (clock ? clock().toISOString() : undefined);

  async function run(
    condition: BaselineCondition,
    input: BaselineInput,
    runOptions: BaselineRunOptions = {},
  ): Promise<BaselineTrace> {
    if (!(BASELINE_CONDITIONS as readonly unknown[]).includes(condition))
      throw new BaselineError('invalid_input');
    const parsed = BaselineInputSchema.safeParse(input);
    if (!parsed.success) throw new BaselineError('invalid_input', parsed.error);
    const data = parsed.data;
    const context = buildContext(condition, data);
    const messages = assembleBaselineMessages(data.request, context.payload);

    const base = {
      condition,
      ownerId: data.ownerId,
      ...(runOptions.caseId === undefined ? {} : { caseId: runOptions.caseId }),
      baselineConfigVersion: BASELINE_CONFIG_VERSION,
      baselinePromptVersion: BASELINE_PROMPT_VERSION,
      profileEntryIdsIncluded: context.payload.profile.map((e) => e.id),
      profileEntryIdsOmittedForBudget: [...context.profileOmitted],
      retrievedHistoryEventIds: context.payload.history.map((h) => h.eventId),
      historyScores: context.scores.map((s) => ({ ...s })),
      historyEventIdsOmittedForBudget: [...context.historyOmitted],
      historyEventIdsTruncated: context.payload.history
        .filter((h) => h.truncated)
        .map((h) => h.eventId),
      assembledMessages: messages.map((m) => ({ ...m })),
    };
    const requestedAt = now();
    const stamp = (at: string | undefined) => ({
      ...(requestedAt === undefined ? {} : { requestedAt }),
      ...(at === undefined ? {} : { completedAt: at }),
    });
    try {
      const result = await invokeModelRuntime(
        runtime,
        { messages },
        {
          ...settings.data,
          ...(runOptions.signal ? { signal: runOptions.signal } : {}),
        },
      );
      return deepFreeze({
        ...base,
        status: 'completed' as const,
        responseText: result.text,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        runtimeStamp: { ...result.runtime },
        modelConfiguration: { ...result.model },
        ...stamp(now()),
      });
    } catch (error) {
      if (!(error instanceof ModelRuntimeError)) throw error;
      return deepFreeze({
        ...base,
        status: 'failed' as const,
        errorCode: error.code,
        ...stamp(now()),
      });
    }
  }
  return Object.freeze({ run });
}
