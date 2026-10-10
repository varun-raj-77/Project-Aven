import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { z } from 'zod';
import {
  CorrectionTargetSchema,
  EventIdSchema,
  EvidenceIdSchema,
  EvidenceRecordSchema,
  ExperienceEventSchema,
  OwnerCorrectionSchema,
  OwnerIdSchema,
  ScopeSchema,
  SessionIdSchema,
  TaskIdSchema,
} from '@aven/contracts';
import {
  createLedger,
  LedgerError,
  type EventInput,
  type EvidenceInput,
} from '@aven/ledger';
import type { Storage } from '@aven/storage';
import { AVEN_010_CORRECTIONS_VERSION } from '../config.ts';
import { CorrectionError, type CorrectionErrorCode } from '../errors.ts';

/**
 * AVEN-010 patch 3: the in-process owner-correction recorder
 * (`@aven/corrections/ledger`). It is the ONLY AVEN-010 write.
 *
 * One call records one explicit, structured owner correction as exactly one
 * frozen AVEN-002 `owner_correction` experience event plus exactly one
 * `recorded_evidence` record holding the corrected instruction, in ONE call
 * to the frozen AVEN-004 `appendEvent`. The Ledger owns the transaction, the
 * recording clock, the frozen `corrections` projection, the reference
 * projections and every foreign-key check at COMMIT; this module writes no
 * table itself and starts no transaction.
 *
 * The submission is DECLARED owner input, not authenticated identity. The
 * caller supplies only the binding, the category, the structured target, the
 * two texts, an applicability discriminator and a durable scope hint. Event
 * type, IDs, provenance, metadata, recording time and the applicability
 * binding are derived here and cannot be supplied. Recording is not
 * application: nothing here resolves overrides, interprets text, writes owner
 * state, learns, suppresses context, grants permission or calls a model. A
 * `permission` correction is recorded like any other category and has no
 * authority effect.
 *
 * Owner-scoped read-only prechecks (owner, task binding, target, identifier
 * availability) give each failure a fixed, owner-local code; the Ledger
 * revalidates all of them at COMMIT and remains authoritative.
 */

export const CORRECTION_CREATION_COMPONENT = '@aven/corrections';

/**
 * Resource bounds on the raw submission, checked while it is copied (before
 * validation). They protect the process; they are not correction semantics.
 * The string bound matches the Context Broker's candidate text limit, so a
 * recorded instruction can later be offered without truncation.
 */
export const SUBMISSION_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 2048,
  maxArrayLength: 256,
  maxStringLength: 20000,
});

const shape = OwnerCorrectionSchema.shape;
type ApplicabilityKind = 'current_task' | 'current_session' | 'unspecified';
/** The frozen immediate-applicability kinds, read from the frozen contract. */
const APPLICABILITY_KINDS = shape.immediateApplicability.options.map(
  (option) => option.shape.kind.value,
) as [ApplicabilityKind, ...ApplicabilityKind[]];

const SubmissionSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  category: shape.category,
  target: CorrectionTargetSchema,
  originalBehavior: shape.originalBehavior,
  correctedInstruction: shape.correctedInstruction,
  immediateApplicability: z.enum(APPLICABILITY_KINDS),
  durableScopeHint: ScopeSchema,
});

/** The caller-facing submission (plain strings; every field is revalidated). */
export type CorrectionSubmission = z.input<typeof SubmissionSchema>;
export type CorrectionIdPrefix = 'event' | 'evidence';
export interface CorrectionRecordingOptions {
  /** Occurrence clock. Defaults to the system clock. Output is revalidated. */
  readonly now?: () => Date;
  /** Identifier suffix allocation. Defaults to random UUIDs. Revalidated. */
  readonly generateId?: (prefix: CorrectionIdPrefix) => string;
}
type ImmediateApplicability = z.output<typeof shape.immediateApplicability>;
/** Recording succeeded. It does not mean the correction was applied. */
export interface CorrectionReceipt {
  readonly ownerId: string;
  readonly eventId: string;
  readonly evidenceId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly immediateApplicability: Readonly<ImmediateApplicability>;
}

const fail = (code: CorrectionErrorCode): never => {
  throw new CorrectionError(code);
};

/** Internal sentinel for a rejected raw value; it never leaves this module. */
const REJECT = Object.freeze({ rejected: true });

/**
 * Copies caller data into inert null-prototype objects and plain arrays,
 * WITHOUT running caller code: Proxies are refused before any reflective
 * read, only own enumerable data properties are read (an accessor is refused
 * unread), symbol keys, non-plain prototypes, sparse or decorated arrays,
 * functions, undefined, bigint and non-finite numbers are refused, and the
 * depth, node, array and string bounds hold. Inherited fields are never
 * read. The realm's own intrinsics are trusted, as in AVEN-009.
 */
function inert(value: unknown, depth: number, budget: { nodes: number }) {
  budget.nodes += 1;
  if (budget.nodes > SUBMISSION_LIMITS.maxNodes) throw REJECT;
  if (typeof value === 'string') {
    if (value.length > SUBMISSION_LIMITS.maxStringLength) throw REJECT;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw REJECT;
    return value;
  }
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'object') throw REJECT;
  if (depth >= SUBMISSION_LIMITS.maxDepth || types.isProxy(value)) throw REJECT;
  const prototype = Object.getPrototypeOf(value) as unknown;
  const keys = Reflect.ownKeys(value);
  const read = (key: string): unknown => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw REJECT;
    return inert(descriptor.value, depth + 1, budget);
  };
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw REJECT;
    const length = keys.length - 1;
    if (length > SUBMISSION_LIMITS.maxArrayLength) throw REJECT;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor?.value !== length) throw REJECT;
    const copy: unknown[] = [];
    for (let i = 0; i < length; i += 1) copy.push(read(String(i)));
    return copy;
  }
  if (prototype !== Object.prototype && prototype !== null) throw REJECT;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw REJECT;
    Object.defineProperty(copy, key, {
      value: read(key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function parseSubmission(submission: unknown) {
  let copy: unknown;
  try {
    copy = inert(submission, 0, { nodes: 0 });
  } catch {
    return fail('invalid_submission');
  }
  const parsed = SubmissionSchema.safeParse(copy);
  return parsed.success ? parsed.data : fail('invalid_submission');
}

/** Options are trusted configuration, still read without running getters. */
function parseOptions(options: unknown) {
  let now: unknown;
  let generateId: unknown;
  if (options !== undefined) {
    if (
      options === null ||
      typeof options !== 'object' ||
      types.isProxy(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype &&
        Object.getPrototypeOf(options) !== null)
    )
      return fail('invalid_submission');
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(options, key);
      if (
        (key !== 'now' && key !== 'generateId') ||
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'function'
      )
        return fail('invalid_submission');
      if (key === 'now') now = descriptor.value;
      else generateId = descriptor.value;
    }
  }
  return {
    now: (now as (() => unknown) | undefined) ?? (() => new Date()),
    generateId:
      (generateId as ((prefix: CorrectionIdPrefix) => unknown) | undefined) ??
      ((prefix: CorrectionIdPrefix) => `${prefix}_${randomUUID()}`),
  };
}

function occurrenceTime(now: () => unknown): string {
  let value: unknown;
  try {
    value = now();
  } catch {
    return fail('internal_error');
  }
  if (
    !(value instanceof Date) ||
    Number.isNaN(Date.prototype.getTime.call(value))
  )
    return fail('internal_error');
  try {
    return Date.prototype.toISOString.call(value);
  } catch {
    return fail('internal_error');
  }
}

function generated<S extends z.ZodType>(
  schema: S,
  generate: (prefix: CorrectionIdPrefix) => unknown,
  prefix: CorrectionIdPrefix,
): z.output<S> {
  let value: unknown;
  try {
    value = generate(prefix);
  } catch {
    return fail('internal_error');
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail('internal_error');
}

/** Pinned owner-scoped, read-only precheck statements (no write, no scan of other owners). */
const PRECHECK_SQL = Object.freeze({
  owner: 'SELECT 1 AS found FROM owners WHERE owner_id = ?',
  task: 'SELECT session_id FROM tasks WHERE owner_id = ? AND task_id = ?',
  event:
    'SELECT 1 AS found FROM experience_events WHERE owner_id = ? AND record_id = ?',
  evidence:
    'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ?',
  evidenceOfEvent:
    'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ? AND event_id = ?',
  ownerState:
    "SELECT 1 AS found FROM record_versions WHERE owner_id = ? AND record_kind = 'owner_state' AND record_id = ? AND record_version = ?",
});

function lookup(
  storage: Storage,
  sql: string,
  ...values: (string | number)[]
): unknown {
  try {
    return storage.sqlite.prepare(sql).get(...values);
  } catch {
    return fail('storage_failure');
  }
}

type Submission = z.output<typeof SubmissionSchema>;

function precheck(
  storage: Storage,
  submission: Submission,
  eventId: string,
  evidenceId: string,
): void {
  let inTransaction: unknown;
  try {
    inTransaction = storage.sqlite.inTransaction;
  } catch {
    fail('storage_failure');
  }
  // The frozen Ledger appends only outside another transaction.
  if (inTransaction !== false) fail('storage_failure');
  const owner = submission.ownerId;
  if (lookup(storage, PRECHECK_SQL.owner, owner) === undefined)
    fail('unknown_binding');
  const task = lookup(storage, PRECHECK_SQL.task, owner, submission.taskId) as
    { session_id: unknown } | undefined;
  if (task === undefined || task.session_id !== submission.sessionId)
    fail('unknown_binding');
  const target = submission.target;
  const resolves =
    target.kind === 'unidentified'
      ? true
      : target.kind === 'event'
        ? lookup(storage, PRECHECK_SQL.event, owner, target.eventId) !==
          undefined
        : target.kind === 'evidence'
          ? lookup(
              storage,
              PRECHECK_SQL.evidenceOfEvent,
              owner,
              target.reference.evidenceId,
              target.reference.eventId,
            ) !== undefined
          : lookup(
              storage,
              PRECHECK_SQL.ownerState,
              owner,
              target.reference.learnedItemId,
              target.reference.version,
            ) !== undefined;
  if (!resolves) fail('unresolved_target');
  if (
    lookup(storage, PRECHECK_SQL.event, owner, eventId) !== undefined ||
    lookup(storage, PRECHECK_SQL.evidence, owner, evidenceId) !== undefined
  )
    fail('identifier_collision');
}

/**
 * Frozen Ledger outcomes after the prechecks passed. Only codes the Ledger
 * reports unambiguously get a specific diagnosis; anything else is a generic
 * storage failure or an internal inconsistency, never a guess.
 */
function fromLedger(error: unknown): CorrectionErrorCode {
  if (!(error instanceof LedgerError)) return 'internal_error';
  switch (error.code) {
    case 'unknown_owner':
    case 'unknown_session':
    case 'unknown_task':
      return 'unknown_binding';
    case 'duplicate_event':
      return 'identifier_collision';
    case 'invalid_reference':
    case 'transaction_active':
    case 'storage_failure':
    case 'integrity_failure':
      return 'storage_failure';
    default:
      // invalid_event: the prechecked contract can now fail only when the
      // Ledger's recording clock precedes the injected occurrence time.
      // invalid_input and cross_owner_reference cannot arise by construction.
      return 'internal_error';
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Records one explicit owner correction. Returns a frozen receipt only after
 * the Ledger COMMIT succeeded; every failure is a `CorrectionError` with a
 * fixed code and message, no cause, and nothing recorded by this call.
 */
export function recordOwnerCorrection(
  storage: Storage,
  submission: unknown,
  options?: CorrectionRecordingOptions,
): CorrectionReceipt {
  try {
    const input = parseSubmission(submission);
    const settings = parseOptions(options);
    const occurredAt = occurrenceTime(settings.now);
    const eventId = generated(EventIdSchema, settings.generateId, 'event');
    const evidenceId = generated(
      EvidenceIdSchema,
      settings.generateId,
      'evidence',
    );
    const target = input.target;
    if (
      (target.kind === 'event' && target.eventId === eventId) ||
      (target.kind === 'evidence' &&
        (target.reference.eventId === eventId ||
          target.reference.evidenceId === evidenceId))
    )
      fail('identifier_collision');

    const ownerId = input.ownerId;
    const task = { sessionId: input.sessionId, taskId: input.taskId };
    const immediateApplicability: ImmediateApplicability =
      input.immediateApplicability === 'current_task'
        ? { kind: 'current_task', task: { ...task } }
        : input.immediateApplicability === 'current_session'
          ? { kind: 'current_session', sessionId: input.sessionId }
          : { kind: 'unspecified' };
    const metadata = () => ({
      schemaVersion: 1 as const,
      recordVersion: 1 as const,
      createdAt: occurredAt,
      creation: {
        component: CORRECTION_CREATION_COMPONENT,
        version: AVEN_010_CORRECTIONS_VERSION,
      },
    });
    const origin = () => ({
      kind: 'explicit_owner_correction' as const,
      ownerId,
      sourceEventId: eventId,
    });
    const event: EventInput = {
      kind: 'experience_event',
      ownerId,
      metadata: metadata(),
      id: eventId,
      occurredAt,
      task,
      evidenceIds: [evidenceId],
      eventType: 'owner_correction',
      payload: {
        kind: 'owner_correction',
        ownerId,
        metadata: metadata(),
        evidence: { evidenceId, eventId },
        provenance: origin(),
        category: input.category,
        target,
        originalBehavior: input.originalBehavior,
        correctedInstruction: input.correctedInstruction,
        immediateApplicability,
        durableScopeHint: input.durableScopeHint,
      },
      provenance: origin(),
    };
    const evidence: EvidenceInput = {
      kind: 'recorded_evidence',
      ownerId,
      metadata: metadata(),
      id: evidenceId,
      eventId,
      provenance: origin(),
      content: { kind: 'recorded_text', text: input.correctedInstruction },
    };
    // Contract preflight with the occurrence time standing in for the
    // recording time: after it, only the Ledger's own clock can disagree.
    if (
      !ExperienceEventSchema.safeParse({ ...event, recordedAt: occurredAt })
        .success ||
      !EvidenceRecordSchema.safeParse({ ...evidence, recordedAt: occurredAt })
        .success
    )
      fail('internal_error');

    precheck(storage, input, eventId, evidenceId);

    let stored;
    try {
      stored = createLedger(storage, ownerId).appendEvent(event, {
        evidence: [evidence],
      });
    } catch (error) {
      return fail(fromLedger(error));
    }
    const committed = stored.event;
    if (committed.eventType !== 'owner_correction')
      return fail('internal_error');
    return freeze({
      ownerId: committed.ownerId,
      eventId: committed.id,
      evidenceId: committed.payload.evidence.evidenceId,
      sequence: stored.sequence,
      occurredAt: committed.occurredAt,
      recordedAt: committed.recordedAt,
      immediateApplicability: JSON.parse(
        JSON.stringify(committed.payload.immediateApplicability),
      ) as ImmediateApplicability,
    });
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError('internal_error');
  }
}
