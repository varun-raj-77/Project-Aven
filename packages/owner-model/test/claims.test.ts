import { describe, expect, it } from 'vitest';
import {
  isVerifiedDurableLineage,
  verifyLifecycleClaims,
  type VerifiedDurableLineage,
} from '../src/claims.ts';
import { OwnerModelError, type OwnerModelErrorCode } from '../src/errors.ts';
import * as publicApi from '../src/index.ts';
import { intakeOwnerState } from '../src/intake.ts';
import {
  buildDurableLineage,
  isDurableLineage,
  type DurableLineage,
} from '../src/lineage.ts';
import {
  deeplyFrozen,
  durable,
  FOREIGN,
  metadata,
  OWNER,
  shuffled,
  T0,
  T1,
  T2,
  T3,
} from './fixtures.ts';

/**
 * AVEN-009 patch 4: agreement of durable lifecycle claims with recorded
 * learning transitions. Every owner, ID, reason, digest and timestamp is
 * SYNTHETIC (see fixtures.ts). These are mechanics checks of exact-event
 * resolution, owner isolation, field agreement, ambiguity, determinism,
 * immutability and privacy. Agreement is structural only: nothing here
 * authenticates Root, applies a transition or decides which version applies.
 */
type Json = Record<string, unknown>;
type Ref = { learnedItemId: string; version: number };

const ref = (learnedItemId: string, version = 1): Ref => ({
  learnedItemId,
  version,
});
const DIGEST = { algorithm: 'sha256', value: 'a'.repeat(64) };
/** A synthetic, structurally valid ALLOW reference (recorded data only). */
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
const CANDIDATE = { candidateId: 'candidate_s1', version: 1 };
const EVALUATIONS = [
  { evaluationId: 'evaluation_s1', version: 1 },
  { evaluationId: 'evaluation_s2', version: 2 },
];
const REASON = 'Synthetic revocation reason';

// ---- Durable snapshots (lifecycle claims) ----------------------------------

function snapshot(id: string, version: number, lifecycle: Json): Json {
  return { ...durable({ id, version }), lifecycle };
}
const observed = (id: string, version = 1) =>
  snapshot(id, version, { status: 'observed' });
const validated = (id: string, version = 1) =>
  snapshot(id, version, {
    status: 'validated',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
  });
const trusted = (
  id: string,
  version: number,
  eventId: string,
  overrides: Json = {},
) =>
  snapshot(id, version, {
    status: 'trusted',
    evaluations: EVALUATIONS,
    lastValidatedAt: T1,
    candidate: CANDIDATE,
    promotionEventId: eventId,
    ...overrides,
  });
const superseded = (
  id: string,
  version: number,
  replacement: Ref,
  eventId: string,
  supersededAt = T1,
) =>
  snapshot(id, version, {
    status: 'superseded',
    supersededAt,
    replacement,
    eventId,
  });
const revoked = (
  id: string,
  version: number,
  eventId: string,
  fallback?: Ref,
  overrides: Json = {},
) =>
  snapshot(id, version, {
    status: 'revoked',
    revokedAt: T2,
    reason: REASON,
    eventId,
    ...(fallback === undefined ? {} : { fallback }),
    ...overrides,
  });

// ---- Recorded transitions -------------------------------------------------

const recorded = (kind: string, eventId: string, fields: Json): Json => ({
  kind,
  ownerId: OWNER,
  metadata: metadata(1, T0),
  eventId,
  occurredAt: T1,
  ...fields,
});
const promotion = (eventId: string, trustedState: Ref, fields: Json = {}) =>
  recorded('learning_promotion', eventId, {
    candidate: CANDIDATE,
    evaluations: EVALUATIONS,
    trustedState,
    authority: POLICY,
    ...fields,
  });
const supersession = (
  eventId: string,
  previous: Ref,
  replacement: Ref,
  fields: Json = {},
) =>
  recorded('learning_supersession', eventId, {
    previous,
    replacement,
    promotionEventId: 'event_promotion_unrelated',
    authority: POLICY,
    reason: 'Synthetic replacement reason',
    ...fields,
  });
const revocation = (
  eventId: string,
  revokedRef: Ref,
  fallback?: Ref,
  fields: Json = {},
) =>
  recorded('learning_revocation', eventId, {
    occurredAt: T2,
    revoked: revokedRef,
    ...(fallback === undefined ? {} : { fallback }),
    authority: POLICY,
    reason: REASON,
    evidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
    ...fields,
  });
const rejection = (eventId: string) =>
  recorded('learning_rejection', eventId, {
    candidate: CANDIDATE,
    evaluations: [],
    reason: 'Synthetic rejection reason',
    evidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
  });
const rollback = (eventId: string, from: Ref, restore: Ref) =>
  recorded('learning_rollback', eventId, {
    from,
    restore,
    revocationEventId: 'event_rev_c2',
    authority: POLICY,
    reason: 'Synthetic rollback reason',
  });
const foreignOwned = (transition: Json): Json => ({
  ...transition,
  ownerId: FOREIGN,
});

// ---- A full synthetic scenario --------------------------------------------

/** Every claim kind plus unbacked observed/validated snapshots. */
const RECORDS = [
  trusted('learned_a', 1, 'event_pro_a1'),
  superseded('learned_b', 1, ref('learned_b', 2), 'event_sup_b1'),
  observed('learned_b', 2),
  observed('learned_c', 1),
  revoked('learned_c', 2, 'event_rev_c2', ref('learned_c', 1)),
  revoked('learned_d', 1, 'event_rev_d1'),
  observed('learned_e'),
  validated('learned_f'),
];
const TRANSITIONS = [
  promotion('event_pro_a1', ref('learned_a', 1)),
  supersession('event_sup_b1', ref('learned_b', 1), ref('learned_b', 2)),
  revocation('event_rev_c2', ref('learned_c', 2), ref('learned_c', 1)),
  revocation('event_rev_d1', ref('learned_d', 1)),
];

const lineageOf = (records: unknown[]): DurableLineage =>
  buildDurableLineage(intakeOwnerState({ ownerId: OWNER, records }));
const verify = (
  records: unknown[],
  transitions: unknown[],
): VerifiedDurableLineage =>
  verifyLifecycleClaims(lineageOf(records), transitions);

/** Claim trace projection (test-side only). */
const trace = (value: VerifiedDurableLineage) =>
  value.claims.map(
    (c) =>
      `${c.kind} ${c.snapshot.learnedItemId}@${c.snapshot.version} ${c.eventId}`,
  );
const FULL_TRACE = [
  'revoked learned_c@2 event_rev_c2',
  'revoked learned_d@1 event_rev_d1',
  'superseded learned_b@1 event_sup_b1',
  'trusted learned_a@1 event_pro_a1',
];

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
};
const expected = (code: OwnerModelErrorCode) =>
  JSON.stringify({ name: 'OwnerModelError', code, message: MESSAGES[code] });

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
const CLAIM_ERROR = expected('invalid_lifecycle_claim');
function rejects(records: unknown[], transitions: unknown[]): void {
  const lineage = lineageOf(records);
  expect(failure(() => verifyLifecycleClaims(lineage, transitions))).toBe(
    CLAIM_ERROR,
  );
}
/** `TRANSITIONS` with the one transition for `eventId` replaced. */
const replacing = (eventId: string, transition: Json | undefined): Json[] =>
  TRANSITIONS.flatMap((t) =>
    t['eventId'] === eventId
      ? transition === undefined
        ? []
        : [transition]
      : [t],
  );

describe('AVEN-009 lifecycle claims: input boundary', () => {
  it('is internal: the package index exports no claim verification', () => {
    expect(
      Object.keys(publicApi).filter((k) => /claim|verif|lineage/i.test(k)),
    ).toEqual([]);
  });

  it('verifies the full synthetic scenario', () => {
    const result = verify(RECORDS, TRANSITIONS);
    expect(result.ownerId).toBe(OWNER);
    expect(trace(result)).toEqual(FULL_TRACE);
    expect(isVerifiedDurableLineage(result)).toBe(true);
  });

  it('accepts only a lineage produced by buildDurableLineage, without running traps', () => {
    const genuine = lineageOf(RECORDS);
    expect(isDurableLineage(genuine)).toBe(true);
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
      getOwnPropertyDescriptor: (t, k) => {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    };
    const lookalikes: unknown[] = [
      { ...genuine },
      Object.assign(Object.create(null) as object, genuine),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(genuine),
      ),
      {
        ownerId: genuine.ownerId,
        histories: genuine.histories,
        edges: genuine.edges,
      },
      structuredClone({ ...genuine }),
      new Proxy(genuine, counting),
      Object.create(genuine),
      null,
      undefined,
      [],
      'lineage',
    ];
    for (const value of lookalikes) {
      expect(isDurableLineage(value)).toBe(false);
      expect(
        failure(() =>
          verifyLifecycleClaims(value as DurableLineage, TRANSITIONS),
        ),
      ).toBe(expected('invalid_input'));
    }
    expect(traps).toBe(0);
  });

  it.each([
    ['an object', { length: 0 }],
    ['a string', 'transitions'],
    ['null', null],
    ['undefined', undefined],
    ['an over-limit array', new Array(100_001)],
  ])('rejects %s as the transition collection with invalid_input', (_l, v) => {
    const lineage = lineageOf(RECORDS);
    expect(failure(() => verifyLifecycleClaims(lineage, v as unknown[]))).toBe(
      expected('invalid_input'),
    );
  });

  it('rejects a revoked or throwing transition-array Proxy with invalid_input', () => {
    const lineage = lineageOf(RECORDS);
    const { proxy, revoke } = Proxy.revocable([...TRANSITIONS], {});
    revoke();
    expect(failure(() => verifyLifecycleClaims(lineage, proxy))).toBe(
      expected('invalid_input'),
    );
    const throwing = new Proxy([...TRANSITIONS], {
      get(target, key) {
        if (key === '1') throw new Error('PRIVATE_SENTINEL');
        return Reflect.get(target, key) as unknown;
      },
    });
    expect(failure(() => verifyLifecycleClaims(lineage, throwing))).toBe(
      expected('invalid_input'),
    );
  });

  it.each([
    ['an unknown key', { ...TRANSITIONS[0], extra: 'field' }],
    [
      'a missing field',
      Object.fromEntries(
        Object.entries(TRANSITIONS[0]!).filter(([k]) => k !== 'candidate'),
      ),
    ],
    ['an unknown kind', { ...TRANSITIONS[0], kind: 'learning_applied' }],
    [
      'a non-ALLOW authority',
      { ...TRANSITIONS[0], authority: { ...POLICY, decision: 'DENY' } },
    ],
    ['a malformed timestamp', { ...TRANSITIONS[0], occurredAt: 'yesterday' }],
    ['a primitive', 42],
    ['null', null],
  ])(
    'fails closed on a malformed transition (%s), never repairing it',
    (_label, bad) => {
      rejects(RECORDS, [...TRANSITIONS, bad]);
      // Also when unused, and also when it claims another owner.
      rejects([observed('learned_e')], [bad]);
      if (bad !== null && typeof bad === 'object')
        rejects([observed('learned_e')], [foreignOwned(bad as Json)]);
    },
  );
});

describe('AVEN-009 lifecycle claims: observed and validated', () => {
  it('needs no transition for observed or validated snapshots', () => {
    for (const records of [
      [observed('learned_e')],
      [validated('learned_f')],
      [observed('learned_e'), validated('learned_f')],
    ]) {
      const result = verify(records, []);
      expect(result.claims).toEqual([]);
      expect(result.lineage.histories).toHaveLength(records.length);
    }
  });

  it('is unchanged by unrelated rejection and rollback records, in any order', () => {
    const records = [observed('learned_e'), validated('learned_f')];
    const extra = [
      rejection('event_rej_x'),
      rollback('event_rb_x', ref('learned_x', 2), ref('learned_x', 1)),
    ];
    const base = JSON.stringify(verify(records, []));
    for (const seed of [1, 2, 3])
      expect(JSON.stringify(verify(records, shuffled(extra, seed)))).toBe(base);
  });
});

describe('AVEN-009 lifecycle claims: trusted <-> promotion', () => {
  const records = [trusted('learned_a', 1, 'event_pro_a1')];
  const good = promotion('event_pro_a1', ref('learned_a', 1));

  it('accepts an exact promotion', () => {
    expect(trace(verify(records, [good]))).toEqual([
      'trusted learned_a@1 event_pro_a1',
    ]);
  });

  it.each([
    ['missing event', []],
    ['another event ID', [promotion('event_pro_other', ref('learned_a', 1))]],
    [
      'exact event ID, supersession kind',
      [supersession('event_pro_a1', ref('learned_a', 1), ref('learned_a', 2))],
    ],
    [
      'exact event ID, revocation kind',
      [revocation('event_pro_a1', ref('learned_a', 1))],
    ],
    ['exact event ID, rejection kind', [rejection('event_pro_a1')]],
    [
      'exact event ID, rollback kind',
      [rollback('event_pro_a1', ref('learned_a', 2), ref('learned_a', 1))],
    ],
    ['foreign owner', [foreignOwned(good)]],
    [
      'wrong trusted-state ID',
      [promotion('event_pro_a1', ref('learned_z', 1))],
    ],
    [
      'wrong trusted-state version',
      [promotion('event_pro_a1', ref('learned_a', 2))],
    ],
    [
      'wrong candidate ID',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          candidate: { candidateId: 'candidate_s2', version: 1 },
        }),
      ],
    ],
    [
      'wrong candidate version',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          candidate: { candidateId: 'candidate_s1', version: 2 },
        }),
      ],
    ],
    [
      'wrong evaluation ID',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          evaluations: [
            EVALUATIONS[0],
            { evaluationId: 'evaluation_s9', version: 2 },
          ],
        }),
      ],
    ],
    [
      'wrong evaluation version',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          evaluations: [
            EVALUATIONS[0],
            { evaluationId: 'evaluation_s2', version: 3 },
          ],
        }),
      ],
    ],
    [
      'evaluation order swapped (arrays are ordered in the contract)',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          evaluations: [EVALUATIONS[1], EVALUATIONS[0]],
        }),
      ],
    ],
    [
      'an evaluation missing',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          evaluations: [EVALUATIONS[0]],
        }),
      ],
    ],
    [
      'an extra evaluation',
      [
        promotion('event_pro_a1', ref('learned_a', 1), {
          evaluations: [
            ...EVALUATIONS,
            { evaluationId: 'evaluation_s3', version: 1 },
          ],
        }),
      ],
    ],
    ['an identical duplicate (event IDs are unique)', [good, { ...good }]],
  ])('rejects %s', (_label, transitions) => {
    rejects(records, transitions);
  });

  it('accepts extra unrelated transitions in any order', () => {
    const extra = [
      good,
      promotion('event_pro_other', ref('learned_q', 1)),
      rejection('event_rej_x'),
      rollback('event_rb_x', ref('learned_q', 2), ref('learned_q', 1)),
    ];
    for (const seed of [1, 2, 3, 4])
      expect(trace(verify(records, shuffled(extra, seed)))).toEqual([
        'trusted learned_a@1 event_pro_a1',
      ]);
  });

  it('does not compare fields only one side carries', () => {
    // previousTrustedState and the policy reference have no lifecycle
    // counterpart; lastValidatedAt is not the promotion time.
    expect(
      trace(
        verify(
          [trusted('learned_a', 1, 'event_pro_a1', { lastValidatedAt: T3 })],
          [
            promotion('event_pro_a1', ref('learned_a', 1), {
              occurredAt: T0,
              previousTrustedState: ref('learned_q', 7),
              authority: { ...POLICY, decisionId: 'decision_s9' },
            }),
          ],
        ),
      ),
    ).toEqual(['trusted learned_a@1 event_pro_a1']);
  });
});

describe('AVEN-009 lifecycle claims: superseded <-> supersession', () => {
  const records = [
    superseded('learned_b', 1, ref('learned_b', 2), 'event_sup_b1'),
    observed('learned_b', 2),
    observed('learned_b', 3),
    observed('learned_g', 2),
  ];
  const good = supersession(
    'event_sup_b1',
    ref('learned_b', 1),
    ref('learned_b', 2),
  );

  it('accepts an exact supersession', () => {
    expect(trace(verify(records, [good]))).toEqual([
      'superseded learned_b@1 event_sup_b1',
    ]);
  });

  it.each([
    ['missing event', []],
    [
      'exact event ID, promotion kind',
      [promotion('event_sup_b1', ref('learned_b', 1))],
    ],
    [
      'exact event ID, revocation kind',
      [revocation('event_sup_b1', ref('learned_b', 1), ref('learned_b', 2))],
    ],
    [
      'exact event ID, rollback kind',
      [rollback('event_sup_b1', ref('learned_b', 1), ref('learned_b', 2))],
    ],
    ['foreign owner', [foreignOwned(good)]],
    [
      'wrong source ID',
      [supersession('event_sup_b1', ref('learned_g', 1), ref('learned_b', 2))],
    ],
    [
      'wrong source version',
      [supersession('event_sup_b1', ref('learned_b', 3), ref('learned_b', 2))],
    ],
    [
      'a replacement other than the Patch-3 edge target (version)',
      [supersession('event_sup_b1', ref('learned_b', 1), ref('learned_b', 3))],
    ],
    [
      'a replacement other than the Patch-3 edge target (ID)',
      [supersession('event_sup_b1', ref('learned_b', 1), ref('learned_g', 2))],
    ],
    ['an identical duplicate (event IDs are unique)', [good, { ...good }]],
  ])('rejects %s', (_label, transitions) => {
    rejects(records, transitions);
  });

  it('accepts extra unrelated transitions in any order', () => {
    const extra = [
      good,
      supersession('event_sup_other', ref('learned_q', 1), ref('learned_q', 2)),
      revocation('event_rev_other', ref('learned_q', 2)),
      rejection('event_rej_x'),
    ];
    for (const seed of [1, 2, 3, 4])
      expect(trace(verify(records, shuffled(extra, seed)))).toEqual([
        'superseded learned_b@1 event_sup_b1',
      ]);
  });

  it('does not compare the supersession reason or its promotion pointer', () => {
    expect(
      trace(
        verify(records, [
          supersession(
            'event_sup_b1',
            ref('learned_b', 1),
            ref('learned_b', 2),
            {
              reason: 'Another synthetic reason',
              promotionEventId: 'event_promotion_elsewhere',
            },
          ),
        ]),
      ),
    ).toEqual(['superseded learned_b@1 event_sup_b1']);
  });
});

describe('AVEN-009 lifecycle claims: revoked <-> revocation', () => {
  const withFallback = [
    observed('learned_c', 1),
    revoked('learned_c', 2, 'event_rev_c2', ref('learned_c', 1)),
    observed('learned_h', 1),
  ];
  const noFallback = [
    revoked('learned_d', 1, 'event_rev_d1'),
    observed('learned_h'),
  ];
  const goodWith = revocation(
    'event_rev_c2',
    ref('learned_c', 2),
    ref('learned_c', 1),
  );
  const goodWithout = revocation('event_rev_d1', ref('learned_d', 1));

  it('accepts an exact revocation with and without a fallback', () => {
    expect(trace(verify(withFallback, [goodWith]))).toEqual([
      'revoked learned_c@2 event_rev_c2',
    ]);
    expect(trace(verify(noFallback, [goodWithout]))).toEqual([
      'revoked learned_d@1 event_rev_d1',
    ]);
  });

  it.each([
    ['missing event', withFallback, []],
    [
      'exact event ID, supersession kind',
      withFallback,
      [supersession('event_rev_c2', ref('learned_c', 2), ref('learned_c', 1))],
    ],
    [
      'exact event ID, rollback kind',
      withFallback,
      [rollback('event_rev_c2', ref('learned_c', 2), ref('learned_c', 1))],
    ],
    ['exact event ID, rejection kind', noFallback, [rejection('event_rev_d1')]],
    ['foreign owner', withFallback, [foreignOwned(goodWith)]],
    [
      'wrong source ID',
      withFallback,
      [revocation('event_rev_c2', ref('learned_h', 1), ref('learned_c', 1))],
    ],
    [
      'wrong source version',
      withFallback,
      [revocation('event_rev_c2', ref('learned_c', 3), ref('learned_c', 1))],
    ],
    [
      'a different reason',
      withFallback,
      [
        revocation('event_rev_c2', ref('learned_c', 2), ref('learned_c', 1), {
          reason: 'Another synthetic reason',
        }),
      ],
    ],
    [
      'a wrong fallback ID',
      withFallback,
      [revocation('event_rev_c2', ref('learned_c', 2), ref('learned_h', 1))],
    ],
    [
      'a wrong fallback version',
      withFallback,
      [revocation('event_rev_c2', ref('learned_c', 2), ref('learned_c', 3))],
    ],
    [
      'a transition fallback the lifecycle does not declare',
      noFallback,
      [revocation('event_rev_d1', ref('learned_d', 1), ref('learned_h', 1))],
    ],
    [
      'a lifecycle fallback the transition does not declare',
      withFallback,
      [revocation('event_rev_c2', ref('learned_c', 2))],
    ],
    ['an identical duplicate', noFallback, [goodWithout, { ...goodWithout }]],
  ])('rejects %s', (_label, records, transitions) => {
    rejects(records, transitions);
  });

  it('accepts extra unrelated transitions in any order', () => {
    const extra = [
      goodWith,
      revocation('event_rev_other', ref('learned_q', 1)),
      rollback('event_rb_c', ref('learned_c', 2), ref('learned_c', 1)),
      promotion('event_pro_other', ref('learned_q', 1)),
    ];
    for (const seed of [1, 2, 3, 4])
      expect(trace(verify(withFallback, shuffled(extra, seed)))).toEqual([
        'revoked learned_c@2 event_rev_c2',
      ]);
  });
});

describe('AVEN-009 lifecycle claims: event identity and ambiguity', () => {
  it.each([
    [
      'two kinds',
      [
        TRANSITIONS[0]!,
        supersession('event_pro_a1', ref('learned_a', 1), ref('learned_a', 2)),
      ],
    ],
    [
      'one kind, different payloads',
      [
        TRANSITIONS[0]!,
        promotion('event_pro_a1', ref('learned_a', 1), {
          previousTrustedState: ref('learned_q', 1),
        }),
      ],
    ],
    [
      'one correct and one wrong payload',
      [TRANSITIONS[0]!, promotion('event_pro_a1', ref('learned_z', 1))],
    ],
    ['identical copies', [TRANSITIONS[0]!, { ...TRANSITIONS[0]! }]],
    [
      'an unused event ID repeated',
      [rejection('event_rej_x'), rejection('event_rej_x')],
    ],
  ])('fails closed on a repeated event ID (%s), in either order', (_l, dup) => {
    const rest = TRANSITIONS.slice(1);
    rejects(RECORDS, [...dup, ...rest]);
    rejects(RECORDS, [...rest, ...[...dup].reverse()]);
  });

  it('ignores a foreign copy of an event ID (no ambiguity, no oracle)', () => {
    const withForeign = [
      ...TRANSITIONS,
      foreignOwned(promotion('event_pro_a1', ref('learned_z', 9))),
      foreignOwned(rejection('event_sup_b1')),
    ];
    for (const seed of [1, 2, 3])
      expect(trace(verify(RECORDS, shuffled(withForeign, seed)))).toEqual(
        FULL_TRACE,
      );
  });

  it('does not let one transition back two claims that share its event ID', () => {
    // Both snapshots name event_sup_shared; the transition's `previous`
    // identifies only one of them, so the other claim is unbacked.
    const records = [
      superseded('learned_b', 1, ref('learned_b', 2), 'event_sup_shared'),
      observed('learned_b', 2),
      superseded('learned_g', 1, ref('learned_b', 2), 'event_sup_shared'),
    ];
    rejects(records, [
      supersession(
        'event_sup_shared',
        ref('learned_b', 1),
        ref('learned_b', 2),
      ),
    ]);
    rejects(
      [
        trusted('learned_a', 1, 'event_pro_shared'),
        trusted('learned_a', 2, 'event_pro_shared'),
      ],
      [promotion('event_pro_shared', ref('learned_a', 1))],
    );
    rejects(
      [
        revoked('learned_d', 1, 'event_rev_shared'),
        revoked('learned_k', 1, 'event_rev_shared'),
      ],
      [revocation('event_rev_shared', ref('learned_d', 1))],
    );
  });

  it('resolves only by exact event ID, never by kind or position', () => {
    // A transition with the right kind and payload but another event ID
    // never backs the claim, wherever it sits.
    for (const seed of [1, 2, 3])
      rejects(
        RECORDS,
        shuffled(
          replacing(
            'event_sup_b1',
            supersession(
              'event_sup_b9',
              ref('learned_b', 1),
              ref('learned_b', 2),
            ),
          ),
          seed,
        ),
      );
  });
});

describe('AVEN-009 lifecycle claims: unused transitions are never applied', () => {
  const unused = [
    promotion('event_pro_unused', ref('learned_q', 1)),
    supersession('event_sup_unused', ref('learned_c', 1), ref('learned_c', 2)),
    revocation('event_rev_unused', ref('learned_e', 1)),
    rejection('event_rej_unused'),
    rollback('event_rb_unused', ref('learned_c', 2), ref('learned_c', 1)),
    // A rollback that names the very revocation the lineage records.
    rollback('event_rb_c2', ref('learned_c', 2), ref('learned_c', 1)),
  ];

  it('returns the same result with or without unused transitions', () => {
    const base = JSON.stringify(verify(RECORDS, TRANSITIONS));
    for (const seed of [1, 2, 3, 4, 5])
      expect(
        JSON.stringify(
          verify(RECORDS, shuffled([...TRANSITIONS, ...unused], seed)),
        ),
      ).toBe(base);
  });

  it('keeps every snapshot status, history and edge exactly as built', () => {
    const lineage = lineageOf(RECORDS);
    const before = JSON.stringify(lineage);
    const result = verifyLifecycleClaims(lineage, [...TRANSITIONS, ...unused]);
    expect(result.lineage).toBe(lineage);
    expect(JSON.stringify(lineage)).toBe(before);
    expect(
      lineage.histories.flatMap((h) =>
        h.versions.map(
          (v) => `${v.id}@${v.metadata.recordVersion} ${v.lifecycle.status}`,
        ),
      ),
    ).toEqual([
      'learned_a@1 trusted',
      'learned_b@1 superseded',
      'learned_b@2 observed',
      'learned_c@1 observed',
      'learned_c@2 revoked',
      'learned_d@1 revoked',
      'learned_e@1 observed',
      'learned_f@1 validated',
    ]);
    expect(
      lineage.edges.map(
        (e) =>
          `${e.kind} ${e.source.learnedItemId}@${e.source.version} -> ${e.target.learnedItemId}@${e.target.version}`,
      ),
    ).toEqual([
      'fallback learned_c@2 -> learned_c@1',
      'replacement learned_b@1 -> learned_b@2',
    ]);
  });
});

describe('AVEN-009 lifecycle claims: result shape, order and immutability', () => {
  it('orders claims by kind, ID, version and event, for any input order', () => {
    const texts = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const result = verify(
        shuffled(RECORDS, seed),
        shuffled(TRANSITIONS, seed + 7),
      );
      expect(trace(result)).toEqual(FULL_TRACE);
      texts.add(JSON.stringify(result));
    }
    expect(texts.size).toBe(1);
  });

  it('exposes only owner, lineage and a minimal claim trace', () => {
    const result = verify(RECORDS, TRANSITIONS);
    expect(Object.keys(result).sort()).toEqual([
      'claims',
      'lineage',
      'ownerId',
    ]);
    for (const claim of result.claims) {
      expect(Object.keys(claim).sort()).toEqual([
        'eventId',
        'kind',
        'snapshot',
      ]);
      expect(Object.keys(claim.snapshot).sort()).toEqual([
        'learnedItemId',
        'version',
      ]);
    }
    // No transition payload (policy, candidate, reason, evidence) is carried.
    const text = JSON.stringify(result.claims);
    for (const absent of [
      'decision_s1',
      'proposal_s1',
      'ALLOW',
      'Synthetic replacement reason',
      'authority',
      'occurredAt',
    ])
      expect(text).not.toContain(absent);
  });

  it('is deeply frozen, null-prototype and holds no Map or Set', () => {
    const result = verify(RECORDS, TRANSITIONS);
    expect(deeplyFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    for (const claim of result.claims) {
      expect(Object.getPrototypeOf(claim)).toBeNull();
      expect(Object.getPrototypeOf(claim.snapshot)).toBeNull();
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
        (result as unknown as Json)['ownerId'] = FOREIGN;
      },
      () => {
        (result.claims as unknown as Json[]).push({});
      },
      () => {
        (result.claims[0] as unknown as Json)['eventId'] = 'event_x';
      },
      () => {
        (result.claims[0]!.snapshot as unknown as Json)['version'] = 9;
      },
      () => {
        (result as unknown as Json)['current'] = result.claims[0];
      },
    ];
    for (const write of writes) expect(write).toThrow(TypeError);
  });

  it('does not mutate or freeze the caller transition array', () => {
    const transitions = structuredClone(TRANSITIONS);
    const before = JSON.stringify(transitions);
    verify(RECORDS, transitions);
    expect(JSON.stringify(transitions)).toBe(before);
    expect(Object.isFrozen(transitions)).toBe(false);
    expect(Object.isFrozen(transitions[0])).toBe(false);
  });
});

describe('AVEN-009 lifecycle claims: verified-result brand', () => {
  it('recognizes only the produced result, without running Proxy traps', () => {
    const real = verify(RECORDS, TRANSITIONS);
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
      has: (t, k) => {
        traps += 1;
        return Reflect.has(t, k);
      },
    };
    const fake = {
      ownerId: real.ownerId,
      lineage: real.lineage,
      claims: real.claims,
    };
    const forgeries: unknown[] = [
      { ...real },
      Object.assign({}, real),
      Object.assign(Object.create(null) as object, real),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(real),
      ),
      new Proxy(real, handler),
      new Proxy(fake, handler),
      fake,
      Object.freeze({ ...fake }),
      structuredClone({ ...real }),
      JSON.parse(JSON.stringify(real)),
    ];
    for (const forged of forgeries)
      expect(isVerifiedDurableLineage(forged)).toBe(false);
    expect(traps).toBe(0);
    expect(isVerifiedDurableLineage(real)).toBe(true);
    expect(isVerifiedDurableLineage(real.lineage)).toBe(false);
    expect(isDurableLineage(real)).toBe(false);
  });
});

describe('AVEN-009 lifecycle claims: timestamps are not compared', () => {
  // No frozen contract, constraint or document equates a transition's
  // occurredAt with a snapshot's supersededAt or revokedAt (independent
  // TimestampSchema fields), so Patch 4 compares neither, as text or instant.
  const DISTANT = '2031-01-15T23:59:59+05:30';

  it('verifies a supersession whose occurredAt differs from supersededAt', () => {
    const records = [
      superseded('learned_b', 1, ref('learned_b', 2), 'event_sup_b1', T1),
      observed('learned_b', 2),
    ];
    for (const occurredAt of [DISTANT, T0, T3, '2026-10-02T10:00:00+01:00'])
      expect(
        trace(
          verify(records, [
            supersession(
              'event_sup_b1',
              ref('learned_b', 1),
              ref('learned_b', 2),
              { occurredAt },
            ),
          ]),
        ),
      ).toEqual(['superseded learned_b@1 event_sup_b1']);
  });

  it('verifies a revocation whose occurredAt differs from revokedAt', () => {
    const records = [
      observed('learned_c', 1),
      revoked('learned_c', 2, 'event_rev_c2', ref('learned_c', 1), {
        revokedAt: T2,
      }),
    ];
    for (const occurredAt of [DISTANT, T0, '2026-10-03T09:00:00.000Z'])
      expect(
        trace(
          verify(records, [
            revocation(
              'event_rev_c2',
              ref('learned_c', 2),
              ref('learned_c', 1),
              {
                occurredAt,
              },
            ),
          ]),
        ),
      ).toEqual(['revoked learned_c@2 event_rev_c2']);
  });

  it('still rejects every duplicated claim when only the timestamps differ', () => {
    rejects(
      [
        superseded('learned_b', 1, ref('learned_b', 2), 'event_sup_b1'),
        observed('learned_b', 2),
        observed('learned_b', 3),
      ],
      [
        supersession('event_sup_b1', ref('learned_b', 1), ref('learned_b', 3), {
          occurredAt: DISTANT,
        }),
      ],
    );
    rejects(
      [revoked('learned_d', 1, 'event_rev_d1')],
      [
        revocation('event_rev_d1', ref('learned_d', 1), undefined, {
          occurredAt: DISTANT,
          reason: 'Another synthetic reason',
        }),
      ],
    );
  });
});

describe('AVEN-009 lifecycle claims: inert transition snapshot', () => {
  const INPUT_ERROR = expected('invalid_input');
  /** Runs the full scenario with transition 0 (the promotion) replaced. */
  function withPromotion(promotionValue: unknown): string {
    const lineage = lineageOf(RECORDS);
    try {
      verifyLifecycleClaims(lineage, [promotionValue, ...TRANSITIONS.slice(1)]);
      return 'accepted';
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerModelError);
      const text = JSON.stringify(error);
      expect(text).not.toContain('PRIVATE_SENTINEL');
      return text;
    }
  }
  const plain = () => structuredClone(TRANSITIONS[0]!) as Json;

  it('accepts null-prototype plain-data transitions, nested too', () => {
    const toNullProto = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(toNullProto);
      if (value === null || typeof value !== 'object') return value;
      const copy = Object.create(null) as Json;
      for (const [k, v] of Object.entries(value)) copy[k] = toNullProto(v);
      return copy;
    };
    expect(
      trace(verify(RECORDS, TRANSITIONS.map(toNullProto) as unknown[])),
    ).toEqual(FULL_TRACE);
  });

  it.each([
    ['a required field', (t: Json) => t, 'eventId', 'event_pro_a1'],
    [
      'a nested field',
      (t: Json) => t['candidate'] as Json,
      'candidateId',
      'candidate_s1',
    ],
    [
      'an array element',
      (t: Json) => t['evaluations'] as Json,
      '0',
      EVALUATIONS[0],
    ],
  ])(
    'rejects a getter on %s with invalid_input without running it',
    (_label, holder, key, value) => {
      const transition = plain();
      let calls = 0;
      Object.defineProperty(holder(transition), key, {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return value;
        },
      });
      expect(withPromotion(transition)).toBe(INPUT_ERROR);
      expect(calls).toBe(0);
    },
  );

  it('rejects a throwing getter without running it or leaking its text', () => {
    const transition = plain();
    let calls = 0;
    Object.defineProperty(transition, 'candidate', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('PRIVATE_SENTINEL');
      },
    });
    expect(withPromotion(transition)).toBe(INPUT_ERROR);
    expect(calls).toBe(0);
  });

  it('rejects a setter-only property without running it', () => {
    const transition = plain();
    let calls = 0;
    Object.defineProperty(transition, 'reason', {
      enumerable: true,
      set() {
        calls += 1;
      },
    });
    expect(withPromotion(transition)).toBe(INPUT_ERROR);
    expect(calls).toBe(0);
  });

  it('rejects a Proxy around an otherwise valid transition, top-level or nested', () => {
    expect(withPromotion(new Proxy(plain(), {}))).toBe(INPUT_ERROR);
    const nested = plain();
    nested['candidate'] = new Proxy({ ...CANDIDATE }, {});
    expect(withPromotion(nested)).toBe(INPUT_ERROR);
    const inArray = plain();
    inArray['evaluations'] = new Proxy([...EVALUATIONS], {});
    expect(withPromotion(inArray)).toBe(INPUT_ERROR);
  });

  it.each([
    'getPrototypeOf',
    'ownKeys',
    'getOwnPropertyDescriptor',
    'get',
  ] as const)(
    'rejects a Proxy whose %s trap throws, without leaking it',
    (trap) => {
      const handler: ProxyHandler<object> = {
        [trap]: () => {
          throw new Error('PRIVATE_SENTINEL');
        },
      };
      expect(withPromotion(new Proxy(plain(), handler))).toBe(INPUT_ERROR);
    },
  );

  it('rejects inherited contract fields and inherited toJSON', () => {
    const { candidate, ...rest } = plain();
    const inheritsField = Object.assign(Object.create({ candidate }), rest);
    expect(withPromotion(inheritsField)).toBe(INPUT_ERROR);
    let calls = 0;
    const inheritsToJSON = Object.assign(
      Object.create({
        toJSON() {
          calls += 1;
          return TRANSITIONS[0];
        },
      }),
      plain(),
    );
    expect(withPromotion(inheritsToJSON)).toBe(INPUT_ERROR);
    expect(calls).toBe(0);
  });

  it('rejects a class instance carrying transition-shaped properties', () => {
    class Recorded {
      constructor(fields: Json) {
        Object.assign(this, fields);
      }
    }
    expect(withPromotion(new Recorded(plain()))).toBe(INPUT_ERROR);
  });

  it.each([
    ['a symbol key', () => Object.assign(plain(), { [Symbol('x')]: 1 })],
    [
      'a non-enumerable data field',
      () =>
        Object.defineProperty(plain(), 'reason', {
          value: 'Synthetic',
          enumerable: false,
        }),
    ],
    [
      'a sparse array',
      () => {
        const t = plain();
        const sparse = [EVALUATIONS[0]];
        sparse[2] = EVALUATIONS[1];
        t['evaluations'] = sparse;
        return t;
      },
    ],
    [
      'an array with an extra property',
      () => {
        const t = plain();
        t['evaluations'] = Object.assign([...EVALUATIONS], { extra: 1 });
        return t;
      },
    ],
    [
      'an array subclass',
      () => {
        class Listed extends Array {}
        const t = plain();
        t['evaluations'] = Listed.from(EVALUATIONS);
        return t;
      },
    ],
    [
      'a cycle',
      () => {
        const t = plain();
        (t['candidate'] as Json)['self'] = t;
        return t;
      },
    ],
    ['an undefined field value', () => ({ ...plain(), reason: undefined })],
    ['a Date value', () => ({ ...plain(), occurredAt: new Date(0) })],
    ['a function value', () => ({ ...plain(), reason: () => 'x' })],
    ['a hole in the transition array', () => undefined],
  ])('rejects %s with invalid_input', (_label, build) => {
    expect(withPromotion(build())).toBe(INPUT_ERROR);
  });

  it('keeps a schema verdict that no caller code can influence', () => {
    // An otherwise-invalid transition (bad event ID) whose getters would,
    // if executed during validation, make the schema's pattern checks pass
    // and then put them back before any later check. The snapshot never
    // runs them, so the transition stays rejected.
    const test = RegExp.prototype.test;
    let calls = 0;
    const invalid = plain();
    invalid['eventId'] = 'not an event id';
    Object.defineProperty(invalid, 'ownerId', {
      enumerable: true,
      get() {
        calls += 1;
        RegExp.prototype.test = () => true;
        return OWNER;
      },
    });
    Object.defineProperty(invalid, 'occurredAt', {
      enumerable: true,
      get() {
        calls += 1;
        RegExp.prototype.test = test;
        return T1;
      },
    });
    let outcome: string;
    try {
      outcome = withPromotion(invalid);
    } finally {
      RegExp.prototype.test = test;
    }
    expect(outcome).toBe(INPUT_ERROR);
    expect(calls).toBe(0);
    // The same invalid transition as inert data is schema-rejected.
    expect(withPromotion({ ...plain(), eventId: 'not an event id' })).toBe(
      CLAIM_ERROR,
    );
  });

  it('never mutates or freezes the caller transition objects', () => {
    const transitions = structuredClone(TRANSITIONS);
    const proxied = new Proxy(structuredClone(TRANSITIONS[0]!), {});
    const before = JSON.stringify(transitions);
    withPromotion(proxied);
    verify(RECORDS, transitions);
    expect(JSON.stringify(transitions)).toBe(before);
    for (const t of transitions) expect(Object.isFrozen(t)).toBe(false);
  });
});

describe('AVEN-009 lifecycle claims: privacy', () => {
  const records = [
    trusted('learned_PRIVATE_SENTINEL_A', 1, 'event_PRIVATE_SENTINEL_X', {
      candidate: { candidateId: 'candidate_PRIVATE_SENTINEL', version: 1 },
    }),
  ];
  const good = promotion(
    'event_PRIVATE_SENTINEL_X',
    ref('learned_PRIVATE_SENTINEL_A', 1),
    { candidate: { candidateId: 'candidate_PRIVATE_SENTINEL', version: 1 } },
  );

  it('gives one identical outcome wherever event X is, or is not', () => {
    const variants: unknown[][] = [
      [],
      [foreignOwned(good)],
      [
        revocation(
          'event_PRIVATE_SENTINEL_X',
          ref('learned_PRIVATE_SENTINEL_A', 1),
        ),
      ],
      [{ ...good, unexpected: 'PRIVATE_SENTINEL' }],
      [good, { ...good, occurredAt: T2 }],
      [
        promotion(
          'event_PRIVATE_SENTINEL_X',
          ref('learned_PRIVATE_SENTINEL_A', 2),
        ),
      ],
    ];
    const lineage = lineageOf(records);
    const outcomes = new Set(
      variants.map((v) => failure(() => verifyLifecycleClaims(lineage, v))),
    );
    expect([...outcomes]).toEqual([CLAIM_ERROR]);
    for (const leak of [
      'PRIVATE_SENTINEL',
      OWNER,
      FOREIGN,
      'promotion',
      'trusted',
      'candidate',
    ])
      expect(CLAIM_ERROR).not.toContain(leak);
  });
});

describe('AVEN-009 lifecycle claims: ambient prototype state', () => {
  function attempt(call: () => unknown): string {
    try {
      call();
      return 'accepted';
    } catch (error) {
      return error instanceof OwnerModelError ? error.code : 'raw';
    }
  }

  it.each([
    ['an unrelated Object.prototype key', 'syntheticUnrelated'],
    ['an inherited fallback', 'fallback'],
    ['an inherited trustedState', 'trustedState'],
  ])(
    'fails closed with invalid_input on %s installed after lineage, then recovers',
    (_label, key) => {
      const lineage = lineageOf(RECORDS);
      Object.defineProperty(Object.prototype, key, {
        value: ref('learned_a', 1),
        configurable: true,
        writable: true,
      });
      let outcome: string;
      try {
        outcome = attempt(() => verifyLifecycleClaims(lineage, TRANSITIONS));
      } finally {
        Reflect.deleteProperty(Object.prototype, key);
      }
      expect(outcome).toBe('invalid_input');
      expect(attempt(() => verifyLifecycleClaims(lineage, TRANSITIONS))).toBe(
        'accepted',
      );
    },
  );

  it('fails closed when reading a transition pollutes a prototype', () => {
    const lineage = lineageOf(RECORDS);
    const hostile = new Proxy([...TRANSITIONS], {
      get(target, key) {
        if (key === '2')
          Object.defineProperty(Object.prototype, 'syntheticLate', {
            value: 1,
            configurable: true,
            writable: true,
          });
        return Reflect.get(target, key) as unknown;
      },
    });
    let outcome: string;
    try {
      outcome = attempt(() => verifyLifecycleClaims(lineage, hostile));
    } finally {
      Reflect.deleteProperty(Object.prototype, 'syntheticLate');
    }
    expect(outcome).toBe('invalid_input');
  });

  it('fails closed when validating a transition pollutes a prototype', () => {
    const lineage = lineageOf(RECORDS);
    const hostile = { ...TRANSITIONS[1] };
    Object.defineProperty(hostile, 'reason', {
      enumerable: true,
      get() {
        Object.defineProperty(Array.prototype, 'syntheticLate', {
          value: 1,
          configurable: true,
          writable: true,
        });
        return 'Synthetic replacement reason';
      },
    });
    let outcome: string;
    try {
      outcome = attempt(() =>
        verifyLifecycleClaims(lineage, [
          TRANSITIONS[0],
          hostile,
          ...TRANSITIONS.slice(2),
        ]),
      );
    } finally {
      Reflect.deleteProperty(Array.prototype, 'syntheticLate');
    }
    expect(outcome).toBe('invalid_input');
  });
});

describe('AVEN-009 lifecycle claims: scale', () => {
  it('verifies 1,000 claims among 20,000 unused transitions', () => {
    const records: Json[] = [];
    const transitions: Json[] = [];
    for (let i = 0; i < 1_000; i += 1) {
      const id = `learned_n${String(i).padStart(4, '0')}`;
      records.push(trusted(id, 1, `event_pro_${i}`));
      transitions.push(promotion(`event_pro_${i}`, ref(id, 1)));
    }
    for (let i = 0; i < 20_000; i += 1)
      transitions.push(rejection(`event_rej_${i}`));
    const lineage = lineageOf(records);
    const result = verifyLifecycleClaims(lineage, shuffled(transitions, 5));
    expect(result.claims).toHaveLength(1_000);
    expect(result.claims[0]!.eventId).toBe('event_pro_0');
  }, 300_000);
});
