import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLedger } from '@aven/ledger';
import { OwnerIdSchema } from '@aven/contracts';
import { openStorage } from '@aven/storage';
import {
  ApiError,
  createApiService,
  type ApiService,
  type IdPrefix,
} from '../src/index.ts';
import {
  conversation,
  count,
  DERIVED_AND_AUTHORITY_TABLES,
  migratedStorage,
  OWNER_A,
  OWNER_B,
  setup,
  snapshot,
  tempDir,
} from './fixtures.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return (error as ApiError).code;
  }
  throw new Error('Expected an ApiError');
}

/** Deterministic, overridable ID allocation for collision tests. */
function scriptedIds(overrides: Partial<Record<IdPrefix, string[]>> = {}) {
  const counters: Record<IdPrefix, number> = {
    session: 0,
    task: 0,
    event: 0,
    evidence: 0,
  };
  return (prefix: IdPrefix) => {
    const scripted = overrides[prefix]?.shift();
    if (scripted) return scripted;
    counters[prefix] += 1;
    return `${prefix}_scripted_${String(counters[prefix]).padStart(4, '0')}`;
  };
}

function collect(
  service: ApiService,
  owner: string,
  sessionId: string,
  limit: number,
  taskId?: string,
) {
  const seen: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = service.readHistory(owner, sessionId, {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(taskId ? { taskId } : {}),
    });
    seen.push(...page.events.map((e) => e.sequence));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 1000);
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sessions (owner-scoped identity provisioning)', () => {
  it('creates, retrieves and lists a session for its owner', () => {
    const { service } = setup();
    const created = service.createSession(OWNER_A);
    expect(created.ownerId).toBe(OWNER_A);
    expect(created.sessionId).toMatch(/^session_[0-9a-f-]{36}$/);
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(service.getSession(OWNER_A, created.sessionId)).toEqual(created);
    expect(service.listSessions(OWNER_A, { limit: 50 })).toEqual({
      items: [created],
      nextCursor: null,
    });
  });

  it('creating a session records no Experience Ledger event or derived state', () => {
    const { storage, service } = setup();
    service.createSession(OWNER_A);
    expect(count(storage, 'experience_events')).toBe(0);
    expect(count(storage, 'evidence')).toBe(0);
    for (const table of DERIVED_AND_AUTHORITY_TABLES)
      expect(count(storage, table)).toBe(0);
  });

  it('a second owner cannot read, list or extend the first owner session', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service, OWNER_A);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'Synthetic A message',
    });
    const before = snapshot(storage);
    expect(code(() => service.getSession(OWNER_B, sessionId))).toBe(
      'session_not_found',
    );
    expect(
      code(() => service.readHistory(OWNER_B, sessionId, { limit: 10 })),
    ).toBe('session_not_found');
    expect(
      code(() => service.listTasks(OWNER_B, sessionId, { limit: 10 })),
    ).toBe('session_not_found');
    expect(code(() => service.createTask(OWNER_B, sessionId))).toBe(
      'session_not_found',
    );
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_B, sessionId, taskId, {
          text: 'Intrusion',
        }),
      ),
    ).toBe('session_not_found');
    expect(service.listSessions(OWNER_B, { limit: 50 }).items).toEqual([]);
    expect(snapshot(storage)).toEqual(before);
  });

  it('a foreign session is indistinguishable from a nonexistent one', () => {
    const { service } = setup();
    const { sessionId, taskId } = conversation(service, OWNER_A);
    const missing = 'session_does_not_exist';
    for (const target of [sessionId, missing]) {
      const errors = [
        () => service.getSession(OWNER_B, target),
        () => service.readHistory(OWNER_B, target, { limit: 10 }),
        () =>
          service.submitOwnerMessage(OWNER_B, target, taskId, {
            text: 'Probe',
          }),
      ].map((fn) => {
        try {
          fn();
        } catch (error) {
          return {
            code: (error as ApiError).code,
            message: (error as ApiError).message,
          };
        }
        return undefined;
      });
      expect(errors).toEqual([
        {
          code: 'session_not_found',
          message: 'Session not found for this owner',
        },
        {
          code: 'session_not_found',
          message: 'Session not found for this owner',
        },
        {
          code: 'session_not_found',
          message: 'Session not found for this owner',
        },
      ]);
    }
  });

  it('equal session IDs in two owner namespaces stay separate (lookup is never global)', () => {
    const ids = scriptedIds({ session: ['session_shared', 'session_shared'] });
    const { service } = setup({ generateId: ids });
    const a = conversation(service, OWNER_A);
    const b = conversation(service, OWNER_B);
    expect(a.sessionId).toBe('session_shared');
    expect(b.sessionId).toBe('session_shared');
    service.submitOwnerMessage(OWNER_A, a.sessionId, a.taskId, {
      text: 'Synthetic A',
    });
    service.submitOwnerMessage(OWNER_B, b.sessionId, b.taskId, {
      text: 'Synthetic B',
    });
    const historyA = service.readHistory(OWNER_A, 'session_shared', {
      limit: 10,
    });
    const historyB = service.readHistory(OWNER_B, 'session_shared', {
      limit: 10,
    });
    expect(historyA.events.map((e) => e.event.ownerId)).toEqual([OWNER_A]);
    expect(historyB.events.map((e) => e.event.ownerId)).toEqual([OWNER_B]);
    // B cannot use A's task inside B's same-named session.
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_B, 'session_shared', a.taskId, {
          text: 'x',
        }),
      ),
    ).toBe('task_not_found');
  });

  it('lists only the addressed owner sessions, paginated without duplicates or gaps', () => {
    const { service } = setup();
    const created = Array.from(
      { length: 7 },
      () => service.createSession(OWNER_A).sessionId,
    );
    for (let i = 0; i < 3; i += 1) service.createSession(OWNER_B);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.listSessions(OWNER_A, {
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.every((s) => s.ownerId === OWNER_A)).toBe(true);
      seen.push(...page.items.map((s) => s.sessionId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.length).toBe(7);
    expect(new Set(seen)).toEqual(new Set(created));
    expect(service.listSessions(OWNER_B, { limit: 200 }).items).toHaveLength(3);
  });

  it('orders sessions deterministically when creation times are equal or reversed', () => {
    const times = [
      '2026-10-04T12:00:02.000Z',
      '2026-10-04T12:00:01.000Z',
      '2026-10-04T12:00:01.000Z',
    ];
    const { service } = setup({
      now: () => new Date(times.shift() ?? '2026-10-04T12:00:00.000Z'),
      generateId: scriptedIds({
        session: ['session_c', 'session_b', 'session_a'],
      }),
    });
    for (let i = 0; i < 3; i += 1) service.createSession(OWNER_A);
    const order = () =>
      service
        .listSessions(OWNER_A, { limit: 50 })
        .items.map((s) => s.sessionId);
    expect(order()).toEqual(['session_a', 'session_b', 'session_c']);
    expect(order()).toEqual(order());
  });

  it('rejects a session-list cursor issued for another owner', () => {
    const { service } = setup();
    for (let i = 0; i < 3; i += 1) service.createSession(OWNER_A);
    const cursor = service.listSessions(OWNER_A, { limit: 1 }).nextCursor;
    expect(cursor).not.toBeNull();
    expect(
      code(() =>
        service.listSessions(OWNER_B, { limit: 1, cursor: cursor ?? '' }),
      ),
    ).toBe('invalid_request');
  });

  it('fails with owner_not_found for an undeclared owner and creates nothing', () => {
    const { storage, service } = setup();
    const before = snapshot(storage);
    expect(code(() => service.createSession('owner_undeclared'))).toBe(
      'owner_not_found',
    );
    expect(
      code(() => service.listSessions('owner_undeclared', { limit: 5 })),
    ).toBe('owner_not_found');
    expect(snapshot(storage)).toEqual(before);
  });

  it('owner provisioning is explicit and idempotent', () => {
    const { storage, service } = setup();
    expect(service.provisionOwner(OWNER_A)).toMatchObject({ created: false });
    expect(service.provisionOwner('owner_synthetic_c')).toMatchObject({
      created: true,
    });
    expect(count(storage, 'owners')).toBe(3);
    expect(code(() => service.provisionOwner('not-an-owner'))).toBe(
      'invalid_identifier',
    );
  });

  it('rejects malformed owner, session and task identifiers before touching storage', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const bad of [
      '',
      'owner_',
      'session_x',
      'owner_a b',
      'owner_💥',
      'OWNER_x',
      `owner_${'a'.repeat(200)}`,
      42,
      null,
    ])
      expect(code(() => service.createSession(bad))).toBe('invalid_identifier');
    for (const bad of ['task_x', 'session_', '../session_x', 'session_x/../y'])
      expect(code(() => service.getSession(OWNER_A, bad))).toBe(
        'invalid_identifier',
      );
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, sessionId, 'event_x', {
          text: 'x',
        }),
      ),
    ).toBe('invalid_identifier');
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, taskId, sessionId, { text: 'x' }),
      ),
    ).toBe('invalid_identifier');
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('tasks (minimal identity required by the owner_request contract)', () => {
  it('creates and lists task identities inside one session only', () => {
    const { service } = setup();
    const s1 = service.createSession(OWNER_A).sessionId;
    const s2 = service.createSession(OWNER_A).sessionId;
    const t1 = service.createTask(OWNER_A, s1);
    service.createTask(OWNER_A, s2);
    expect(t1).toMatchObject({ ownerId: OWNER_A, sessionId: s1 });
    expect(service.listTasks(OWNER_A, s1, { limit: 50 }).items).toEqual([t1]);
  });

  it('a task from another session of the same owner cannot be used', () => {
    const { storage, service } = setup();
    const one = conversation(service);
    const two = conversation(service);
    const before = snapshot(storage);
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, one.sessionId, two.taskId, {
          text: 'x',
        }),
      ),
    ).toBe('task_not_found');
    expect(
      code(() =>
        service.readHistory(OWNER_A, one.sessionId, {
          limit: 5,
          taskId: two.taskId,
        }),
      ),
    ).toBe('task_not_found');
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('owner message ingestion through the Experience Ledger', () => {
  it('records exactly one owner_request event with owner-statement evidence', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    const text =
      '  Synthetic message with surrounding spaces, émoji 🧪 and "quotes"  ';
    const receipt = service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text,
    });
    expect(receipt).toMatchObject({
      accepted: true,
      ownerId: OWNER_A,
      sessionId,
      taskId,
      eventType: 'owner_request',
      sequence: 1,
    });
    expect(count(storage, 'experience_events')).toBe(1);
    expect(count(storage, 'evidence')).toBe(1);

    const stored = createLedger(storage, OwnerIdSchema.parse(OWNER_A)).getEvent(
      receipt.eventId as never,
    );
    expect(stored?.sequence).toBe(receipt.sequence);
    const event = stored?.event;
    if (event?.eventType !== 'owner_request')
      throw new Error('Unexpected event type');
    // Verbatim owner text, never trimmed or rewritten.
    expect(event.payload.instruction).toBe(text);
    expect(event.payload.task).toEqual({ sessionId, taskId });
    expect(event.task).toEqual({ sessionId, taskId });
    expect(event.recordedAt).toBe(receipt.recordedAt);
    expect(event.occurredAt).toBe(receipt.occurredAt);
    expect(event.evidenceIds).toEqual([receipt.evidenceId]);
    expect(event.metadata.creation).toEqual({
      component: '@aven/api',
      version: '0.1.0',
    });
    // Owner-origin provenance originating at this exact event.
    expect(event.provenance).toEqual({
      kind: 'explicit_owner_statement',
      ownerId: OWNER_A,
      sourceEventId: receipt.eventId,
    });
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.evidence[0]).toMatchObject({
      id: receipt.evidenceId,
      eventId: receipt.eventId,
      ownerId: OWNER_A,
      provenance: event.provenance,
      content: { kind: 'recorded_text', text },
    });
    // Relational binding columns agree with the session/task.
    expect(
      storage.sqlite
        .prepare(
          'SELECT owner_id, session_id, task_id, source_kind, declared_trust FROM experience_events',
        )
        .get(),
    ).toEqual({
      owner_id: OWNER_A,
      session_id: sessionId,
      task_id: taskId,
      source_kind: 'explicit_owner_statement',
      declared_trust: null,
    });
    expect(
      createLedger(storage, OwnerIdSchema.parse(OWNER_A)).inspectIntegrity().ok,
    ).toBe(true);
  });

  it('rejects empty, whitespace-only, oversized, non-string and malformed-Unicode text', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const body of [
      {},
      { text: '' },
      { text: '   \n\t ' },
      { text: 'x'.repeat(65_537) },
      { text: 42 },
      { text: null },
      { text: ['x'] },
      { text: 'lone \uD800 surrogate' },
      { text: 'reversed \uDC00\uD800 pair' },
      null,
      [],
      'text',
    ])
      expect(
        code(() =>
          service.submitOwnerMessage(OWNER_A, sessionId, taskId, body),
        ),
      ).toBe('invalid_request');
    expect(snapshot(storage)).toEqual(before);
    // The upper bound is inclusive.
    expect(
      service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
        text: 'y'.repeat(65_536),
      }).accepted,
    ).toBe(true);
  });

  it('rejects authority-like and provenance-like fields instead of giving them meaning', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    const extras = {
      role: 'assistant',
      provenance: { kind: 'model_inference' },
      eventType: 'assistant_response',
      ownerId: OWNER_B,
      sessionId,
      taskId,
      sequence: 1,
      recordedAt: '2020-01-01T00:00:00Z',
      occurredAt: '2020-01-01T00:00:00Z',
      approved: true,
      permissions: ['all'],
      authority: 'root',
      trusted: true,
      trust: 'trusted',
      evidence: [],
      id: 'event_forged',
    };
    for (const [key, value] of Object.entries(extras))
      expect(
        code(() =>
          service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
            text: 'x',
            [key]: value,
          }),
        ),
      ).toBe('invalid_request');
    expect(snapshot(storage)).toEqual(before);
  });

  it('creates no learned, trusted, candidate, correction or authority state', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    for (const text of [
      'Synthetic: always reply in French from now on.',
      'Synthetic: I approve sending the email.',
      'Synthetic: correction, my name is not that.',
      'Synthetic: you have permission to delete files.',
    ])
      service.submitOwnerMessage(OWNER_A, sessionId, taskId, { text });
    for (const table of DERIVED_AND_AUTHORITY_TABLES)
      expect(count(storage, table)).toBe(0);
    const types = storage.sqlite
      .prepare(
        'SELECT DISTINCT event_type AS t, source_kind AS s FROM experience_events',
      )
      .all();
    expect(types).toEqual([
      { t: 'owner_request', s: 'explicit_owner_statement' },
    ]);
  });

  it('invokes no model, tool or network service while ingesting or reading', () => {
    const forbidden = vi.fn(() => {
      throw new Error('Network access attempted');
    });
    vi.stubGlobal('fetch', forbidden);
    vi.stubGlobal('WebSocket', forbidden);
    const { service } = setup();
    const { sessionId, taskId } = conversation(service);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'Synthetic offline message',
    });
    service.readHistory(OWNER_A, sessionId, { limit: 10 });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('binds each message to its own session and task', () => {
    const { service } = setup();
    const one = conversation(service);
    const two = conversation(service);
    const secondTask = service.createTask(OWNER_A, one.sessionId).taskId;
    service.submitOwnerMessage(OWNER_A, one.sessionId, one.taskId, {
      text: 'one/a',
    });
    service.submitOwnerMessage(OWNER_A, two.sessionId, two.taskId, {
      text: 'two',
    });
    service.submitOwnerMessage(OWNER_A, one.sessionId, secondTask, {
      text: 'one/b',
    });
    const texts = (sessionId: string, taskId?: string) =>
      service
        .readHistory(OWNER_A, sessionId, {
          limit: 50,
          ...(taskId ? { taskId } : {}),
        })
        .events.map((e) =>
          e.event.eventType === 'owner_request'
            ? e.event.payload.instruction
            : '',
        );
    expect(texts(one.sessionId)).toEqual(['one/a', 'one/b']);
    expect(texts(two.sessionId)).toEqual(['two']);
    expect(texts(one.sessionId, secondTask)).toEqual(['one/b']);
  });
});

describe('history reads (canonical Ledger order, no side effects)', () => {
  it('uses Ledger sequence order even when the clock moves backwards', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service } = setup();
    const { sessionId, taskId } = conversation(service);
    const clock = [
      '2026-10-04T15:00:00.000Z',
      '2026-10-04T13:00:00.000Z',
      '2026-10-04T14:00:00.000Z',
      '2026-10-04T13:00:00.000Z',
    ];
    const receipts = clock.map((time, i) => {
      vi.setSystemTime(new Date(time));
      return service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
        text: `m${String(i)}`,
      });
    });
    const events = service.readHistory(OWNER_A, sessionId, {
      limit: 50,
    }).events;
    expect(events.map((e) => e.event.id)).toEqual(
      receipts.map((r) => r.eventId),
    );
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    // Timestamps are preserved as claims but do not order history.
    expect(events.map((e) => e.event.occurredAt)).toEqual(clock);
    expect(events.map((e) => e.event.recordedAt)).toEqual(clock);
  });

  it('repeated reads return identical results and change nothing', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    for (let i = 0; i < 5; i += 1)
      service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
        text: `m${String(i)}`,
      });
    const before = snapshot(storage);
    const changes = storage.sqlite.prepare('SELECT total_changes() AS n').get();
    storage.sqlite.pragma('query_only = ON');
    const first = service.readHistory(OWNER_A, sessionId, { limit: 2 });
    for (let i = 0; i < 3; i += 1) {
      expect(service.readHistory(OWNER_A, sessionId, { limit: 2 })).toEqual(
        first,
      );
      service.getSession(OWNER_A, sessionId);
      service.listSessions(OWNER_A, { limit: 10 });
      service.listTasks(OWNER_A, sessionId, { limit: 10 });
    }
    storage.sqlite.pragma('query_only = OFF');
    expect(storage.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(
      changes,
    );
    expect(snapshot(storage)).toEqual(before);
  });

  it('paginates without duplicates or skips across interleaved sessions and owners', () => {
    const { service } = setup();
    const mine = conversation(service, OWNER_A);
    const other = conversation(service, OWNER_A);
    const foreign = conversation(service, OWNER_B);
    const expected: number[] = [];
    for (let i = 0; i < 23; i += 1) {
      expected.push(
        service.submitOwnerMessage(OWNER_A, mine.sessionId, mine.taskId, {
          text: `mine ${String(i)}`,
        }).sequence,
      );
      if (i % 2 === 0)
        service.submitOwnerMessage(OWNER_A, other.sessionId, other.taskId, {
          text: 'other',
        });
      if (i % 3 === 0)
        service.submitOwnerMessage(OWNER_B, foreign.sessionId, foreign.taskId, {
          text: 'foreign',
        });
    }
    for (const limit of [1, 2, 5, 7, 22, 23, 24, 200])
      expect(collect(service, OWNER_A, mine.sessionId, limit)).toEqual(
        expected,
      );
  });

  it('a history traversal is bounded at its first page and ignores later appends', () => {
    const { service } = setup();
    const { sessionId, taskId } = conversation(service);
    const expected = Array.from(
      { length: 6 },
      (_, i) =>
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
          text: `m${String(i)}`,
        }).sequence,
    );
    const first = service.readHistory(OWNER_A, sessionId, { limit: 2 });
    const later = service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'later',
    }).sequence;
    const seen = first.events.map((e) => e.sequence);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = service.readHistory(OWNER_A, sessionId, {
        limit: 2,
        cursor,
      });
      seen.push(...page.events.map((e) => e.sequence));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(expected);
    expect(collect(service, OWNER_A, sessionId, 2)).toEqual([
      ...expected,
      later,
    ]);
  });

  it('a cursor cannot read another owner, session or task history', () => {
    const ids = scriptedIds({ session: ['session_shared', 'session_shared'] });
    const { service } = setup({ generateId: ids });
    const a = conversation(service, OWNER_A);
    const b = conversation(service, OWNER_B);
    const aOther = conversation(service, OWNER_A);
    for (let i = 0; i < 4; i += 1) {
      service.submitOwnerMessage(OWNER_A, a.sessionId, a.taskId, {
        text: `secret A ${String(i)}`,
      });
      service.submitOwnerMessage(OWNER_B, b.sessionId, b.taskId, {
        text: `B ${String(i)}`,
      });
    }
    const cursorA =
      service.readHistory(OWNER_A, a.sessionId, { limit: 1 }).nextCursor ?? '';
    // Same session ID string, other owner: rejected, not reinterpreted.
    expect(
      code(() =>
        service.readHistory(OWNER_B, b.sessionId, {
          limit: 1,
          cursor: cursorA,
        }),
      ),
    ).toBe('invalid_request');
    expect(
      code(() =>
        service.readHistory(OWNER_A, aOther.sessionId, {
          limit: 1,
          cursor: cursorA,
        }),
      ),
    ).toBe('invalid_request');
    expect(
      code(() =>
        service.readHistory(OWNER_A, a.sessionId, {
          limit: 1,
          cursor: cursorA,
          taskId: a.taskId,
        }),
      ),
    ).toBe('invalid_request');
    // A forged cursor naming owner B's own scope still only yields B's events.
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'history',
        ownerId: OWNER_B,
        sessionId: b.sessionId,
        taskId: null,
        afterSequence: 0,
        throughSequence: Number.MAX_SAFE_INTEGER,
      }),
    ).toString('base64url');
    const page = service.readHistory(OWNER_B, b.sessionId, {
      limit: 100,
      cursor: forged,
    });
    expect(page.events.every((e) => e.event.ownerId === OWNER_B)).toBe(true);
    expect(page.events).toHaveLength(4);
    for (const bad of [
      '%%%',
      'e30',
      Buffer.from('{"v":2}').toString('base64url'),
      'x'.repeat(2000),
    ])
      expect(
        code(() =>
          service.readHistory(OWNER_A, a.sessionId, { limit: 1, cursor: bad }),
        ),
      ).toBe('invalid_request');
  });
});

describe('atomicity, conflicts and typed storage failures', () => {
  it('a failed append leaves no partial message, evidence, catalog entry or sequence', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, { text: 'before' });
    const before = snapshot(storage);
    // Test-only fault injection: the event row is inserted, then evidence fails.
    storage.sqlite.exec(
      "CREATE TEMP TRIGGER inject_fault BEFORE INSERT ON evidence BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
    );
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
          text: 'lost',
        }),
      ),
    ).toBe('storage_failure');
    expect(snapshot(storage)).toEqual(before);
    storage.sqlite.exec('DROP TRIGGER inject_fault');
    // The connection remains usable and the next sequence continues normally.
    const next = service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'after',
    });
    expect(next.sequence).toBe(2);
    expect(
      createLedger(storage, OwnerIdSchema.parse(OWNER_A)).inspectIntegrity().ok,
    ).toBe(true);
  });

  it('writer contention becomes storage_failure with nothing recorded', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, 'contention.sqlite');
      const { storage, service } = setup({}, file);
      const { sessionId, taskId } = conversation(service);
      storage.sqlite.pragma('busy_timeout = 0');
      const other = openStorage(file);
      other.sqlite.exec('BEGIN IMMEDIATE');
      const before = snapshot(storage);
      try {
        expect(
          code(() =>
            service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
              text: 'x',
            }),
          ),
        ).toBe('storage_failure');
        expect(code(() => service.createSession(OWNER_A))).toBe(
          'storage_failure',
        );
      } finally {
        other.sqlite.exec('ROLLBACK');
        other.close();
      }
      expect(snapshot(storage)).toEqual(before);
      storage.close();
    } finally {
      cleanup();
    }
  });

  it('a closed database yields storage_failure, never a raw driver error', () => {
    const { storage, service } = setup();
    const { sessionId, taskId } = conversation(service);
    storage.close();
    for (const fn of [
      () => service.createSession(OWNER_A),
      () => service.getSession(OWNER_A, sessionId),
      () =>
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, { text: 'x' }),
      () => service.readHistory(OWNER_A, sessionId, { limit: 1 }),
    ]) {
      try {
        fn();
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('storage_failure');
        expect((error as ApiError).message).not.toMatch(
          /sqlite|database connection|TypeError/i,
        );
      }
    }
  });

  it('a colliding event ID is a conflict and never overwrites history', () => {
    const ids = scriptedIds({ event: ['event_fixed', 'event_fixed'] });
    const { storage, service } = setup({ generateId: ids });
    const { sessionId, taskId } = conversation(service);
    const first = service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'original',
    });
    const before = snapshot(storage);
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
          text: 'replacement',
        }),
      ),
    ).toBe('conflict');
    expect(snapshot(storage)).toEqual(before);
    const stored = service.readHistory(OWNER_A, sessionId, {
      limit: 10,
    }).events;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event.id).toBe(first.eventId);
    expect(
      stored[0]?.event.eventType === 'owner_request' &&
        stored[0].event.payload.instruction,
    ).toBe('original');
  });

  it('a colliding evidence ID is rejected as a reference failure with nothing recorded', () => {
    const ids = scriptedIds({ evidence: ['evidence_fixed', 'evidence_fixed'] });
    const { storage, service } = setup({ generateId: ids });
    const { sessionId, taskId } = conversation(service);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'original',
    });
    const before = snapshot(storage);
    expect(
      code(() =>
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
          text: 'second',
        }),
      ),
    ).toBe('invalid_reference');
    expect(snapshot(storage)).toEqual(before);
  });

  it('colliding session and task IDs are conflicts and change nothing', () => {
    const ids = scriptedIds({
      session: ['session_fixed', 'session_fixed'],
      task: ['task_fixed', 'task_fixed'],
    });
    const { storage, service } = setup({ generateId: ids });
    const first = service.createSession(OWNER_A);
    const task = service.createTask(OWNER_A, first.sessionId);
    const before = snapshot(storage);
    // Both scripted IDs are now exhausted by these two colliding attempts.
    expect(code(() => service.createSession(OWNER_A))).toBe('conflict');
    expect(code(() => service.createTask(OWNER_A, first.sessionId))).toBe(
      'conflict',
    );
    expect(snapshot(storage)).toEqual(before);
    expect(service.getSession(OWNER_A, first.sessionId)).toEqual(first);
    expect(
      service.listTasks(OWNER_A, first.sessionId, { limit: 10 }).items,
    ).toEqual([task]);
  });

  it('task IDs are owner-wide: reuse in another session of the same owner conflicts', () => {
    const ids = scriptedIds({ task: ['task_fixed', 'task_fixed'] });
    const { storage, service } = setup({ generateId: ids });
    const s1 = service.createSession(OWNER_A).sessionId;
    const s2 = service.createSession(OWNER_A).sessionId;
    service.createTask(OWNER_A, s1);
    const before = snapshot(storage);
    expect(code(() => service.createTask(OWNER_A, s2))).toBe('conflict');
    expect(snapshot(storage)).toEqual(before);
  });

  it('invalid generated identifiers fail closed as internal errors', () => {
    const { storage, service } = setup({ generateId: () => 'not a valid id' });
    const before = snapshot(storage);
    expect(code(() => service.createSession(OWNER_A))).toBe('internal_error');
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('service-level page validation (independent of HTTP)', () => {
  it('rejects invalid page limits on every listing with invalid_request and reads nothing', () => {
    const { service, storage } = setup();
    const { sessionId, taskId } = conversation(service);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, { text: 'x' });
    const before = snapshot(storage);
    const listings = {
      sessions: (q: unknown) => service.listSessions(OWNER_A, q as never),
      tasks: (q: unknown) => service.listTasks(OWNER_A, sessionId, q as never),
      history: (q: unknown) =>
        service.readHistory(OWNER_A, sessionId, q as never),
    };
    const badLimits: unknown[] = [
      0,
      -1,
      -0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      201,
      1000,
      Number.MAX_SAFE_INTEGER,
      '10',
      null,
      undefined,
      true,
      {},
      [10],
      10n,
    ];
    for (const [name, list] of Object.entries(listings)) {
      for (const limit of badLimits)
        expect(
          code(() => list({ limit })),
          `${name} limit ${String(limit)}`,
        ).toBe('invalid_request');
      for (const query of [null, undefined, 'limit=10', 42])
        expect(
          code(() => list(query)),
          `${name} query ${String(query)}`,
        ).toBe('invalid_request');
      for (const cursor of [42, '', {}, 'x'.repeat(1025)])
        expect(
          code(() => list({ limit: 10, cursor })),
          `${name} cursor`,
        ).toBe('invalid_request');
      // The documented bounds are inclusive.
      expect(() => list({ limit: 1 })).not.toThrow();
      expect(() => list({ limit: 200 })).not.toThrow();
    }
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('durable reopen', () => {
  it('history survives closing and reopening the database file', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, 'reopen.sqlite');
      const first = setup({}, file);
      const { sessionId, taskId } = conversation(first.service);
      const receipts = [1, 2, 3].map((i) =>
        first.service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
          text: `m${String(i)}`,
        }),
      );
      first.storage.close();
      const storage = migratedStorage(file);
      const service = createApiService(storage);
      expect(
        service
          .readHistory(OWNER_A, sessionId, { limit: 10 })
          .events.map((e) => e.event.id),
      ).toEqual(receipts.map((r) => r.eventId));
      expect(
        service.submitOwnerMessage(OWNER_A, sessionId, taskId, { text: 'm4' })
          .sequence,
      ).toBe(4);
      storage.close();
    } finally {
      cleanup();
    }
  });
});
