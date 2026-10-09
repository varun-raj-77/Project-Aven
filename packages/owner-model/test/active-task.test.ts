import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildActiveTaskView,
  isActiveTaskView,
  type ActiveTaskView,
  type ActiveTaskViewRequest,
} from '../src/active-task.ts';
import { verifyLifecycleClaims } from '../src/claims.ts';
import { OwnerModelError, type OwnerModelErrorCode } from '../src/errors.ts';
import * as publicApi from '../src/index.ts';
import { intakeOwnerState, type OwnerStateIntake } from '../src/intake.ts';
import { buildDurableLineage } from '../src/lineage.ts';
import { buildDurableCategoryViews } from '../src/views.ts';
import {
  activeTask,
  deeplyFrozen,
  durable,
  FOREIGN,
  OWNER,
  shuffled,
  T0,
  T1,
  T2,
} from './fixtures.ts';

/**
 * AVEN-009 patch 6: task-bound active task state view. Every owner, ID and
 * text is SYNTHETIC (see fixtures.ts). These are mechanics checks of exact
 * binding, per-ID head selection, closed heads, ambiguity, inert request
 * reading, immutability and boundaries. Nothing here expires, ranks,
 * executes or decides anything.
 */
type Json = Record<string, unknown>;

const S1 = 'session_s1';
const S2 = 'session_s2';
const K1 = 'task_s1';
const K2 = 'task_s2';
const REQUEST: ActiveTaskViewRequest = { sessionId: S1, taskId: K1 };

const closed = (outcome: 'completed' | 'cancelled'): Json => ({
  status: 'closed',
  closedAt: T2,
  outcome,
});

/** One synthetic active-task-state snapshot. */
function task(
  id: string,
  version = 1,
  options: {
    sessionId?: string;
    taskId?: string;
    lifecycle?: Json;
    createdAt?: string;
    openLoops?: string[];
    sourceEvidence?: Json[];
    objective?: string;
    ownerId?: string;
  } = {},
): Json {
  const base = activeTask({
    id,
    version,
    createdAt: options.createdAt ?? T0,
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
  });
  return {
    ...base,
    task: { sessionId: options.sessionId ?? S1, taskId: options.taskId ?? K1 },
    lifecycle: options.lifecycle ?? { status: 'active' },
    ...(options.openLoops === undefined
      ? {}
      : { openLoops: options.openLoops }),
    ...(options.sourceEvidence === undefined
      ? {}
      : { sourceEvidence: options.sourceEvidence }),
    ...(options.objective === undefined
      ? {}
      : { objective: options.objective }),
  };
}

const intake = (records: unknown[]): OwnerStateIntake =>
  intakeOwnerState({ ownerId: OWNER, records });
const view = (
  records: unknown[],
  request: ActiveTaskViewRequest = REQUEST,
): ActiveTaskView | undefined => buildActiveTaskView(intake(records), request);
/** `id@version` of the returned state, or 'none'. */
const pick = (records: unknown[], request = REQUEST) => {
  const result = view(records, request);
  return result === undefined
    ? 'none'
    : `${result.state.id}@${result.state.metadata.recordVersion}`;
};

const MESSAGES: Record<OwnerModelErrorCode, string> = {
  invalid_input: 'The owner-model input is malformed; no owner state was read',
  internal_error:
    'The owner model failed an internal consistency check; no owner state was read',
  conflicting_duplicate:
    'Owner-state records share an identity and version but disagree; no owner state was read',
  identity_conflict:
    'An owner-state identity changes record kind or category across versions; no owner state was read',
  version_order_conflict:
    'An owner-state creation time moves backwards as its version increases; no owner state was read',
  invalid_lineage_reference:
    'An owner-state lineage reference does not resolve to a version of the same category; no lineage was built',
  lineage_cycle:
    'Owner-state lineage references form a cycle; no lineage was built',
  invalid_lifecycle_claim:
    'Owner-state lifecycle claims do not agree with recorded transitions; no verified owner model was built',
  invalid_owner_state_view:
    'An owner-state record is inconsistent with its category; no owner-state view was built',
  active_task_conflict:
    'Several active task states declare the same task binding; no active task view was built',
  invalid_persisted_owner_model:
    'Persisted owner state failed read-only reconstruction; no owner model was built',
};
const expected = (code: OwnerModelErrorCode) =>
  JSON.stringify({ name: 'OwnerModelError', code, message: MESSAGES[code] });
function failure(call: () => unknown): string {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OwnerModelError);
  expect('cause' in (thrown as object)).toBe(false);
  const text = JSON.stringify(thrown);
  expect(text).not.toContain('PRIVATE_SENTINEL');
  return text;
}
const INPUT_ERROR = expected('invalid_input');
const CONFLICT_ERROR = expected('active_task_conflict');

describe('AVEN-009 active task view: input boundary', () => {
  it('is internal: the package index exports no active task view', () => {
    expect(
      Object.keys(publicApi).filter((k) => /task|active/i.test(k)),
    ).toEqual([]);
  });

  it('accepts only a genuine intake result, without running Proxy traps', () => {
    const records = [task('learned_t1')];
    const real = intake(records);
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get: (t, k) => {
        traps += 1;
        return Reflect.get(t, k);
      },
      getPrototypeOf: (t) => {
        traps += 1;
        return Reflect.getPrototypeOf(t);
      },
      ownKeys: (t) => {
        traps += 1;
        return Reflect.ownKeys(t);
      },
    };
    const fake = {
      ownerId: real.ownerId,
      durable: real.durable,
      activeTasks: real.activeTasks,
    };
    const verified = verifyLifecycleClaims(buildDurableLineage(real), []);
    const lookalikes: unknown[] = [
      { ...real },
      Object.assign({}, real),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(real),
      ),
      JSON.parse(JSON.stringify(real)),
      Object.create(real),
      new Proxy(real, handler),
      new Proxy(fake, handler),
      fake,
      [...real.activeTasks],
      buildDurableLineage(real),
      verified,
      buildDurableCategoryViews(verified, { referenceTime: T2 }),
      null,
      undefined,
    ];
    for (const value of lookalikes)
      expect(
        failure(() => buildActiveTaskView(value as OwnerStateIntake, REQUEST)),
      ).toBe(INPUT_ERROR);
    expect(traps).toBe(0);
    expect(pick(records)).toBe('learned_t1@1');
  });

  it('fails closed on ambient prototype pollution installed after intake', () => {
    const real = intake([task('learned_t1')]);
    Object.defineProperty(Object.prototype, 'sessionId', {
      value: S1,
      configurable: true,
      writable: true,
    });
    let text: string;
    try {
      text = failure(() => buildActiveTaskView(real, REQUEST));
    } finally {
      Reflect.deleteProperty(Object.prototype, 'sessionId');
    }
    expect(text).toBe(INPUT_ERROR);
    expect(buildActiveTaskView(real, REQUEST)?.state.id).toBe('learned_t1');
  });
});

describe('AVEN-009 active task view: request boundary', () => {
  const real = () => intake([task('learned_t1')]);

  it('accepts a plain or null-prototype request of exactly two valid IDs', () => {
    expect(
      buildActiveTaskView(real(), { sessionId: S1, taskId: K1 }),
    ).toBeDefined();
    expect(
      buildActiveTaskView(real(), { taskId: K1, sessionId: S1 }),
    ).toBeDefined();
    const nullProto = Object.assign(Object.create(null) as object, REQUEST);
    expect(
      buildActiveTaskView(real(), nullProto as ActiveTaskViewRequest),
    ).toBeDefined();
  });

  it('never runs an accessor and never consumes its value', () => {
    let calls = 0;
    const getterOn = (key: 'sessionId' | 'taskId', thrower = false) => {
      const request = { ...REQUEST } as Json;
      Object.defineProperty(request, key, {
        enumerable: true,
        get() {
          calls += 1;
          if (thrower) throw new Error('PRIVATE_SENTINEL');
          return REQUEST[key];
        },
      });
      return request;
    };
    const setterOnly = { taskId: K1 } as Json;
    Object.defineProperty(setterOnly, 'sessionId', {
      enumerable: true,
      set() {
        calls += 1;
      },
    });
    for (const request of [
      getterOn('sessionId'),
      getterOn('taskId'),
      getterOn('taskId', true),
      setterOnly,
    ])
      expect(
        failure(() =>
          buildActiveTaskView(
            real(),
            request as unknown as ActiveTaskViewRequest,
          ),
        ),
      ).toBe(INPUT_ERROR);
    expect(calls).toBe(0);
  });

  it.each([
    ['null', null],
    ['a string', 'session_s1/task_s1'],
    ['an array', [S1, K1]],
    ['a missing sessionId', { taskId: K1 }],
    ['a missing taskId', { sessionId: S1 }],
    ['an extra key', { ...REQUEST, ownerId: OWNER }],
    ['a symbol key', { ...REQUEST, [Symbol('x')]: 1 }],
    ['inherited IDs', Object.create(REQUEST)],
    [
      'an inherited sessionId',
      Object.assign(Object.create({ sessionId: S1 }), { taskId: K1 }),
    ],
    [
      'a class instance',
      new (class Binding {
        sessionId = S1;
        taskId = K1;
      })(),
    ],
    ['boxed strings', { sessionId: new String(S1), taskId: new String(K1) }],
    [
      'string-coercible objects',
      {
        sessionId: { toString: () => S1 },
        taskId: { [Symbol.toPrimitive]: () => K1 },
      },
    ],
    ['a malformed session ID', { sessionId: 'Session_s1', taskId: K1 }],
    ['a padded session ID', { sessionId: ` ${S1}`, taskId: K1 }],
    ['a task ID as session ID', { sessionId: K1, taskId: K1 }],
    ['a malformed task ID', { sessionId: S1, taskId: 'task_s1 ' }],
    ['an empty task ID', { sessionId: S1, taskId: '' }],
  ])('rejects %s with invalid_input, never coercing', (_label, request) => {
    expect(
      failure(() =>
        buildActiveTaskView(
          real(),
          request as unknown as ActiveTaskViewRequest,
        ),
      ),
    ).toBe(INPUT_ERROR);
  });

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const)(
    'rejects a request Proxy whose %s trap throws, without leaking it',
    (trap) => {
      const request = new Proxy(
        { ...REQUEST },
        {
          [trap]: () => {
            throw new Error('PRIVATE_SENTINEL');
          },
        },
      );
      expect(failure(() => buildActiveTaskView(real(), request))).toBe(
        INPUT_ERROR,
      );
    },
  );

  it('never folds case or trims: near-miss bindings do not match', () => {
    const records = [task('learned_t1', 1, { sessionId: 'session_S1' })];
    expect(pick(records, { sessionId: S1, taskId: K1 })).toBe('none');
    expect(pick(records, { sessionId: 'session_S1', taskId: K1 })).toBe(
      'learned_t1@1',
    );
  });
});

describe('AVEN-009 active task view: exact binding', () => {
  it('returns nothing for an empty intake', () => {
    expect(view([])).toBeUndefined();
  });

  it('returns the one exact active state, preserving owner and data', () => {
    const records = [task('learned_t1')];
    const input = intake(records);
    const result = buildActiveTaskView(input, REQUEST)!;
    expect(result.ownerId).toBe(OWNER);
    expect(result.state).toBe(input.activeTasks[0]);
    expect({ ...result.task }).toEqual(REQUEST);
  });

  it.each([
    ['the same task in another session', { sessionId: S2, taskId: K1 }],
    ['another task in the same session', { sessionId: S1, taskId: K2 }],
    ['both different', { sessionId: S2, taskId: K2 }],
  ])('does not match %s', (_label, request) => {
    expect(pick([task('learned_t1')], request)).toBe('none');
  });

  it('never matches durable state, whatever text it carries', () => {
    const decoy = {
      ...durable({ id: 'learned_d1' }),
      content: {
        category: 'fact',
        subject: `${S1} ${K1}`,
        assertion: 'task session_s1 task_s1 active',
      },
      scope: { kind: 'bounded', taskId: K1 },
    };
    expect(pick([decoy])).toBe('none');
    expect(pick([decoy, task('learned_t1')])).toBe('learned_t1@1');
  });

  it('never recovers another owner’s task state', () => {
    expect(pick([task('learned_t9', 1, { ownerId: FOREIGN })])).toBe('none');
  });
});

describe('AVEN-009 active task view: per-ID head selection', () => {
  it('takes the numerically highest version (10 after 2)', () => {
    expect(
      pick([
        task('learned_t1', 2),
        task('learned_t1', 10),
        task('learned_t1', 1),
      ]),
    ).toBe('learned_t1@10');
  });

  it('allows version gaps and a first version above 1', () => {
    expect(pick([task('learned_t1', 3), task('learned_t1', 7)])).toBe(
      'learned_t1@7',
    );
  });

  it.each(['completed', 'cancelled'] as const)(
    'returns nothing when the head is closed (%s); the older active version never returns',
    (outcome) => {
      expect(
        pick([
          task('learned_t1', 1),
          task('learned_t1', 2, { lifecycle: closed(outcome) }),
        ]),
      ).toBe('none');
    },
  );

  it('selects each head before testing the binding', () => {
    const moved = [
      task('learned_t1', 1, { sessionId: S1, taskId: K1 }),
      task('learned_t1', 2, { sessionId: S2, taskId: K2 }),
    ];
    expect(pick(moved, { sessionId: S1, taskId: K1 })).toBe('none');
    expect(pick(moved, { sessionId: S2, taskId: K2 })).toBe('learned_t1@2');
    const arrived = [
      task('learned_t1', 1, { sessionId: S2, taskId: K2 }),
      task('learned_t1', 2, { sessionId: S1, taskId: K1 }),
    ];
    expect(pick(arrived)).toBe('learned_t1@2');
    expect(pick(arrived, { sessionId: S2, taskId: K2 })).toBe('none');
  });

  it('reopening after a close is just a newer active head', () => {
    expect(
      pick([
        task('learned_t1', 1),
        task('learned_t1', 2, { lifecycle: closed('completed') }),
        task('learned_t1', 3),
      ]),
    ).toBe('learned_t1@3');
  });
});

describe('AVEN-009 active task view: several stable IDs', () => {
  it('fails closed when two IDs both have matching active heads, in any order', () => {
    const records = [
      task('learned_ta', 1),
      task('learned_tb', 9),
      task('learned_tb', 2),
    ];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const input = intake(shuffled(records, seed));
      expect(failure(() => buildActiveTaskView(input, REQUEST))).toBe(
        CONFLICT_ERROR,
      );
    }
    for (const leak of ['learned_t', S1, K1, OWNER, '2'])
      expect(CONFLICT_ERROR).not.toContain(leak);
  });

  it('returns the only active one when the other head is closed', () => {
    expect(
      pick([
        task('learned_ta', 1),
        task('learned_tb', 1),
        task('learned_tb', 2, { lifecycle: closed('cancelled') }),
      ]),
    ).toBe('learned_ta@1');
  });

  it('returns the only one still bound here when the other head moved', () => {
    expect(
      pick([
        task('learned_ta', 1),
        task('learned_tb', 1),
        task('learned_tb', 2, { sessionId: S2 }),
      ]),
    ).toBe('learned_ta@1');
  });

  it('never compares versions across identities', () => {
    // A higher version under another ID does not win; both active is a
    // conflict, and one active is simply that one.
    expect(
      failure(() => view([task('learned_ta', 1), task('learned_tb', 50)])),
    ).toBe(CONFLICT_ERROR);
    expect(
      pick([
        task('learned_ta', 1),
        task('learned_tb', 50, { lifecycle: closed('completed') }),
      ]),
    ).toBe('learned_ta@1');
  });

  it('returns nothing when every matching head is closed', () => {
    expect(
      pick([
        task('learned_ta', 1, { lifecycle: closed('completed') }),
        task('learned_tb', 1, { lifecycle: closed('cancelled') }),
      ]),
    ).toBe('none');
  });
});

describe('AVEN-009 active task view: no expiry, no clock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a very old active head active, touching no clock or timer', () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(performance, 'now'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
    ];
    const records = [
      task('learned_t1', 1, { createdAt: '1971-01-01T00:00:00Z' }),
      task('learned_t2', 1, {
        createdAt: '1971-01-01T00:00:00Z',
        taskId: K2,
        lifecycle: {
          status: 'closed',
          closedAt: '1971-01-02T00:00:00Z',
          outcome: 'completed',
        },
      }),
    ];
    const input = intake(records);
    const RealDate = Date;
    let constructed = 0;
    globalThis.Date = class extends RealDate {
      constructor(...args: []) {
        super(...args);
        constructed += 1;
      }
    } as DateConstructor;
    let result: ActiveTaskView | undefined;
    try {
      result = buildActiveTaskView(input, REQUEST);
    } finally {
      globalThis.Date = RealDate;
    }
    expect(result?.state.id).toBe('learned_t1');
    expect(constructed).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('AVEN-009 active task view: data preservation and shape', () => {
  const rich = () =>
    task('learned_t1', 4, {
      objective: 'Synthetic objective with   spacing',
      openLoops: ['Synthetic loop', 'Synthetic loop', 'Another synthetic loop'],
      sourceEvidence: [
        { evidenceId: 'evidence_s1', eventId: 'event_s1' },
        { evidenceId: 'evidence_s2', eventId: 'event_s2' },
        { evidenceId: 'evidence_s1', eventId: 'event_s1' },
      ],
    });

  it('returns the intake snapshot itself, unchanged', () => {
    const input = intake([rich()]);
    const before = JSON.stringify(input);
    const result = buildActiveTaskView(input, REQUEST)!;
    expect(result.state).toBe(input.activeTasks[0]);
    expect(result.state.openLoops).toEqual([
      'Synthetic loop',
      'Synthetic loop',
      'Another synthetic loop',
    ]);
    expect(result.state.sourceEvidence).toHaveLength(3);
    expect(result.state.objective).toBe('Synthetic objective with   spacing');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('pins the exact result keys and adds nothing else', () => {
    const result = view([rich()])!;
    expect(Object.keys(result).sort()).toEqual(['ownerId', 'state', 'task']);
    expect(Object.keys(result.task).sort()).toEqual(['sessionId', 'taskId']);
    const envelope = JSON.stringify({ ...result, state: undefined });
    for (const absent of [
      'expiresAt',
      'expired',
      'age',
      'freshness',
      'rank',
      'score',
      'contextCandidate',
      'action',
      'tool',
      'currentDurable',
      'referenceTime',
      'authority',
      'permission',
      'Root',
      'storage',
    ])
      expect(envelope).not.toContain(absent);
  });

  it('is deeply frozen, null-prototype and holds no Map or Set', () => {
    const result = view([rich()])!;
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.task)).toBeNull();
    const seen: unknown[] = [result];
    while (seen.length > 0) {
      const value = seen.pop();
      expect(
        value instanceof Map ||
          value instanceof Set ||
          value instanceof WeakMap ||
          value instanceof WeakSet,
      ).toBe(false);
      if (value !== null && typeof value === 'object')
        seen.push(...Object.values(value));
    }
    for (const write of [
      () => {
        (result as unknown as Json)['state'] = undefined;
      },
      () => {
        (result.task as unknown as Json)['taskId'] = K2;
      },
      () => {
        (result as unknown as Json)['expiresAt'] = T1;
      },
    ])
      expect(write).toThrow(TypeError);
  });

  it('does not mutate or freeze the caller request', () => {
    const request = { ...REQUEST };
    view([rich()], request);
    expect(request).toEqual(REQUEST);
    expect(Object.isFrozen(request)).toBe(false);
  });

  it('brands only the produced view, without running Proxy traps', () => {
    const result = view([rich()])!;
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get: (t, k) => {
        traps += 1;
        return Reflect.get(t, k);
      },
      getPrototypeOf: (t) => {
        traps += 1;
        return Reflect.getPrototypeOf(t);
      },
    };
    for (const forged of [
      { ...result },
      Object.assign(Object.create(null) as object, result),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(result),
      ),
      new Proxy(result, handler),
      JSON.parse(JSON.stringify(result)),
      result.state,
    ])
      expect(isActiveTaskView(forged)).toBe(false);
    expect(traps).toBe(0);
    expect(isActiveTaskView(result)).toBe(true);
  });

  it('is identical for every source order', () => {
    const records = [
      rich(),
      task('learned_t1', 2),
      task('learned_t2', 1, { taskId: K2 }),
      task('learned_t3', 1, { lifecycle: closed('completed') }),
      durable({ id: 'learned_d1' }),
    ];
    const texts = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = view(shuffled(records, seed));
      texts.add(JSON.stringify(result));
      expect(result?.state.metadata.recordVersion).toBe(4);
    }
    expect(texts.size).toBe(1);
  });

  it('leaves durable category views free of task state', () => {
    const input = intake([task('learned_t1'), durable({ id: 'learned_d1' })]);
    const views = buildDurableCategoryViews(
      verifyLifecycleClaims(buildDurableLineage(input), []),
      { referenceTime: T2 },
    );
    expect(Object.keys(views)).not.toContain('activeTasks');
    expect(JSON.stringify(views)).not.toContain('learned_t1');
  });
});
