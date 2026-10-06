import { z } from 'zod';
import {
  ContextSourceSchema,
  NonEmptyTextSchema,
  OwnerIdSchema,
  ProvenanceSchema,
  ScopeSchema,
  TaskBindingSchema,
  TimestampSchema,
} from '@aven/contracts';
import {
  CONTEXT_SOURCE_KINDS,
  MAX_CANDIDATE_TEXT_CHARS,
  MAX_LABEL_CHARS,
  MAX_LOCAL_ID_CHARS,
  MAX_METADATA_CHARS,
  MAX_REQUEST_CHARS,
} from './config.ts';
import { codePointLength } from './util.ts';

const boundedText = (max: number) =>
  NonEmptyTextSchema.refine(
    (s) => codePointLength(s) <= max,
    `Must be at most ${max} characters`,
  );

/** A declarative scope label (domain, task type or qualifier). */
const LabelSchema = boundedText(MAX_LABEL_CHARS);

/**
 * Broker-local identifier for a source or a candidate. Unicode letters and
 * numbers are allowed (with combining marks, `_`, `.`, `:` and `-` after the
 * first character). The value must already be NFC-normalized, so two
 * canonically equivalent spellings can never be two different IDs.
 */
export const LocalIdSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.:-]*$/u)
  .refine(
    (s) => codePointLength(s) <= MAX_LOCAL_ID_CHARS,
    `Must be at most ${MAX_LOCAL_ID_CHARS} characters`,
  )
  .refine((s) => s === s.normalize('NFC'), 'Must be NFC-normalized');

/**
 * Explicit labels describing the CURRENT task, supplied by the trusted caller.
 * Names mirror the frozen AVEN-002 bounded-scope dimensions so matching is
 * label-to-label. An omitted label is "not declared", never a wildcard match.
 */
export const TaskDescriptorSchema = z.strictObject({
  domain: LabelSchema.optional(),
  taskType: LabelSchema.optional(),
  qualifiers: z
    .strictObject({
      recipient: LabelSchema.optional(),
      entity: LabelSchema.optional(),
      context: LabelSchema.optional(),
    })
    .optional(),
});

/**
 * One owner-scoped request for task context. `referenceTime` is the only clock
 * the broker uses, so identical requests produce identical output.
 */
export const ContextRequestSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  task: TaskBindingSchema,
  request: boundedText(MAX_REQUEST_CHARS),
  referenceTime: TimestampSchema,
  taskDescriptor: TaskDescriptorSchema,
});

const unitInterval = z
  .number()
  .refine((n) => Number.isFinite(n), 'Must be a finite number')
  .refine((n) => n >= 0 && n <= 1, 'Must be within [0, 1]');

/**
 * Numeric ranking signals supplied by the trusted source adapter. Each is
 * finite and bounded to [0, 1]; NaN and Infinity are rejected. They are
 * uncalibrated ordinal inputs, not probabilities. AVEN-002 deliberately
 * defines no numeric confidence; the adapter that builds this transient view
 * (AVEN-009 and later) owns how its state maps to these values.
 */
export const CandidateSignalsSchema = z.strictObject({
  confidence: unitInterval,
  salience: unitInterval,
  negativeRetrieval: unitInterval,
});

export const CandidateTimestampsSchema = z
  .strictObject({
    recordedAt: TimestampSchema,
    lastValidatedAt: TimestampSchema.optional(),
  })
  .refine(
    (v) =>
      v.lastValidatedAt === undefined ||
      Date.parse(v.lastValidatedAt) >= Date.parse(v.recordedAt),
    'Validation cannot precede recording',
  );

const OWNER_INSTRUCTION_PROVENANCE: readonly string[] = [
  'explicit_owner_statement',
  'explicit_owner_correction',
];

function scopeLabels(scope: z.infer<typeof ScopeSchema>): string[] {
  const bounded =
    scope.kind === 'bounded'
      ? [scope]
      : scope.kind === 'uncertain'
        ? scope.possibilities
        : [];
  return bounded.flatMap((b) => [
    ...(b.domain === undefined ? [] : [b.domain]),
    ...(b.taskType === undefined ? [] : [b.taskType]),
    ...Object.values(b.qualifiers ?? {}).filter(
      (q): q is string => q !== undefined,
    ),
  ]);
}

/** Every string leaf of a value (frozen contract metadata is plain data). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringLeaves);
  return [];
}

/**
 * ContextCandidate: a normalized, TRANSIENT retrieval view of one item that a
 * source offers for the current task. It is not durable owner state, not an
 * Owner Model record and not a learned item.
 *
 * Structured fields reuse frozen AVEN-002 semantics:
 *   - `reference`  is an AVEN-002 `ContextSource` (evidence, owner state with
 *                  its lifecycle, active task state, or current instruction);
 *   - `provenance` is an AVEN-002 `Provenance`;
 *   - `scope`      is an AVEN-002 `Scope` (unknown, uncertain, bounded,
 *                  global; never defaulted).
 * Only `text` is free prose, and the broker treats it as data: it is
 * tokenized for lexical relevance and copied, never interpreted. Strict:
 * unknown fields are rejected rather than allowed to influence ranking.
 */
export const ContextCandidateSchema = z
  .strictObject({
    candidateId: LocalIdSchema,
    ownerId: OwnerIdSchema,
    reference: ContextSourceSchema,
    provenance: ProvenanceSchema,
    scope: ScopeSchema,
    text: boundedText(MAX_CANDIDATE_TEXT_CHARS),
    timestamps: CandidateTimestampsSchema,
    signals: CandidateSignalsSchema,
  })
  .superRefine((v, ctx) => {
    if (
      v.reference.kind === 'current_instruction' &&
      !OWNER_INSTRUCTION_PROVENANCE.includes(v.provenance.kind)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance'],
        message:
          'A current instruction requires explicit owner-instruction provenance',
      });
    }
    if (
      scopeLabels(v.scope).some(
        (label) => codePointLength(label) > MAX_LABEL_CHARS,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: `Scope labels must be at most ${MAX_LABEL_CHARS} characters`,
      });
    }
    // Frozen AVEN-002 text fields carry no length limit; bound them here so a
    // source cannot push unbounded metadata into a bundle.
    if (
      stringLeaves([v.reference, v.provenance, v.scope]).some(
        (s) =>
          s.length > MAX_METADATA_CHARS &&
          codePointLength(s) > MAX_METADATA_CHARS,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `Metadata strings must be at most ${MAX_METADATA_CHARS} characters`,
      });
    }
  });

export const ContextSourceKindSchema = z.enum(CONTEXT_SOURCE_KINDS);

/*
 * Public input types are the schemas' INPUT types (plain strings, no ID
 * brands): every entry point re-validates, so callers need not pre-brand.
 */
export type TaskDescriptor = z.input<typeof TaskDescriptorSchema>;
export type ContextRequest = z.input<typeof ContextRequestSchema>;
export type ContextCandidate = z.input<typeof ContextCandidateSchema>;
export type CandidateSignals = z.input<typeof CandidateSignalsSchema>;
export type ParsedContextRequest = z.output<typeof ContextRequestSchema>;
export type ParsedContextCandidate = z.output<typeof ContextCandidateSchema>;
