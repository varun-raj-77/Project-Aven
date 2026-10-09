import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearningTransition, OwnerId } from '@aven/contracts';
import { openStorage, type Storage } from '@aven/storage';
import { buildActiveTaskView } from '../src/active-task.ts';
import {
  isVerifiedDurableLineage,
  verifyLifecycleClaims,
} from '../src/claims.ts';
import { OwnerModelError, type OwnerModelErrorCode } from '../src/errors.ts';
import * as root from '../src/index.ts';
import { intakeOwnerState, isOwnerStateIntake } from '../src/intake.ts';
import { buildDurableLineage } from '../src/lineage.ts';
import * as persistence from '../src/persistence/index.ts';
import {
  isRebuiltOwnerModel,
  rebuildOwnerModel,
  type RebuiltOwnerModel,
} from '../src/persistence/rebuild.ts';
import { buildDurableCategoryViews } from '../src/views.ts';
import {
  A,
  approvalOrigin,
  as,
  B,
  claims,
  correctionOrigin,
  corrupt,
  durable,
  experience,
  f,
  fresh,
  history,
  identities,
  snapshots,
  statement,
  task,
  transitionEvent,
  transitions,
  world,
} from './persisted.ts';

/**
 * AVEN-009 patch 7: read-only rebuild over persisted snapshots and the
 * owner-bound Ledger. Every owner, ID, text and digest is SYNTHETIC (see
 * persisted.ts). These are mechanics checks of owner scoping, owner-origin
 * integrity, claim replay, immutability, determinism and zero writes, not a
 * claim of runtime isolation.
 */
type Json = Record<string, unknown>;
const opened: Storage[] = [];
function db(): Storage {
  const storage = fresh();
  opened.push(storage);
  return storage;
}
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  vi.restoreAllMocks();
});
const rebuild = (storage: Storage, owner: string) =>
  rebuildOwnerModel(storage, owner as OwnerId);

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
const PERSISTED = expected('invalid_persisted_owner_model');
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
  for (const leak of [
    A,
    B,
    'event_',
    'evidence_',
    'learned_',
    'SELECT',
    'learned_owner_state',
    'owner_request',
    'SQLITE',
    'Ledger',
  ])
    expect(text).not.toContain(leak);
  return text;
}
const claimTrace = (rebuilt: RebuiltOwnerModel) =>
  rebuilt.verified.claims.map(
    (c) =>
      `${c.kind} ${c.snapshot.learnedItemId}@${c.snapshot.version} ${c.eventId}`,
  );
const STANDARD_TRACE = [
  'revoked learned_c@2 event_rev_c2',
  'superseded learned_b@1 event_sup_b1',
  'trusted learned_a@1 event_pro_a1',
];

describe('AVEN-009 persistence: package surfaces', () => {
  it('keeps the root surface at five exports and adds only rebuildOwnerModel under ./persistence', () => {
    expect(Object.keys(root).sort()).toEqual([
      'AVEN_009_OWNER_MODEL_VERSION',
      'OWNER_MODEL_CONFIG',
      'OWNER_MODEL_ERROR_CODES',
      'OwnerModelError',
      'intakeOwnerState',
    ]);
    expect(Object.keys(persistence)).toEqual(['rebuildOwnerModel']);
  });
});

describe('AVEN-009 persistence: successful read-only rebuild', () => {
  it('rebuilds genuine intake and verified results for the standard world', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
    expect(rebuilt.ownerId).toBe(A);
    expect(isOwnerStateIntake(rebuilt.intake)).toBe(true);
    expect(isVerifiedDurableLineage(rebuilt.verified)).toBe(true);
    expect(rebuilt.intake.durable).toHaveLength(6);
    expect(rebuilt.intake.activeTasks).toHaveLength(3);
    expect(claimTrace(rebuilt)).toEqual(STANDARD_TRACE);
    expect(
      rebuilt.verified.lineage.histories.map((h) => h.learnedItemId),
    ).toEqual(['learned_a', 'learned_b', 'learned_c', 'learned_d']);
  });

  it('returns a frozen, null-prototype, branded wrapper exposing no storage or Ledger', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
    expect(Object.isFrozen(rebuilt)).toBe(true);
    expect(Object.getPrototypeOf(rebuilt)).toBeNull();
    expect(Object.keys(rebuilt).sort()).toEqual([
      'intake',
      'ownerId',
      'verified',
    ]);
    const seen: unknown[] = [rebuilt];
    while (seen.length > 0) {
      const value = seen.pop();
      expect(value).not.toBe(storage);
      expect(
        value instanceof Map ||
          value instanceof Set ||
          value instanceof WeakMap ||
          value instanceof WeakSet,
      ).toBe(false);
      if (value !== null && typeof value === 'object') {
        for (const key of [
          'sqlite',
          'db',
          'appendEvent',
          'replayEvents',
          'close',
        ])
          expect(Object.hasOwn(value, key), key).toBe(false);
        seen.push(...Object.values(value));
      }
    }
    expect(() => {
      (rebuilt as unknown as Json)['ownerId'] = B;
    }).toThrow(TypeError);
  });

  it('brands only the produced result, without running Proxy traps', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
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
      { ...rebuilt },
      Object.assign(Object.create(null) as object, rebuilt),
      Object.defineProperties(
        Object.create(null) as object,
        Object.getOwnPropertyDescriptors(rebuilt),
      ),
      new Proxy(rebuilt, handler),
      JSON.parse(JSON.stringify(rebuilt)),
      { ownerId: A, intake: rebuilt.intake, verified: rebuilt.verified },
      rebuilt.verified,
    ])
      expect(isRebuiltOwnerModel(forged)).toBe(false);
    expect(traps).toBe(0);
    expect(isRebuiltOwnerModel(rebuilt)).toBe(true);
  });

  it('is repeatable byte for byte against unchanged storage', () => {
    const storage = db();
    world(storage, A);
    const texts = new Set(
      [1, 2, 3, 4].map(() => JSON.stringify(rebuild(storage, A))),
    );
    expect(texts.size).toBe(1);
  });

  it('does not depend on storage insertion order', () => {
    const forward = db();
    const reverse = db();
    world(forward, A);
    world(reverse, A, { reverse: true });
    expect(JSON.stringify(rebuild(reverse, A))).toBe(
      JSON.stringify(rebuild(forward, A)),
    );
  });

  it('touches no clock, randomness or timers', () => {
    const storage = db();
    world(storage, A);
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'setTimeout'),
    ];
    rebuild(storage, A);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('AVEN-009 persistence: read-only', () => {
  it('makes zero changes on the connection', () => {
    const storage = db();
    world(storage, A);
    world(storage, B);
    const changes = () =>
      (
        storage.sqlite.prepare('SELECT total_changes() AS n').get() as {
          n: number;
        }
      ).n;
    const before = changes();
    rebuild(storage, A);
    rebuild(storage, B);
    expect(() => rebuild(storage, 'owner_persist_unknown')).toThrow();
    expect(changes()).toBe(before);
  });

  it('leaves a file-backed database byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aven-009-persist-'));
    try {
      const file = join(dir, 'owner-model.sqlite');
      const setup = fresh(file);
      world(setup, A);
      world(setup, B);
      setup.close();
      const hash = () =>
        createHash('sha256').update(readFileSync(file)).digest('hex');
      const before = hash();
      const storage = openStorage(file);
      const rebuilt = JSON.stringify(rebuild(storage, A));
      rebuild(storage, B);
      storage.close();
      expect(hash()).toBe(before);
      const again = openStorage(file);
      expect(JSON.stringify(rebuild(again, A))).toBe(rebuilt);
      again.close();
      expect(hash()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AVEN-009 persistence: owner ID boundary', () => {
  it.each([
    ['a non-owner prefix', 'learned_a'],
    ['an upper-case prefix', 'Owner_persist_a'],
    ['padding', ` ${A}`],
    ['an empty string', ''],
    ['a number', 42],
    ['a boxed string', new String(A)],
    ['null', null],
  ])('rejects %s with invalid_input', (_label, value) => {
    const storage = db();
    world(storage, A);
    expect(failure(() => rebuildOwnerModel(storage, value as OwnerId))).toBe(
      expected('invalid_input'),
    );
  });

  it('fails a valid but unknown owner with the persisted error, without reading others', () => {
    const storage = db();
    world(storage, A);
    expect(failure(() => rebuild(storage, 'owner_persist_unknown'))).toBe(
      PERSISTED,
    );
  });
});

describe('AVEN-009 persistence: owner-origin provenance', () => {
  it('accepts statement, correction and approval origins on durable and task state', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
    const kinds = (records: readonly { provenance: { kind: string } }[]) =>
      [...new Set(records.map((r) => r.provenance.kind))].sort();
    expect(kinds(rebuilt.intake.durable)).toEqual([
      'explicit_owner_correction',
      'explicit_owner_statement',
      'model_inference',
      'owner_approval',
    ]);
    expect(kinds(rebuilt.intake.activeTasks)).toEqual([
      'explicit_owner_correction',
      'explicit_owner_statement',
      'owner_approval',
    ]);
  });

  const origins = [
    [
      'explicit_owner_statement',
      statement,
      ['event_correction', 'event_approval'],
    ],
    [
      'explicit_owner_correction',
      correctionOrigin,
      ['event_source', 'event_approval'],
    ],
    ['owner_approval', approvalOrigin, ['event_source', 'event_correction']],
  ] as const;
  const targets = (wrongOrigin: readonly string[]) =>
    [
      ['a missing event', 'event_missing'],
      ['an assistant response', 'event_assistant'],
      ['a learning event', 'event_pro_a1'],
      ['a candidate event', 'event_candidate'],
      ...wrongOrigin.map((id) => [`another owner-origin type (${id})`, id]),
    ] as const;

  for (const [kind, origin, wrong] of origins)
    for (const [label, eventId] of targets(wrong))
      for (const form of ['durable', 'task'] as const)
        it(`fails ${kind} on ${form} state pointing at ${label}`, () => {
          const storage = db();
          world(storage, A);
          const record =
            form === 'durable'
              ? durable(
                  A,
                  'learned_x',
                  1,
                  { status: 'observed' },
                  origin(A, eventId),
                )
              : task(A, 'learned_x', 1, origin(A, eventId));
          corrupt(storage, [
            [
              form === 'durable' ? 'learned_owner_state' : 'active_task_state',
              record,
            ],
          ]);
          expect(failure(() => rebuild(storage, A))).toBe(PERSISTED);
        });

  it('never resolves a source event that only another owner recorded', () => {
    const storage = db();
    world(storage, A);
    world(storage, B);
    // In the shared DB, B records an owner_request that A never did.
    corruptB(storage);
    corrupt(storage, [
      [
        'learned_owner_state',
        durable(
          A,
          'learned_x',
          1,
          { status: 'observed' },
          statement(A, 'event_only_b'),
        ),
      ],
    ]);
    expect(failure(() => rebuild(storage, A))).toBe(PERSISTED);
    expect(claimTrace(rebuild(storage, B))).toEqual(STANDARD_TRACE);
  });
});

/** B records an owner_request `event_only_b` with evidence `evidence_only_b`. */
function corruptB(storage: Storage) {
  corrupt(storage, [
    [
      'experience_events',
      experience(
        B,
        'event_only_b',
        'owner_request',
        { instruction: 'Synthetic request', task: f.task },
        statement(B, 'event_only_b'),
        ['evidence_only_b'],
      ),
    ],
    [
      'evidence',
      as(B, {
        ...f.recordedEvidence,
        id: 'evidence_only_b',
        eventId: 'event_only_b',
        provenance: statement(f.owner, 'event_only_b'),
      }),
    ],
  ]);
}

describe('AVEN-009 persistence: owner confirmation evidence', () => {
  it('accepts confirmed and disputed confirmations with recorded evidence', () => {
    const storage = db();
    world(storage, A);
    const statuses = rebuild(storage, A)
      .intake.durable.map((r) => r.evidence.ownerConfirmation.status)
      .sort();
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('disputed');
  });

  const confirmed = (eventId: string, evidenceId: string) => ({
    status: 'confirmed',
    evidence: { eventId, evidenceId },
    provenance: statement(f.owner, eventId),
  });
  const disputed = (eventId: string, evidenceId: string) => ({
    status: 'disputed',
    evidence: { eventId, evidenceId },
    provenance: correctionOrigin(f.owner, eventId),
  });

  it.each([
    [
      'confirmed, evidence ID absent from the event',
      confirmed('event_source', 'evidence_absent'),
    ],
    [
      'confirmed, evidence of another event',
      confirmed('event_source', 'evidence_approval'),
    ],
    [
      'confirmed, citing an owner_correction',
      confirmed('event_correction', 'evidence_correction'),
    ],
    [
      'confirmed, citing an owner_approval',
      confirmed('event_approval', 'evidence_approval'),
    ],
    [
      'confirmed, missing event',
      confirmed('event_missing', 'evidence_missing'),
    ],
    [
      'disputed, citing an owner_request',
      disputed('event_source', 'evidence_source'),
    ],
    [
      'disputed, evidence ID absent from the event',
      disputed('event_correction', 'evidence_absent'),
    ],
    [
      'confirmed, event and evidence only under another owner',
      confirmed('event_only_b', 'evidence_only_b'),
    ],
  ])('fails %s', (_label, confirmation) => {
    const storage = db();
    world(storage, A);
    world(storage, B);
    corruptB(storage);
    corrupt(storage, [
      [
        'learned_owner_state',
        durable(
          A,
          'learned_x',
          1,
          { status: 'observed' },
          f.inference,
          confirmation,
        ),
      ],
    ]);
    expect(failure(() => rebuild(storage, A))).toBe(PERSISTED);
    expect(claimTrace(rebuild(storage, B))).toEqual(STANDARD_TRACE);
  });
});

describe('AVEN-009 persistence: transitions come from Ledger replay', () => {
  it('fails through Patch-4 claim verification when a backing event is absent', () => {
    const storage = db();
    world(storage, A);
    corrupt(storage, [
      [
        'learned_owner_state',
        durable(A, 'learned_y', 1, {
          status: 'trusted',
          evaluations: [f.evalRef],
          lastValidatedAt: f.time,
          candidate: f.candidateRef,
          promotionEventId: 'event_pro_y1',
        }),
      ],
    ]);
    expect(failure(() => rebuild(storage, A))).toBe(
      expected('invalid_lifecycle_claim'),
    );
  });

  it('never accepts the lifecycle_records projection without the Ledger event', () => {
    const storage = db();
    world(storage, A);
    const promotion = { ...transitions(A)[0]!, eventId: 'event_pro_y1' };
    (promotion as Json)['trustedState'] = {
      learnedItemId: 'learned_y',
      version: 1,
    };
    corrupt(storage, [
      [
        'learned_owner_state',
        durable(A, 'learned_y', 1, {
          status: 'trusted',
          evaluations: [f.evalRef],
          lastValidatedAt: f.time,
          candidate: f.candidateRef,
          promotionEventId: 'event_pro_y1',
        }),
      ],
      ['lifecycle_records', promotion],
    ]);
    expect(failure(() => rebuild(storage, A))).toBe(
      expected('invalid_lifecycle_claim'),
    );
  });

  it('never lets another owner’s identical event ID back a claim', () => {
    const storage = db();
    world(storage, A);
    identities(storage, B);
    history(storage, B);
    // B fully records learned_y and its promotion; A only claims it.
    const promotion = {
      ...transitions(B)[0]!,
      eventId: 'event_pro_y1',
    } as Json;
    promotion['trustedState'] = { learnedItemId: 'learned_y', version: 1 };
    const trustedY = (owner: string) =>
      durable(owner, 'learned_y', 1, {
        status: 'trusted',
        evaluations: [f.evalRef],
        lastValidatedAt: f.time,
        candidate: f.candidateRef,
        promotionEventId: 'event_pro_y1',
      });
    claims(storage, B, {
      records: [...snapshots(B), trustedY(B)],
      extraTransitions: [promotion as unknown as LearningTransition],
    });
    corrupt(storage, [['learned_owner_state', trustedY(A)]]);
    expect(failure(() => rebuild(storage, A))).toBe(
      expected('invalid_lifecycle_claim'),
    );
    expect(claimTrace(rebuild(storage, B))).toContain(
      'trusted learned_y@1 event_pro_y1',
    );
  });

  it('keeps rejection and rollback history inert', () => {
    const plain = db();
    const inert = db();
    world(plain, A, { inert: false });
    world(inert, A, { inert: true });
    const without = rebuild(plain, A);
    const withInert = rebuild(inert, A);
    expect(JSON.stringify(withInert)).toBe(JSON.stringify(without));
    const views = (r: RebuiltOwnerModel) =>
      JSON.stringify(
        buildDurableCategoryViews(r.verified, { referenceTime: f.later }),
      );
    expect(views(withInert)).toBe(views(without));
    expect(
      withInert.intake.durable.find(
        (r) => r.id === 'learned_c' && r.metadata.recordVersion === 2,
      )?.lifecycle.status,
    ).toBe('revoked');
  });

  it('synthesizes no snapshot from events', () => {
    const storage = db();
    identities(storage, A);
    history(storage, A);
    corrupt(storage, [
      ['experience_events', transitionEvent(A, transitions(A)[0]!)],
    ]);
    const rebuilt = rebuild(storage, A);
    expect(rebuilt.intake.durable).toEqual([]);
    expect(rebuilt.intake.activeTasks).toEqual([]);
    expect(rebuilt.verified.claims).toEqual([]);
  });

  it('keeps fixed Patch-2 errors for persisted state they reject', () => {
    const storage = db();
    world(storage, A);
    storage.sqlite.transaction(() => {
      for (const [version, createdAt] of [
        [1, f.later],
        [2, f.time],
      ] as const)
        storage.sqlite
          .prepare('INSERT INTO learned_owner_state (record_json) VALUES (?)')
          .run(
            JSON.stringify({
              ...durable(A, 'learned_v', version, { status: 'observed' }),
              metadata: { ...f.metadata, recordVersion: version, createdAt },
            }),
          );
    })();
    expect(failure(() => rebuild(storage, A))).toBe(
      expected('version_order_conflict'),
    );
  });

  it('pages through more than 1,000 Ledger events', () => {
    const storage = db();
    const ledger = world(storage, A);
    for (let i = 0; i < 1_050; i += 1) {
      const id = `event_bulk_${i}`;
      const { recordedAt: _r, ...input } = experience(
        A,
        id,
        'owner_request',
        { instruction: 'Synthetic bulk request', task: f.task },
        statement(A, id),
      ) as unknown as Json;
      ledger.appendEvent(input as never);
    }
    corrupt(storage, [
      [
        'active_task_state',
        task(A, 'learned_bulk', 1, statement(A, 'event_bulk_1049')),
      ],
    ]);
    const rebuilt = rebuild(storage, A);
    expect(rebuilt.intake.activeTasks.map((t) => t.id)).toContain(
      'learned_bulk',
    );
  });
});

describe('AVEN-009 persistence: owner isolation', () => {
  const variants: [string, (storage: Storage) => void][] = [
    ['no rows', () => undefined],
    ['a valid world', (s) => world(s, B)],
    [
      'many extra snapshots',
      (s) => {
        world(s, B);
        corrupt(
          s,
          Array.from({ length: 50 }, (_, i) => [
            'learned_owner_state',
            durable(
              B,
              `learned_many_${i}`,
              1,
              { status: 'observed' },
              f.inference,
            ),
          ]),
        );
      },
    ],
    [
      'wrong provenance',
      (s) => {
        world(s, B);
        corrupt(s, [
          [
            'learned_owner_state',
            durable(
              B,
              'learned_x',
              1,
              { status: 'observed' },
              statement(B, 'event_assistant'),
            ),
          ],
        ]);
      },
    ],
    [
      'extra transitions',
      (s) => {
        const ledger = world(s, B);
        corrupt(s, [
          [
            'experience_events',
            transitionEvent(B, {
              ...transitions(B)[1]!,
              eventId: 'event_sup_extra',
            } as LearningTransition),
          ],
        ]);
        void ledger;
      },
    ],
  ];

  it('rebuilds owner A identically whatever owner B holds', () => {
    const texts = new Set<string>();
    for (const [, setupB] of variants) {
      const storage = db();
      world(storage, A);
      setupB(storage);
      texts.add(JSON.stringify(rebuild(storage, A)));
    }
    expect(texts.size).toBe(1);
  });

  it('keeps a failing owner B from affecting owner A', () => {
    const storage = db();
    world(storage, A);
    variants[3]![1](storage);
    expect(failure(() => rebuild(storage, B))).toBe(PERSISTED);
    expect(claimTrace(rebuild(storage, A))).toEqual(STANDARD_TRACE);
  });
});

describe('AVEN-009 persistence: projections from the rebuilt model', () => {
  function inMemory() {
    const intake = intakeOwnerState({ ownerId: A, records: snapshots(A) });
    const inertTransitions = [
      as(A, f.rejection),
      as(A, {
        kind: 'learning_rollback',
        ownerId: f.owner,
        metadata: f.metadata,
        eventId: 'event_rollback_c',
        occurredAt: f.later,
        from: { learnedItemId: 'learned_c', version: 2 },
        restore: { learnedItemId: 'learned_c', version: 1 },
        revocationEventId: 'event_rev_c2',
        authority: f.policyRef,
        reason: 'Synthetic rollback',
      }),
    ];
    const verified = verifyLifecycleClaims(buildDurableLineage(intake), [
      ...transitions(A),
      ...inertTransitions,
    ]);
    return { intake, verified };
  }

  it('feeds Patch-5 category views exactly like the in-memory records', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
    const memory = inMemory();
    for (const referenceTime of [f.time, f.later, '2030-01-01T00:00:00Z'])
      expect(
        JSON.stringify(
          buildDurableCategoryViews(rebuilt.verified, { referenceTime }),
        ),
      ).toBe(
        JSON.stringify(
          buildDurableCategoryViews(memory.verified, { referenceTime }),
        ),
      );
  });

  it('feeds Patch-6 active task views exactly like the in-memory records', () => {
    const storage = db();
    world(storage, A);
    const rebuilt = rebuild(storage, A);
    const memory = inMemory();
    for (const taskId of [f.task.taskId, 'task_other', 'task_absent']) {
      const request = { sessionId: f.task.sessionId, taskId };
      expect(JSON.stringify(buildActiveTaskView(rebuilt.intake, request))).toBe(
        JSON.stringify(buildActiveTaskView(memory.intake, request)),
      );
    }
    expect(
      buildActiveTaskView(rebuilt.intake, {
        sessionId: f.task.sessionId,
        taskId: f.task.taskId,
      })?.state.id,
    ).toBe('learned_t1');
  });
});
