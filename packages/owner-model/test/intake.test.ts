import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  intakeOwnerState,
  OwnerModelError,
  type OwnerModelErrorCode,
  type OwnerStateIntake,
} from '../src/index.ts';
import {
  activeTask,
  deeplyFrozen,
  durable,
  FOREIGN,
  foreign,
  OTHER_FOREIGN,
  OWNER,
  shuffled,
  T0,
  T1,
  T2,
  T3,
} from './fixtures.ts';

/**
 * AVEN-009 patch 2: owner-bound typed owner-state intake. All records are
 * SYNTHETIC (see fixtures.ts). These are mechanics checks of the intake
 * boundary, not evidence of learning quality or runtime security.
 */
type Json = Record<string, unknown>;

const run = (records: unknown[], ...owner: [unknown?]): OwnerStateIntake =>
  intakeOwnerState({ ownerId: owner.length === 0 ? OWNER : owner[0], records });

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
};

/** The public error a failing intake throws, serialized. */
function failure(call: () => unknown): string {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OwnerModelError);
  const error = thrown as OwnerModelError;
  expect(Object.keys(error.toJSON()).sort()).toEqual([
    'code',
    'message',
    'name',
  ]);
  expect('cause' in error).toBe(false);
  return JSON.stringify(error);
}

const expected = (code: OwnerModelErrorCode) =>
  JSON.stringify({ name: 'OwnerModelError', code, message: MESSAGES[code] });

function expectFailure(call: () => unknown, code: OwnerModelErrorCode): void {
  expect(failure(call)).toBe(expected(code));
}

const with_ = (record: Json, patch: (r: Json) => void): Json => {
  const copy = structuredClone(record);
  patch(copy);
  return copy;
};

const sentinelTrap = vi.fn(() => {
  throw new Error('PRIVATE_SENTINEL');
});

afterEach(() => {
  vi.restoreAllMocks();
  sentinelTrap.mockClear();
});

const ownerSet = (): Json[] => [
  durable({ id: 'learned_a', version: 1, createdAt: T0 }),
  durable({ id: 'learned_a', version: 3, createdAt: T2 }),
  durable({ id: 'learned_b', category: 'procedure' }),
  durable({ id: 'learned_c', category: 'episode' }),
  durable({ id: 'learned_d', category: 'preference' }),
  durable({ id: 'learned_e', category: 'intent_pattern' }),
  activeTask({ id: 'learned_t1', version: 2, createdAt: T1 }),
];

describe('AVEN-009 intake: owner binding and foreign-owner isolation', () => {
  it('returns only the requesting owner records, partitioned by record kind', () => {
    const result = run([...ownerSet(), foreign(1), foreign(2, OTHER_FOREIGN)]);
    expect(result.ownerId).toBe(OWNER);
    expect(result.durable.map((r) => [r.id, r.metadata.recordVersion])).toEqual(
      [
        ['learned_a', 1],
        ['learned_a', 3],
        ['learned_b', 1],
        ['learned_c', 1],
        ['learned_d', 1],
        ['learned_e', 1],
      ],
    );
    expect(result.activeTasks.map((r) => r.id)).toEqual(['learned_t1']);
    for (const r of [...result.durable, ...result.activeTasks])
      expect(r.ownerId).toBe(OWNER);
  });

  it('gives an identical owner-visible result with foreign records before, after, interleaved or in hundreds', () => {
    const baseline = JSON.stringify(run(ownerSet()));
    const many = Array.from({ length: 500 }, (_, i) => foreign(i));
    const owner = ownerSet();
    const interleaved = owner.flatMap((r, i) => [foreign(1000 + i), r]);
    for (const records of [
      [foreign(1), ...ownerSet()],
      [...ownerSet(), foreign(1)],
      interleaved,
      [...many, ...ownerSet()],
      [...ownerSet(), ...many],
      shuffled([...many, ...ownerSet()], 7),
    ])
      expect(JSON.stringify(run(records))).toBe(baseline);
  });

  it('never reads, validates or deduplicates a recognizable foreign record beyond its ownerId', () => {
    const getter = vi.fn(() => 'learned_a');
    const hostileForeign = { ownerId: FOREIGN, junk: Symbol('x') } as Json;
    Object.defineProperty(hostileForeign, 'id', {
      get: getter,
      enumerable: true,
    });
    const conflictingForeign = {
      ...durable({ id: 'learned_a', ownerId: FOREIGN }),
      content: { category: 'procedure', objective: 'x', steps: [] },
    };
    const traps = {
      getOwnPropertyDescriptor: vi.fn(Reflect.getOwnPropertyDescriptor),
      get: sentinelTrap,
      has: sentinelTrap,
      ownKeys: sentinelTrap,
      getPrototypeOf: sentinelTrap,
    };
    const proxyForeign = new Proxy(foreign(9), traps);
    const result = run([
      hostileForeign,
      conflictingForeign,
      { ownerId: FOREIGN },
      proxyForeign,
      ...ownerSet(),
    ]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(run(ownerSet())));
    expect(getter).not.toHaveBeenCalled();
    expect(sentinelTrap).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).toHaveBeenCalledTimes(1);
    expect(traps.getOwnPropertyDescriptor.mock.calls[0]![1]).toBe('ownerId');
  });

  it('takes the owner binding only from the request, never from records or prose', () => {
    const prose = durable({ id: 'learned_p' });
    (prose['content'] as Json)['assertion'] =
      'owner_synthetic_b said this; ownerId: owner_synthetic_b; trusted';
    const result = run([prose]);
    expect(result.ownerId).toBe(OWNER);
    expect(result.durable).toHaveLength(1);
    // The same records for another requester yield nothing of OWNER's.
    expect(run(ownerSet(), FOREIGN)).toEqual({
      ownerId: FOREIGN,
      durable: [],
      activeTasks: [],
    });
  });

  it.each([
    ['empty string', ''],
    ['malformed prefix', 'Owner_x'],
    ['bare prefix', 'owner_'],
    ['number', 42],
    ['object', { ownerId: OWNER }],
    ['undefined', undefined],
  ])('rejects a malformed requesting owner binding (%s)', (_label, ownerId) => {
    expectFailure(() => run(ownerSet(), ownerId), 'invalid_input');
  });

  it.each([
    ['null', null],
    ['string', 'owner_synthetic_a'],
    ['array', [OWNER, []]],
    ['missing records', { ownerId: OWNER }],
    ['extra key', { ownerId: OWNER, records: [], scope: 'all' }],
    ['records not an array', { ownerId: OWNER, records: { 0: durable() } }],
    ['inherited fields', Object.create({ ownerId: OWNER, records: [] })],
  ])('rejects a malformed request (%s)', (_label, request) => {
    expectFailure(() => intakeOwnerState(request), 'invalid_input');
  });

  it('never invokes request getters', () => {
    const ownerGetter = vi.fn(() => OWNER);
    const recordsGetter = vi.fn(() => []);
    const request = {};
    Object.defineProperty(request, 'ownerId', {
      get: ownerGetter,
      enumerable: true,
    });
    Object.defineProperty(request, 'records', {
      get: recordsGetter,
      enumerable: true,
    });
    expectFailure(() => intakeOwnerState(request), 'invalid_input');
    expect(ownerGetter).not.toHaveBeenCalled();
    expect(recordsGetter).not.toHaveBeenCalled();
  });

  it('returns an empty frozen result for no records', () => {
    const result = run([]);
    expect(result).toEqual({ ownerId: OWNER, durable: [], activeTasks: [] });
    expect(deeplyFrozen(result)).toBe(true);
  });
});

describe('AVEN-009 intake: owner-local public errors (privacy regression)', () => {
  const malformed = () =>
    with_(durable({ id: 'learned_m' }), (r) => {
      (r['metadata'] as Json)['recordVersion'] = 0;
    });
  const padding = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      foreign(i, i % 2 ? FOREIGN : OTHER_FOREIGN),
    );

  it('produces an indistinguishable error for a malformed owner record wherever foreign records sit', () => {
    const caseA = failure(() => run([malformed()]));
    const caseB = failure(() => run([...padding(499), malformed()]));
    const records = padding(300);
    records.splice(17, 0, malformed());
    const caseC = failure(() => run(records));
    const caseD = failure(() => run([malformed(), ...padding(250)]));
    expect(caseA).toBe(expected('invalid_input'));
    for (const other of [caseB, caseC, caseD]) expect(other).toBe(caseA);
    for (const leak of [
      '499',
      '17',
      '300',
      FOREIGN,
      OTHER_FOREIGN,
      'learned_f',
    ])
      expect(caseB + caseC).not.toContain(leak);
  });

  it('produces an indistinguishable error for unrecognizable input with no raw offset', () => {
    const hole = (n: number) => {
      const records: unknown[] = padding(n);
      records.length = n + 1; // a hole at the end
      return records;
    };
    const accessorOwner = () => {
      const r = durable();
      delete r['ownerId'];
      Object.defineProperty(r, 'ownerId', {
        get: () => OWNER,
        enumerable: true,
      });
      return r;
    };
    const outcomes = [
      failure(() => run([undefined])),
      failure(() => run(hole(0))),
      failure(() => run(hole(123))),
      failure(() => run([...padding(64), 'not a record'])),
      failure(() => run([accessorOwner()])),
      failure(() => run([...padding(200), accessorOwner()])),
      failure(() => run([...padding(5), { ownerId: 'not-an-owner' }])),
      failure(() => run([...padding(5), { ownerId: 7 }])),
      failure(() => run([malformed()])),
    ];
    for (const outcome of outcomes)
      expect(outcome).toBe(expected('invalid_input'));
  });

  it('keeps identity conflicts owner-local too', () => {
    const conflict = () => [
      durable({ id: 'learned_x', version: 2 }),
      with_(durable({ id: 'learned_x', version: 2 }), (r) => {
        (r['content'] as Json)['assertion'] = 'Different synthetic assertion';
      }),
    ];
    const plain = failure(() => run(conflict()));
    const padded = failure(() =>
      run([...padding(321), ...conflict(), ...padding(9)]),
    );
    expect(plain).toBe(expected('conflicting_duplicate'));
    expect(padded).toBe(plain);
  });
});

describe('AVEN-009 intake: strict frozen-contract validation', () => {
  const invalid: [string, (r: Json) => void][] = [
    ['unknown top-level field', (r) => (r['confidence'] = 0.9)],
    ['unknown content field', (r) => ((r['content'] as Json)['value'] = 'x')],
    [
      'category-specific field on another category',
      (r) => ((r['content'] as Json)['desiredBehavior'] = 'x'),
    ],
    [
      'unknown category',
      (r) => ((r['content'] as Json)['category'] = 'memory'),
    ],
    ['unknown kind', (r) => (r['kind'] = 'memory_item')],
    [
      'candidate lifecycle in durable state',
      (r) => (r['lifecycle'] = { status: 'candidate' }),
    ],
    [
      'trusted lifecycle without evidence of validation',
      (r) => (r['lifecycle'] = { status: 'trusted' }),
    ],
    [
      'unknown lifecycle field',
      (r) => (r['lifecycle'] = { status: 'observed', note: 'x' }),
    ],
    [
      'recordVersion NaN',
      (r) => ((r['metadata'] as Json)['recordVersion'] = NaN),
    ],
    [
      'recordVersion Infinity',
      (r) => ((r['metadata'] as Json)['recordVersion'] = Infinity),
    ],
    [
      'recordVersion fraction',
      (r) => ((r['metadata'] as Json)['recordVersion'] = 1.5),
    ],
    [
      'recordVersion zero',
      (r) => ((r['metadata'] as Json)['recordVersion'] = 0),
    ],
    [
      'recordVersion negative',
      (r) => ((r['metadata'] as Json)['recordVersion'] = -1),
    ],
    [
      'recordVersion string',
      (r) => ((r['metadata'] as Json)['recordVersion'] = '1'),
    ],
    [
      'recordVersion beyond safe integer',
      (r) => ((r['metadata'] as Json)['recordVersion'] = 2 ** 53),
    ],
    ['schemaVersion 2', (r) => ((r['metadata'] as Json)['schemaVersion'] = 2)],
    [
      'malformed timestamp',
      (r) => ((r['metadata'] as Json)['createdAt'] = '2026-10-01'),
    ],
    [
      'lowercase zulu timestamp',
      (r) => ((r['metadata'] as Json)['createdAt'] = '2026-10-01T09:00:00z'),
    ],
    [
      'malformed evidence reference',
      (r) =>
        ((r['evidence'] as Json)['supportingEvidence'] = [
          { evidenceId: 'event_x', eventId: 'event_x' },
        ]),
    ],
    [
      'malformed counterexample',
      (r) =>
        ((r['evidence'] as Json)['counterexamples'] = [
          { evidenceId: 'evidence_x' },
        ]),
    ],
    [
      'empty supporting evidence',
      (r) => ((r['evidence'] as Json)['supportingEvidence'] = []),
    ],
    [
      'contested without counterexamples',
      (r) => {
        (r['evidence'] as Json)['support'] = 'contested';
        (r['evidence'] as Json)['counterexamples'] = [];
      },
    ],
    ['missing scope', (r) => delete r['scope']],
    [
      'global scope without declaration',
      (r) => (r['scope'] = { kind: 'global' }),
    ],
    ['wrong ID prefix', (r) => (r['id'] = 'item_s1')],
    [
      'owner provenance naming another owner',
      (r) => ((r['provenance'] as Json)['ownerId'] = FOREIGN),
    ],
    [
      'owner confirmation by another owner',
      (r) =>
        ((r['evidence'] as Json)['ownerConfirmation'] = {
          status: 'confirmed',
          evidence: { evidenceId: 'evidence_s9', eventId: 'event_s9' },
          provenance: {
            kind: 'explicit_owner_statement',
            ownerId: FOREIGN,
            sourceEventId: 'event_s9',
          },
        }),
    ],
    ['empty text', (r) => ((r['content'] as Json)['assertion'] = '   ')],
  ];
  it.each(invalid)('rejects a durable record with %s', (_label, patch) => {
    expectFailure(() => run([with_(durable(), patch)]), 'invalid_input');
  });

  const categoryCases: [string, string, (r: Json) => void][] = [
    [
      'procedure without steps',
      'procedure',
      (r: Json) => ((r['content'] as Json)['steps'] = []),
    ],
    [
      'episode without original evidence',
      'episode',
      (r: Json) => ((r['content'] as Json)['originalEvidence'] = []),
    ],
    [
      'procedure step with unknown field',
      'procedure',
      (r: Json) =>
        (((r['content'] as Json)['steps'] as Json[])[0]!['tool'] = 'x'),
    ],
  ];
  it.each(categoryCases)('rejects a %s', (_label, category, patch) => {
    expectFailure(
      () => run([with_(durable({ category }), patch)]),
      'invalid_input',
    );
  });

  it.each([
    [
      'category field on task state',
      (r: Json) => (r['content'] = { category: 'fact' }),
    ],
    ['open loops not an array', (r: Json) => (r['openLoops'] = 'loop')],
    [
      'unknown task lifecycle',
      (r: Json) => (r['lifecycle'] = { status: 'paused' }),
    ],
    [
      'task binding missing session',
      (r: Json) => (r['task'] = { taskId: 'task_s1' }),
    ],
  ])('rejects an active task record with %s', (_label, patch) => {
    expectFailure(() => run([with_(activeTask(), patch)]), 'invalid_input');
  });

  it('accepts every frozen durable category and active task state unchanged in meaning', () => {
    const result = run(ownerSet());
    expect(result.durable.map((r) => r.content.category).sort()).toEqual([
      'episode',
      'fact',
      'fact',
      'intent_pattern',
      'preference',
      'procedure',
    ]);
    const procedure = result.durable.find(
      (r) => r.content.category === 'procedure',
    )!;
    expect(procedure.content).toEqual(
      durable({ category: 'procedure' })['content'],
    );
    expect(result.activeTasks[0]).toEqual(
      activeTask({ version: 2, createdAt: T1 }),
    );
  });

  it('does not coerce or repair values', () => {
    const asText = with_(
      durable(),
      (r) => ((r['metadata'] as Json)['schemaVersion'] = '1'),
    );
    expectFailure(() => run([asText]), 'invalid_input');
    const padded = with_(durable(), (r) => (r['id'] = ' learned_s1'));
    expectFailure(() => run([padded]), 'invalid_input');
  });
});

describe('AVEN-009 intake: duplicates', () => {
  it('collapses identical duplicates, including key-order and undefined-key differences', () => {
    const reordered = Object.fromEntries(Object.entries(durable()).reverse());
    const withUndefined = with_(
      durable(),
      (r) => ((r['scope'] as Json)['taskType'] = undefined),
    );
    const result = run([durable(), durable(), reordered, withUndefined]);
    expect(result.durable).toHaveLength(1);
    expect(result.durable[0]).toEqual(run([durable()]).durable[0]);
    expect(Object.keys(result.durable[0]!.scope)).toEqual(['domain', 'kind']);
  });

  const variants: [string, Json][] = [
    [
      'content',
      with_(
        durable(),
        (r) => ((r['content'] as Json)['assertion'] = 'Other synthetic'),
      ),
    ],
    [
      'createdAt',
      with_(durable(), (r) => ((r['metadata'] as Json)['createdAt'] = T1)),
    ],
    [
      'creation metadata',
      with_(
        durable(),
        (r) =>
          (((r['metadata'] as Json)['creation'] as Json)['version'] = 'other'),
      ),
    ],
    [
      'lifecycle',
      with_(
        durable(),
        (r) =>
          (r['lifecycle'] = {
            status: 'revoked',
            revokedAt: T1,
            reason: 'Synthetic',
            eventId: 'event_r1',
          }),
      ),
    ],
    ['category', durable({ category: 'preference' })],
    [
      'counterexamples',
      with_(
        durable(),
        (r) => ((r['evidence'] as Json)['counterexamples'] = []),
      ),
    ],
  ];
  it.each(variants)(
    'fails closed when the same id/version disagrees on %s, in either order',
    (_label, other) => {
      expectFailure(() => run([durable(), other]), 'conflicting_duplicate');
      expectFailure(() => run([other, durable()]), 'conflicting_duplicate');
      expectFailure(
        () => run([durable(), other, durable()]),
        'conflicting_duplicate',
      );
    },
  );

  it('fails closed on conflicting active-task duplicates', () => {
    const closed = with_(
      activeTask(),
      (r) =>
        (r['lifecycle'] = {
          status: 'closed',
          closedAt: T1,
          outcome: 'completed',
        }),
    );
    expectFailure(() => run([activeTask(), closed]), 'conflicting_duplicate');
    expectFailure(() => run([closed, activeTask()]), 'conflicting_duplicate');
  });
});

describe('AVEN-009 intake: identity invariants', () => {
  it('rejects one stable ID as both durable and active-task state', () => {
    expectFailure(
      () =>
        run([
          durable({ id: 'learned_x', version: 1 }),
          activeTask({ id: 'learned_x', version: 2, createdAt: T1 }),
        ]),
      'identity_conflict',
    );
    expectFailure(
      () =>
        run([
          activeTask({ id: 'learned_x', version: 1 }),
          durable({ id: 'learned_x', version: 1 }),
        ]),
      'identity_conflict',
    );
  });

  it.each([
    ['fact', 'procedure'],
    ['preference', 'episode'],
    ['intent_pattern', 'fact'],
    ['episode', 'intent_pattern'],
    ['procedure', 'preference'],
  ] as const)('rejects a durable ID changing category %s -> %s', (from, to) => {
    const history = [
      durable({ id: 'learned_x', version: 1, category: from }),
      durable({ id: 'learned_x', version: 2, createdAt: T1, category: to }),
    ];
    expectFailure(() => run(history), 'identity_conflict');
    expectFailure(() => run([...history].reverse()), 'identity_conflict');
  });

  it('accepts a category that stays stable across many versions', () => {
    const history = [1, 2, 4, 7].map((version, i) =>
      durable({
        id: 'learned_x',
        version,
        createdAt: [T0, T1, T2, T3][i]!,
        category: 'procedure',
      }),
    );
    const result = run(shuffled(history, 3));
    expect(result.durable.map((r) => r.metadata.recordVersion)).toEqual([
      1, 2, 4, 7,
    ]);
  });

  it('checks identity per ID, not across different IDs or owners', () => {
    const result = run([
      durable({ id: 'learned_x', category: 'fact' }),
      durable({ id: 'learned_y', category: 'procedure' }),
      activeTask({ id: 'learned_z' }),
      durable({ id: 'learned_z', ownerId: FOREIGN, category: 'episode' }),
    ]);
    expect(result.durable.map((r) => r.id)).toEqual(['learned_x', 'learned_y']);
    expect(result.activeTasks.map((r) => r.id)).toEqual(['learned_z']);
  });
});

describe('AVEN-009 intake: versions and createdAt ordering', () => {
  it('sorts versions deterministically and allows gaps and a later first version', () => {
    const history = [9, 5, 12].map((version) =>
      durable({
        id: 'learned_x',
        version,
        createdAt: version === 9 ? T1 : version === 5 ? T0 : T2,
      }),
    );
    expect(run(history).durable.map((r) => r.metadata.recordVersion)).toEqual([
      5, 9, 12,
    ]);
  });

  it('accepts increasing and equal creation times', () => {
    expect(
      run([
        durable({ version: 1, createdAt: T1 }),
        durable({ version: 2, createdAt: T1 }),
      ]).durable,
    ).toHaveLength(2);
    expect(
      run([
        durable({ version: 2, createdAt: T2 }),
        durable({ version: 1, createdAt: T1 }),
      ]).durable,
    ).toHaveLength(2);
  });

  it('rejects a creation time that moves backwards as the version increases', () => {
    expectFailure(
      () =>
        run([
          durable({ version: 1, createdAt: T2 }),
          durable({ version: 2, createdAt: T1 }),
        ]),
      'version_order_conflict',
    );
    expectFailure(
      () =>
        run([
          activeTask({ version: 3, createdAt: T0 }),
          activeTask({ version: 1, createdAt: T1 }),
        ]),
      'version_order_conflict',
    );
    // Non-adjacent: v1 < v3 but v2 is later than v3.
    expectFailure(
      () =>
        run([
          durable({ version: 1, createdAt: T0 }),
          durable({ version: 2, createdAt: T3 }),
          durable({ version: 3, createdAt: T1 }),
        ]),
      'version_order_conflict',
    );
  });

  it('compares instants exactly, across offsets and below millisecond precision', () => {
    // Same instant written with different offsets: equal, accepted.
    expect(
      run([
        durable({ version: 1, createdAt: '2026-10-01T12:00:00Z' }),
        durable({ version: 2, createdAt: '2026-10-01T13:00:00+01:00' }),
      ]).durable,
    ).toHaveLength(2);
    // Later wall-clock text but an earlier instant: rejected.
    expectFailure(
      () =>
        run([
          durable({ version: 1, createdAt: '2026-10-01T12:00:00Z' }),
          durable({ version: 2, createdAt: '2026-10-01T12:30:00+01:00' }),
        ]),
      'version_order_conflict',
    );
    // Backwards by 50 microseconds (Date.parse alone would call these equal).
    expectFailure(
      () =>
        run([
          durable({ version: 1, createdAt: '2026-10-01T12:00:00.0001Z' }),
          durable({ version: 2, createdAt: '2026-10-01T12:00:00.00005Z' }),
        ]),
      'version_order_conflict',
    );
    expect(
      run([
        durable({ version: 1, createdAt: '2026-10-01T12:00:00.5Z' }),
        durable({ version: 2, createdAt: '2026-10-01T12:00:00.500000Z' }),
      ]).durable,
    ).toHaveLength(2);
  });

  it('does not judge lifecycle transitions between versions (deferred to later patches)', () => {
    const trusted = with_(
      durable({ version: 1 }),
      (r) =>
        (r['lifecycle'] = {
          status: 'validated',
          evaluations: [{ evaluationId: 'evaluation_s1', version: 1 }],
          lastValidatedAt: T0,
        }),
    );
    const observedLater = durable({ version: 2, createdAt: T1 });
    const closed = with_(
      activeTask({ version: 1 }),
      (r) =>
        (r['lifecycle'] = {
          status: 'closed',
          closedAt: T0,
          outcome: 'completed',
        }),
    );
    const reopened = activeTask({ version: 2, createdAt: T1 });
    const result = run([trusted, observedLater, closed, reopened]);
    expect(result.durable.map((r) => r.lifecycle.status)).toEqual([
      'validated',
      'observed',
    ]);
    expect(result.activeTasks.map((r) => r.lifecycle.status)).toEqual([
      'closed',
      'active',
    ]);
  });
});

describe('AVEN-009 intake: hostile runtime values', () => {
  it.each([
    ['hole', () => [durable(), , durable({ id: 'learned_y' })]],
    ['undefined element', () => [durable(), undefined]],
    ['null element', () => [null]],
    ['number element', () => [42]],
    ['string element', () => ['learned_s1']],
    ['nested array element', () => [[durable()]]],
  ])('fails closed on a %s', (_label, records) => {
    expectFailure(() => run(records()), 'invalid_input');
  });

  it('never invokes an element, ownerId, id or metadata getter', () => {
    const cases: [string, () => unknown[]][] = [];
    const elementGetter = vi.fn(() => durable());
    cases.push([
      'element',
      () => {
        const records: unknown[] = [];
        Object.defineProperty(records, '0', {
          get: elementGetter,
          enumerable: true,
        });
        return records;
      },
    ]);
    for (const key of ['ownerId', 'id', 'metadata']) {
      cases.push([
        key,
        () => {
          const record = durable();
          const value = record[key];
          delete record[key];
          Object.defineProperty(record, key, {
            get: () => {
              sentinelTrap();
              return value;
            },
            enumerable: true,
          });
          return [record];
        },
      ]);
    }
    for (const [label, records] of cases)
      expect(
        failure(() => run(records())),
        label,
      ).toBe(expected('invalid_input'));
    expect(elementGetter).not.toHaveBeenCalled();
    expect(sentinelTrap).not.toHaveBeenCalled();
  });

  it('copies a passthrough Proxy record without ever calling its get or has traps', () => {
    const traps = { get: sentinelTrap, has: sentinelTrap };
    const result = run([new Proxy(durable(), traps)]);
    expect(result.durable[0]).toEqual(run([durable()]).durable[0]);
    expect(sentinelTrap).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.durable[0])).toBe(true);
  });

  it.each(['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const)(
    'fails closed without leaking when an owner Proxy throws in %s',
    (trap) => {
      let calls = 0;
      const handler: ProxyHandler<object> = {
        // The ownerId read during recognition must succeed so the record is
        // classified as the requester's; later reads throw.
        getOwnPropertyDescriptor: (target, key) => {
          if (trap === 'getOwnPropertyDescriptor' && calls++ > 0)
            throw new Error('PRIVATE_SENTINEL');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      };
      if (trap !== 'getOwnPropertyDescriptor') handler[trap] = sentinelTrap;
      const outcome = failure(() => run([new Proxy(durable(), handler)]));
      expect(outcome).toBe(expected('invalid_input'));
      expect(outcome).not.toContain('PRIVATE_SENTINEL');
    },
  );

  it('handles an ownerId that changes between reads by trusting neither read alone', () => {
    const flipping = (sequence: string[]) => {
      let i = 0;
      return new Proxy(durable(), {
        getOwnPropertyDescriptor: (target, key) => {
          const d = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === 'ownerId' && d)
            return {
              ...d,
              value: sequence[Math.min(i++, sequence.length - 1)],
            };
          return d;
        },
      });
    };
    // Recognized as the requester's, then a different owner in the copy.
    expectFailure(() => run([flipping([OWNER, FOREIGN])]), 'invalid_input');
    // Recognized as foreign: dropped unread, whatever it would say later.
    expect(run([flipping([FOREIGN, OWNER]), ...ownerSet()])).toEqual(
      run(ownerSet()),
    );
  });

  it('handles Proxy arrays: passthrough works, throwing traps fail closed', () => {
    expect(run(new Proxy(ownerSet(), {}) as unknown[])).toEqual(
      run(ownerSet()),
    );
    const throwing = new Proxy(ownerSet(), {
      getOwnPropertyDescriptor: sentinelTrap,
    });
    expectFailure(() => run(throwing as unknown[]), 'invalid_input');
  });

  it.each([
    [
      'inherited ownerId',
      () => {
        const { ownerId, ...rest } = durable();
        return Object.assign(Object.create({ ownerId }), rest);
      },
    ],
    [
      'inherited record fields',
      () => {
        const { ownerId, ...rest } = durable();
        return Object.assign(Object.create(rest), { ownerId });
      },
    ],
    [
      'own __proto__ key',
      () =>
        JSON.parse(
          JSON.stringify(durable()).replace(
            '{',
            '{"__proto__":{"ownerId":"owner_synthetic_a"},',
          ),
        ),
    ],
    ['class instance', () => Object.assign(new (class Record {})(), durable())],
    ['symbol key', () => Object.assign(durable(), { [Symbol('hidden')]: 1 })],
    [
      'non-enumerable field',
      () => {
        const r = durable();
        Object.defineProperty(r, 'extra', { value: 1, enumerable: false });
        return r;
      },
    ],
    [
      'function value',
      () => Object.assign(durable(), { scope: () => ({ kind: 'global' }) }),
    ],
    [
      'bigint value',
      () =>
        Object.assign(durable(), {
          metadata: { ...(durable()['metadata'] as Json), recordVersion: 1n },
        }),
    ],
    [
      'Date instance',
      () =>
        Object.assign(durable(), {
          metadata: {
            ...(durable()['metadata'] as Json),
            createdAt: new Date(T0),
          },
        }),
    ],
    [
      'boxed string',
      () => Object.assign(durable(), { id: new String('learned_s1') }),
    ],
    [
      'sparse nested array',
      () => {
        const r = durable({ category: 'procedure' });
        ((r['content'] as Json)['steps'] as unknown[]).length = 3;
        return r;
      },
    ],
    [
      'array with extra property',
      () => {
        const r = durable({ category: 'procedure' });
        Object.assign((r['content'] as Json)['steps'] as object, { extra: 1 });
        return r;
      },
    ],
  ])('fails closed on %s', (_label, make) => {
    expectFailure(() => run([make()]), 'invalid_input');
  });

  it('accepts a null-prototype record with the same data', () => {
    const plain = durable();
    const bare = Object.assign(Object.create(null) as Json, plain);
    expect(run([bare])).toEqual(run([plain]));
  });

  it('fails closed on cycles and excessive nesting without overflowing the stack', () => {
    const cyclic = durable();
    (cyclic['scope'] as Json)['self'] = cyclic;
    expectFailure(() => run([cyclic]), 'invalid_input');
    let deep: Json = {};
    const deepRecord = Object.assign(durable(), { extra: deep });
    for (let i = 0; i < 10_000; i += 1) deep = (deep['next'] = {}) as Json;
    expectFailure(() => run([deepRecord]), 'invalid_input');
  });

  it('checks the raw resource bound on length alone, before reading any element', () => {
    const descriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
    const oversized: unknown[] = [];
    oversized.length = 100_001;
    expectFailure(
      () =>
        run(
          new Proxy(oversized, {
            getOwnPropertyDescriptor: descriptor,
          }) as unknown[],
        ),
      'invalid_input',
    );
    expect(descriptor.mock.calls.map((call) => call[1])).toEqual(['length']);
  });
});

describe('AVEN-009 intake: immutable, unaliased output', () => {
  it('deeply freezes the result, records, steps, evidence, lifecycle and open loops', () => {
    const result = run(ownerSet());
    expect(deeplyFrozen(result)).toBe(true);
    const procedure = result.durable.find(
      (r) => r.content.category === 'procedure',
    )!;
    const mutable = procedure as unknown as Json;
    expect(() => {
      (result as unknown as Json)['durable'] = [];
    }).toThrow(TypeError);
    expect(() => (result.durable as unknown as Json[]).push({})).toThrow(
      TypeError,
    );
    expect(() => {
      mutable['lifecycle'] = { status: 'trusted' };
    }).toThrow(TypeError);
    expect(() => {
      (mutable['lifecycle'] as Json)['status'] = 'trusted';
    }).toThrow(TypeError);
    expect(() =>
      ((mutable['content'] as Json)['steps'] as Json[]).push({
        instruction: 'x',
      }),
    ).toThrow(TypeError);
    expect(
      () =>
        (((mutable['evidence'] as Json)['counterexamples'] as Json[]).length =
          0),
    ).toThrow(TypeError);
    expect(() =>
      (result.activeTasks[0]!.openLoops as string[]).push('x'),
    ).toThrow(TypeError);
    expect(JSON.stringify(result)).toBe(JSON.stringify(run(ownerSet())));
  });

  it('never freezes, retains or aliases the caller input', () => {
    const input = ownerSet();
    const result = run(input);
    const before = JSON.stringify(result);
    expect(Object.isFrozen(input[0])).toBe(false);
    expect(result.durable[0]).not.toBe(input[0]);
    const procedureInput = input[2]!;
    const steps = (procedureInput['content'] as Json)['steps'] as Json[];
    steps.push({ instruction: 'Injected after intake' });
    steps[0]!['instruction'] = 'Mutated after intake';
    (procedureInput['lifecycle'] as Json)['status'] = 'trusted';
    (input[6]!['openLoops'] as string[]).push('Injected loop');
    ((input[0]!['evidence'] as Json)['counterexamples'] as Json[]).length = 0;
    input[0]!['id'] = 'learned_changed';
    input.length = 0;
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe('AVEN-009 intake: determinism', () => {
  it('gives deeply equal, byte-identical results for many permutations and repeated runs', () => {
    const records = [
      ...ownerSet(),
      durable({ id: 'learned_B', category: 'preference' }),
      durable({ id: 'learned_a', version: 3, createdAt: T2 }),
      activeTask({ id: 'learned_t0' }),
      ...Array.from({ length: 30 }, (_, i) => foreign(i)),
    ];
    const baseline = run(records);
    const text = JSON.stringify(baseline);
    for (let seed = 1; seed <= 60; seed += 1) {
      const result = run(shuffled(records, seed));
      expect(result).toEqual(baseline);
      expect(JSON.stringify(result)).toBe(text);
    }
    // Code-unit order: uppercase sorts before lowercase.
    expect(
      baseline.durable.map((r) => `${r.id}@${r.metadata.recordVersion}`),
    ).toEqual([
      'learned_B@1',
      'learned_a@1',
      'learned_a@3',
      'learned_b@1',
      'learned_c@1',
      'learned_d@1',
      'learned_e@1',
    ]);
    expect(baseline.activeTasks.map((r) => r.id)).toEqual([
      'learned_t0',
      'learned_t1',
    ]);
  });

  it('reports the same failure for every permutation of a multi-fault input', () => {
    const records = [
      durable({ id: 'learned_m', version: 1, createdAt: T2 }),
      durable({ id: 'learned_m', version: 2, createdAt: T1 }),
      durable({ id: 'learned_k', version: 1 }),
      with_(
        durable({ id: 'learned_k', version: 1 }),
        (r) => ((r['content'] as Json)['subject'] = 'Other'),
      ),
      durable({ id: 'learned_n', version: 1, category: 'fact' }),
      durable({
        id: 'learned_n',
        version: 2,
        createdAt: T1,
        category: 'episode',
      }),
    ];
    const first = failure(() => run(records));
    // learned_k sorts first, so its duplicate conflict is the reported fault.
    expect(first).toBe(expected('conflicting_duplicate'));
    for (let seed = 1; seed <= 30; seed += 1)
      expect(failure(() => run(shuffled(records, seed)))).toBe(first);
  });

  it('uses no clock, randomness or timers while running', () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'fetch'),
    ];
    run(ownerSet());
    failure(() =>
      run([
        durable({ version: 1, createdAt: T2 }),
        durable({ version: 2, createdAt: T1 }),
      ]),
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
