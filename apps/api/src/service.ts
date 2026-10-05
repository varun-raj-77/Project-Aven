import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  EventIdSchema,
  EvidenceIdSchema,
  OwnerIdSchema,
  SessionIdSchema,
  TaskBindingSchema,
  TaskIdSchema,
  type EvidenceRecord,
  type ExperienceEvent,
  type OwnerId,
  type SessionId,
  type TaskId,
} from '@aven/contracts';
import {
  createLedger,
  type EventInput,
  type EvidenceInput,
} from '@aven/ledger';
import type { Storage } from '@aven/storage';
import { ApiError, toApiError } from './errors.ts';
import {
  createIdentityStore,
  type SessionRecord,
  type TaskRecord,
} from './identity-store.ts';
import {
  decodeHistoryCursor,
  decodeIdentityCursor,
  encodeHistoryCursor,
  encodeIdentityCursor,
  OwnerMessageBodySchema,
  ServicePageSchema,
} from './schemas.ts';

/** Recorded as `metadata.creation` on every event this boundary records. */
export const API_COMPONENT = '@aven/api';
export const API_VERSION = '0.1.0';

export type IdPrefix = 'session' | 'task' | 'event' | 'evidence';
export interface ServiceOptions {
  /** Clock for identity creation and owner-message occurrence. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Identifier suffix allocation. Defaults to random UUIDs. Output is revalidated. */
  readonly generateId?: (prefix: IdPrefix) => string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface MessageReceipt {
  readonly accepted: true;
  readonly ownerId: OwnerId;
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly eventId: string;
  readonly evidenceId: string;
  readonly eventType: 'owner_request';
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
}
export interface HistoryEntry {
  readonly sequence: number;
  readonly event: ExperienceEvent;
  readonly evidence: readonly EvidenceRecord[];
}
export interface HistoryPage {
  readonly ownerId: OwnerId;
  readonly sessionId: SessionId;
  readonly taskId: TaskId | null;
  readonly events: readonly HistoryEntry[];
  readonly nextCursor: string | null;
}

function parseId<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('invalid_identifier');
  return result.data;
}
export const parseOwnerId = (v: unknown): OwnerId => parseId(OwnerIdSchema, v);
export const parseSessionId = (v: unknown): SessionId =>
  parseId(SessionIdSchema, v);
export const parseTaskId = (v: unknown): TaskId => parseId(TaskIdSchema, v);

/**
 * Page parameters are validated here as well as at HTTP, so direct callers of
 * the exported service get the same bounds and the same typed failure.
 */
function parsePage(query: unknown): {
  limit: number;
  cursor: string | undefined;
} {
  const result = ServicePageSchema.safeParse(query);
  if (!result.success) throw new ApiError('invalid_request', result.error);
  return { limit: result.data.limit, cursor: result.data.cursor };
}

/**
 * Validated application operations between HTTP and storage/Ledger.
 *
 * Owner identity is a declared path value, not an authenticated principal.
 * Accepting a message records that it was submitted; it does not authorize any
 * action, create owner state, or invoke a model, tool, or network service.
 */
export function createApiService(
  storage: Storage,
  options: ServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const generate =
    options.generateId ?? ((prefix: IdPrefix) => `${prefix}_${randomUUID()}`);
  const identities = createIdentityStore(storage);

  function timestamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime()))
      throw new ApiError('internal_error', new Error('Invalid clock value'));
    return value.toISOString();
  }
  function allocate<S extends z.ZodType>(
    prefix: IdPrefix,
    schema: S,
  ): z.output<S> {
    const result = schema.safeParse(generate(prefix));
    if (!result.success)
      throw new ApiError(
        'internal_error',
        new Error(`Generated ${prefix} ID is invalid`),
      );
    return result.data;
  }
  /** Every public operation surfaces only typed ApiErrors. */
  function guard<A extends unknown[], R>(
    fn: (...args: A) => R,
  ): (...args: A) => R {
    return (...args: A) => {
      try {
        return fn(...args);
      } catch (error) {
        throw toApiError(error);
      }
    };
  }

  function provisionOwner(owner: unknown) {
    const ownerId = parseOwnerId(owner);
    return { ownerId, ...identities.provisionOwner(ownerId, timestamp()) };
  }

  function createSession(owner: unknown): SessionRecord {
    const ownerId = parseOwnerId(owner);
    return identities.createSession(
      ownerId,
      allocate('session', SessionIdSchema),
      timestamp(),
    );
  }

  function getSession(owner: unknown, session: unknown): SessionRecord {
    return identities.getSession(parseOwnerId(owner), parseSessionId(session));
  }

  function listSessions(
    owner: unknown,
    query: { limit: number; cursor?: string | undefined },
  ): Page<SessionRecord> {
    const ownerId = parseOwnerId(owner);
    const { limit, cursor } = parsePage(query);
    const after = cursor
      ? decodeIdentityCursor('sessions', ownerId, cursor)
      : undefined;
    const result = identities.listSessions(ownerId, limit, after);
    return {
      items: result.items,
      nextCursor: result.next
        ? encodeIdentityCursor('sessions', ownerId, result.next)
        : null,
    };
  }

  function createTask(owner: unknown, session: unknown): TaskRecord {
    const ownerId = parseOwnerId(owner);
    const sessionId = parseSessionId(session);
    return identities.createTask(
      ownerId,
      sessionId,
      allocate('task', TaskIdSchema),
      timestamp(),
    );
  }

  function listTasks(
    owner: unknown,
    session: unknown,
    query: { limit: number; cursor?: string | undefined },
  ): Page<TaskRecord> {
    const ownerId = parseOwnerId(owner);
    const sessionId = parseSessionId(session);
    const { limit, cursor } = parsePage(query);
    const scope = `${ownerId}/${sessionId}`;
    const after = cursor
      ? decodeIdentityCursor('tasks', scope, cursor)
      : undefined;
    const result = identities.listTasks(ownerId, sessionId, limit, after);
    return {
      items: result.items,
      nextCursor: result.next
        ? encodeIdentityCursor('tasks', scope, result.next)
        : null,
    };
  }

  /**
   * Records one owner message as an AVEN-002 `owner_request` event with one
   * owner-statement evidence record, through the AVEN-004 Ledger in a single
   * atomic append. The receipt is returned only after COMMIT succeeds.
   */
  function submitOwnerMessage(
    owner: unknown,
    session: unknown,
    taskValue: unknown,
    body: unknown,
  ): MessageReceipt {
    const ownerId = parseOwnerId(owner);
    const sessionId = parseSessionId(session);
    const taskId = parseTaskId(taskValue);
    const parsed = OwnerMessageBodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError('invalid_request', parsed.error);
    const { text } = parsed.data;

    // Clear 404s for the client. The Ledger re-verifies every binding inside its
    // own write transaction, so this pre-check is not the authority.
    identities.requireTask(ownerId, sessionId, taskId);

    const eventId = allocate('event', EventIdSchema);
    const evidenceId = allocate('evidence', EvidenceIdSchema);
    const occurredAt = timestamp();
    const task = TaskBindingSchema.parse({ sessionId, taskId });
    const metadata = {
      schemaVersion: 1 as const,
      recordVersion: 1 as const,
      createdAt: occurredAt,
      creation: { component: API_COMPONENT, version: API_VERSION },
    };
    // Explicit owner-statement provenance originating at this very event. The
    // API cannot be asked to record any other provenance or event type.
    const provenance = {
      kind: 'explicit_owner_statement' as const,
      ownerId,
      sourceEventId: eventId,
    };
    const event: EventInput = {
      kind: 'experience_event',
      ownerId,
      metadata,
      id: eventId,
      occurredAt,
      task,
      evidenceIds: [evidenceId],
      eventType: 'owner_request',
      payload: { instruction: text, task },
      provenance,
    };
    const evidence: EvidenceInput = {
      kind: 'recorded_evidence',
      ownerId,
      metadata,
      id: evidenceId,
      eventId,
      provenance,
      content: { kind: 'recorded_text', text },
    };
    const stored = createLedger(storage, ownerId).appendEvent(event, {
      evidence: [evidence],
    });
    return {
      accepted: true,
      ownerId,
      sessionId,
      taskId,
      eventId: stored.event.id,
      evidenceId,
      eventType: 'owner_request',
      sequence: stored.sequence,
      occurredAt: stored.event.occurredAt,
      recordedAt: stored.event.recordedAt,
    };
  }

  /**
   * Session history is a read of canonical Ledger records in Ledger sequence
   * order, never a second store. It is side-effect free.
   */
  function readHistory(
    owner: unknown,
    session: unknown,
    query: { limit: number; cursor?: string | undefined; taskId?: unknown },
  ): HistoryPage {
    const ownerId = parseOwnerId(owner);
    const sessionId = parseSessionId(session);
    const { limit, cursor } = parsePage(query);
    const taskId =
      query.taskId === undefined ? undefined : parseTaskId(query.taskId);
    if (taskId) identities.requireTask(ownerId, sessionId, taskId);
    else identities.getSession(ownerId, sessionId);
    const position = cursor
      ? decodeHistoryCursor(ownerId, sessionId, taskId, cursor)
      : undefined;
    const page = createLedger(storage, ownerId).listEvents({
      sessionId,
      ...(taskId ? { taskId } : {}),
      ...(position ?? {}),
      limit,
    });
    return {
      ownerId,
      sessionId,
      taskId: taskId ?? null,
      events: page.events.map((e) => ({
        sequence: e.sequence,
        event: e.event,
        evidence: e.evidence,
      })),
      nextCursor: page.nextCursor
        ? encodeHistoryCursor(ownerId, sessionId, taskId, page.nextCursor)
        : null,
    };
  }

  return Object.freeze({
    provisionOwner: guard(provisionOwner),
    createSession: guard(createSession),
    getSession: guard(getSession),
    listSessions: guard(listSessions),
    createTask: guard(createTask),
    listTasks: guard(listTasks),
    submitOwnerMessage: guard(submitOwnerMessage),
    readHistory: guard(readHistory),
  });
}
export type ApiService = ReturnType<typeof createApiService>;
