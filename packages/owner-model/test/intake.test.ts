import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  intakeOwnerState,
  OwnerModelError,
  type OwnerModelErrorCode,
  type OwnerStateIntake,
} from '../src/index.ts';
import { ambientPrototypesAreStandard } from '../src/ambient.ts';
import { canonicalText } from '../src/canonical-text.ts';
import {
  activeTask,
  deeplyFrozen,
  durable,
  FOREIGN,
  foreign,
  observed,
  OTHER_FOREIGN,
  OWNER,
  revoked,
  shuffled,
  superseded,
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
  invalid_owner_model_context:
    'Owner-model context candidates do not fit the context source contract; no candidates were offered',
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

/* -------------------------------------------------------------------------
 * Patch-2 review fixes (H1, M1, M2). Pollution is installed only inside
 * `polluted`, restored in `finally`, and the restoration of Object.prototype
 * and Array.prototype is asserted after every test of these groups. Results
 * are captured inside the polluted region and asserted after restoration, so
 * Vitest itself never runs against a polluted realm.
 * ---------------------------------------------------------------------- */

type Captured =
  | { readonly ok: true; readonly result: OwnerStateIntake }
  | { readonly ok: false; readonly error: unknown };

function capture(call: () => OwnerStateIntake): Captured {
  try {
    return { ok: true, result: call() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Every own key and descriptor of both prototypes, plus Array.prototype's
 * chain. Sorted by key text: re-adding a deleted standard property restores
 * the realm even though it changes enumeration order.
 */
function prototypeState(): unknown {
  const describe = (target: object) =>
    Reflect.ownKeys(target)
      .map(
        (key) =>
          [String(key), Reflect.getOwnPropertyDescriptor(target, key)] as const,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    describe(Object.prototype),
    describe(Array.prototype),
    Object.getPrototypeOf(Array.prototype) === Object.prototype,
  ];
}
const PRISTINE = prototypeState();

/** Installs one inherited property for the duration of `body` only. */
function polluted<T>(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  body: () => T,
): T {
  const before = Reflect.getOwnPropertyDescriptor(target, key);
  // Array.prototype is itself an array: an index key also moves its length.
  const length = Array.isArray(target) ? target.length : undefined;
  const install = Object.create(null) as PropertyDescriptor;
  Object.assign(install, descriptor, { configurable: true });
  Object.defineProperty(target, key, install);
  try {
    return body();
  } finally {
    if (before === undefined) Reflect.deleteProperty(target, key);
    else
      Object.defineProperty(
        target,
        key,
        Object.assign(Object.create(null) as PropertyDescriptor, before),
      );
    if (length !== undefined) (target as unknown[]).length = length;
  }
}

/** Canonical text of a result, computed outside any polluted region. */
const text = (outcome: Captured): string => {
  if (outcome.ok) return JSON.stringify(outcome.result);
  expect(outcome.error).toBeInstanceOf(OwnerModelError);
  return JSON.stringify(outcome.error);
};

const procedure = () => durable({ id: 'learned_p', category: 'procedure' });
const cleanText = (records: unknown[]) => text(capture(() => run(records)));

/** Applies an arbitrary realm change for the duration of `body` only. */
function altered<T>(apply: () => void, restore: () => void, body: () => T): T {
  apply();
  try {
    return body();
  } finally {
    restore();
  }
}

const counted = <T extends (...args: never[]) => unknown>(fn: T) => vi.fn(fn);

/** Every relevant descriptor kind an attacker could install. */
function hostileDescriptors(): [
  string,
  PropertyDescriptor,
  ReturnType<typeof vi.fn>,
][] {
  const getter = counted(() => 'INHERITED');
  const throwing = counted(() => {
    throw new Error('PRIVATE_SENTINEL');
  });
  const setter = counted(() => undefined);
  const both = counted(() => 'INHERITED');
  const hook = counted(() => 'COLLISION');
  return [
    ['string data', { value: 'INHERITED', writable: true }, counted(() => 0)],
    [
      'enumerable data',
      { value: 'INHERITED', writable: true, enumerable: true },
      counted(() => 0),
    ],
    [
      'object data',
      { value: { status: 'observed', kind: 'global' }, writable: true },
      counted(() => 0),
    ],
    ['function data', { value: hook, writable: true }, hook],
    ['getter', { get: getter }, getter],
    ['throwing getter', { get: throwing }, throwing],
    ['setter', { set: setter }, setter],
    ['getter and setter', { get: both, set: both }, both],
  ];
}

describe('AVEN-009 intake: ambient-prototype gate (fail closed, zero hooks)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  it('matches the pinned baseline in a clean Node 24 realm, so clean intake is unaffected', () => {
    expect(ambientPrototypesAreStandard()).toBe(true);
    expect(run([procedure(), durable(), activeTask()]).durable).toHaveLength(2);
  });

  /*
   * Each record below is INVALID under the frozen schema in a clean realm.
   * Before this fix, each became ACCEPTED under the listed pollution, because
   * the frozen refinements read the field from the schema's own ordinary
   * output objects (reproduced on 74c782b). Now: invalid_input, zero hooks.
   */
  const unbounded = () => ({
    ...durable(),
    scope: { kind: 'bounded', qualifiers: { recipient: 'synthetic' } },
  });
  const selfReplacing = () => ({
    ...durable({ id: 'learned_x' }),
    lifecycle: {
      status: 'superseded',
      supersededAt: T1,
      replacement: { learnedItemId: 'learned_x', version: 1 },
      eventId: 'event_x',
    },
  });
  const contestedWithoutCounterexamples = () =>
    with_(durable(), (r) => {
      (r['evidence'] as Json)['support'] = 'contested';
      (r['evidence'] as Json)['counterexamples'] = [];
    });
  const verdictCases: [string, () => Json, string, 'get' | 'value', unknown][] =
    [
      [
        'self-replacing superseded record',
        selfReplacing,
        'lifecycle',
        'get',
        { status: 'observed' },
      ],
      [
        'contested evidence without counterexamples',
        contestedWithoutCounterexamples,
        'support',
        'get',
        'limited',
      ],
      [
        'bounded scope without a boundary (forged domain getter)',
        unbounded,
        'domain',
        'get',
        'forged domain',
      ],
      [
        'bounded scope without a boundary (inherited domain data)',
        unbounded,
        'domain',
        'value',
        'forged domain',
      ],
      [
        'bounded scope without a boundary (inherited taskType data)',
        unbounded,
        'taskType',
        'value',
        'forged type',
      ],
      [
        'bounded scope without a boundary (inherited taskId data)',
        unbounded,
        'taskId',
        'value',
        'task_forged',
      ],
    ];
  it.each(verdictCases)(
    'never lets ambient state accept an invalid record: %s',
    (_label, make, key, kind, forged) => {
      expect(cleanText([make()])).toBe(expected('invalid_input'));
      const input = make();
      const hook = vi.fn(() => forged);
      const descriptor: PropertyDescriptor =
        kind === 'get' ? { get: hook } : { value: forged, writable: true };
      const outcome = polluted(Object.prototype, key, descriptor, () =>
        capture(() => run([input])),
      );
      expect(hook).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
      expect(text(outcome)).toBe(expected('invalid_input'));
      expect(text(outcome)).not.toContain('forged');
    },
  );

  it('fails closed for valid records under any Object.prototype pollution, with zero hook calls', () => {
    const input = [procedure(), durable(), activeTask()];
    for (const key of [
      'assertion',
      'precondition',
      'lifecycle',
      'until',
      'toJSON',
      'syntheticUnrelated',
      '0',
      'scope',
      'constructorX',
    ]) {
      for (const [kind, descriptor, hook] of hostileDescriptors()) {
        const outcome = polluted(Object.prototype, key, descriptor, () =>
          capture(() => run(input)),
        );
        expect(hook, `${key} ${kind}`).not.toHaveBeenCalled();
        expect(text(outcome), `${key} ${kind}`).toBe(expected('invalid_input'));
        expect(text(outcome)).not.toContain('PRIVATE_SENTINEL');
        expect(text(outcome)).not.toContain(key === '0' ? 'never' : key);
      }
    }
  });

  it('fails closed for valid records under any Array.prototype pollution, with zero hook calls', () => {
    const input = [procedure(), durable(), activeTask()];
    for (const key of [
      '0',
      '1',
      '7',
      'toJSON',
      'syntheticUnrelated',
      'assertion',
      'evidenceId',
    ]) {
      for (const [kind, descriptor, hook] of hostileDescriptors()) {
        const outcome = polluted(Array.prototype, key, descriptor, () =>
          capture(() => run(input)),
        );
        expect(hook, `${key} ${kind}`).not.toHaveBeenCalled();
        expect(text(outcome), `${key} ${kind}`).toBe(expected('invalid_input'));
      }
    }
  });

  it('fails closed when a standard property is modified, without calling the replacement', () => {
    const input = [procedure(), durable(), activeTask()];
    const replacement = counted(function some() {
      return true;
    });
    const cases: [string, object, PropertyKey, PropertyDescriptor][] = [
      [
        'Object.prototype.toString as JS function',
        Object.prototype,
        'toString',
        { value: replacement, writable: true },
      ],
      [
        'Object.prototype.toString as getter',
        Object.prototype,
        'toString',
        { get: replacement },
      ],
      [
        'Object.prototype.toString made enumerable',
        Object.prototype,
        'toString',
        { value: Object.prototype.toString, writable: true, enumerable: true },
      ],
      [
        'Object.prototype.hasOwnProperty swapped for another native',
        Object.prototype,
        'hasOwnProperty',
        { value: Object.prototype.isPrototypeOf, writable: true },
      ],
      [
        'Object.prototype.valueOf as bound native',
        Object.prototype,
        'valueOf',
        { value: Object.prototype.valueOf.bind(null), writable: true },
      ],
      [
        'Object.prototype.constructor as data string',
        Object.prototype,
        'constructor',
        { value: 'Object', writable: true },
      ],
      [
        'Object.prototype symbol key',
        Object.prototype,
        Symbol.toPrimitive,
        { value: replacement, writable: true },
      ],
      [
        'Array.prototype.some as JS function',
        Array.prototype,
        'some',
        { value: replacement, writable: true },
      ],
      [
        'Array.prototype.some swapped for every',
        Array.prototype,
        'some',
        { value: Array.prototype.every, writable: true },
      ],
      [
        'Array.prototype.map as Proxy of native',
        Array.prototype,
        'map',
        { value: new Proxy(Array.prototype.map, {}), writable: true },
      ],
      [
        'Array.prototype iterator replaced',
        Array.prototype,
        Symbol.iterator,
        { value: replacement, writable: true },
      ],
      [
        'Array.prototype unscopables as getter',
        Array.prototype,
        Symbol.unscopables,
        { get: replacement },
      ],
      [
        'Array.prototype.length non-zero',
        Array.prototype,
        'length',
        { value: 3, writable: true, configurable: false },
      ],
    ];
    for (const [label, target, key, descriptor] of cases) {
      const outcome =
        key === 'length'
          ? altered(
              () => ((Array.prototype as unknown[]).length = 3),
              () => ((Array.prototype as unknown[]).length = 0),
              () => capture(() => run(input)),
            )
          : polluted(target, key, descriptor, () => capture(() => run(input)));
      expect(text(outcome), label).toBe(expected('invalid_input'));
    }
    expect(replacement).not.toHaveBeenCalled();
  });

  it('fails closed when a standard property is missing or the prototype chain is changed', () => {
    const input = [procedure()];
    const at = Reflect.getOwnPropertyDescriptor(Array.prototype, 'at')!;
    const missing = altered(
      () => Reflect.deleteProperty(Array.prototype, 'at'),
      () => Object.defineProperty(Array.prototype, 'at', at),
      () => capture(() => run(input)),
    );
    const interposed = Object.create(Object.prototype) as object;
    const rechained = altered(
      () => Object.setPrototypeOf(Array.prototype, interposed),
      () => Object.setPrototypeOf(Array.prototype, Object.prototype),
      () => capture(() => run(input)),
    );
    expect(text(missing)).toBe(expected('invalid_input'));
    expect(text(rechained)).toBe(expected('invalid_input'));
  });

  it('is deterministic under pollution: every run and every input fails identically', () => {
    const inputs = [
      [],
      [durable()],
      [foreign(1)],
      [selfReplacing()],
      [durable(), durable()],
    ];
    const outcomes = polluted(
      Object.prototype,
      'assertion',
      { value: 'INHERITED', writable: true },
      () =>
        inputs.flatMap((records) => [
          capture(() => run(records)),
          capture(() => run(records)),
        ]),
    );
    for (const outcome of outcomes)
      expect(text(outcome)).toBe(expected('invalid_input'));
  });

  it('constructs and serializes OwnerModelError without invoking any inherited hook', () => {
    const hooks = {
      toJSON: counted(() => 'COLLISION'),
      message: counted(() => 'PRIVATE_SENTINEL'),
      code: counted(() => 'PRIVATE_SENTINEL'),
      get: counted(() => 'PRIVATE_SENTINEL'),
      set: counted(() => 'PRIVATE_SENTINEL'),
    };
    const serialized = polluted(
      Object.prototype,
      'toJSON',
      { value: hooks.toJSON, writable: true },
      () =>
        polluted(Object.prototype, 'message', { get: hooks.message }, () =>
          polluted(Object.prototype, 'code', { get: hooks.code }, () =>
            polluted(
              Object.prototype,
              'get',
              { value: hooks.get, writable: true },
              () =>
                polluted(
                  Object.prototype,
                  'set',
                  { value: hooks.set, writable: true },
                  () => {
                    const outcome = capture(() => run([durable()]));
                    const error = outcome.ok ? undefined : outcome.error;
                    const direct = new OwnerModelError('identity_conflict');
                    return {
                      isError: error instanceof OwnerModelError,
                      thrown: JSON.stringify(error),
                      json:
                        error instanceof OwnerModelError
                          ? JSON.stringify(error.toJSON())
                          : 'accepted or foreign error',
                      direct: JSON.stringify(direct),
                    };
                  },
                ),
            ),
          ),
        ),
    );
    for (const hook of Object.values(hooks))
      expect(hook).not.toHaveBeenCalled();
    expect(serialized.isError).toBe(true);
    expect(serialized.thrown).toBe(expected('invalid_input'));
    expect(serialized.json).toBe(expected('invalid_input'));
    expect(serialized.direct).toBe(expected('identity_conflict'));
  });

  it('returns null-prototype records, so absent fields never resolve through Object.prototype', () => {
    const result = run([procedure(), activeTask()]);
    expect(Object.getPrototypeOf(result)).toBeNull();
    const record = result.durable[0]!;
    for (const value of [
      record,
      record.metadata,
      record.content,
      record.scope,
      record.evidence,
      record.lifecycle,
      result.activeTasks[0]!.task,
    ])
      expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(result.durable)).toBe(Array.prototype);
    expect(deeplyFrozen(result)).toBe(true);
  });
});

describe('AVEN-009 canonical own-data serializer (independent of the gate)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  it('never consults an inherited toJSON or inherited enumerable data', () => {
    const objectHook = counted(() => 'COLLISION');
    const arrayHook = counted(() => 'COLLISION');
    const texts = polluted(
      Object.prototype,
      'toJSON',
      { value: objectHook, writable: true },
      () =>
        polluted(
          Array.prototype,
          'toJSON',
          { value: arrayHook, writable: true },
          () =>
            polluted(
              Object.prototype,
              'inherited',
              { value: 'INHERITED', writable: true, enumerable: true },
              () => [
                canonicalText({
                  steps: [{ instruction: 'a' }, { instruction: 'b' }],
                }),
                canonicalText({
                  steps: [{ instruction: 'b' }, { instruction: 'a' }],
                }),
                canonicalText({ b: [1, 2], a: { y: 'x', x: null } }),
                canonicalText({ a: { x: null, y: 'x' }, b: [1, 2] }),
                canonicalText(
                  Object.assign(Object.create(null) as Json, { a: 'A' }),
                ),
                canonicalText({ a: 'A' }),
              ],
            ),
        ),
    );
    expect(objectHook).not.toHaveBeenCalled();
    expect(arrayHook).not.toHaveBeenCalled();
    expect(texts[0]).toBe(
      '{"steps":[{"instruction":"a"},{"instruction":"b"}]}',
    );
    expect(texts[1]).not.toBe(texts[0]);
    expect(texts[2]).toBe('{"a":{"x":null,"y":"x"},"b":[1,2]}');
    expect(texts[3]).toBe(texts[2]);
    expect(texts[4]).toBe('{"a":"A"}');
    expect(texts[5]).toBe(texts[4]);
  });

  it('distinguishes values that ordinary serialization would collapse', () => {
    expect(canonicalText([1, 2])).not.toBe(canonicalText([2, 1]));
    expect(canonicalText({ t: '2026-10-01T09:00:00Z' })).not.toBe(
      canonicalText({ t: '2026-10-01T09:00:00.000Z' }),
    );
    expect(() => canonicalText({ n: Number.NaN })).toThrow();
    expect(() => canonicalText({ f: () => 1 })).toThrow();
  });
});

describe('AVEN-009 intake: request prototype policy (M1)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  const valid = () => ({ ownerId: OWNER, records: [durable()] });
  const decorate = (target: object) => Object.assign(target, valid());

  it('accepts ordinary and null-prototype request containers', () => {
    const ordinary = intakeOwnerState(valid());
    const bare = intakeOwnerState(
      Object.assign(Object.create(null) as Json, valid()),
    );
    expect(bare).toEqual(ordinary);
    expect(ordinary.durable).toHaveLength(1);
  });

  it.each([
    ['decorated Date', () => decorate(new Date(T0))],
    ['decorated RegExp', () => decorate(/synthetic/)],
    ['decorated Map', () => decorate(new Map())],
    ['decorated Set', () => decorate(new Set())],
    ['decorated class instance', () => decorate(new (class Request {})())],
    ['custom prototype', () => decorate(Object.create({ synthetic: true }))],
    [
      'custom prototype with the same fields',
      () => decorate(Object.create(valid())),
    ],
    ['decorated array', () => decorate([])],
    ['decorated function', () => decorate(function request() {})],
    ['decorated boxed string', () => decorate(new String('x'))],
  ])('rejects a %s even with valid own ownerId and records', (_label, make) => {
    expectFailure(() => intakeOwnerState(make()), 'invalid_input');
  });

  it('reads the prototype once through a guarded trap and never leaks a thrown value', () => {
    const throwing = new Proxy(valid(), {
      getPrototypeOf: () => {
        throw new Error('PRIVATE_SENTINEL');
      },
    });
    const outcome = failure(() => intakeOwnerState(throwing));
    expect(outcome).toBe(expected('invalid_input'));
    expect(outcome).not.toContain('PRIVATE_SENTINEL');

    const answers = (sequence: (object | null)[]) => {
      const trap = vi.fn(
        () =>
          sequence[Math.min(trap.mock.calls.length - 1, sequence.length - 1)]!,
      );
      return { trap, proxy: new Proxy(valid(), { getPrototypeOf: trap }) };
    };
    const plainFirst = answers([Object.prototype, Date.prototype]);
    expect(intakeOwnerState(plainFirst.proxy).durable).toHaveLength(1);
    expect(plainFirst.trap).toHaveBeenCalledTimes(1);
    const dateFirst = answers([Date.prototype, Object.prototype]);
    expectFailure(() => intakeOwnerState(dateFirst.proxy), 'invalid_input');
    expect(dateFirst.trap).toHaveBeenCalledTimes(1);
  });
});

describe('AVEN-009 intake: no owner coercion (M2)', () => {
  const hooked = (
    kind: 'toPrimitive' | 'toString' | 'valueOf',
    result: () => string,
  ) => {
    const hook = vi.fn(result);
    const key = kind === 'toPrimitive' ? Symbol.toPrimitive : kind;
    return { hook, value: { [key]: hook } };
  };

  it.each(['toPrimitive', 'toString', 'valueOf'] as const)(
    'never converts a record ownerId object via %s, and never drops it as foreign',
    (kind) => {
      for (const coerced of [FOREIGN, OWNER]) {
        const { hook, value } = hooked(kind, () => coerced);
        const records = [
          durable(),
          { ...durable({ id: 'learned_h' }), ownerId: value },
          foreign(1),
        ];
        // A coerced foreign owner would silently drop the record and succeed.
        expect(failure(() => run(records))).toBe(expected('invalid_input'));
        expect(hook).not.toHaveBeenCalled();
      }
      const { hook, value } = hooked(kind, () => {
        throw new Error('PRIVATE_SENTINEL');
      });
      const outcome = failure(() => run([{ ...durable(), ownerId: value }]));
      expect(outcome).toBe(expected('invalid_input'));
      expect(outcome).not.toContain('PRIVATE_SENTINEL');
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it.each(['toPrimitive', 'toString', 'valueOf'] as const)(
    'never converts a requesting ownerId object via %s',
    (kind) => {
      const { hook, value } = hooked(kind, () => OWNER);
      expectFailure(
        () => intakeOwnerState({ ownerId: value, records: [durable()] }),
        'invalid_input',
      );
      expect(hook).not.toHaveBeenCalled();
    },
  );

  it('rejects a boxed String owner that would equal the requester only after conversion', () => {
    expectFailure(
      () => run([{ ...durable(), ownerId: new String(OWNER) }]),
      'invalid_input',
    );
    expectFailure(
      () =>
        run([
          durable(),
          { ...durable({ id: 'learned_h' }), ownerId: new String(FOREIGN) },
        ]),
      'invalid_input',
    );
  });
});

describe('AVEN-009 intake: lifecycle references are kept, never resolved (M2 scope guard)', () => {
  it('keeps a superseded record and its replacement as two separate, unchanged records', () => {
    const records = [
      observed('learned_b', 'Synthetic B'),
      superseded(
        'learned_a',
        { learnedItemId: 'learned_b', version: 1 },
        'Synthetic A',
      ),
    ];
    const result = run(records);
    expect(
      result.durable.map((r) => [
        r.id,
        r.lifecycle.status,
        (r.content as { assertion: string }).assertion,
      ]),
    ).toEqual([
      ['learned_a', 'superseded', 'Synthetic A'],
      ['learned_b', 'observed', 'Synthetic B'],
    ]);
    expect(result.durable[0]!.lifecycle).toEqual(records[1]!['lifecycle']);
  });

  it('keeps a revoked record and its fallback as two separate, unchanged records', () => {
    const records = [
      revoked(
        'learned_c',
        { learnedItemId: 'learned_d', version: 1 },
        'Synthetic C',
      ),
      observed('learned_d', 'Synthetic D'),
    ];
    const result = run(shuffled(records, 5));
    expect(
      result.durable.map((r) => [
        r.id,
        r.lifecycle.status,
        (r.content as { assertion: string }).assertion,
      ]),
    ).toEqual([
      ['learned_c', 'revoked', 'Synthetic C'],
      ['learned_d', 'observed', 'Synthetic D'],
    ]);
    expect(result.durable[0]!.lifecycle).toEqual(records[0]!['lifecycle']);
  });

  it('does not check dangling references, cycles or cross-category replacement (deferred to later patches)', () => {
    const result = run([
      superseded(
        'learned_a',
        { learnedItemId: 'learned_b', version: 1 },
        'Synthetic A',
      ),
      superseded(
        'learned_b',
        { learnedItemId: 'learned_a', version: 1 },
        'Synthetic B',
      ),
      superseded(
        'learned_c',
        { learnedItemId: 'learned_missing', version: 9 },
        'Synthetic C',
      ),
      revoked(
        'learned_e',
        { learnedItemId: 'learned_p', version: 1 },
        'Synthetic E',
      ),
      procedure(),
    ]);
    expect(result.durable.map((r) => `${r.id}:${r.lifecycle.status}`)).toEqual([
      'learned_a:superseded',
      'learned_b:superseded',
      'learned_c:superseded',
      'learned_e:revoked',
      'learned_p:observed',
    ]);
  });

  it('keeps every version of an item superseded by its own later version', () => {
    const v1 = {
      ...superseded(
        'learned_s',
        { learnedItemId: 'learned_s', version: 2 },
        'Synthetic v1',
      ),
    };
    const v2 = observed('learned_s', 'Synthetic v2');
    (v2['metadata'] as Json)['recordVersion'] = 2;
    (v2['metadata'] as Json)['createdAt'] = T1;
    const result = run([v2, v1]);
    expect(
      result.durable.map((r) => [r.metadata.recordVersion, r.lifecycle.status]),
    ).toEqual([
      [1, 'superseded'],
      [2, 'observed'],
    ]);
  });
});

/* -------------------------------------------------------------------------
 * H1: pollution installed by CALLER TRAPS after the entry gate, and M1:
 * same-named native substitutions. Trap-installed state is removed in
 * `finally` by `lateInstaller`, and restoration is asserted after each test.
 * ---------------------------------------------------------------------- */

/** Installs one prototype property the first time `install` runs. */
function lateInstaller(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
) {
  let installed = false;
  let before: PropertyDescriptor | undefined;
  let length: number | undefined;
  return {
    install(): void {
      if (installed) return;
      installed = true;
      before = Reflect.getOwnPropertyDescriptor(target, key);
      length = Array.isArray(target) ? target.length : undefined;
      const install = Object.create(null) as PropertyDescriptor;
      Object.assign(install, descriptor, { configurable: true });
      Object.defineProperty(target, key, install);
    },
    restore(): void {
      if (!installed) return;
      if (before === undefined) Reflect.deleteProperty(target, key);
      else
        Object.defineProperty(
          target,
          key,
          Object.assign(Object.create(null) as PropertyDescriptor, before),
        );
      if (length !== undefined) (target as unknown[]).length = length;
    },
  };
}

type Placement =
  | 'request getPrototypeOf'
  | 'request ownKeys'
  | 'record ownerId descriptor'
  | 'record getPrototypeOf';
const PLACEMENTS: readonly Placement[] = [
  'request getPrototypeOf',
  'request ownKeys',
  'record ownerId descriptor',
  'record getPrototypeOf',
];

/** A request whose trap at `placement` installs the pollution. */
function trappedRequest(
  placement: Placement,
  record: Json,
  install: () => void,
  padding: number,
): unknown {
  const target =
    placement === 'record ownerId descriptor'
      ? new Proxy(record, {
          getOwnPropertyDescriptor(t, k) {
            if (k === 'ownerId') install();
            return Reflect.getOwnPropertyDescriptor(t, k);
          },
        })
      : placement === 'record getPrototypeOf'
        ? new Proxy(record, {
            getPrototypeOf(t) {
              install();
              return Reflect.getPrototypeOf(t);
            },
          })
        : record;
  const records: unknown[] = [];
  for (let i = 0; i < padding; i += 1) records.push(foreign(i));
  records.push(target);
  const request = { ownerId: OWNER, records };
  if (placement === 'request getPrototypeOf')
    return new Proxy(request, {
      getPrototypeOf(t) {
        install();
        return Reflect.getPrototypeOf(t);
      },
    });
  if (placement === 'request ownKeys')
    return new Proxy(request, {
      ownKeys(t) {
        install();
        return Reflect.ownKeys(t);
      },
    });
  return request;
}

describe('AVEN-009 intake: ambient integrity survives caller traps (H1)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  const unbounded = () => ({
    ...durable(),
    scope: { kind: 'bounded', qualifiers: { recipient: 'synthetic' } },
  });
  const selfReplacing = () => ({
    ...durable({ id: 'learned_x' }),
    lifecycle: {
      status: 'superseded',
      supersededAt: T1,
      replacement: { learnedItemId: 'learned_x', version: 1 },
      eventId: 'event_x',
    },
  });

  it('records stay invalid in a clean realm (precondition of every case)', () => {
    expect(cleanText([unbounded()])).toBe(expected('invalid_input'));
    expect(cleanText([selfReplacing()])).toBe(expected('invalid_input'));
  });

  for (const placement of PLACEMENTS)
    for (const [label, make, key, forged, getter] of [
      [
        'non-enumerable domain DATA',
        unbounded,
        'domain',
        'forged domain',
        false,
      ],
      [
        'forged lifecycle GETTER',
        selfReplacing,
        'lifecycle',
        { status: 'observed' },
        true,
      ],
    ] as const)
      it(`rejects an invalid record when ${placement} installs ${label}, with zero hook calls`, () => {
        const outcomes: string[] = [];
        for (const padding of [0, 3, 40]) {
          const hook = vi.fn(() => forged);
          const late = lateInstaller(
            Object.prototype,
            key,
            getter ? { get: hook } : { value: forged, writable: true },
          );
          const request = trappedRequest(
            placement,
            make(),
            late.install,
            padding,
          );
          let outcome: Captured;
          try {
            outcome = capture(() => intakeOwnerState(request));
          } finally {
            late.restore();
          }
          expect(hook).not.toHaveBeenCalled();
          expect(outcome.ok, `${placement} padding ${padding}`).toBe(false);
          outcomes.push(text(outcome));
        }
        for (const outcome of outcomes) {
          expect(outcome).toBe(expected('invalid_input'));
          expect(outcome).not.toContain('forged');
          expect(outcome).not.toContain('PRIVATE_SENTINEL');
        }
      });

  it('rejects valid records when a trap installs unsafe Array.prototype state, with zero hook calls', () => {
    const getter = counted(() => 'INHERITED');
    const setter = counted(() => undefined);
    const toJSON = counted(() => 'COLLISION');
    const arrayCases: [string, PropertyKey, PropertyDescriptor][] = [
      ['index 0 data', '0', { value: 'INHERITED', writable: true }],
      ['index 0 accessor', '0', { get: getter, set: setter }],
      ['toJSON', 'toJSON', { value: toJSON, writable: true }],
      [
        'some replaced by Uint8Array some',
        'some',
        { value: Uint8Array.prototype.some, writable: true },
      ],
    ];
    for (const placement of PLACEMENTS)
      for (const [label, key, descriptor] of arrayCases) {
        const late = lateInstaller(Array.prototype, key, descriptor);
        const request = trappedRequest(placement, durable(), late.install, 2);
        let outcome: Captured;
        try {
          outcome = capture(() => intakeOwnerState(request));
        } finally {
          late.restore();
        }
        expect(text(outcome), `${placement}: ${label}`).toBe(
          expected('invalid_input'),
        );
      }
    for (const hook of [getter, setter, toJSON])
      expect(hook).not.toHaveBeenCalled();
  });

  it('still accepts the same trap-bearing requests when the traps install nothing', () => {
    for (const placement of PLACEMENTS) {
      const request = trappedRequest(placement, durable(), () => undefined, 2);
      expect(intakeOwnerState(request).durable, placement).toHaveLength(1);
    }
  });
});

describe('AVEN-009 intake: same-named native substitutions are rejected (M1)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  const countingRequest = () => {
    const reads = vi.fn();
    const request = new Proxy(
      { ownerId: OWNER, records: [durable()] },
      {
        getPrototypeOf(t) {
          reads();
          return Reflect.getPrototypeOf(t);
        },
        ownKeys(t) {
          reads();
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, k) {
          reads();
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
    return { reads, request };
  };

  it.each(['includes', 'some', 'sort', 'map'] as const)(
    'rejects Array.prototype.%s = the same-named Uint8Array.prototype native before reading the request',
    (name) => {
      const native = Uint8Array.prototype[name];
      const { reads, request } = countingRequest();
      const [standard, outcome] = polluted(
        Array.prototype,
        name,
        { value: native, writable: true },
        () =>
          [
            ambientPrototypesAreStandard(),
            capture(() => intakeOwnerState(request)),
          ] as const,
      );
      expect(standard).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(text(outcome)).toBe(expected('invalid_input'));
    },
  );

  it('also rejects other same-named natives (diagnostic: Array.prototype.toString = Object.prototype.toString)', () => {
    for (const [target, name, native] of [
      [Array.prototype, 'toString', Object.prototype.toString],
      [Array.prototype, 'at', String.prototype.at],
      [Array.prototype, 'indexOf', String.prototype.indexOf],
      [Object.prototype, 'toString', Array.prototype.toString],
      [Object.prototype, 'valueOf', Number.prototype.valueOf],
    ] as const) {
      const { reads, request } = countingRequest();
      const outcome = polluted(
        target,
        name,
        { value: native, writable: true },
        () => capture(() => intakeOwnerState(request)),
      );
      expect(reads, name).not.toHaveBeenCalled();
      expect(text(outcome), name).toBe(expected('invalid_input'));
    }
  });

  it('passes every semantic probe with the ordinary Node 24 built-ins', () => {
    expect(ambientPrototypesAreStandard()).toBe(true);
    const { reads, request } = countingRequest();
    expect(intakeOwnerState(request).durable).toHaveLength(1);
    expect(reads).toHaveBeenCalled();
  });
});

describe('AVEN-009 intake: integrity is re-established after EVERY caller interaction (H1)', () => {
  afterEach(() => {
    expect(prototypeState()).toEqual(PRISTINE);
  });

  /*
   * Transient pollution: one trap installs it and the very NEXT caller
   * operation removes it, so only the check immediately after the installing
   * operation can see it. A valid record must still be refused: owner-model
   * never continues while the realm is unsafe, even briefly.
   */
  function transient(placement: Placement) {
    const late = lateInstaller(Object.prototype, 'domain', {
      value: 'forged domain',
      writable: true,
    });
    const record = durable();
    let request: unknown;
    if (
      placement === 'request getPrototypeOf' ||
      placement === 'request ownKeys'
    ) {
      request = new Proxy(
        { ownerId: OWNER, records: [record] },
        {
          getPrototypeOf(t) {
            if (placement === 'request getPrototypeOf') late.install();
            return Reflect.getPrototypeOf(t);
          },
          ownKeys(t) {
            if (placement === 'request getPrototypeOf') late.restore();
            if (placement === 'request ownKeys') late.install();
            return Reflect.ownKeys(t);
          },
          getOwnPropertyDescriptor(t, k) {
            if (placement === 'request ownKeys') late.restore();
            return Reflect.getOwnPropertyDescriptor(t, k);
          },
        },
      );
    } else {
      const proxied = new Proxy(record, {
        getOwnPropertyDescriptor(t, k) {
          if (placement === 'record ownerId descriptor' && k === 'ownerId')
            late.install();
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        getPrototypeOf(t) {
          if (placement === 'record ownerId descriptor') late.restore();
          if (placement === 'record getPrototypeOf') late.install();
          return Reflect.getPrototypeOf(t);
        },
        ownKeys(t) {
          if (placement === 'record getPrototypeOf') late.restore();
          return Reflect.ownKeys(t);
        },
      });
      // For the ownerId case the very next caller operation is the records
      // array's descriptor read of the following element: it removes the
      // pollution, so only the check right after the ownerId read sees it.
      const records =
        placement === 'record ownerId descriptor'
          ? new Proxy([proxied, foreign(1)], {
              getOwnPropertyDescriptor(t, k) {
                if (k === '1') late.restore();
                return Reflect.getOwnPropertyDescriptor(t, k);
              },
            })
          : [proxied];
      request = { ownerId: OWNER, records };
    }
    return { late, request };
  }

  it.each(PLACEMENTS)(
    'refuses a valid record when %s pollutes only briefly',
    (placement) => {
      const { late, request } = transient(placement);
      let outcome: Captured;
      try {
        outcome = capture(() => intakeOwnerState(request));
      } finally {
        late.restore();
      }
      expect(text(outcome)).toBe(expected('invalid_input'));
    },
  );
});
