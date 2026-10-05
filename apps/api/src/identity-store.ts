import { and, asc, eq, gt, or } from 'drizzle-orm';
import type { OwnerId, SessionId, TaskId } from '@aven/contracts';
import { schema, type Storage } from '@aven/storage';
import { ApiError } from './errors.ts';
import type { IdentityPosition } from './schemas.ts';

/**
 * Explicit identity provisioning over the frozen AVEN-003 `owners`, `sessions`
 * and `tasks` tables, which the Ledger deliberately leaves to its caller.
 *
 * Every read and write is keyed by the owner. A session or task ID alone never
 * selects a row: AVEN-003 identity is `(owner_id, session_id)` and
 * `(owner_id, task_id)`, so another owner's session is indistinguishable from a
 * nonexistent one. This module only inserts and reads; it never updates or
 * deletes, and it writes nothing to history or owner state.
 */

export interface SessionRecord {
  readonly ownerId: OwnerId;
  readonly sessionId: SessionId;
  readonly createdAt: string;
}
export interface TaskRecord {
  readonly ownerId: OwnerId;
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly createdAt: string;
}
export interface IdentityPage<T> {
  readonly items: readonly T[];
  readonly next: IdentityPosition | null;
}

export function createIdentityStore(storage: Storage) {
  const { db, sqlite } = storage;

  function independent() {
    if (sqlite.inTransaction)
      throw new ApiError(
        'storage_failure',
        new Error('Caller transaction already active'),
      );
  }
  /** Short owner-checked read; fails `owner_not_found` before any lookup. */
  function read<T>(ownerId: OwnerId, fn: () => T): T {
    independent();
    return sqlite
      .transaction(() => {
        requireOwner(ownerId);
        return fn();
      })
      .deferred();
  }
  /** Serialized write under SQLite's writer lock (`BEGIN IMMEDIATE`). */
  function write<T>(ownerId: OwnerId, fn: () => T): T {
    independent();
    return sqlite
      .transaction(() => {
        requireOwner(ownerId);
        return fn();
      })
      .immediate();
  }
  function requireOwner(ownerId: OwnerId) {
    const owner = db
      .select({ ownerId: schema.owners.ownerId })
      .from(schema.owners)
      .where(eq(schema.owners.ownerId, ownerId))
      .get();
    if (!owner) throw new ApiError('owner_not_found');
  }
  function sessionRow(ownerId: OwnerId, sessionId: SessionId) {
    return db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.ownerId, ownerId),
          eq(schema.sessions.sessionId, sessionId),
        ),
      )
      .get();
  }
  function requireSession(
    ownerId: OwnerId,
    sessionId: SessionId,
  ): SessionRecord {
    const row = sessionRow(ownerId, sessionId);
    if (!row) throw new ApiError('session_not_found');
    return session(row);
  }
  function session(row: {
    ownerId: string;
    sessionId: string;
    createdAt: string;
  }): SessionRecord {
    return {
      ownerId: row.ownerId as OwnerId,
      sessionId: row.sessionId as SessionId,
      createdAt: row.createdAt,
    };
  }
  function task(row: {
    ownerId: string;
    sessionId: string;
    taskId: string;
    createdAt: string;
  }): TaskRecord {
    return {
      ownerId: row.ownerId as OwnerId,
      sessionId: row.sessionId as SessionId,
      taskId: row.taskId as TaskId,
      createdAt: row.createdAt,
    };
  }
  function page<T, R extends { createdAt: string }>(
    rows: R[],
    limit: number,
    map: (row: R) => T,
    id: (row: R) => string,
  ): IdentityPage<T> {
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(map),
      next:
        rows.length > limit && last
          ? { createdAt: last.createdAt, id: id(last) }
          : null,
    };
  }

  return Object.freeze({
    /** Operator-level, idempotent declaration of a local owner. Not exposed over HTTP. */
    provisionOwner(ownerId: OwnerId, createdAt: string): { created: boolean } {
      independent();
      return sqlite
        .transaction(() => {
          const existing = db
            .select({ ownerId: schema.owners.ownerId })
            .from(schema.owners)
            .where(eq(schema.owners.ownerId, ownerId))
            .get();
          if (existing) return { created: false };
          db.insert(schema.owners).values({ ownerId, createdAt }).run();
          return { created: true };
        })
        .immediate();
    },

    createSession(
      ownerId: OwnerId,
      sessionId: SessionId,
      createdAt: string,
    ): SessionRecord {
      return write(ownerId, () => {
        if (sessionRow(ownerId, sessionId)) throw new ApiError('conflict');
        db.insert(schema.sessions)
          .values({ ownerId, sessionId, createdAt })
          .run();
        return requireSession(ownerId, sessionId);
      });
    },

    getSession(ownerId: OwnerId, sessionId: SessionId): SessionRecord {
      return read(ownerId, () => requireSession(ownerId, sessionId));
    },

    listSessions(
      ownerId: OwnerId,
      limit: number,
      after: IdentityPosition | undefined,
    ): IdentityPage<SessionRecord> {
      return read(ownerId, () => {
        const s = schema.sessions;
        const rows = db
          .select()
          .from(s)
          .where(
            and(
              eq(s.ownerId, ownerId),
              after
                ? or(
                    gt(s.createdAt, after.createdAt),
                    and(
                      eq(s.createdAt, after.createdAt),
                      gt(s.sessionId, after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(s.createdAt), asc(s.sessionId))
          .limit(limit + 1)
          .all();
        return page(rows, limit, session, (r) => r.sessionId);
      });
    },

    createTask(
      ownerId: OwnerId,
      sessionId: SessionId,
      taskId: TaskId,
      createdAt: string,
    ): TaskRecord {
      return write(ownerId, () => {
        requireSession(ownerId, sessionId);
        // Task IDs are unique per owner across all of that owner's sessions.
        const existing = db
          .select({ taskId: schema.tasks.taskId })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.ownerId, ownerId),
              eq(schema.tasks.taskId, taskId),
            ),
          )
          .get();
        if (existing) throw new ApiError('conflict');
        db.insert(schema.tasks)
          .values({ ownerId, sessionId, taskId, createdAt })
          .run();
        return { ownerId, sessionId, taskId, createdAt };
      });
    },

    /** Task must exist for this owner and belong to exactly this session. */
    requireTask(
      ownerId: OwnerId,
      sessionId: SessionId,
      taskId: TaskId,
    ): TaskRecord {
      return read(ownerId, () => {
        requireSession(ownerId, sessionId);
        const row = db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.ownerId, ownerId),
              eq(schema.tasks.sessionId, sessionId),
              eq(schema.tasks.taskId, taskId),
            ),
          )
          .get();
        if (!row) throw new ApiError('task_not_found');
        return task(row);
      });
    },

    listTasks(
      ownerId: OwnerId,
      sessionId: SessionId,
      limit: number,
      after: IdentityPosition | undefined,
    ): IdentityPage<TaskRecord> {
      return read(ownerId, () => {
        requireSession(ownerId, sessionId);
        const t = schema.tasks;
        const rows = db
          .select()
          .from(t)
          .where(
            and(
              eq(t.ownerId, ownerId),
              eq(t.sessionId, sessionId),
              after
                ? or(
                    gt(t.createdAt, after.createdAt),
                    and(
                      eq(t.createdAt, after.createdAt),
                      gt(t.taskId, after.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(t.createdAt), asc(t.taskId))
          .limit(limit + 1)
          .all();
        return page(rows, limit, task, (r) => r.taskId);
      });
    },
  });
}
export type IdentityStore = ReturnType<typeof createIdentityStore>;
