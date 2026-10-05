import { z } from 'zod';
import {
  NonEmptyTextSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
  type SessionId,
  type TaskId,
} from '@aven/contracts';
import { ApiError } from './errors.ts';

/**
 * API-boundary schemas. These are transport shapes, not domain contracts: the
 * domain records are still built and validated by AVEN-002 contracts inside the
 * service and Ledger. Every object is strict, so no unknown field (for example
 * `role`, `provenance`, `eventType`, `ownerId`, `trusted`, `approved`) can
 * silently gain meaning.
 */

/** Generous local bound; owner text is stored verbatim, never trimmed or rewritten. */
export const MAX_MESSAGE_CHARACTERS = 65_536;
export const MAX_BODY_BYTES = 256 * 1024;

// A lone UTF-16 surrogate would be silently replaced when SQLite stores UTF-8,
// so the recorded evidence would differ from what the owner submitted.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const OwnerMessageBodySchema = z.strictObject({
  text: NonEmptyTextSchema.max(MAX_MESSAGE_CHARACTERS).refine(
    (s) => !LONE_SURROGATE.test(s),
    'Text must be well-formed Unicode',
  ),
});
export type OwnerMessageBody = z.infer<typeof OwnerMessageBodySchema>;

/** Creation requests carry no client-chosen fields in AVEN-005. */
export const EmptyBodySchema = z.strictObject({});

/** Page size bounds for every listing. Bounded below the Ledger's 1000 so one response stays a reasonable size. */
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;
/** A finite integer page size in 1..MAX_PAGE_LIMIT (rejects NaN, Infinity, fractions and non-numbers). */
export const PageLimitSchema = z.number().int().min(1).max(MAX_PAGE_LIMIT);
const CursorSchema = z.string().min(1).max(1024);
/**
 * Page parameters accepted by the exported service, independently of HTTP.
 * Other keys (for example a history `taskId`) are validated by their own code.
 */
export const ServicePageSchema = z.object({
  limit: PageLimitSchema,
  cursor: CursorSchema.optional(),
});

const limit = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/)
  .transform(Number)
  .pipe(PageLimitSchema)
  .default(DEFAULT_PAGE_LIMIT);

export const SessionListQuerySchema = z.strictObject({
  limit,
  cursor: CursorSchema.optional(),
});
export const TaskListQuerySchema = SessionListQuerySchema;
export const HistoryQuerySchema = z.strictObject({
  limit,
  cursor: CursorSchema.optional(),
  taskId: TaskIdSchema.optional(),
});

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Opaque to clients, but bound to the exact listing it continues. */
const IdentityCursorSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['sessions', 'tasks']),
  scope: z.string().min(1).max(256),
  createdAt: TimestampSchema,
  id: z.string().min(1).max(256),
});
const HistoryCursorSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('history'),
  ownerId: z.string().min(1).max(256),
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema.nullable(),
  afterSequence: sequence,
  throughSequence: sequence,
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decode<S extends z.ZodType>(schema: S, cursor: string): z.output<S> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Not base64url');
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    return schema.parse(parsed);
  } catch (cause) {
    throw new ApiError('invalid_request', cause);
  }
}

export interface IdentityPosition {
  readonly createdAt: string;
  readonly id: string;
}
export function encodeIdentityCursor(
  kind: 'sessions' | 'tasks',
  scope: string,
  position: IdentityPosition,
): string {
  return encode({
    v: 1,
    kind,
    scope,
    createdAt: position.createdAt,
    id: position.id,
  });
}
export function decodeIdentityCursor(
  kind: 'sessions' | 'tasks',
  scope: string,
  cursor: string,
): IdentityPosition {
  const value = decode(IdentityCursorSchema, cursor);
  if (value.kind !== kind || value.scope !== scope)
    throw new ApiError(
      'invalid_request',
      new Error('Cursor belongs to another listing'),
    );
  return { createdAt: value.createdAt, id: value.id };
}

export interface HistoryPosition {
  readonly afterSequence: number;
  readonly throughSequence: number;
}
export function encodeHistoryCursor(
  ownerId: string,
  sessionId: SessionId,
  taskId: TaskId | undefined,
  position: HistoryPosition,
): string {
  return encode({
    v: 1,
    kind: 'history',
    ownerId,
    sessionId,
    taskId: taskId ?? null,
    afterSequence: position.afterSequence,
    throughSequence: position.throughSequence,
  });
}
export function decodeHistoryCursor(
  ownerId: string,
  sessionId: SessionId,
  taskId: TaskId | undefined,
  cursor: string,
): HistoryPosition {
  const value = decode(HistoryCursorSchema, cursor);
  if (
    value.ownerId !== ownerId ||
    value.sessionId !== sessionId ||
    value.taskId !== (taskId ?? null)
  )
    throw new ApiError(
      'invalid_request',
      new Error('Cursor belongs to another history'),
    );
  return {
    afterSequence: value.afterSequence,
    throughSequence: value.throughSequence,
  };
}
