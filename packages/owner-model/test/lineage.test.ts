import { describe, expect, it } from 'vitest';
import { OwnerModelError, type OwnerModelErrorCode } from '../src/errors.ts';
import * as publicApi from '../src/index.ts';
import { intakeOwnerState, type OwnerStateIntake } from '../src/intake.ts';
import { buildDurableLineage, type DurableLineage } from '../src/lineage.ts';
import {
  activeTask,
  CONTENT,
  deeplyFrozen,
  durable,
  FOREIGN,
  OWNER,
  shuffled,
  T0,
  T1,
  T2,
  T3,
} from './fixtures.ts';

/**
 * AVEN-009 patch 3: deterministic STRUCTURAL lineage of durable owner state.
 * Every owner, ID, category and text is SYNTHETIC (see fixtures.ts). These
 * are mechanics checks of exact-reference resolution, category agreement,
 * cycle detection, ordering, immutability and error sanitization. They are
 * not evidence about which version applies, about learning quality or about
 * runtime security.
 */
type Json = Record<string, unknown>;
type Category = keyof typeof CONTENT;
type Ref = { learnedItemId: string; version: number };

const CATEGORIES = Object.keys(CONTENT) as Category[];

const EVALUATIONS = [{ evaluationId: 'evaluation_s1', version: 1 }];

/** A synthetic lifecycle of each frozen status. */
const LIFECYCLE = {
  observed: () => ({ status: 'observed' }),
  validated: () => ({
    status: 'validated',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
  }),
  trusted: () => ({
    status: 'trusted',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
    candidate: { candidateId: 'candidate_s1', version: 1 },
    promotionEventId: 'event_promotion_s1',
  }),
  superseded: (replacement: Ref) => ({
    status: 'superseded',
    supersededAt: T1,
    replacement,
    eventId: 'event_sup_s1',
  }),
  revoked: (fallback?: Ref) => ({
    status: 'revoked',
    revokedAt: T1,
    reason: 'Synthetic revocation',
    eventId: 'event_rev_s1',
    ...(fallback === undefined ? {} : { fallback }),
  }),
} as const;

const ref = (learnedItemId: string, version = 1): Ref => ({
  learnedItemId,
  version,
});

/** One synthetic durable snapshot with a chosen lifecycle. */
function item(
  id: string,
  version = 1,
  options: { category?: Category; lifecycle?: Json; createdAt?: string } = {},
): Json {
  return {
    ...durable({
      id,
      version,
      category: options.category ?? 'fact',
      createdAt: options.createdAt ?? T0,
    }),
    lifecycle: options.lifecycle ?? LIFECYCLE.observed(),
  };
}
const replacing = (
  id: string,
  version: number,
  target: Ref,
  category?: Category,
) =>
  item(id, version, {
    lifecycle: LIFECYCLE.superseded(target),
    ...(category === undefined ? {} : { category }),
  });
const falling = (
  id: string,
  version: number,
  target: Ref | undefined,
  category?: Category,
) =>
  item(id, version, {
    lifecycle: LIFECYCLE.revoked(target),
    ...(category === undefined ? {} : { category }),
  });

const intake = (records: unknown[]): OwnerStateIntake =>
  intakeOwnerState({ ownerId: OWNER, records });
const lineage = (records: unknown[]): DurableLineage =>
  buildDurableLineage(intake(records));

/** A compact, readable projection of a lineage (test-side only). */
function shape(value: DurableLineage) {
  return {
    histories: value.histories.map(
      (h) =>
        `${h.learnedItemId} ${h.category} [${h.versions
          .map((v) => v.metadata.recordVersion)
          .join(',')}]`,
    ),
    edges: value.edges.map(
      (e) =>
        `${e.kind} ${e.source.learnedItemId}@${e.source.version} -> ${e.target.learnedItemId}@${e.target.version}`,
    ),
  };
}

const MESSAGE: Record<OwnerModelErrorCode, string> = {
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
};

/** The serialized public error a failing call throws (asserted exact). */
function failure(call: () => unknown): string {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(OwnerModelError);
  const error = thrown as OwnerModelError;
  expect('cause' in error).toBe(false);
  expect(Object.keys(error.toJSON()).sort()).toEqual([
    'code',
    'message',
    'name',
  ]);
  return JSON.stringify(error);
}
const expected = (code: OwnerModelErrorCode) =>
  JSON.stringify({ name: 'OwnerModelError', code, message: MESSAGE[code] });
function expectLineageFailure(
  records: unknown[],
  code: OwnerModelErrorCode,
): void {
  const input = intake(records);
  expect(failure(() => buildDurableLineage(input))).toBe(expected(code));
}

describe('AVEN-009 lineage: input boundary', () => {
  it('is internal: the package index does not export it', () => {
    expect(Object.keys(publicApi)).not.toContain('buildDurableLineage');
    expect(Object.keys(publicApi).filter((k) => /lineage/i.test(k))).toEqual(
      [],
    );
  });

  it('accepts only a result produced by intakeOwnerState', () => {
    const genuine = intake([item('learned_a')]);
    const lookalikes: unknown[] = [
      { ownerId: OWNER, durable: [], activeTasks: [] },
      { ...genuine },
      Object.freeze({ ...genuine }),
      structuredClone({ ...genuine }),
      Object.create(genuine),
      JSON.parse(JSON.stringify(genuine)),
      [],
      null,
      undefined,
      0,
      'intake',
      () => genuine,
    ];
    for (const value of lookalikes)
      expect(
        failure(() =>
          buildDurableLineage(value as unknown as OwnerStateIntake),
        ),
      ).toBe(expected('invalid_input'));
    expect(shape(buildDurableLineage(genuine)).histories).toEqual([
      'learned_a fact [1]',
    ]);
  });

  it('rejects a Proxy around a genuine intake without running any trap', () => {
    const genuine = intake([item('learned_a')]);
    let traps = 0;
    const handler: ProxyHandler<object> = {};
    for (const trap of [
      'get',
      'has',
      'ownKeys',
      'getOwnPropertyDescriptor',
      'getPrototypeOf',
      'apply',
    ] as const)
      (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
        traps += 1;
        return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
      };
    const proxy = new Proxy(genuine, handler) as OwnerStateIntake;
    expect(failure(() => buildDurableLineage(proxy))).toBe(
      expected('invalid_input'),
    );
    expect(traps).toBe(0);
  });

  it('uses durable state only: active task state never enters lineage', () => {
    const onlyActive = lineage([
      activeTask({ id: 'learned_t1' }),
      activeTask({ id: 'learned_t2' }),
    ]);
    expect(onlyActive.histories).toEqual([]);
    expect(onlyActive.edges).toEqual([]);
    const mixed = lineage([
      activeTask({ id: 'learned_t1' }),
      item('learned_a'),
    ]);
    expect(shape(mixed)).toEqual({
      histories: ['learned_a fact [1]'],
      edges: [],
    });
    // A reference never resolves against an active task, even an exact one.
    expectLineageFailure(
      [
        activeTask({ id: 'learned_t1' }),
        replacing('learned_a', 1, ref('learned_t1')),
      ],
      'invalid_lineage_reference',
    );
    expectLineageFailure(
      [
        activeTask({ id: 'learned_t1' }),
        falling('learned_a', 1, ref('learned_t1')),
      ],
      'invalid_lineage_reference',
    );
  });

  it('carries the intake owner and never resolves into a dropped foreign record', () => {
    const input = intake([
      item('learned_a'),
      durable({ id: 'learned_f1', ownerId: FOREIGN }),
    ]);
    const result = buildDurableLineage(input);
    expect(result.ownerId).toBe(OWNER);
    expect(shape(result).histories).toEqual(['learned_a fact [1]']);
    expectLineageFailure(
      [
        replacing('learned_a', 1, ref('learned_f1')),
        durable({ id: 'learned_f1', ownerId: FOREIGN }),
      ],
      'invalid_lineage_reference',
    );
  });
});

describe('AVEN-009 lineage: histories', () => {
  it('builds an empty lineage from an empty durable set', () => {
    const result = lineage([]);
    expect(result.ownerId).toBe(OWNER);
    expect(result.histories).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('groups by stable ID in code-unit order with every version in numeric order', () => {
    const records = [
      item('learned_b', 10),
      item('learned_b', 2),
      item('learned_b', 1),
      item('learned_a_', 1),
      item('learned_a', 3),
      item('learned_a', 1),
      item('learned_B', 1, { category: 'preference' }),
      item('learned_a-', 1, { category: 'episode' }),
      item('learned_a2', 7),
    ];
    for (const seed of [1, 7, 42, 9001]) {
      const result = lineage(shuffled(records, seed));
      // Code units: 'B' (66) < '_' (95) < 'a' (97), and '-' (45) < '2' (50)
      // < '_' (95). Versions: 1 < 2 < 10 numerically, never as text; gaps
      // (1, 3) are kept as they are and nothing is inferred for them.
      expect(shape(result).histories).toEqual([
        'learned_B preference [1]',
        'learned_a fact [1,3]',
        'learned_a- episode [1]',
        'learned_a2 fact [7]',
        'learned_a_ fact [1]',
        'learned_b fact [1,2,10]',
      ]);
      expect(result.edges).toEqual([]);
    }
  });

  it('keeps every frozen Patch-2 record as is, without copy or substitution', () => {
    const input = intake([
      item('learned_b', 2),
      item('learned_a'),
      item('learned_b', 1),
    ]);
    const result = buildDurableLineage(input);
    const listed = result.histories.flatMap((h) => h.versions);
    expect(listed).toHaveLength(input.durable.length);
    for (const record of input.durable)
      expect(listed.filter((v) => v === record)).toHaveLength(1);
    for (const history of result.histories)
      for (const version of history.versions) {
        expect(version.id).toBe(history.learnedItemId);
        expect(version.content.category).toBe(history.category);
      }
  });

  it('builds one fact v1, and one ID with versions 1, 2 and 3', () => {
    expect(shape(lineage([item('learned_a')]))).toEqual({
      histories: ['learned_a fact [1]'],
      edges: [],
    });
    const result = lineage([
      item('learned_a', 3, { createdAt: T2 }),
      item('learned_a', 1),
      item('learned_a', 2, { createdAt: T1 }),
    ]);
    expect(shape(result).histories).toEqual(['learned_a fact [1,2,3]']);
    expect(
      result.histories[0]!.versions.map((v) => v.metadata.createdAt),
    ).toEqual([T0, T1, T2]);
  });

  it('records each history category for every content category', () => {
    const result = lineage(
      CATEGORIES.map((category, i) => item(`learned_c${i}`, 1, { category })),
    );
    expect(result.histories.map((h) => h.category)).toEqual(CATEGORIES);
  });

  it('exposes no in-force, current or selected version notion', () => {
    const result = lineage([
      item('learned_a', 1, {
        lifecycle: LIFECYCLE.superseded(ref('learned_a', 2)),
      }),
      item('learned_a', 2),
    ]);
    expect(Object.keys(result).sort()).toEqual([
      'edges',
      'histories',
      'ownerId',
    ]);
    for (const history of result.histories)
      expect(Object.keys(history).sort()).toEqual([
        'category',
        'learnedItemId',
        'versions',
      ]);
    for (const edge of result.edges) {
      expect(Object.keys(edge).sort()).toEqual(['kind', 'source', 'target']);
      expect(Object.keys(edge.source).sort()).toEqual([
        'learnedItemId',
        'version',
      ]);
    }
  });
});

describe('AVEN-009 lineage: replacement and fallback edges', () => {
  it('derives a replacement edge to another version of the same ID', () => {
    expect(
      shape(
        lineage([
          replacing('learned_a', 1, ref('learned_a', 2)),
          item('learned_a', 2),
        ]),
      ),
    ).toEqual({
      histories: ['learned_a fact [1,2]'],
      edges: ['replacement learned_a@1 -> learned_a@2'],
    });
  });

  it('allows a reference to an earlier version of the same ID', () => {
    expect(
      shape(
        lineage([
          item('learned_a', 1),
          replacing('learned_a', 2, ref('learned_a', 1)),
        ]),
      ).edges,
    ).toEqual(['replacement learned_a@2 -> learned_a@1']);
    expect(
      shape(
        lineage([
          item('learned_a', 1),
          falling('learned_a', 2, ref('learned_a', 1)),
        ]),
      ).edges,
    ).toEqual(['fallback learned_a@2 -> learned_a@1']);
  });

  it('derives a replacement edge to a different ID of the same category', () => {
    expect(
      shape(
        lineage([
          replacing('learned_a', 1, ref('learned_b')),
          item('learned_b'),
        ]),
      ).edges,
    ).toEqual(['replacement learned_a@1 -> learned_b@1']);
  });

  it('derives a fallback edge only when a revoked snapshot declares one', () => {
    expect(
      shape(
        lineage([
          falling('learned_a', 2, ref('learned_b', 3)),
          item('learned_b', 3),
        ]),
      ).edges,
    ).toEqual(['fallback learned_a@2 -> learned_b@3']);
    const without = lineage([
      falling('learned_a', 1, undefined),
      item('learned_b'),
    ]);
    expect(without.edges).toEqual([]);
    expect(shape(without).histories).toEqual([
      'learned_a fact [1]',
      'learned_b fact [1]',
    ]);
  });

  it('derives no edge from observed, validated or trusted snapshots', () => {
    const result = lineage([
      item('learned_a', 1, { lifecycle: LIFECYCLE.observed() }),
      item('learned_b', 1, { lifecycle: LIFECYCLE.validated() }),
      item('learned_c', 1, { lifecycle: LIFECYCLE.trusted() }),
    ]);
    expect(result.edges).toEqual([]);
    expect(result.histories).toHaveLength(3);
  });

  it.each([
    ['observed', LIFECYCLE.observed()],
    ['validated', LIFECYCLE.validated()],
    ['trusted', LIFECYCLE.trusted()],
    ['superseded', LIFECYCLE.superseded(ref('learned_c'))],
    ['revoked without fallback', LIFECYCLE.revoked()],
    ['revoked with fallback', LIFECYCLE.revoked(ref('learned_c'))],
  ])('ignores the target lifecycle status (%s)', (_label, targetLifecycle) => {
    for (const source of [
      replacing('learned_a', 1, ref('learned_b')),
      falling('learned_a', 1, ref('learned_b')),
    ]) {
      const result = lineage([
        source,
        item('learned_b', 1, { lifecycle: targetLifecycle }),
        item('learned_c'),
      ]);
      const kind = source['lifecycle'] as Json;
      const own = `${kind['status'] === 'superseded' ? 'replacement' : 'fallback'} learned_a@1 -> learned_b@1`;
      expect(shape(result).edges).toContain(own);
    }
  });

  it('builds a long mixed chain whose targets are themselves superseded or revoked', () => {
    const result = lineage([
      replacing('learned_a', 1, ref('learned_a', 2)),
      falling('learned_a', 2, ref('learned_b')),
      replacing('learned_b', 1, ref('learned_c')),
      item('learned_c'),
    ]);
    expect(shape(result).edges).toEqual([
      'fallback learned_a@2 -> learned_b@1',
      'replacement learned_a@1 -> learned_a@2',
      'replacement learned_b@1 -> learned_c@1',
    ]);
  });

  it('allows many sources to share one target (no uniqueness inference)', () => {
    const result = lineage([
      replacing('learned_a', 1, ref('learned_z')),
      falling('learned_b', 1, ref('learned_z')),
      replacing('learned_c', 1, ref('learned_z')),
      item('learned_z'),
    ]);
    expect(shape(result).edges).toEqual([
      'fallback learned_b@1 -> learned_z@1',
      'replacement learned_a@1 -> learned_z@1',
      'replacement learned_c@1 -> learned_z@1',
    ]);
  });

  it('orders edges by kind, source ID, source version, target ID, target version', () => {
    const records = [
      replacing('learned_b', 1, ref('learned_t', 1)),
      replacing('learned_a', 2, ref('learned_t', 2)),
      replacing('learned_a', 1, ref('learned_u', 1)),
      falling('learned_c', 1, ref('learned_t', 1)),
      falling('learned_B', 1, ref('learned_u', 1)),
      item('learned_t', 1),
      item('learned_t', 2),
      item('learned_u', 1),
    ];
    for (const seed of [3, 5, 11, 123]) {
      expect(shape(lineage(shuffled(records, seed))).edges).toEqual([
        'fallback learned_B@1 -> learned_u@1',
        'fallback learned_c@1 -> learned_t@1',
        'replacement learned_a@1 -> learned_u@1',
        'replacement learned_a@2 -> learned_t@2',
        'replacement learned_b@1 -> learned_t@1',
      ]);
    }
  });

  it('does not verify lifecycle claims: event IDs, timestamps and reasons are not compared', () => {
    // Claim agreement is a later patch. Structurally valid references are
    // accepted whatever the claimed time, event or reason.
    const late = (status: 'superseded' | 'revoked', target: Ref): Json =>
      status === 'superseded'
        ? {
            status,
            supersededAt: T0,
            replacement: target,
            eventId: 'event_shared',
            lastValidatedAt: T3,
          }
        : {
            status,
            revokedAt: T0,
            reason: 'Synthetic other reason',
            eventId: 'event_shared',
            fallback: target,
            lastValidatedAt: T3,
          };
    const result = lineage([
      item('learned_a', 1, { lifecycle: late('superseded', ref('learned_b')) }),
      item('learned_c', 1, { lifecycle: late('revoked', ref('learned_b')) }),
      item('learned_b', 1, { createdAt: T2 }),
    ]);
    expect(shape(result).edges).toEqual([
      'fallback learned_c@1 -> learned_b@1',
      'replacement learned_a@1 -> learned_b@1',
    ]);
  });
});

describe('AVEN-009 lineage: records are preserved, never resolved or substituted', () => {
  const records = [
    replacing('learned_a', 1, ref('learned_b', 2)),
    item('learned_b', 1),
    falling('learned_b', 2, ref('learned_b', 1)),
    falling('learned_c', 1, ref('learned_a', 1)),
  ];

  it('lists every intake record exactly once, at its own identity', () => {
    const input = intake(records);
    const before = JSON.stringify(input);
    const result = buildDurableLineage(input);
    const listed = result.histories.flatMap((h) => h.versions);
    expect(listed).toHaveLength(input.durable.length);
    for (const record of input.durable)
      expect(listed.filter((v) => v === record)).toHaveLength(1);
    expect(shape(result).histories).toEqual([
      'learned_a fact [1]',
      'learned_b fact [1,2]',
      'learned_c fact [1]',
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps each source with its own status and its exact declared reference', () => {
    const input = intake(records);
    const result = buildDurableLineage(input);
    expect(result.edges).toHaveLength(3);
    for (const edge of result.edges) {
      const history = result.histories.find(
        (h) => h.learnedItemId === edge.source.learnedItemId,
      )!;
      const source = history.versions.find(
        (v) => v.metadata.recordVersion === edge.source.version,
      )!;
      expect(input.durable).toContain(source);
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.lifecycle)).toBe(true);
      const lifecycle = source.lifecycle;
      const declared =
        lifecycle.status === 'superseded'
          ? lifecycle.replacement
          : lifecycle.status === 'revoked'
            ? lifecycle.fallback
            : undefined;
      expect(lifecycle.status).toBe(
        edge.kind === 'replacement' ? 'superseded' : 'revoked',
      );
      expect(declared).toEqual(edge.target);
      // The target is listed at its own identity too, unchanged.
      const target = result.histories
        .find((h) => h.learnedItemId === edge.target.learnedItemId)!
        .versions.find(
          (v) => v.metadata.recordVersion === edge.target.version,
        )!;
      expect(input.durable).toContain(target);
      expect(target).not.toBe(source);
    }
  });
});

describe('AVEN-009 lineage: exact resolution only', () => {
  it.each([
    ['a missing version above the existing ones', ref('learned_b', 3)],
    ['a missing version below the existing ones', ref('learned_b', 1)],
    ['a missing version inside a gap', ref('learned_b', 4)],
    ['an unknown ID', ref('learned_unknown', 2)],
    ['a near-miss ID', ref('learned_B', 2)],
  ])('rejects %s, with no latest or nearest fallback', (_label, target) => {
    const present = [
      item('learned_b', 2),
      item('learned_b', 5, { createdAt: T1 }),
    ];
    for (const source of [
      replacing('learned_a', 1, target),
      falling('learned_a', 1, target),
    ])
      expectLineageFailure([source, ...present], 'invalid_lineage_reference');
  });

  it.each([
    ['observed', LIFECYCLE.observed()],
    ['trusted', LIFECYCLE.trusted()],
    ['revoked', LIFECYCLE.revoked()],
  ])(
    'resolves version 2 exactly, never the latest version 3 (latest is %s)',
    (_label, latest) => {
      const present = [
        item('learned_a', 1),
        item('learned_a', 2, { createdAt: T1 }),
        item('learned_a', 3, { createdAt: T2, lifecycle: latest }),
      ];
      for (const [source, kind] of [
        [replacing('learned_z', 1, ref('learned_a', 2)), 'replacement'],
        [falling('learned_z', 1, ref('learned_a', 2)), 'fallback'],
      ] as const)
        expect(shape(lineage([source, ...present])).edges).toEqual([
          `${kind} learned_z@1 -> learned_a@2`,
        ]);
    },
  );

  it('rejects a reference to a version of the source ID that does not exist', () => {
    expectLineageFailure(
      [replacing('learned_a', 1, ref('learned_a', 2))],
      'invalid_lineage_reference',
    );
    expectLineageFailure(
      [item('learned_a', 1), falling('learned_a', 2, ref('learned_a', 3))],
      'invalid_lineage_reference',
    );
  });

  it('leaves self-reference to the frozen schema (rejected at intake)', () => {
    for (const record of [
      replacing('learned_a', 1, ref('learned_a', 1)),
      falling('learned_a', 2, ref('learned_a', 2)),
    ])
      expect(failure(() => intake([record]))).toBe(expected('invalid_input'));
  });

  const pairs = CATEGORIES.flatMap((from) =>
    CATEGORIES.map((to) => [from, to] as const),
  );

  it.each(pairs.filter(([from, to]) => from !== to))(
    'rejects a cross-category reference from %s to %s, for both edge kinds',
    (from, to) => {
      const target = item('learned_b', 1, { category: to });
      expectLineageFailure(
        [replacing('learned_a', 1, ref('learned_b'), from), target],
        'invalid_lineage_reference',
      );
      expectLineageFailure(
        [falling('learned_a', 1, ref('learned_b'), from), target],
        'invalid_lineage_reference',
      );
    },
  );

  it.each(CATEGORIES)(
    'accepts a same-category reference within %s',
    (category) => {
      const result = lineage([
        replacing('learned_a', 1, ref('learned_b'), category),
        falling('learned_c', 1, ref('learned_b'), category),
        item('learned_b', 1, { category }),
      ]);
      expect(shape(result).edges).toEqual([
        'fallback learned_c@1 -> learned_b@1',
        'replacement learned_a@1 -> learned_b@1',
      ]);
    },
  );
});

describe('AVEN-009 lineage: cycles', () => {
  it.each([
    [
      'a two-node replacement cycle',
      [
        replacing('learned_a', 1, ref('learned_b')),
        replacing('learned_b', 1, ref('learned_a')),
      ],
    ],
    [
      'a two-node fallback cycle',
      [
        falling('learned_a', 1, ref('learned_b')),
        falling('learned_b', 1, ref('learned_a')),
      ],
    ],
    [
      'a mixed replacement and fallback cycle',
      [
        replacing('learned_a', 1, ref('learned_b')),
        falling('learned_b', 1, ref('learned_a')),
      ],
    ],
    [
      'a cycle between versions of one ID',
      [
        replacing('learned_a', 1, ref('learned_a', 2)),
        falling('learned_a', 2, ref('learned_a', 1)),
      ],
    ],
    [
      'a three-node cycle across IDs and versions',
      [
        replacing('learned_a', 1, ref('learned_b', 2)),
        item('learned_b', 1),
        falling('learned_b', 2, ref('learned_c')),
        replacing('learned_c', 1, ref('learned_a')),
      ],
    ],
    [
      'a cycle reached through an acyclic tail',
      [
        replacing('learned_t', 1, ref('learned_u')),
        replacing('learned_u', 1, ref('learned_a')),
        replacing('learned_a', 1, ref('learned_b')),
        falling('learned_b', 1, ref('learned_a')),
        item('learned_z'),
      ],
    ],
  ])('rejects %s, in any input order', (_label, records) => {
    for (const seed of [1, 2, 3, 4, 5])
      expectLineageFailure(shuffled(records, seed), 'lineage_cycle');
  });

  it('accepts converging chains that only look cyclic by ID', () => {
    // learned_a@2 -> learned_b@1 and learned_b@2 -> learned_a@1 share IDs in
    // both directions but no exact node repeats, so there is no cycle.
    const result = lineage([
      item('learned_a', 1),
      replacing('learned_a', 2, ref('learned_b', 1)),
      item('learned_b', 1),
      replacing('learned_b', 2, ref('learned_a', 1)),
    ]);
    expect(shape(result).edges).toEqual([
      'replacement learned_a@2 -> learned_b@1',
      'replacement learned_b@2 -> learned_a@1',
    ]);
  });

  const width = 5;
  const id = (i: number) => `learned_n${String(i).padStart(width, '0')}`;
  /**
   * A chain node(0) -> node(1) -> ... alternating replacement and fallback
   * edges. With `closer`, the LAST node closes the chain back to node(0)
   * using that edge kind, so the only cycle is found at the very end.
   */
  function chain(count: number, closer?: 'replacement' | 'fallback') {
    const records: Json[] = [];
    for (let i = 0; i < count - 1; i += 1)
      records.push(
        i % 2 === 0
          ? replacing(id(i), 1, ref(id(i + 1)))
          : falling(id(i), 1, ref(id(i + 1))),
      );
    const last = count - 1;
    records.push(
      closer === undefined
        ? item(id(last))
        : closer === 'replacement'
          ? replacing(id(last), 1, ref(id(0)))
          : falling(id(last), 1, ref(id(0))),
    );
    return records;
  }
  // Intake of 10,000 records dominates these tests (Patch 2 validates each
  // record); lineage itself is linear. Each large fixture is built once.
  const HEAVY = 300_000;

  it(
    'handles a 10,000-node chain iteratively (no recursion, no stack overflow)',
    () => {
      const result = lineage(shuffled(chain(10_000), 17));
      expect(result.histories).toHaveLength(10_000);
      expect(result.edges).toHaveLength(9_999);
      expect(result.histories[0]!.learnedItemId).toBe(id(0));
      expect(result.histories[9_999]!.learnedItemId).toBe(id(9_999));
      expect(result.edges.filter((e) => e.kind === 'replacement')).toHaveLength(
        5_000,
      );
    },
    HEAVY,
  );

  it(
    'detects a cycle closed only by the last of 10,000 nodes',
    () => {
      expectLineageFailure(chain(10_000, 'fallback'), 'lineage_cycle');
    },
    HEAVY,
  );

  it(
    'detects a late cycle closed by a replacement edge (2,000 nodes)',
    () => {
      expectLineageFailure(chain(2_000, 'replacement'), 'lineage_cycle');
    },
    HEAVY,
  );

  it(
    'handles a 2,000-version chain within one stable ID, and its late cycle',
    () => {
      const records: Json[] = [];
      for (let v = 1; v <= 2_000; v += 1)
        records.push(
          v < 2_000
            ? replacing('learned_a', v, ref('learned_a', v + 1))
            : item('learned_a', v),
        );
      const result = lineage(shuffled(records, 99));
      expect(result.histories).toHaveLength(1);
      expect(result.histories[0]!.versions).toHaveLength(2_000);
      expect(result.edges).toHaveLength(1_999);
      records[1_999] = falling('learned_a', 2_000, ref('learned_a', 1));
      expectLineageFailure(records, 'lineage_cycle');
    },
    HEAVY,
  );
});

describe('AVEN-009 lineage: error precedence', () => {
  const cycle = [
    replacing('learned_a', 1, ref('learned_b')),
    replacing('learned_b', 1, ref('learned_a')),
  ];

  it('reports an unresolved reference before a cycle, wherever either sits', () => {
    for (const unresolved of [
      replacing('learned_0', 1, ref('learned_missing')),
      falling('learned_z', 1, ref('learned_missing')),
      replacing('learned_z', 1, ref('learned_a', 9)),
    ])
      for (const seed of [1, 2, 3, 4])
        expectLineageFailure(
          shuffled([...cycle, unresolved], seed),
          'invalid_lineage_reference',
        );
  });

  it('reports a cross-category reference before a cycle', () => {
    for (const seed of [1, 2, 3])
      expectLineageFailure(
        shuffled(
          [
            ...cycle,
            replacing('learned_z', 1, ref('learned_p'), 'fact'),
            item('learned_p', 1, { category: 'preference' }),
          ],
          seed,
        ),
        'invalid_lineage_reference',
      );
  });

  it('reports intake faults before any lineage fault (lineage never sees them)', () => {
    expect(
      failure(() =>
        intake([...cycle, item('learned_a', 2, { category: 'episode' })]),
      ),
    ).toBe(expected('identity_conflict'));
  });

  it('picks the reference fault for an unresolved, a cyclic and a cross-category item together', () => {
    const records = [
      replacing('learned_z', 1, ref('learned_missing')),
      ...cycle,
      replacing('learned_m', 1, ref('learned_n'), 'fact'),
      item('learned_n', 1, { category: 'procedure' }),
    ];
    for (const seed of [1, 2, 3, 4, 5, 6])
      expectLineageFailure(
        shuffled(records, seed),
        'invalid_lineage_reference',
      );
  });

  it('reports the same error for every permutation of a multi-fault input', () => {
    const records = [
      ...cycle,
      falling('learned_c', 1, ref('learned_d')),
      replacing('learned_d', 1, ref('learned_c')),
      falling('learned_e', 1, ref('learned_e', 2)),
    ];
    const outcomes = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) =>
        failure(() => lineage(shuffled(records, seed))),
      ),
    );
    expect([...outcomes]).toEqual([expected('invalid_lineage_reference')]);
  });
});

describe('AVEN-009 lineage: determinism and immutability', () => {
  const records = [
    replacing('learned_a', 1, ref('learned_a', 2)),
    item('learned_a', 2, { createdAt: T1 }),
    falling('learned_b', 1, ref('learned_a', 1)),
    item('learned_c', 1, { category: 'procedure' }),
    replacing('learned_c', 2, ref('learned_c', 1), 'procedure'),
  ];

  it('produces byte-identical output for every input order and repeat', () => {
    const texts = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const input = intake(shuffled(records, seed));
      texts.add(JSON.stringify(buildDurableLineage(input)));
      texts.add(JSON.stringify(buildDurableLineage(input)));
    }
    expect(texts.size).toBe(1);
  });

  it('returns deeply frozen null-prototype objects and frozen arrays, with no Map or Set', () => {
    const result = lineage(records);
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Array.isArray(result.histories)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    for (const history of result.histories) {
      expect(Object.getPrototypeOf(history)).toBeNull();
      expect(Object.isFrozen(history.versions)).toBe(true);
    }
    for (const edge of result.edges) {
      expect(Object.getPrototypeOf(edge)).toBeNull();
      expect(Object.getPrototypeOf(edge.source)).toBeNull();
      expect(Object.getPrototypeOf(edge.target)).toBeNull();
    }
    const seen: unknown[] = [result];
    while (seen.length > 0) {
      const value = seen.pop();
      expect(value instanceof Map || value instanceof Set).toBe(false);
      expect(value instanceof WeakMap || value instanceof WeakSet).toBe(false);
      if (value !== null && typeof value === 'object')
        seen.push(...Object.values(value));
    }
  });

  it('rejects mutation of every level of the result', () => {
    const result = lineage(records);
    const writes: (() => void)[] = [
      () => {
        (result as unknown as Json)['ownerId'] = 'owner_synthetic_b';
      },
      () => {
        (result.histories as unknown as Json[]).push({});
      },
      () => {
        (result.histories[0] as unknown as Json)['category'] = 'preference';
      },
      () => {
        (result.histories[0]!.versions as unknown as Json[]).pop();
      },
      () => {
        (result.edges as unknown as Json[]).length = 0;
      },
      () => {
        (result.edges[0] as unknown as Json)['kind'] = 'replacement';
      },
      () => {
        (result.edges[0]!.target as unknown as Json)['version'] = 99;
      },
      () => {
        (result.histories[0]!.versions[0] as unknown as Json)['id'] =
          'learned_x';
      },
    ];
    const before = JSON.stringify(result);
    for (const write of writes) expect(write).toThrow(TypeError);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('leaves the intake result unchanged, including its durable order', () => {
    const input = intake(shuffled(records, 4));
    const before = JSON.stringify(input);
    const order = [...input.durable];
    buildDurableLineage(input);
    expect(JSON.stringify(input)).toBe(before);
    expect([...input.durable]).toEqual(order);
    for (let i = 0; i < order.length; i += 1)
      expect(input.durable[i]).toBe(order[i]);
  });

  it('returns a fresh result per call that shares only the frozen records', () => {
    const input = intake(records);
    const first = buildDurableLineage(input);
    const second = buildDurableLineage(input);
    expect(first).not.toBe(second);
    expect(first.edges).not.toBe(second.edges);
    expect(first.histories[0]!.versions[0]).toBe(
      second.histories[0]!.versions[0],
    );
  });
});

describe('AVEN-009 lineage: error sanitization', () => {
  const SECRET_ID = 'learned_PRIVATE_SENTINEL_ID';
  const SECRET_VERSION = 424_242;

  it.each([
    [
      'an unresolved reference',
      [
        replacing(
          SECRET_ID,
          1,
          ref('learned_PRIVATE_SENTINEL_TARGET', SECRET_VERSION),
        ),
      ],
      'invalid_lineage_reference',
    ],
    [
      'a cross-category reference',
      [
        replacing(
          SECRET_ID,
          1,
          ref('learned_PRIVATE_SENTINEL_TARGET'),
          'preference',
        ),
        item('learned_PRIVATE_SENTINEL_TARGET', 1, { category: 'procedure' }),
      ],
      'invalid_lineage_reference',
    ],
    [
      'a cycle',
      [
        replacing(
          SECRET_ID,
          SECRET_VERSION,
          ref('learned_PRIVATE_SENTINEL_TARGET'),
        ),
        falling(
          'learned_PRIVATE_SENTINEL_TARGET',
          1,
          ref(SECRET_ID, SECRET_VERSION),
        ),
      ],
      'lineage_cycle',
    ],
  ] as const)(
    'reports %s with a fixed message and no ID, version, category, path, count or owner',
    (_label, records, code) => {
      const text = failure(() => lineage([...records]));
      expect(text).toBe(expected(code));
      for (const leak of [
        'PRIVATE_SENTINEL',
        String(SECRET_VERSION),
        'preference',
        'procedure',
        OWNER,
        'replacement',
        'fallback',
        'lifecycle',
      ])
        expect(text).not.toContain(leak);
    },
  );
});

describe('AVEN-009 lineage: ambient prototype state', () => {
  function attempt(input: OwnerStateIntake): string {
    try {
      buildDurableLineage(input);
      return 'accepted';
    } catch (error) {
      return error instanceof OwnerModelError ? error.code : 'raw';
    }
  }
  /** Installs one property for the duration of `body` only. */
  function polluted<T>(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    body: () => T,
  ): T {
    const before = Reflect.getOwnPropertyDescriptor(target, key);
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

  const records = [
    replacing('learned_a', 1, ref('learned_b')),
    item('learned_b'),
  ];

  it.each([
    [
      'an unrelated Object.prototype key',
      Object.prototype,
      'syntheticUnrelated',
      { value: 1, writable: true },
    ],
    [
      'an inherited replacement',
      Object.prototype,
      'replacement',
      { value: ref('learned_a'), writable: true },
    ],
    [
      'an inherited fallback getter',
      Object.prototype,
      'fallback',
      { get: () => ref('learned_a') },
    ],
    [
      'an Array.prototype index',
      Array.prototype,
      '0',
      { value: 'INHERITED', writable: true },
    ],
    [
      'a substituted Array.prototype.sort',
      Array.prototype,
      'sort',
      { value: Uint8Array.prototype.sort, writable: true },
    ],
    [
      'a substituted Array.prototype.slice',
      Array.prototype,
      'slice',
      { value: Uint8Array.prototype.slice, writable: true },
    ],
  ] as const)(
    'fails closed with invalid_input on %s installed after intake, then recovers',
    (_label, target, key, descriptor) => {
      const input = intake(records);
      const outcome = polluted(target, key, descriptor, () => attempt(input));
      expect(outcome).toBe('invalid_input');
      expect(attempt(input)).toBe('accepted');
      expect(shape(buildDurableLineage(input)).edges).toEqual([
        'replacement learned_a@1 -> learned_b@1',
      ]);
    },
  );
});
