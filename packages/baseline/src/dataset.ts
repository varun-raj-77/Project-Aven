import { z } from 'zod';
import { OwnerIdSchema } from '@aven/contracts';
import { BaselineError } from './errors.ts';
import {
  HistorySchema,
  OwnerProfileSchema,
  OwnerRequestTextSchema,
  type BaselineInput,
} from './types.ts';

/**
 * Model-visible case INPUTS of a prebuilt baseline dataset (for AVEN-007,
 * `evals/aven-007/cases.jsonl`). This module never reads files and has no
 * knowledge of scorer-only oracle data: it parses case text supplied by the
 * caller. Unknown keys (an oracle label merged in by mistake) are rejected.
 *
 * `caseId`, `scenarioFamilyId`, `split` and `category` are evaluation
 * bookkeeping. They are kept in the case record but never reach prompt
 * assembly: `toBaselineInput` passes on only owner, request, profile and
 * history.
 */
export const DATASET_SPLITS = ['development', 'held_out'] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

export const DATASET_CATEGORIES = [
  'preference_application',
  'preference_non_application',
  'procedure_application',
  'changed_or_stale_preference',
  'conflict_or_ambiguity',
  'episodic_recall',
  'disagreement_preservation',
  'irrelevant_history_resistance',
] as const;
export type DatasetCategory = (typeof DATASET_CATEGORIES)[number];

const SlugIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);

export const BaselineCaseSchema = z
  .strictObject({
    caseId: SlugIdSchema,
    scenarioFamilyId: SlugIdSchema,
    split: z.enum(DATASET_SPLITS),
    category: z.enum(DATASET_CATEGORIES),
    ownerId: OwnerIdSchema,
    profile: OwnerProfileSchema,
    history: HistorySchema,
    request: OwnerRequestTextSchema,
  })
  .refine((c) => c.profile.ownerId === c.ownerId, {
    path: ['profile', 'ownerId'],
    message: 'Profile owner must match the case owner',
  });
export type BaselineCase = z.infer<typeof BaselineCaseSchema>;

/**
 * RAW, ALL-SPLIT parser for dataset validation, manifest/hash checks and
 * tooling only. It returns every case INCLUDING HELD-OUT cases, which is why
 * its name says so. Ordinary development use must call `loadBaselineCases`,
 * which returns development cases unless held-out access is requested
 * explicitly.
 *
 * Fails closed on any malformed line, schema violation or duplicate case ID.
 * Blank lines are not permitted except a single trailing newline.
 */
export function parseAllBaselineCasesForValidation(
  text: string,
): BaselineCase[] {
  if (typeof text !== 'string') throw new BaselineError('invalid_dataset');
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.length === 0) throw new BaselineError('invalid_dataset');
  const cases: BaselineCase[] = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new BaselineError('invalid_dataset', error);
    }
    const parsed = BaselineCaseSchema.safeParse(value);
    if (!parsed.success)
      throw new BaselineError('invalid_dataset', parsed.error);
    if (seen.has(parsed.data.caseId))
      throw new BaselineError('invalid_dataset');
    seen.add(parsed.data.caseId);
    cases.push(parsed.data);
  }
  return cases;
}

export interface CaseSelectionOptions {
  /** Explicit opt-in to include held-out cases alongside development cases. */
  readonly includeHeldOut?: boolean;
  /** Explicit single split. `held_out` is itself an explicit opt-in. */
  readonly split?: DatasetSplit;
}

const CaseSelectionOptionsSchema = z
  .strictObject({
    includeHeldOut: z.boolean().optional(),
    split: z.enum(DATASET_SPLITS).optional(),
  })
  .refine(
    (o) => !(o.includeHeldOut === true && o.split === 'development'),
    'includeHeldOut contradicts split: development',
  );

/**
 * Research-discipline friction, not a security boundary: by default only
 * development cases are returned. Held-out cases require `split: 'held_out'`
 * or `includeHeldOut: true`. The held-out split is frozen but NOT secret; it
 * is version-controlled in this repository.
 */
export function selectBaselineCases(
  cases: readonly BaselineCase[],
  options: CaseSelectionOptions = {},
): BaselineCase[] {
  const parsed = CaseSelectionOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new BaselineError('invalid_case_selection', parsed.error);
  const { includeHeldOut, split } = parsed.data;
  if (split) return cases.filter((c) => c.split === split);
  if (includeHeldOut === true) return [...cases];
  return cases.filter((c) => c.split === 'development');
}

/**
 * The ordinary loader. Parses case text and returns DEVELOPMENT cases only,
 * unless the caller explicitly passes `{ split: 'held_out' }` or
 * `{ includeHeldOut: true }`. Omitted or `undefined` options mean
 * development only; `null` or malformed options are rejected. Research
 * discipline, not access control.
 */
export function loadBaselineCases(
  text: string,
  options?: CaseSelectionOptions,
): BaselineCase[] {
  return selectBaselineCases(parseAllBaselineCasesForValidation(text), options);
}

/** The only fields of a case that may reach prompt assembly. */
export function toBaselineInput(testCase: BaselineCase): BaselineInput {
  return {
    ownerId: testCase.ownerId,
    request: testCase.request,
    profile: testCase.profile,
    history: testCase.history,
  };
}
