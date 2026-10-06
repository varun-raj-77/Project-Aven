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

/*
 * Every schema is built by a function. The broker validates with its own
 * private instances (`INTERNAL`), and the package exports separate instances,
 * so mutating an exported schema object cannot change broker behavior. The
 * frozen AVEN-002 schemas these compose are shared objects from
 * `@aven/contracts`; that package is frozen and was not changed.
 */

const boundedText = (max: number) =>
  NonEmptyTextSchema.refine(
    (s) => codePointLength(s) <= max,
    `Must be at most ${max} characters`,
  );

/**
 * Broker-local identifier for a source or a candidate. Unicode letters and
 * numbers are allowed (with combining marks, `_`, `.`, `:` and `-` after the
 * first character). The value must already be NFC-normalized, so two
 * canonically equivalent spellings can never be two different IDs.
 */
function localIdSchema() {
  return z
    .string()
    .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.:-]*$/u)
    .refine(
      (s) => codePointLength(s) <= MAX_LOCAL_ID_CHARS,
      `Must be at most ${MAX_LOCAL_ID_CHARS} characters`,
    )
    .refine((s) => s === s.normalize('NFC'), 'Must be NFC-normalized');
}

/**
 * Explicit labels describing the CURRENT task, supplied by the trusted caller.
 * Names mirror the frozen AVEN-002 bounded-scope dimensions so matching is
 * label-to-label. An omitted label is "not declared", never a wildcard match.
 */
function taskDescriptorSchema() {
  const label = boundedText(MAX_LABEL_CHARS);
  return z.strictObject({
    domain: label.optional(),
    taskType: label.optional(),
    qualifiers: z
      .strictObject({
        recipient: label.optional(),
        entity: label.optional(),
        context: label.optional(),
      })
      .optional(),
  });
}

/**
 * One owner-scoped request for task context. `referenceTime` is the only clock
 * the broker uses for any output value.
 */
function contextRequestSchema() {
  return z.strictObject({
    ownerId: OwnerIdSchema,
    task: TaskBindingSchema,
    request: boundedText(MAX_REQUEST_CHARS),
    referenceTime: TimestampSchema,
    taskDescriptor: taskDescriptorSchema(),
  });
}

/**
 * Numeric ranking signals supplied by the trusted source adapter. Each is
 * finite and bounded to [0, 1]; NaN and Infinity are rejected. They are
 * uncalibrated ordinal inputs, not probabilities. AVEN-002 deliberately
 * defines no numeric confidence; the adapter that builds this transient view
 * (AVEN-009 and later) owns how its state maps to these values.
 */
function candidateSignalsSchema() {
  const unitInterval = z
    .number()
    .refine((n) => Number.isFinite(n), 'Must be a finite number')
    .refine((n) => n >= 0 && n <= 1, 'Must be within [0, 1]');
  return z.strictObject({
    confidence: unitInterval,
    salience: unitInterval,
    negativeRetrieval: unitInterval,
  });
}

function candidateTimestampsSchema() {
  return z
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
}

const OWNER_INSTRUCTION_PROVENANCE: readonly string[] = Object.freeze([
  'explicit_owner_statement',
  'explicit_owner_correction',
]);

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
 *
 * Local provenance consistency (M3, mirroring the frozen AVEN-002 evidence
 * rule "owner evidence must match its source event and owner"):
 *   - owner-origin provenance (statement, correction, approval) must name the
 *     candidate's own owner;
 *   - a DIRECT owner-origin reference (`evidence` or `current_instruction`)
 *     must carry the same event ID as its provenance `sourceEventId`.
 * Learned references (`owner_state`, `active_task_state`) cite supporting
 * events separately, so their learned-item IDs are never compared with event
 * IDs. No Ledger lookup or lineage resolution happens here.
 */
function contextCandidateSchema() {
  return z
    .strictObject({
      candidateId: localIdSchema(),
      ownerId: OwnerIdSchema,
      reference: ContextSourceSchema,
      provenance: ProvenanceSchema,
      scope: ScopeSchema,
      text: boundedText(MAX_CANDIDATE_TEXT_CHARS),
      timestamps: candidateTimestampsSchema(),
      signals: candidateSignalsSchema(),
    })
    .superRefine((v, ctx) => {
      const provenance = v.provenance;
      const reference = v.reference;
      if (
        reference.kind === 'current_instruction' &&
        !OWNER_INSTRUCTION_PROVENANCE.includes(provenance.kind)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['provenance'],
          message:
            'A current instruction requires explicit owner-instruction provenance',
        });
      if ('ownerId' in provenance) {
        if (provenance.ownerId !== v.ownerId)
          ctx.addIssue({
            code: 'custom',
            path: ['provenance', 'ownerId'],
            message: 'Owner-origin provenance must name the candidate owner',
          });
        const directEvent =
          reference.kind === 'evidence'
            ? reference.reference.eventId
            : reference.kind === 'current_instruction'
              ? reference.evidence.eventId
              : undefined;
        if (
          directEvent !== undefined &&
          directEvent !== provenance.sourceEventId
        )
          ctx.addIssue({
            code: 'custom',
            path: ['provenance', 'sourceEventId'],
            message:
              'Direct owner-origin evidence must cite its own source event',
          });
      }
      if (
        scopeLabels(v.scope).some(
          (label) => codePointLength(label) > MAX_LABEL_CHARS,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['scope'],
          message: `Scope labels must be at most ${MAX_LABEL_CHARS} characters`,
        });
      // Frozen AVEN-002 text fields carry no length limit; bound them here so
      // a source cannot push unbounded metadata into a bundle.
      if (
        stringLeaves([v.reference, v.provenance, v.scope]).some(
          (s) =>
            s.length > MAX_METADATA_CHARS &&
            codePointLength(s) > MAX_METADATA_CHARS,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: `Metadata strings must be at most ${MAX_METADATA_CHARS} characters`,
        });
    });
}

/** Private instances used by the broker; never exported from the package. */
export const INTERNAL = Object.freeze({
  localId: localIdSchema(),
  request: contextRequestSchema(),
  candidate: contextCandidateSchema(),
  sourceKind: z.enum(CONTEXT_SOURCE_KINDS),
  ownerId: OwnerIdSchema,
});

/** Public instances, independent of the broker's own instances. */
export const LocalIdSchema = localIdSchema();
export const TaskDescriptorSchema = taskDescriptorSchema();
export const ContextRequestSchema = contextRequestSchema();
export const CandidateSignalsSchema = candidateSignalsSchema();
export const ContextCandidateSchema = contextCandidateSchema();

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
