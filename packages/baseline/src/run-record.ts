import { z } from 'zod';
import {
  NonEmptyTextSchema,
  TimestampSchema,
  UsageSchema,
} from '@aven/contracts';
import {
  MODEL_RUNTIME_ERROR_CODES,
  ReportedModelSchema,
  ReportedRuntimeSchema,
} from '@aven/runtime';
import { BASELINE_CONDITIONS } from './config.ts';
import type { BaselineTrace } from './runner.ts';

/**
 * A small, serializable record of one future baseline run, for later
 * evaluation work. It is an experiment artifact, never owner state: it is not
 * persisted here, not written to the Ledger and not fed back into any
 * profile. It carries no hidden reasoning and no oracle or scorer data.
 * `executionKind` distinguishes mechanics validation with a scripted runtime
 * from a real model run; only the latter could ever support a research claim.
 */
export const BaselineRunRecordSchema = z
  .strictObject({
    caseId: NonEmptyTextSchema,
    condition: z.enum(BASELINE_CONDITIONS),
    datasetId: NonEmptyTextSchema,
    datasetVersion: NonEmptyTextSchema,
    baselineConfigVersion: NonEmptyTextSchema,
    baselinePromptVersion: NonEmptyTextSchema,
    executionKind: z.enum(['mechanics_validation', 'model_run']),
    runtime: ReportedRuntimeSchema.nullable(),
    model: ReportedModelSchema.nullable(),
    profileEntryIdsIncluded: z.array(NonEmptyTextSchema),
    retrievedHistoryEventIds: z.array(NonEmptyTextSchema),
    status: z.enum(['completed', 'failed']),
    responseText: NonEmptyTextSchema.nullable(),
    errorCode: z
      .enum(MODEL_RUNTIME_ERROR_CODES as [string, ...string[]])
      .nullable(),
    usage: UsageSchema.nullable(),
    requestedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .refine(
    (r) =>
      r.status === 'completed'
        ? r.responseText !== null && r.errorCode === null
        : r.responseText === null && r.errorCode !== null,
    'Completed runs carry text and no error; failed runs carry an error and no text',
  );
export type BaselineRunRecord = z.infer<typeof BaselineRunRecordSchema>;

export interface RunRecordContext {
  readonly caseId: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly executionKind: BaselineRunRecord['executionKind'];
}

export function createBaselineRunRecord(
  trace: BaselineTrace,
  context: RunRecordContext,
): BaselineRunRecord {
  return BaselineRunRecordSchema.parse({
    caseId: context.caseId,
    condition: trace.condition,
    datasetId: context.datasetId,
    datasetVersion: context.datasetVersion,
    baselineConfigVersion: trace.baselineConfigVersion,
    baselinePromptVersion: trace.baselinePromptVersion,
    executionKind: context.executionKind,
    runtime: trace.runtimeStamp ?? null,
    model: trace.modelConfiguration ?? null,
    profileEntryIdsIncluded: [...trace.profileEntryIdsIncluded],
    retrievedHistoryEventIds: [...trace.retrievedHistoryEventIds],
    status: trace.status,
    responseText: trace.responseText ?? null,
    errorCode: trace.errorCode ?? null,
    usage: trace.usage ?? null,
    requestedAt: trace.requestedAt ?? null,
    completedAt: trace.completedAt ?? null,
  });
}
