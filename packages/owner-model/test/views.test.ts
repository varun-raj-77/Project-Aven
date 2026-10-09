import { describe, expect, it } from 'vitest';
import {
  isVerifiedDurableLineage,
  verifyLifecycleClaims,
  type VerifiedDurableLineage,
} from '../src/claims.ts';
import { OwnerModelError, type OwnerModelErrorCode } from '../src/errors.ts';
import * as publicApi from '../src/index.ts';
import { intakeOwnerState } from '../src/intake.ts';
import { buildDurableLineage } from '../src/lineage.ts';
import { compareInstants } from '../src/timestamps.ts';
import {
  buildDurableCategoryViews,
  isDurableCategoryViews,
  type DurableCategoryViews,
} from '../src/views.ts';
import {
  activeTask,
  CONTENT,
  deeplyFrozen,
  durable,
  metadata,
  OWNER,
  shuffled,
} from './fixtures.ts';

/**
 * AVEN-009 patch 5: declared durable category views. Every owner, ID, text
 * and time is SYNTHETIC (see fixtures.ts). These are mechanics checks of the
 * as-of projection, lifecycle and temporal-scope rules, typing, ordering,
 * immutability and boundaries. A declared view is NOT Root trusted-version
 * selection and says nothing about truth or permission.
 */
type Json = Record<string, unknown>;
type Ref = { learnedItemId: string; version: number };
type Category = keyof typeof CONTENT;

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';
const T3 = '2026-03-01T00:00:00Z';
const T4 = '2026-04-01T00:00:00Z';
const T5 = '2026-05-01T00:00:00Z';
const BEFORE = '2025-12-31T23:59:59.999999Z';
const LATER = '2027-01-01T00:00:00Z';

const ref = (learnedItemId: string, version = 1): Ref => ({
  learnedItemId,
  version,
});
const EVALUATIONS = [{ evaluationId: 'evaluation_s1', version: 1 }];
const CANDIDATE = { candidateId: 'candidate_s1', version: 1 };
const DIGEST = { algorithm: 'sha256', value: 'b'.repeat(64) };
const POLICY = {
  decisionId: 'decision_s1',
  proposal: {
    proposalId: 'proposal_s1',
    proposalVersion: 1,
    proposalDigest: DIGEST,
    parametersDigest: DIGEST,
  },
  decision: 'ALLOW',
};

const LIFECYCLE = {
  observed: (): Json => ({ status: 'observed' }),
  validated: (): Json => ({
    status: 'validated',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
  }),
  trusted: (eventId: string): Json => ({
    status: 'trusted',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
    candidate: CANDIDATE,
    promotionEventId: eventId,
  }),
  superseded: (eventId: string, replacement: Ref): Json => ({
    status: 'superseded',
    supersededAt: T1,
    replacement,
    eventId,
  }),
  revoked: (eventId: string, fallback?: Ref): Json => ({
    status: 'revoked',
    revokedAt: T1,
    reason: 'Synthetic revocation reason',
    eventId,
    ...(fallback === undefined ? {} : { fallback }),
  }),
};

/** One synthetic durable snapshot. */
function item(
  id: string,
  version = 1,
  options: {
    category?: Category;
    createdAt?: string;
    lifecycle?: Json;
    scope?: Json;
    content?: Json;
  } = {},
): Json {
  const base = durable({
    id,
    version,
    category: options.category ?? 'fact',
    createdAt: options.createdAt ?? T1,
  });
  // Synthetic episodes occur at their creation time unless a test says so.
  const content =
    options.category === 'episode'
      ? { occurredAt: options.createdAt ?? T1, ...options.content }
      : options.content;
  return {
    ...base,
    ...(content === undefined
      ? {}
      : { content: { ...(base['content'] as Json), ...content } }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    lifecycle: options.lifecycle ?? LIFECYCLE.observed(),
  };
}

/** Synthetic recorded transitions that agree with every lifecycle claim. */
function transitionsFor(records: Json[]): Json[] {
  const out: Json[] = [];
  for (const record of records) {
    const lifecycle = record['lifecycle'] as Json;
    const self = ref(
      record['id'] as string,
      (record['metadata'] as Json)['recordVersion'] as number,
    );
    const common = {
      ownerId: OWNER,
      metadata: metadata(1, T1),
      occurredAt: T1,
    };
    if (lifecycle['status'] === 'trusted')
      out.push({
        kind: 'learning_promotion',
        ...common,
        eventId: lifecycle['promotionEventId'],
        candidate: CANDIDATE,
        evaluations: EVALUATIONS,
        trustedState: self,
        authority: POLICY,
      });
    if (lifecycle['status'] === 'superseded')
      out.push({
        kind: 'learning_supersession',
        ...common,
        eventId: lifecycle['eventId'],
        previous: self,
        replacement: lifecycle['replacement'],
        promotionEventId: 'event_promotion_elsewhere',
        authority: POLICY,
        reason: 'Synthetic replacement reason',
      });
    if (lifecycle['status'] === 'revoked')
      out.push({
        kind: 'learning_revocation',
        ...common,
        eventId: lifecycle['eventId'],
        revoked: self,
        ...(lifecycle['fallback'] === undefined
          ? {}
          : { fallback: lifecycle['fallback'] }),
        authority: POLICY,
        reason: lifecycle['reason'],
        evidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
      });
  }
  return out;
}

const verifiedOf = (records: unknown[]): VerifiedDurableLineage =>
  verifyLifecycleClaims(
    buildDurableLineage(intakeOwnerState({ ownerId: OWNER, records })),
    transitionsFor(
      records.filter(
        (r) => (r as Json)['kind'] === 'durable_owner_state',
      ) as Json[],
    ),
  );
const views = (records: unknown[], referenceTime: string) =>
  buildDurableCategoryViews(verifiedOf(records), { referenceTime });

const CATEGORY_KEYS = [
  'facts',
  'preferences',
  'episodes',
  'intentPatterns',
  'procedures',
] as const;
const ALL_KEYS = [
  'episodes',
  'facts',
  'intentPatterns',
  'ownerId',
  'preferences',
  'procedures',
  'referenceTime',
  'verified',
];

/** Compact projection: `id: latest vN [current vN | none]` per category. */
function shape(value: DurableCategoryViews) {
  const out: Record<string, string[]> = {};
  for (const key of CATEGORY_KEYS)
    out[key] = value[key].map(
      (v) =>
        `${v.learnedItemId} latest v${v.latestDeclared.metadata.recordVersion} ${
          v.currentDeclared === undefined
            ? 'none'
            : `current v${v.currentDeclared.metadata.recordVersion}`
        }`,
    );
  return out;
}
/** The single fact entry for `id` (or undefined when absent). */
const factEntry = (value: DurableCategoryViews, id = 'learned_a') =>
  shape(value).facts!.find((line) => line.startsWith(`${id} `));

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
  return JSON.stringify(thrown);
}

describe('AVEN-009 category views: input boundary', () => {
  it('is internal: the package index exports no view builder', () => {
    expect(
      Object.keys(publicApi).filter((k) => /view|categor|declared/i.test(k)),
    ).toEqual([]);
  });

  it('accepts only a genuine verified lineage, without running Proxy traps', () => {
    const records = [item('learned_a')];
    const verified = verifiedOf(records);
    expect(isVerifiedDurableLineage(verified)).toBe(true);
    let traps = 0;
    const counting: ProxyHandler<object> = {
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
    const intake = intakeOwnerState({ ownerId: OWNER, records });
    const lineage = buildDurableLineage(intake);
    for (const value of [
      { ...verified },
      Object.assign(Object.create(null) as object, verified),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(verified),
      ),
      structuredClone({ ...verified }),
      JSON.parse(JSON.stringify(verified)),
      new Proxy(verified, counting),
      Object.create(verified),
      intake,
      lineage,
      null,
      undefined,
      'verified',
    ])
      expect(
        failure(() =>
          buildDurableCategoryViews(value as VerifiedDurableLineage, {
            referenceTime: T2,
          }),
        ),
      ).toBe(expected('invalid_input'));
    expect(traps).toBe(0);
  });

  it.each([
    ['a date only', '2026-01-01'],
    ['no seconds', '2026-01-01T00:00Z'],
    ['no offset', '2026-01-01T00:00:00'],
    ['a compact offset', '2026-01-01T00:00:00+0530'],
    ['an impossible date', '2026-02-30T00:00:00Z'],
    ['a space separator', '2026-01-01 00:00:00Z'],
    ['an empty string', ''],
    ['a number', 1_767_225_600_000],
    ['a Date', new Date(0)],
    ['null', null],
    ['undefined', undefined],
  ])('rejects a reference time that is %s, never coercing it', (_l, value) => {
    const verified = verifiedOf([item('learned_a')]);
    expect(
      failure(() =>
        buildDurableCategoryViews(verified, {
          referenceTime: value as string,
        }),
      ),
    ).toBe(expected('invalid_input'));
  });

  it('reads the request inertly and rejects anything but { referenceTime }', () => {
    const verified = verifiedOf([item('learned_a')]);
    let calls = 0;
    const getter = Object.defineProperty({}, 'referenceTime', {
      enumerable: true,
      get() {
        calls += 1;
        return T2;
      },
    });
    class Request {
      referenceTime = T2;
    }
    const bad: unknown[] = [
      getter,
      Object.create({ referenceTime: T2 }),
      new Request(),
      { referenceTime: T2, domain: 'synthetic domain' },
      { referenceTime: T2, taskId: 'task_s1' },
      [T2],
      T2,
      null,
      undefined,
      new Proxy(
        { referenceTime: T2 },
        {
          ownKeys() {
            throw new Error('PRIVATE_SENTINEL');
          },
        },
      ),
    ];
    for (const request of bad) {
      const text = failure(() =>
        buildDurableCategoryViews(
          verified,
          request as { referenceTime: string },
        ),
      );
      expect(text).toBe(expected('invalid_input'));
      expect(text).not.toContain('PRIVATE_SENTINEL');
    }
    expect(calls).toBe(0);
    const nullProto = Object.assign(Object.create(null) as object, {
      referenceTime: T2,
    }) as { referenceTime: string };
    expect(buildDurableCategoryViews(verified, nullProto).referenceTime).toBe(
      T2,
    );
  });

  it('fails closed on ambient prototype pollution installed after verification', () => {
    const verified = verifiedOf([item('learned_a')]);
    Object.defineProperty(Object.prototype, 'currentDeclared', {
      value: 'INHERITED',
      configurable: true,
      writable: true,
    });
    let outcome: string;
    try {
      outcome = failure(() =>
        buildDurableCategoryViews(verified, { referenceTime: T2 }),
      );
    } finally {
      Reflect.deleteProperty(Object.prototype, 'currentDeclared');
    }
    expect(outcome).toBe(expected('invalid_input'));
    expect(
      buildDurableCategoryViews(verified, { referenceTime: T2 }).facts,
    ).toHaveLength(1);
  });
});

describe('AVEN-009 category views: basic grouping', () => {
  it('builds empty views from an empty lineage, with pinned keys', () => {
    const result = views([], T2);
    expect(Object.keys(result).sort()).toEqual(ALL_KEYS);
    for (const key of CATEGORY_KEYS) expect(result[key]).toEqual([]);
    expect(result.ownerId).toBe(OWNER);
    expect(result.referenceTime).toBe(T2);
  });

  it('routes one item of each category to its typed array only', () => {
    const categories = Object.keys(CONTENT) as Category[];
    const result = views(
      categories.map((category, i) => item(`learned_c${i}`, 1, { category })),
      T2,
    );
    const expectations: Record<(typeof CATEGORY_KEYS)[number], Category> = {
      facts: 'fact',
      preferences: 'preference',
      episodes: 'episode',
      intentPatterns: 'intent_pattern',
      procedures: 'procedure',
    };
    for (const key of CATEGORY_KEYS) {
      expect(result[key]).toHaveLength(1);
      for (const view of result[key]) {
        expect(view.latestDeclared.content.category).toBe(expectations[key]);
        expect(view.currentDeclared?.content.category).toBe(expectations[key]);
      }
    }
    // Compile-time discrimination: category-specific fields are typed.
    const fact = result.facts[0]!.latestDeclared.content;
    const procedure = result.procedures[0]!.latestDeclared.content;
    const episode = result.episodes[0]!.latestDeclared.content;
    expect([fact.subject, fact.assertion]).toEqual([
      'Synthetic subject',
      'Synthetic assertion',
    ]);
    expect(procedure.steps).toHaveLength(2);
    expect(episode.originalEvidence).toHaveLength(1);
  });

  it('orders several IDs per category by code units, for any input order', () => {
    const records = [
      item('learned_b'),
      item('learned_a2'),
      item('learned_B'),
      item('learned_a'),
      item('learned_a_'),
      item('learned_p2', 1, { category: 'preference' }),
      item('learned_P1', 1, { category: 'preference' }),
    ];
    const texts = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = views(shuffled(records, seed), T2);
      expect(result.facts.map((v) => v.learnedItemId)).toEqual([
        'learned_B',
        'learned_a',
        'learned_a2',
        'learned_a_',
        'learned_b',
      ]);
      expect(result.preferences.map((v) => v.learnedItemId)).toEqual([
        'learned_P1',
        'learned_p2',
      ]);
      texts.add(JSON.stringify(result));
    }
    expect(texts.size).toBe(1);
  });

  it('declares version 10 after version 2 (numeric, not textual)', () => {
    const result = views(
      [item('learned_a', 2), item('learned_a', 10), item('learned_a', 1)],
      T2,
    );
    expect(factEntry(result)).toBe('learned_a latest v10 current v10');
  });

  it('keeps every history reachable through the same verified object', () => {
    const verified = verifiedOf([
      item('learned_a', 1),
      item('learned_a', 2, { createdAt: T3 }),
    ]);
    const result = buildDurableCategoryViews(verified, { referenceTime: T2 });
    expect(result.verified).toBe(verified);
    expect(
      result.verified.lineage.histories[0]!.versions.map(
        (v) => v.metadata.recordVersion,
      ),
    ).toEqual([1, 2]);
    expect(factEntry(result)).toBe('learned_a latest v1 current v1');
  });

  it('ignores active task state completely', () => {
    const result = views(
      [activeTask({ id: 'learned_t1' }), item('learned_a')],
      T2,
    );
    expect(Object.keys(result)).not.toContain('activeTasks');
    expect(JSON.stringify(result)).not.toContain('learned_t1');
  });
});

describe('AVEN-009 category views: historical as-of declaration', () => {
  const records = [
    item('learned_a', 1, { createdAt: T1 }),
    item('learned_a', 2, { createdAt: T2 }),
    item('learned_a', 3, { createdAt: T3 }),
  ];

  it.each([
    ['before v1', BEFORE, undefined],
    ['exactly at v1', T1, 1],
    ['between v1 and v2', '2026-01-15T00:00:00Z', 1],
    ['exactly at v2', T2, 2],
    ['between v2 and v3', '2026-02-15T00:00:00Z', 2],
    ['exactly at v3', T3, 3],
    ['after v3', LATER, 3],
  ])('declares the right version %s', (_label, referenceTime, version) => {
    const entry = factEntry(views(records, referenceTime));
    expect(entry).toBe(
      version === undefined
        ? undefined
        : `learned_a latest v${version} current v${version}`,
    );
  });

  it('compares instants exactly: offsets and long fractions', () => {
    // T1 written with a +05:30 offset is the same instant as T1.
    expect(factEntry(views(records, '2026-01-01T05:30:00+05:30'))).toBe(
      'learned_a latest v1 current v1',
    );
    // One ten-millionth of a second before T2 is still before v2.
    const precise = [
      item('learned_a', 1, { createdAt: T1 }),
      item('learned_a', 2, { createdAt: '2026-02-01T00:00:00.0000001Z' }),
    ];
    expect(factEntry(views(precise, T2))).toBe(
      'learned_a latest v1 current v1',
    );
    expect(factEntry(views(precise, '2026-02-01T00:00:00.00000010Z'))).toBe(
      'learned_a latest v2 current v2',
    );
    // Lexically "2026-01-31T20:00:00-05:00" sorts before T2, but it is the
    // same instant as 2026-02-01T01:00:00Z, which is after T2.
    expect(factEntry(views(records, '2026-01-31T20:00:00-05:00'))).toBe(
      'learned_a latest v2 current v2',
    );
  });

  it('keeps the extracted comparator identical for intake ordering', () => {
    expect(compareInstants('2026-01-01T05:30:00+05:30', T1)).toBe(0);
    expect(
      compareInstants('2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.10Z'),
    ).toBe(0);
    expect(compareInstants('2026-01-01T00:00:00.0000001Z', T1)).toBe(1);
    expect(compareInstants('2026-01-01', T1)).toBeUndefined();
    // Intake still rejects a creation time that moves backwards by 100ns...
    expect(
      failure(() =>
        intakeOwnerState({
          ownerId: OWNER,
          records: [
            item('learned_a', 1, { createdAt: '2026-01-01T00:00:00.0000002Z' }),
            item('learned_a', 2, { createdAt: '2026-01-01T00:00:00.0000001Z' }),
          ],
        }),
      ),
    ).toBe(expected('version_order_conflict'));
    // ...and still accepts an equal instant written with another offset.
    expect(
      intakeOwnerState({
        ownerId: OWNER,
        records: [
          item('learned_a', 1, { createdAt: '2026-01-01T00:00:00.0000002Z' }),
          item('learned_a', 2, {
            createdAt: '2026-01-01T05:30:00.0000002+05:30',
          }),
        ],
      }).durable,
    ).toHaveLength(2);
  });
});

describe('AVEN-009 category views: lifecycle of the declared head', () => {
  it.each([
    ['observed', LIFECYCLE.observed(), true],
    ['validated', LIFECYCLE.validated(), true],
    ['trusted', LIFECYCLE.trusted('event_pro_a1'), true],
    [
      'superseded',
      LIFECYCLE.superseded('event_sup_a1', ref('learned_z')),
      false,
    ],
    ['revoked', LIFECYCLE.revoked('event_rev_a1'), false],
  ])(
    'keeps a %s head declared; currentDeclared only when live',
    (_l, lifecycle, live) => {
      const result = views(
        [item('learned_a', 1, { lifecycle }), item('learned_z')],
        T2,
      );
      expect(factEntry(result)).toBe(
        `learned_a latest v1 ${live ? 'current v1' : 'none'}`,
      );
    },
  );

  it.each([
    [
      'trusted v1 then revoked v2',
      LIFECYCLE.trusted('event_pro_a1'),
      LIFECYCLE.revoked('event_rev_a2'),
    ],
    [
      'trusted v1 then superseded v2',
      LIFECYCLE.trusted('event_pro_a1'),
      LIFECYCLE.superseded('event_sup_a2', ref('learned_z')),
    ],
    [
      'validated v1 then revoked v2',
      LIFECYCLE.validated(),
      LIFECYCLE.revoked('event_rev_a2'),
    ],
    [
      'trusted v1 then revoked v2 with a fallback to v1',
      LIFECYCLE.trusted('event_pro_a1'),
      LIFECYCLE.revoked('event_rev_a2', ref('learned_a', 1)),
    ],
  ])('never resurrects an older version: %s', (_label, first, second) => {
    const records = [
      item('learned_a', 1, { createdAt: T1, lifecycle: first }),
      item('learned_a', 2, { createdAt: T3, lifecycle: second }),
      item('learned_z'),
    ];
    expect(factEntry(views(records, T4))).toBe('learned_a latest v2 none');
    // Before v2 existed, v1 was the declared head (history, not fallback).
    expect(factEntry(views(records, T2))).toBe(
      'learned_a latest v1 current v1',
    );
  });

  it.each([
    ['trusted v1 then validated v2', LIFECYCLE.validated()],
    ['trusted v1 then observed v2', LIFECYCLE.observed()],
  ])('prefers the newer declared version, not trust: %s', (_l, second) => {
    const records = [
      item('learned_a', 1, {
        createdAt: T1,
        lifecycle: LIFECYCLE.trusted('event_pro_a1'),
      }),
      item('learned_a', 2, { createdAt: T2, lifecycle: second }),
    ];
    expect(factEntry(views(records, T3))).toBe(
      'learned_a latest v2 current v2',
    );
  });

  it('does not follow replacement or fallback references across identities', () => {
    const result = views(
      [
        item('learned_a', 1, {
          lifecycle: LIFECYCLE.superseded('event_sup_a1', ref('learned_b')),
        }),
        item('learned_b'),
        item('learned_c', 1, {
          lifecycle: LIFECYCLE.revoked('event_rev_c1', ref('learned_d')),
        }),
        item('learned_d'),
      ],
      T2,
    );
    expect(shape(result).facts).toEqual([
      'learned_a latest v1 none',
      'learned_b latest v1 current v1',
      'learned_c latest v1 none',
      'learned_d latest v1 current v1',
    ]);
    for (const view of result.facts)
      expect(view.latestDeclared.id).toBe(view.learnedItemId);
  });
});

describe('AVEN-009 category views: temporal scope', () => {
  const bounded = (temporal?: Json): Json => ({
    kind: 'bounded',
    domain: 'synthetic domain',
    ...(temporal === undefined ? {} : { temporal }),
  });

  it.each([
    ['before from', T1, false],
    ['exactly at from', T2, true],
    ['inside', T3, true],
    ['exactly at until (exclusive)', T4, false],
    ['after until', T5, false],
  ])('applies from/until %s', (_label, referenceTime, live) => {
    const records = [
      item('learned_a', 1, {
        createdAt: '2025-06-01T00:00:00Z',
        scope: bounded({ from: T2, until: T4 }),
      }),
    ];
    expect(factEntry(views(records, referenceTime))).toBe(
      `learned_a latest v1 ${live ? 'current v1' : 'none'}`,
    );
  });

  it('applies an open-ended from, and nothing without a temporal qualifier', () => {
    const fromOnly = [
      item('learned_a', 1, { createdAt: T1, scope: bounded({ from: T3 }) }),
    ];
    expect(factEntry(views(fromOnly, T2))).toBe('learned_a latest v1 none');
    expect(factEntry(views(fromOnly, T3))).toBe(
      'learned_a latest v1 current v1',
    );
    expect(factEntry(views(fromOnly, LATER))).toBe(
      'learned_a latest v1 current v1',
    );
    const untimed = [item('learned_a', 1, { scope: bounded() })];
    expect(factEntry(views(untimed, LATER))).toBe(
      'learned_a latest v1 current v1',
    );
  });

  it('keeps creation time and temporal applicability separate', () => {
    // Applies from T1 but declared only at T3: absent before T3.
    const records = [
      item('learned_a', 1, { createdAt: T3, scope: bounded({ from: T1 }) }),
    ];
    expect(factEntry(views(records, T2))).toBeUndefined();
    expect(factEntry(views(records, T3))).toBe(
      'learned_a latest v1 current v1',
    );
  });

  it('compares temporal bounds as exact instants', () => {
    const records = [
      item('learned_a', 1, {
        createdAt: T1,
        scope: bounded({ from: '2026-02-01T05:30:00+05:30', until: T4 }),
      }),
    ];
    expect(factEntry(views(records, T2))).toBe(
      'learned_a latest v1 current v1',
    );
    expect(factEntry(views(records, '2026-03-31T23:59:59.9999999Z'))).toBe(
      'learned_a latest v1 current v1',
    );
    expect(factEntry(views(records, '2026-04-01T01:00:00+01:00'))).toBe(
      'learned_a latest v1 none',
    );
  });

  it('does not task-match or interpret other scope fields or kinds', () => {
    const scopes: Json[] = [
      { kind: 'bounded', domain: 'unrelated synthetic domain' },
      { kind: 'bounded', taskType: 'synthetic task type' },
      { kind: 'bounded', taskId: 'task_unrelated' },
      {
        kind: 'bounded',
        domain: 'synthetic domain',
        qualifiers: {
          recipient: 'synthetic recipient',
          entity: 'synthetic entity',
          context: 'synthetic context',
        },
      },
      { kind: 'global', explicitDeclaration: 'Synthetic global declaration' },
      { kind: 'unknown', reason: 'Synthetic unknown scope' },
      {
        kind: 'uncertain',
        reason: 'Synthetic uncertain scope',
        // A possibility whose temporal window excludes the reference time is
        // not interpreted: uncertain scopes are left to the Context Broker.
        possibilities: [
          {
            kind: 'bounded',
            domain: 'synthetic domain',
            temporal: { from: T4 },
          },
        ],
      },
    ];
    const records = scopes.map((scope, i) =>
      item(`learned_s${i}`, 1, { scope }),
    );
    const result = views(records, T2);
    expect(shape(result).facts).toEqual(
      scopes.map((_, i) => `learned_s${i} latest v1 current v1`),
    );
    for (const [i, view] of result.facts.entries())
      expect(JSON.stringify(view.latestDeclared.scope)).toBe(
        JSON.stringify(
          intakeOwnerState({ ownerId: OWNER, records: [records[i]] })
            .durable[0]!.scope,
        ),
      );
  });
});

describe('AVEN-009 category views: category semantics', () => {
  const episode = (occurredAt: string, createdAt: string) =>
    item('learned_e', 1, {
      category: 'episode',
      createdAt,
      content: { occurredAt },
    });

  it.each([
    ['earlier', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'],
    ['equal', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'],
    [
      'equal with another offset',
      '2026-01-02T05:30:00+05:30',
      '2026-01-02T00:00:00Z',
    ],
    [
      'equal with long fractions',
      '2026-01-02T00:00:00.10000000Z',
      '2026-01-02T00:00:00.1Z',
    ],
  ])(
    'accepts an episode that occurred %s than its creation',
    (_l, occurredAt, createdAt) => {
      expect(
        views([episode(occurredAt, createdAt)], LATER).episodes,
      ).toHaveLength(1);
    },
  );

  it.each([
    ['by a day', '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z'],
    ['by 100ns', '2026-01-02T00:00:00.0000001Z', '2026-01-02T00:00:00Z'],
    [
      'across offsets',
      '2026-01-02T00:00:01+00:00',
      '2026-01-02T05:30:00+05:30',
    ],
  ])(
    'fails closed when an episode occurred after its creation (%s)',
    (_l, occurredAt, createdAt) => {
      const verified = verifiedOf([
        episode(occurredAt, createdAt),
        item('learned_a'),
      ]);
      const text = failure(() =>
        buildDurableCategoryViews(verified, { referenceTime: LATER }),
      );
      expect(text).toBe(expected('invalid_owner_state_view'));
      for (const leak of ['learned_e', 'episode', '2026', OWNER])
        expect(text).not.toContain(leak);
    },
  );

  it('checks episode times in every version, independent of the reference time', () => {
    const verified = verifiedOf([
      episode('2026-01-01T00:00:00Z', T1),
      item('learned_e', 2, {
        category: 'episode',
        createdAt: T3,
        content: { occurredAt: T4 },
      }),
    ]);
    expect(
      failure(() => buildDurableCategoryViews(verified, { referenceTime: T2 })),
    ).toBe(expected('invalid_owner_state_view'));
  });

  it('preserves procedure steps exactly and executes nothing', () => {
    const steps = [
      { instruction: 'Synthetic step one' },
      { instruction: 'Synthetic step two', precondition: 'Synthetic gate' },
      { instruction: 'Synthetic step one' },
      {
        instruction: 'Synthetic step zero',
        precondition: 'Synthetic other gate',
      },
    ];
    const result = views(
      [item('learned_p', 1, { category: 'procedure', content: { steps } })],
      T2,
    );
    const content = result.procedures[0]!.latestDeclared.content;
    expect(JSON.parse(JSON.stringify(content.steps))).toEqual(steps);
    expect(Object.keys(result.procedures[0]!).sort()).toEqual([
      'currentDeclared',
      'latestDeclared',
      'learnedItemId',
    ]);
  });

  it('adds nothing beyond the envelope to facts, preferences or intent patterns', () => {
    const categories = Object.keys(CONTENT) as Category[];
    const records = categories.map((category, i) =>
      item(`learned_c${i}`, 1, { category }),
    );
    const result = views(records, T2);
    const intake = intakeOwnerState({ ownerId: OWNER, records });
    for (const key of CATEGORY_KEYS)
      for (const view of result[key]) {
        expect(Object.keys(view).sort()).toEqual([
          'currentDeclared',
          'latestDeclared',
          'learnedItemId',
        ]);
        // The record is the frozen intake record itself, unchanged.
        expect(intake.durable.map((r) => JSON.stringify(r))).toContain(
          JSON.stringify(view.latestDeclared),
        );
      }
    const text = JSON.stringify(result);
    for (const absent of [
      'truth',
      'isTrue',
      'verifiedTruth',
      'polarity',
      'personality',
      'strength',
      'universal',
      'inferredIntent',
      '"global"',
      'activeTasks',
      'contextCandidates',
      'rank',
      'score',
      'authority',
      'storage',
      'sourceAdapter',
    ])
      expect(text).not.toContain(absent);
  });
});

describe('AVEN-009 category views: result shape and immutability', () => {
  it('omits currentDeclared exactly when nothing is currently declared', () => {
    const result = views(
      [item('learned_a', 1, { lifecycle: LIFECYCLE.revoked('event_rev_a1') })],
      T2,
    );
    expect(Object.keys(result.facts[0]!).sort()).toEqual([
      'latestDeclared',
      'learnedItemId',
    ]);
  });

  it('references the frozen verified input and records without copying', () => {
    const verified = verifiedOf([item('learned_a')]);
    const before = JSON.stringify(verified);
    const result = buildDurableCategoryViews(verified, { referenceTime: T2 });
    expect(result.verified).toBe(verified);
    expect(result.facts[0]!.latestDeclared).toBe(
      verified.lineage.histories[0]!.versions[0],
    );
    expect(JSON.stringify(verified)).toBe(before);
  });

  it('is deeply frozen, null-prototype and holds no Map or Set', () => {
    const result = views([item('learned_a'), item('learned_b')], T2);
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    for (const key of CATEGORY_KEYS) {
      expect(Array.isArray(result[key])).toBe(true);
      for (const view of result[key])
        expect(Object.getPrototypeOf(view)).toBeNull();
    }
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
    const writes = [
      () => {
        (result as unknown as Json)['referenceTime'] = T5;
      },
      () => {
        (result.facts as unknown as Json[]).pop();
      },
      () => {
        (result.facts[0] as unknown as Json)['currentDeclared'] = undefined;
      },
      () => {
        (result as unknown as Json)['activeTasks'] = [];
      },
    ];
    for (const write of writes) expect(write).toThrow(TypeError);
  });

  it('brands only the produced result, without running Proxy traps', () => {
    const result = views([item('learned_a')], T2);
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
      structuredClone({ ...result }),
      result.verified,
    ])
      expect(isDurableCategoryViews(forged)).toBe(false);
    expect(traps).toBe(0);
    expect(isDurableCategoryViews(result)).toBe(true);
  });

  it('scales to 2,000 versions of one identity', () => {
    const records: Json[] = [];
    for (let v = 1; v <= 2_000; v += 1)
      records.push(
        item('learned_a', v, {
          createdAt: `2026-01-01T00:00:00.${String(v).padStart(6, '0')}Z`,
        }),
      );
    const verified = verifiedOf(records);
    expect(
      factEntry(
        buildDurableCategoryViews(verified, {
          referenceTime: '2026-01-01T00:00:00.000999Z',
        }),
      ),
    ).toBe('learned_a latest v999 current v999');
  }, 300_000);
});
