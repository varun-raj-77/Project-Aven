import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BASELINE_CONFIG_V2,
  BASELINE_CONTEXT_LABEL,
  BASELINE_PROMPT_VERSION,
  BASELINE_SYSTEM_PROMPT_V1,
  DATASET_CATEGORIES,
  parseAllBaselineCasesForValidation,
  selectHistoryContext,
  STOPWORDS_V2,
  TOKENIZER_VERSION,
  type BaselineCase,
} from '../../packages/baseline/src/index.ts';
import { computeAven007Diagnostics } from './aven-007-diagnostics.ts';

/**
 * AVEN-007 dataset validation (scorer-side tooling; research discipline, not
 * security). Only this tooling and tests parse the scorer-only files
 * (`oracle.jsonl`, `b-mechanics-controls.json`, `construction.json`,
 * `diagnostics.json`). The production baseline package never reads them.
 *
 * Validation fails closed: any count, split, family, ID, oracle, control,
 * archive or hash deviation is reported as a problem.
 */
export const AVEN_007_DATASET_ID = 'AVEN-007-DATASET-001';
export const AVEN_007_DATASET_VERSION = '2.0.0';

/**
 * The independently reviewed v1 candidate, preserved byte-for-byte under
 * `evals/aven-007/reviewed-v1/` as review evidence. It was never frozen as the
 * final benchmark and was superseded before any C implementation or
 * real-model result. Pinned here so neither the archive nor the current
 * manifest's record of it can drift silently.
 */
export const REVIEWED_V1 = Object.freeze({
  datasetVersion: '1.0.0',
  archivePath: 'evals/aven-007/reviewed-v1/',
  casesSha256:
    '162a879729293a28bad2afdec54936b66d0ad05aec56315afeed3295c1184cc8',
  oracleSha256:
    '5798eb24b68cffbc00ad40d9a76fd88ab8b7c83fd0a92800d19f18c0b388ff58',
  manifestSha256:
    'd6dc4bcdf3fbcb480f45222d2dc14aeaf7c3a8b0f4d4f60951570f8ba03f4205',
  baselineConfigVersion: 'aven-007-baseline-config-v1',
  tokenizerVersion: 'aven-007-tokenizer-v1',
  stopwordsSha256:
    '74c2b0c091c094aa2b24a3a3d052e4585354891d78d88cdb0862ba239c71daae',
});

export const EXPECTED = Object.freeze({
  cases: 64,
  development: 48,
  heldOut: 16,
  families: 32,
  casesPerFamily: 2,
  categories: 8,
  casesPerCategory: 8,
  developmentFamiliesPerCategory: 3,
  heldOutFamiliesPerCategory: 1,
});

export const CATEGORY_CODES: Record<
  (typeof DATASET_CATEGORIES)[number],
  string
> = {
  preference_application: 'pa',
  preference_non_application: 'pn',
  procedure_application: 'pr',
  changed_or_stale_preference: 'cs',
  conflict_or_ambiguity: 'ca',
  episodic_recall: 'er',
  disagreement_preservation: 'dp',
  irrelevant_history_resistance: 'ir',
};

export const EXPECTED_BEHAVIOR_CLASSES = [
  'apply_preference',
  'withhold_preference',
  'follow_current_request_override',
  'apply_procedure',
  'apply_current_preference_over_stale',
  'acknowledge_conflict_or_clarify',
  'recall_episode',
  'preserve_disagreement',
  'ignore_irrelevant_or_untrusted_history',
] as const;

const Text = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Scorer-only oracle row (v2 contract). Never model input.
 *
 * `behavior` is the PRIMARY correctness definition: what a response must and
 * must not do, plus defensible alternatives that are not failures. It never
 * names raw context IDs.
 *
 * `contextDiagnostics` is DIAGNOSTIC ONLY. It labels every profile entry and
 * history record of the case as supporting, stale-or-conflicting, or
 * distractor so that B's lexical mechanics can be inspected. It does NOT mean
 * a future system must retrieve those exact raw IDs, and retrieving a stale or
 * conflicting item is not by itself wrong. Condition C may use derived state,
 * extra evidence or a different representation.
 */
export const OracleRecordSchema = z.strictObject({
  caseId: Text,
  behavior: z.strictObject({
    expectedBehaviorClass: z.enum(EXPECTED_BEHAVIOR_CLASSES),
    requiredBehavior: z.array(Text).min(1),
    forbiddenBehavior: z.array(Text).min(1),
    acceptableAlternatives: z.array(Text),
    scorerNotes: Text,
  }),
  contextDiagnostics: z.strictObject({
    role: z.literal('diagnostic_only_not_behavioral_requirement'),
    supportingContextIds: z.array(Text),
    staleOrConflictingContextIds: z.array(Text),
    distractorContextIds: z.array(Text),
  }),
});
export type OracleRecord = z.infer<typeof OracleRecordSchema>;

/** B-mechanics exposure controls: NOT behavioral criteria; never applied to C. */
export const BMechanicsControlsSchema = z.strictObject({
  purpose: Text,
  controls: z.array(
    z.strictObject({
      caseId: Text,
      mechanism: Text,
      mustRetrieveEventIds: z.array(Text),
      mustRetrieveNothing: z.boolean(),
    }),
  ),
});
export type BMechanicsControls = z.infer<typeof BMechanicsControlsSchema>;

/** Construction intent recorded BEFORE diagnostics were computed. */
export const ConstructionSchema = z.strictObject({
  note: Text,
  cases: z.array(
    z.strictObject({
      caseId: Text,
      split: z.enum(['development', 'held_out']),
      designedSupportingOverlap: z.enum([
        'high',
        'partial',
        'low',
        'none',
        'n/a',
      ]),
      sizeClass: z.enum(['S', 'M', 'L']),
      topKCompetitionRecords: z.number().int().nonnegative(),
    }),
  ),
});

const SplitCounts = z.strictObject({
  development: z.number().int(),
  held_out: z.number().int(),
});
const FileEntry = <R extends string>(role: R) =>
  z.strictObject({ role: z.literal(role), sha256: Sha256 });

export const DatasetManifestSchema = z.strictObject({
  datasetId: z.literal(AVEN_007_DATASET_ID),
  datasetVersion: z.literal(AVEN_007_DATASET_VERSION),
  milestone: z.literal('AVEN-007'),
  contentStatus: z.literal('candidate_pending_final_external_verification'),
  dataProvenance: z.literal('synthetic'),
  containsRealOwnerData: z.literal(false),
  counts: z.strictObject({
    cases: z.number().int(),
    development: z.number().int(),
    heldOut: z.number().int(),
    families: z.number().int(),
    casesPerFamily: z.number().int(),
    categories: z.number().int(),
    perCategory: z.record(z.string(), SplitCounts),
  }),
  splitPolicy: z.strictObject({
    unit: z.literal('scenario_family'),
    heldOutShare: z.number(),
    developmentFamiliesPerCategory: z.number().int(),
    heldOutFamiliesPerCategory: z.number().int(),
    heldOutSecret: z.literal(false),
    heldOutStatus: z.literal('frozen_version_controlled_not_secret'),
    defaultAccess: z.literal('development_only'),
    heldOutAccess: z.literal('explicit_opt_in'),
    heldOutRole: z.literal(
      'aven007_baseline_asset_not_promotion_eval_not_exp001_final_held_out',
    ),
    exp001Relationship: z.literal(
      'separate_asset_no_automatic_reuse_exp001_unchanged',
    ),
  }),
  baseline: z.strictObject({
    configuration: z.unknown(),
    configVersion: Text,
    tokenizerVersion: Text,
    stopwordsVersion: z.literal('STOPWORDS_V2'),
    stopwordsSha256: Sha256,
    promptVersion: Text,
    promptSha256: Sha256,
    contextLabel: Text,
  }),
  files: z.strictObject({
    'cases.jsonl': FileEntry('model_visible_inputs'),
    'oracle.jsonl': FileEntry('scorer_only_behavior_and_diagnostics'),
    'b-mechanics-controls.json': FileEntry(
      'scorer_only_b_mechanics_exposure_controls',
    ),
    'construction.json': FileEntry('scorer_only_construction_intent'),
    'diagnostics.json': FileEntry('scorer_only_lexical_diagnostics'),
  }),
  supersedes: z.strictObject({
    datasetVersion: z.literal(REVIEWED_V1.datasetVersion),
    status: z.literal('superseded_pre_freeze_after_independent_review'),
    archivePath: z.literal(REVIEWED_V1.archivePath),
    casesSha256: z.literal(REVIEWED_V1.casesSha256),
    oracleSha256: z.literal(REVIEWED_V1.oracleSha256),
    manifestSha256: z.literal(REVIEWED_V1.manifestSha256),
    baselineConfigVersion: z.literal(REVIEWED_V1.baselineConfigVersion),
    tokenizerVersion: z.literal(REVIEWED_V1.tokenizerVersion),
    stopwordsSha256: z.literal(REVIEWED_V1.stopwordsSha256),
    reason: Text,
  }),
  execution: z.strictObject({
    status: z.literal('not_run'),
    results: z.null(),
    note: Text,
  }),
});
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export const promptSha256 = (): string => sha256Hex(BASELINE_SYSTEM_PROMPT_V1);
export const stopwordsSha256 = (): string =>
  sha256Hex(JSON.stringify(STOPWORDS_V2));

export function parseOracle(text: string): OracleRecord[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body
    .split('\n')
    .map((line) => OracleRecordSchema.parse(JSON.parse(line)));
}

/** Counts derived from the case file itself. */
export function deriveCounts(cases: readonly BaselineCase[]) {
  const families = new Set(cases.map((c) => c.scenarioFamilyId));
  const perCategory: Record<string, { development: number; held_out: number }> =
    {};
  for (const category of DATASET_CATEGORIES)
    perCategory[category] = { development: 0, held_out: 0 };
  for (const c of cases) perCategory[c.category]![c.split] += 1;
  return {
    cases: cases.length,
    development: cases.filter((c) => c.split === 'development').length,
    heldOut: cases.filter((c) => c.split === 'held_out').length,
    families: families.size,
    casesPerFamily: families.size === 0 ? 0 : cases.length / families.size,
    categories: new Set(cases.map((c) => c.category)).size,
    perCategory,
  };
}

const PERSONAL_IDENTIFIER_TRIPWIRES: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email address
  /\+?\d[\d\s().-]{8,}\d/, // phone-number-like digit run
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-like
];
/** Behavioral text must not depend on raw context IDs (M3). */
const RAW_CONTEXT_ID = /\b(?:event_|pentry_)[A-Za-z0-9_-]+/;

export interface ValidationInput {
  readonly casesText: string;
  readonly oracleText: string;
  readonly controlsText: string;
  readonly constructionText: string;
  readonly diagnosticsText: string;
  readonly manifest: unknown;
  /** Raw bytes of the archived reviewed-v1 files. */
  readonly archive: {
    readonly cases: Uint8Array | string;
    readonly oracle: Uint8Array | string;
    readonly manifest: Uint8Array | string;
  };
}

/** Returns every problem found (empty means valid). */
export function validateAven007Dataset(input: ValidationInput): string[] {
  const problems: string[] = [];
  let cases: BaselineCase[];
  let oracle: OracleRecord[];
  try {
    cases = parseAllBaselineCasesForValidation(input.casesText);
  } catch (error) {
    return [`cases.jsonl does not parse: ${String(error)}`];
  }
  try {
    oracle = parseOracle(input.oracleText);
  } catch (error) {
    return [`oracle.jsonl does not parse: ${String(error)}`];
  }
  const manifestParse = DatasetManifestSchema.safeParse(input.manifest);
  if (!manifestParse.success)
    return [`manifest.json is malformed: ${manifestParse.error.message}`];
  const manifest = manifestParse.data;
  let controls: BMechanicsControls;
  let construction: z.infer<typeof ConstructionSchema>;
  try {
    controls = BMechanicsControlsSchema.parse(JSON.parse(input.controlsText));
    construction = ConstructionSchema.parse(JSON.parse(input.constructionText));
  } catch (error) {
    return [`controls or construction file is malformed: ${String(error)}`];
  }

  // Archived reviewed v1: byte-identical to the pinned review evidence.
  if (sha256Hex(input.archive.cases) !== REVIEWED_V1.casesSha256)
    problems.push('archived reviewed-v1 cases.jsonl SHA-256 changed');
  if (sha256Hex(input.archive.oracle) !== REVIEWED_V1.oracleSha256)
    problems.push('archived reviewed-v1 oracle.jsonl SHA-256 changed');
  if (sha256Hex(input.archive.manifest) !== REVIEWED_V1.manifestSha256)
    problems.push('archived reviewed-v1 manifest.json SHA-256 changed');
  if (input.casesText === String(input.archive.cases))
    problems.push('current cases.jsonl is identical to the superseded v1');

  // Counts.
  const counts = deriveCounts(cases);
  const expectCount = (name: string, actual: number, expected: number) => {
    if (actual !== expected)
      problems.push(`${name}: expected ${expected}, found ${actual}`);
  };
  expectCount('cases', counts.cases, EXPECTED.cases);
  expectCount('development cases', counts.development, EXPECTED.development);
  expectCount('held-out cases', counts.heldOut, EXPECTED.heldOut);
  expectCount('families', counts.families, EXPECTED.families);
  expectCount('categories', counts.categories, EXPECTED.categories);
  for (const category of DATASET_CATEGORIES) {
    const c = counts.perCategory[category]!;
    expectCount(`${category} development cases`, c.development, 6);
    expectCount(`${category} held-out cases`, c.held_out, 2);
  }

  // Families: exactly two cases, one split, one category, one owner, valid IDs.
  const byFamily = new Map<string, BaselineCase[]>();
  for (const c of cases)
    byFamily.set(c.scenarioFamilyId, [
      ...(byFamily.get(c.scenarioFamilyId) ?? []),
      c,
    ]);
  for (const [familyId, members] of byFamily) {
    if (members.length !== EXPECTED.casesPerFamily)
      problems.push(`${familyId}: expected 2 cases, found ${members.length}`);
    if (new Set(members.map((m) => m.split)).size !== 1)
      problems.push(
        `${familyId}: family crosses the development/held-out boundary`,
      );
    if (new Set(members.map((m) => m.category)).size !== 1)
      problems.push(`${familyId}: family spans more than one category`);
    if (new Set(members.map((m) => m.ownerId)).size !== 1)
      problems.push(`${familyId}: family spans more than one synthetic owner`);
    const category = members[0]!.category;
    const match = /^aven007-([a-z]{2})-(\d{2})$/.exec(familyId);
    if (!match || match[1] !== CATEGORY_CODES[category])
      problems.push(
        `${familyId}: family ID does not match category ${category}`,
      );
    for (const m of members)
      if (!new RegExp(`^${familyId}-v[12]$`).test(m.caseId))
        problems.push(
          `${m.caseId}: case ID does not belong to family ${familyId}`,
        );
  }
  for (const category of DATASET_CATEGORIES) {
    const families = [...byFamily.values()].filter(
      (m) => m[0]!.category === category,
    );
    expectCount(
      `${category} development families`,
      families.filter((m) => m[0]!.split === 'development').length,
      3,
    );
    expectCount(
      `${category} held-out families`,
      families.filter((m) => m[0]!.split === 'held_out').length,
      1,
    );
  }

  // Owners, history and profile IDs; synthetic-data tripwires.
  const seenEvents = new Set<string>();
  for (const c of cases) {
    if (!/^owner_syn_[a-z0-9]+$/.test(c.ownerId))
      problems.push(`${c.caseId}: owner ID is not a synthetic owner ID`);
    for (const record of c.history) {
      if (record.ownerId !== c.ownerId)
        problems.push(
          `${c.caseId}: history record ${record.eventId} has another owner`,
        );
      if (!/^event_syn_[a-z0-9_]+$/.test(record.eventId))
        problems.push(
          `${c.caseId}: history event ID ${record.eventId} is not synthetic`,
        );
      if (seenEvents.has(record.eventId))
        problems.push(
          `${c.caseId}: history event ID ${record.eventId} is reused`,
        );
      seenEvents.add(record.eventId);
    }
    for (const entry of c.profile.entries)
      if (!/^pentry_[a-z0-9_]+$/.test(entry.id))
        problems.push(`${c.caseId}: profile entry ID ${entry.id} is malformed`);
    const text = [
      c.request,
      ...c.profile.entries.map((e) => e.text),
      ...c.history.map((h) => h.text),
    ].join('\n');
    for (const pattern of PERSONAL_IDENTIFIER_TRIPWIRES)
      if (pattern.test(text))
        problems.push(
          `${c.caseId}: contains a personal-identifier-like string`,
        );
  }

  // Distractor diversity: exact history text reused across unrelated
  // families is not allowed (review finding H3).
  const familiesByText = new Map<string, Set<string>>();
  for (const c of cases)
    for (const h of c.history)
      familiesByText.set(
        h.text,
        (familiesByText.get(h.text) ?? new Set()).add(c.scenarioFamilyId),
      );
  for (const [text, families] of familiesByText)
    if (families.size > 1)
      problems.push(
        `history text reused across ${families.size} families: ${text.slice(0, 60)}`,
      );

  // Oracle: one-to-one in case order; behavior separate from diagnostics.
  const caseIds = cases.map((c) => c.caseId);
  const oracleIds = oracle.map((o) => o.caseId);
  const missing = caseIds.filter((id) => !oracleIds.includes(id));
  const extra = oracleIds.filter((id) => !caseIds.includes(id));
  if (missing.length)
    problems.push(`oracle missing for: ${missing.join(', ')}`);
  if (extra.length)
    problems.push(`oracle has extra cases: ${extra.join(', ')}`);
  if (new Set(oracleIds).size !== oracleIds.length)
    problems.push('oracle case IDs are not unique');
  if (
    missing.length === 0 &&
    extra.length === 0 &&
    caseIds.join() !== oracleIds.join()
  )
    problems.push('oracle order does not match case order');
  const caseById = new Map(cases.map((c) => [c.caseId, c]));
  for (const o of oracle) {
    const c = caseById.get(o.caseId);
    if (!c) continue;
    const behaviorText = JSON.stringify(o.behavior);
    if (RAW_CONTEXT_ID.test(behaviorText))
      problems.push(
        `${o.caseId}: behavioral criteria reference raw context IDs (diagnostic IDs must stay diagnostic)`,
      );
    const all = [
      ...c.profile.entries.map((e) => e.id),
      ...c.history.map((h) => h.eventId),
    ];
    const d = o.contextDiagnostics;
    const labelled = [
      ...d.supportingContextIds,
      ...d.staleOrConflictingContextIds,
      ...d.distractorContextIds,
    ];
    for (const id of labelled)
      if (!all.includes(id))
        problems.push(`${o.caseId}: diagnostics cite unknown context ${id}`);
    if (new Set(labelled).size !== labelled.length)
      problems.push(
        `${o.caseId}: a context ID has more than one diagnostic label`,
      );
    for (const id of all)
      if (!labelled.includes(id))
        problems.push(`${o.caseId}: context ${id} has no diagnostic label`);
  }

  // B-mechanics exposure controls (B only; never a behavioral criterion).
  for (const control of controls.controls) {
    const c = caseById.get(control.caseId);
    if (!c) {
      problems.push(`control cites unknown case ${control.caseId}`);
      continue;
    }
    const got = selectHistoryContext(c.ownerId, c.request, c.history).items.map(
      (i) => i.eventId,
    );
    for (const id of control.mustRetrieveEventIds) {
      if (!c.history.some((h) => h.eventId === id))
        problems.push(`${control.caseId}: control cites unknown event ${id}`);
      else if (!got.includes(id))
        problems.push(
          `${control.caseId}: B-mechanics exposure control failed: ${id} not retrieved (${control.mechanism})`,
        );
    }
    if (control.mustRetrieveNothing && got.length > 0)
      problems.push(
        `${control.caseId}: B-mechanics control expects no retrieval but got ${got.join(', ')}`,
      );
    if (control.mustRetrieveNothing === control.mustRetrieveEventIds.length > 0)
      problems.push(`${control.caseId}: control must be exactly one kind`);
  }

  // Construction intent covers every case once, with matching splits.
  const constructionIds = construction.cases.map((x) => x.caseId);
  if (constructionIds.join() !== caseIds.join())
    problems.push('construction.json does not list every case in order');
  for (const x of construction.cases)
    if (caseById.get(x.caseId)?.split !== x.split)
      problems.push(`${x.caseId}: construction split differs from the case`);

  // Diagnostics file must equal a fresh recomputation.
  // Diagnostics need a complete one-to-one oracle; otherwise report, never throw.
  const oracleComplete =
    missing.length === 0 &&
    extra.length === 0 &&
    new Set(oracleIds).size === oracleIds.length;
  let recordedDiagnostics: unknown;
  try {
    recordedDiagnostics = JSON.parse(input.diagnosticsText);
  } catch {
    recordedDiagnostics = undefined;
  }
  if (!oracleComplete)
    problems.push('diagnostics not recomputed: the oracle is incomplete');
  else if (
    JSON.stringify(recordedDiagnostics) !==
    JSON.stringify(computeAven007Diagnostics(cases, oracle))
  )
    problems.push('diagnostics.json differs from recomputed diagnostics');

  // Manifest: counts, baseline configuration and every file hash.
  if (JSON.stringify(manifest.counts) !== JSON.stringify(counts))
    problems.push('manifest counts do not match the case file');
  if (
    manifest.splitPolicy.heldOutShare !== counts.heldOut / counts.cases ||
    manifest.splitPolicy.developmentFamiliesPerCategory !== 3 ||
    manifest.splitPolicy.heldOutFamiliesPerCategory !== 1
  )
    problems.push('manifest split policy does not match the case file');
  if (
    JSON.stringify(manifest.baseline.configuration) !==
    JSON.stringify(BASELINE_CONFIG_V2)
  )
    problems.push(
      'manifest baseline configuration differs from BASELINE_CONFIG_V2',
    );
  if (manifest.baseline.configVersion !== BASELINE_CONFIG_V2.version)
    problems.push('manifest configuration version differs');
  if (manifest.baseline.tokenizerVersion !== TOKENIZER_VERSION)
    problems.push('manifest tokenizer version differs');
  if (manifest.baseline.promptVersion !== BASELINE_PROMPT_VERSION)
    problems.push('manifest prompt version differs from the baseline prompt');
  if (manifest.baseline.promptSha256 !== promptSha256())
    problems.push(
      'manifest prompt hash differs from BASELINE_SYSTEM_PROMPT_V1',
    );
  if (manifest.baseline.contextLabel !== BASELINE_CONTEXT_LABEL)
    problems.push('manifest context label differs from the baseline');
  if (manifest.baseline.stopwordsSha256 !== stopwordsSha256())
    problems.push('manifest stopword hash differs from STOPWORDS_V2');
  const fileHashes: Record<keyof DatasetManifest['files'], string> = {
    'cases.jsonl': input.casesText,
    'oracle.jsonl': input.oracleText,
    'b-mechanics-controls.json': input.controlsText,
    'construction.json': input.constructionText,
    'diagnostics.json': input.diagnosticsText,
  };
  for (const [file, text] of Object.entries(fileHashes))
    if (
      manifest.files[file as keyof DatasetManifest['files']].sha256 !==
      sha256Hex(text)
    )
      problems.push(`${file} SHA-256 does not match the manifest`);
  return problems;
}
