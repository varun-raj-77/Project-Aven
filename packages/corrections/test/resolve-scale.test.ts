import * as c from '@aven/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CorrectionError,
  resolveImmediateCorrections,
  type ImmediateCorrectionView,
} from '../src/index.ts';
import { linkSupersessions } from '../src/resolve.ts';
import {
  SCALE_CATEGORIES,
  SCALE_FAR_FUTURE,
  SCALE_OTHER_SESSION,
  SCALE_OWNER,
  SCALE_SESSION,
  SCALE_TASKS,
  distributionA,
  distributionB,
  scaleAsOf,
  scaleEventId,
  scaleEvidenceId,
  scaleHistory,
  scaleQuery,
  scaleTime,
  seeded,
  type ScaleEntry,
  type ScaleSpec,
  type ScaleTarget,
} from './scale-fixtures.ts';

/*
 * AVEN-010 Codex remediation R2 (audit F2): the resolver's supersession step
 * is an indexed single pass, not a pairwise search. Every owner, ID, time and
 * text is SYNTHETIC. These tests check that the semantics did not change
 * (against an independent pairwise reference oracle, byte for byte), that
 * the linkage step does linear work (a deterministic read count, not a
 * timer), and that the scale cases behave. Timings live in
 * `bench/resolve.bench.ts`, outside the default suite.
 */

// Generous per-test allowance for slower machines: these tests assert
// semantics and deterministic read counts, never elapsed time.
const SCALE_TIMEOUT_MS = 60_000;
const [T1, T2, T3] = SCALE_TASKS as [string, string, string];
const LATER_TASK = 'task_scale_later';
const S = SCALE_SESSION;
const S2 = SCALE_OTHER_SESSION;

type View = ImmediateCorrectionView;
type Binding = ReturnType<typeof scaleQuery>;
type AsOf = ReturnType<typeof scaleAsOf>;
interface History {
  readonly ownerId: string;
  readonly entries: readonly ScaleEntry[];
}

const resolve = (
  h: unknown,
  q: unknown = scaleQuery(),
  o: unknown = scaleAsOf(),
) => resolveImmediateCorrections(h, q, o);

/** A session-wide (unless overridden) synthetic spec. */
const spec = (seq: number, over: Partial<ScaleSpec> = {}): ScaleSpec => ({
  seq,
  name: `c${seq}`,
  kind: 'current_session',
  session: S,
  task: T1,
  category: 'communication',
  target: { kind: 'unidentified', description: `u${seq}` },
  ...over,
});
const toEvent = (name: string): ScaleTarget => ({
  kind: 'event',
  eventId: scaleEventId(name),
});
const toOwnEvidence = (name: string): ScaleTarget => ({
  kind: 'evidence',
  reference: {
    evidenceId: scaleEvidenceId(name),
    eventId: scaleEventId(name),
  },
});
const toEvidence = (evidenceName: string, eventName: string): ScaleTarget => ({
  kind: 'evidence',
  reference: {
    evidenceId: scaleEvidenceId(evidenceName),
    eventId: scaleEventId(eventName),
  },
});
const external = (n: number): ScaleTarget => ({
  kind: 'event',
  eventId: `event_external_${n}`,
});

const viewParts = (view: View) =>
  JSON.stringify({
    active: view.active,
    inactive: view.inactive,
    supersessions: view.supersessions,
    overlaps: view.overlaps,
    suppressionTargets: view.suppressionTargets,
  });
const activeIds = (view: View) => view.active.map((a) => a.eventId);
const inactiveOf = (view: View) =>
  view.inactive.map((i) => [i.eventId, i.reason, [...i.supersededBy]]);

function invalidHistory(fn: () => unknown) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CorrectionError);
  expect((caught as CorrectionError).code).toBe('invalid_correction_history');
}

/** Deterministic Fisher-Yates shuffle with the fixed-seed generator. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = seeded(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Independent reference oracle: a direct, PAIRWISE restatement of the
// accepted semantics (D3, D4 as modified, D5, D12) written without the
// production indexes, used only on moderate histories. It reads the
// synthetic fixtures (whole-second `Z` times, so Date.parse is exact).
// ---------------------------------------------------------------------------

interface OracleEvent {
  id: string;
  recordedAt: string;
  task?: { sessionId: string; taskId: string };
  payload: {
    evidence: { evidenceId: string; eventId: string };
    category: string;
    target: ScaleTarget;
    correctedInstruction: string;
    immediateApplicability:
      | { kind: 'current_task'; task: { sessionId: string; taskId: string } }
      | { kind: 'current_session'; sessionId: string }
      | { kind: 'unspecified' };
  };
}

function oracle(history: History, q: Binding, o: AsOf): string {
  const events = [...history.entries]
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({
      sequence: e.sequence,
      event: e.event as unknown as OracleEvent,
    }));
  const included: typeof events = [];
  for (const e of events) {
    if (o.throughSequence !== null && e.sequence > o.throughSequence) break;
    if (Date.parse(e.event.recordedAt) > Date.parse(o.referenceTime)) break;
    included.push(e);
  }
  const applicable: {
    sequence: number;
    event: OracleEvent;
    label: string;
    origin: { sessionId: string; taskId: string | null };
  }[] = [];
  for (const { sequence, event } of included) {
    const env = event.task;
    const d = event.payload.immediateApplicability;
    if (d.kind === 'current_task') {
      const consistent =
        env === undefined ||
        (env.sessionId === d.task.sessionId && env.taskId === d.task.taskId);
      if (
        consistent &&
        d.task.sessionId === q.sessionId &&
        d.task.taskId === q.taskId
      )
        applicable.push({
          sequence,
          event,
          label: 'current_task',
          origin: { sessionId: d.task.sessionId, taskId: d.task.taskId },
        });
    } else if (d.kind === 'current_session') {
      const consistent = env === undefined || env.sessionId === d.sessionId;
      if (consistent && d.sessionId === q.sessionId)
        applicable.push({
          sequence,
          event,
          label: 'current_session',
          origin: { sessionId: d.sessionId, taskId: env?.taskId ?? null },
        });
    } else if (
      env !== undefined &&
      env.sessionId === q.sessionId &&
      env.taskId === q.taskId
    )
      applicable.push({
        sequence,
        event,
        label: 'unspecified_origin_task',
        origin: { sessionId: env.sessionId, taskId: env.taskId },
      });
  }
  const permission = (e: OracleEvent) => e.payload.category === 'permission';
  // Pairwise, by definition: every later applicable non-permission
  // correction explicitly naming an earlier applicable non-permission one.
  const by = applicable.map(() => [] as string[]);
  for (let i = 0; i < applicable.length; i += 1)
    for (let j = i + 1; j < applicable.length; j += 1) {
      const earlier = applicable[i]!.event;
      const later = applicable[j]!.event;
      if (permission(earlier) || permission(later)) continue;
      const t = later.payload.target;
      const named =
        (t.kind === 'event' && t.eventId === earlier.id) ||
        (t.kind === 'evidence' &&
          t.reference.evidenceId === earlier.payload.evidence.evidenceId &&
          t.reference.eventId === earlier.payload.evidence.eventId);
      if (named) by[i]!.push(later.id);
    }
  const target = (t: ScaleTarget) =>
    t.kind === 'event'
      ? { kind: t.kind, eventId: t.eventId }
      : t.kind === 'evidence'
        ? {
            kind: t.kind,
            reference: {
              evidenceId: t.reference.evidenceId,
              eventId: t.reference.eventId,
            },
          }
        : t.kind === 'owner_state'
          ? {
              kind: t.kind,
              reference: {
                learnedItemId: t.reference.learnedItemId,
                version: t.reference.version,
              },
            }
          : { kind: t.kind, description: t.description };
  const base = (a: (typeof applicable)[number]) => ({
    sequence: a.sequence,
    eventId: a.event.id,
    evidence: {
      evidenceId: a.event.payload.evidence.evidenceId,
      eventId: a.event.payload.evidence.eventId,
    },
    recordedAt: a.event.recordedAt,
    category: a.event.payload.category,
    applicability: a.label,
    origin: { sessionId: a.origin.sessionId, taskId: a.origin.taskId },
    target: target(a.event.payload.target),
  });
  const active: (ReturnType<typeof base> & { correctedInstruction: string })[] =
    [];
  const inactive: (ReturnType<typeof base> & {
    reason: string;
    supersededBy: string[];
  })[] = [];
  applicable.forEach((a, i) => {
    if (permission(a.event))
      inactive.push({
        ...base(a),
        reason: 'deferred_to_root',
        supersededBy: [],
      });
    else if (by[i]!.length > 0)
      inactive.push({
        ...base(a),
        reason: 'superseded_by_correction',
        supersededBy: by[i]!,
      });
    else
      active.push({
        ...base(a),
        correctedInstruction: a.event.payload.correctedInstruction,
      });
  });
  const supersessions = inactive.flatMap((i) =>
    i.supersededBy.map((b) => ({ supersededEventId: i.eventId, byEventId: b })),
  );
  const groups: { key: string; target: unknown; ids: string[] }[] = [];
  for (const a of active) {
    if (a.target.kind === 'unidentified') continue;
    const key = JSON.stringify(a.target);
    const group = groups.find((g) => g.key === key);
    if (group) group.ids.push(a.eventId);
    else groups.push({ key, target: a.target, ids: [a.eventId] });
  }
  return JSON.stringify({
    active,
    inactive,
    supersessions,
    overlaps: groups
      .filter((g) => g.ids.length > 1)
      .map((g) => ({ target: g.target, eventIds: g.ids })),
    suppressionTargets: groups.map((g) => ({
      target: g.target,
      byEventIds: g.ids,
    })),
  });
}

/** Resolver and oracle agree byte for byte (and the resolver is deterministic under reordering). */
function expectEquivalent(history: History, q: Binding, o: AsOf, seed = 1) {
  const view = resolve(history, q, o);
  expect(viewParts(view)).toBe(oracle(history, q, o));
  const reordered = { ...history, entries: shuffled(history.entries, seed) };
  expect(JSON.stringify(resolve(reordered, q, o))).toBe(JSON.stringify(view));
  return view;
}

/**
 * A random, frozen-schema-valid, R1-consistent history: every scope kind,
 * both sessions, three tasks, absent and disagreeing envelopes, permission
 * corrections, additional evidence, event/own-evidence/additional-evidence
 * links to earlier corrections (biased toward recent ones, so chains and
 * branches form), shared external and owner-state targets (overlaps),
 * unidentified targets, sequence gaps and a few out-of-order recording
 * times (to exercise the as-of prefix).
 */
function randomHistory(seed: number, n: number): History {
  const rand = seeded(seed);
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(rand() * items.length)]!;
  const specs: ScaleSpec[] = [];
  let seq = 0;
  for (let i = 0; i < n; i += 1) {
    seq += 1 + Math.floor(rand() * 3);
    const name = `r${seed}_${i}`;
    const earlier =
      specs.length === 0
        ? undefined
        : specs[
            Math.max(
              0,
              specs.length - 1 - Math.floor(rand() ** 2 * specs.length),
            )
          ]!;
    const roll = rand();
    const target: ScaleTarget =
      earlier !== undefined && roll < 0.3
        ? toEvent(earlier.name)
        : earlier !== undefined && roll < 0.5
          ? toOwnEvidence(earlier.name)
          : earlier !== undefined && roll < 0.6 && earlier.extraEvidence
            ? toEvidence(`${earlier.name}_extra`, earlier.name)
            : roll < 0.7
              ? external(Math.floor(rand() * 3))
              : roll < 0.75
                ? {
                    kind: 'evidence',
                    reference: {
                      evidenceId: 'evidence_external_0',
                      eventId: 'event_external_0',
                    },
                  }
                : roll < 0.85
                  ? {
                      kind: 'owner_state',
                      reference: {
                        learnedItemId: `learned_scale_${Math.floor(rand() * 2)}`,
                        version: 1 + Math.floor(rand() * 2),
                      },
                    }
                  : { kind: 'unidentified', description: `free ${name}` };
    const kind = pick([
      'current_task',
      'current_session',
      'unspecified',
    ] as const);
    const session = rand() < 0.8 ? S : S2;
    const task = pick([T1, T2, T3]);
    const envelopeRoll = rand();
    const envelope =
      envelopeRoll < 0.1
        ? null
        : envelopeRoll < 0.18
          ? { sessionId: rand() < 0.5 ? S2 : S, taskId: pick([T1, T2, T3]) }
          : undefined;
    const category =
      rand() < 0.15 ? 'permission' : pick(SCALE_CATEGORIES.slice(0, 6));
    specs.push({
      seq,
      name,
      kind,
      session,
      task,
      envelope,
      category,
      target,
      ...(rand() < 0.2
        ? { extraEvidence: [scaleEvidenceId(`${name}_extra`)] }
        : {}),
      ...(rand() < 0.05 ? { recordedAt: scaleTime(seq + 500) } : {}),
    });
  }
  return scaleHistory(specs);
}

const BINDINGS = [
  scaleQuery(T1, S),
  scaleQuery(T2, S),
  scaleQuery(LATER_TASK, S),
  scaleQuery(T3, S2),
];

describe('R2 fixtures', { timeout: SCALE_TIMEOUT_MS }, () => {
  it('builds frozen-schema-valid synthetic entries for both benchmark distributions and the random generator', () => {
    const histories = [
      scaleHistory(distributionA(300)),
      scaleHistory(distributionB(300, 40)),
      randomHistory(7, 300),
    ];
    for (const history of histories)
      for (const entry of history.entries) {
        expect(c.ExperienceEventSchema.safeParse(entry.event).success).toBe(
          true,
        );
        for (const record of entry.evidence)
          expect(c.EvidenceRecordSchema.safeParse(record).success).toBe(true);
      }
    // And the resolver accepts every one of them.
    for (const history of histories)
      expect(() => resolve(history)).not.toThrow();
  });
});

describe(
  'R2 semantic equivalence with the independent pairwise oracle',
  { timeout: SCALE_TIMEOUT_MS },
  () => {
    it('matches the oracle byte for byte on random moderate histories, every binding and several as-of boundaries', () => {
      let supersessions = 0;
      let overlaps = 0;
      let deferred = 0;
      for (let seed = 1; seed <= 12; seed += 1) {
        const history = randomHistory(seed, 100);
        const sequences = history.entries.map((e) => e.sequence);
        const middle = sequences[Math.floor(sequences.length / 2)]!;
        const asOfs = [
          scaleAsOf(),
          scaleAsOf(SCALE_FAR_FUTURE, middle),
          scaleAsOf(scaleTime(middle), null),
        ];
        for (const q of BINDINGS)
          for (const o of asOfs) {
            const view = expectEquivalent(history, q, o, seed);
            supersessions += view.supersessions.length;
            overlaps += view.overlaps.length;
            deferred += view.inactive.filter(
              (i) => i.reason === 'deferred_to_root',
            ).length;
          }
      }
      // The campaign actually exercised the interesting paths.
      expect(supersessions).toBeGreaterThan(200);
      expect(overlaps).toBeGreaterThan(50);
      expect(deferred).toBeGreaterThan(50);
    });

    it('matches the oracle on both benchmark distributions at moderate size', () => {
      for (const history of [
        scaleHistory(distributionA(1000)),
        scaleHistory(distributionB(1000, 200)),
      ])
        for (const q of BINDINGS) expectEquivalent(history, q, scaleAsOf());
    });
  },
);

describe(
  'R2 scale and supersession matrix',
  { timeout: SCALE_TIMEOUT_MS },
  () => {
    it('keeps thousands of independent corrections active, with no supersession, overlap or suppression', () => {
      const view = expectEquivalent(
        scaleHistory(distributionA(3000)),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(view.active).toHaveLength(3000);
      expect(view.inactive).toEqual([]);
      expect(view.supersessions).toEqual([]);
      expect(view.overlaps).toEqual([]);
      expect(view.suppressionTargets).toEqual([]);
    });

    it('resolves a long event-ID chain to its last link, each link superseded by the next', () => {
      const n = 2000;
      const specs = Array.from({ length: n }, (_, i) =>
        spec(i + 1, i === 0 ? {} : { target: toEvent(`c${i}`) }),
      );
      const view = expectEquivalent(
        scaleHistory(specs),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(activeIds(view)).toEqual([scaleEventId(`c${n}`)]);
      expect(view.inactive).toHaveLength(n - 1);
      view.inactive.forEach((item, i) => {
        expect(item.eventId).toBe(scaleEventId(`c${i + 1}`));
        expect(item.reason).toBe('superseded_by_correction');
        expect(item.supersededBy).toEqual([scaleEventId(`c${i + 2}`)]);
      });
      expect(view.suppressionTargets).toEqual([
        { target: toEvent(`c${n - 1}`), byEventIds: [scaleEventId(`c${n}`)] },
      ]);
    });

    it('resolves a long own-evidence chain the same way', () => {
      const n = 2000;
      const specs = Array.from({ length: n }, (_, i) =>
        spec(i + 1, i === 0 ? {} : { target: toOwnEvidence(`c${i}`) }),
      );
      const view = expectEquivalent(
        scaleHistory(specs),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(activeIds(view)).toEqual([scaleEventId(`c${n}`)]);
      expect(view.supersessions).toHaveLength(n - 1);
      expect(view.supersessions.at(-1)).toEqual({
        supersededEventId: scaleEventId(`c${n - 1}`),
        byEventId: scaleEventId(`c${n}`),
      });
    });

    it('records branching superseders in ascending sequence order, whatever the input order', () => {
      const history = scaleHistory([
        spec(1),
        spec(2, { target: toEvent('c1') }),
        spec(3, { target: toOwnEvidence('c1') }),
        spec(5, { target: toEvent('c1') }),
        spec(4, { target: toEvent('c2') }),
      ]);
      const view = expectEquivalent(history, scaleQuery(), scaleAsOf(), 3);
      expect(inactiveOf(view)).toEqual([
        [
          'event_c1',
          'superseded_by_correction',
          ['event_c2', 'event_c3', 'event_c5'],
        ],
        ['event_c2', 'superseded_by_correction', ['event_c4']],
      ]);
      expect(activeIds(view)).toEqual(['event_c3', 'event_c4', 'event_c5']);
      for (const seed of [11, 12, 13, 14])
        expect(
          JSON.stringify(
            resolve({ ...history, entries: shuffled(history.entries, seed) }),
          ),
        ).toBe(JSON.stringify(view));
    });

    it('keeps an earlier correction inactive when its superseder is itself superseded (no resurrection)', () => {
      const view = expectEquivalent(
        scaleHistory([
          spec(1),
          spec(2, { target: toEvent('c1') }),
          spec(3, { target: toOwnEvidence('c2') }),
          spec(4, { target: toEvent('c3') }),
        ]),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(inactiveOf(view)).toEqual([
        ['event_c1', 'superseded_by_correction', ['event_c2']],
        ['event_c2', 'superseded_by_correction', ['event_c3']],
        ['event_c3', 'superseded_by_correction', ['event_c4']],
      ]);
      expect(activeIds(view)).toEqual(['event_c4']);
    });

    it('never supersedes a permission correction and never lets one supersede', () => {
      const view = expectEquivalent(
        scaleHistory([
          spec(1, { category: 'permission' }),
          spec(2, { target: toEvent('c1') }),
          spec(3, { target: toOwnEvidence('c1') }),
          spec(4),
          spec(5, { category: 'permission', target: toEvent('c4') }),
          spec(6, { category: 'permission', target: toOwnEvidence('c4') }),
        ]),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(inactiveOf(view)).toEqual([
        ['event_c1', 'deferred_to_root', []],
        ['event_c5', 'deferred_to_root', []],
        ['event_c6', 'deferred_to_root', []],
      ]);
      expect(activeIds(view)).toEqual(['event_c2', 'event_c3', 'event_c4']);
      expect(view.supersessions).toEqual([]);
      // Permission corrections contribute no suppression target.
      expect(view.suppressionTargets.map((s) => s.byEventIds)).toEqual([
        ['event_c2'],
        ['event_c3'],
      ]);
    });

    it('never treats an additional evidence record as the correction it belongs to', () => {
      const view = expectEquivalent(
        scaleHistory([
          spec(1, { extraEvidence: [scaleEvidenceId('c1_extra')] }),
          spec(2, { target: toEvidence('c1_extra', 'c1') }),
        ]),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(activeIds(view)).toEqual(['event_c1', 'event_c2']);
      expect(view.supersessions).toEqual([]);
      expect(view.suppressionTargets).toEqual([
        { target: toEvidence('c1_extra', 'c1'), byEventIds: ['event_c2'] },
      ]);
    });

    it("confines supersession to the superseding correction's own scope (other task, session vs task, unspecified)", () => {
      const history = scaleHistory([
        // A task-T2 correction named by a task-T1 correction.
        spec(1, { kind: 'current_task', task: T2 }),
        spec(2, { kind: 'current_task', task: T1, target: toEvent('c1') }),
        // A session-wide correction named by a narrower task-T1 correction.
        spec(3),
        spec(4, { kind: 'current_task', task: T1, target: toEvent('c3') }),
        // A task-T2 correction named by a later session-wide correction.
        spec(5, { kind: 'current_task', task: T2 }),
        spec(6, { target: toOwnEvidence('c5') }),
        // An unspecified correction (origin T3) naming a session-wide one.
        spec(7),
        spec(8, { kind: 'unspecified', task: T3, target: toEvent('c7') }),
      ]);
      const t1 = expectEquivalent(history, scaleQuery(T1), scaleAsOf());
      expect(activeIds(t1)).toEqual([
        'event_c2',
        'event_c4',
        'event_c6',
        'event_c7',
      ]);
      expect(inactiveOf(t1)).toEqual([
        ['event_c3', 'superseded_by_correction', ['event_c4']],
      ]);
      const t2 = expectEquivalent(history, scaleQuery(T2), scaleAsOf());
      expect(activeIds(t2)).toEqual([
        'event_c1',
        'event_c3',
        'event_c6',
        'event_c7',
      ]);
      expect(inactiveOf(t2)).toEqual([
        ['event_c5', 'superseded_by_correction', ['event_c6']],
      ]);
      const t3 = expectEquivalent(history, scaleQuery(T3), scaleAsOf());
      expect(activeIds(t3)).toEqual(['event_c3', 'event_c6', 'event_c8']);
      expect(inactiveOf(t3)).toEqual([
        ['event_c7', 'superseded_by_correction', ['event_c8']],
      ]);
      const later = expectEquivalent(
        history,
        scaleQuery(LATER_TASK),
        scaleAsOf(),
      );
      expect(activeIds(later)).toEqual(['event_c3', 'event_c6', 'event_c7']);
      expect(later.inactive).toEqual([]);
      const otherSession = expectEquivalent(
        history,
        scaleQuery(T1, S2),
        scaleAsOf(),
      );
      expect(otherSession.active).toEqual([]);
    });

    it('exposes thousands of corrections sharing one target as one unresolved overlap, never as supersession', () => {
      const n = 2000;
      const view = expectEquivalent(
        scaleHistory(
          Array.from({ length: n }, (_, i) =>
            spec(i + 1, { target: external(0) }),
          ),
        ),
        scaleQuery(),
        scaleAsOf(),
      );
      const ids = Array.from({ length: n }, (_, i) =>
        scaleEventId(`c${i + 1}`),
      );
      expect(activeIds(view)).toEqual(ids);
      expect(view.supersessions).toEqual([]);
      expect(view.overlaps).toEqual([{ target: external(0), eventIds: ids }]);
      expect(view.suppressionTargets).toEqual([
        { target: external(0), byEventIds: ids },
      ]);
    });

    it('treats external event and evidence targets as suppression targets only', () => {
      const view = expectEquivalent(
        scaleHistory([
          spec(1, { target: external(1) }),
          spec(2, {
            target: {
              kind: 'evidence',
              reference: {
                evidenceId: 'evidence_external_1',
                eventId: 'event_external_1',
              },
            },
          }),
          spec(3, { target: external(1) }),
        ]),
        scaleQuery(),
        scaleAsOf(),
      );
      expect(activeIds(view)).toEqual(['event_c1', 'event_c2', 'event_c3']);
      expect(view.supersessions).toEqual([]);
      expect(view.overlaps).toEqual([
        { target: external(1), eventIds: ['event_c1', 'event_c3'] },
      ]);
    });

    it('replays a long chain at every throughSequence and referenceTime boundary sampled', () => {
      const n = 800;
      const history = scaleHistory(
        Array.from({ length: n }, (_, i) =>
          spec(
            i + 1,
            i === 0
              ? {}
              : { target: i % 2 ? toEvent(`c${i}`) : toOwnEvidence(`c${i}`) },
          ),
        ),
      );
      for (const k of [1, 2, 399, 400, 799]) {
        for (const o of [
          scaleAsOf(SCALE_FAR_FUTURE, k),
          scaleAsOf(scaleTime(k), null),
        ]) {
          const view = expectEquivalent(history, scaleQuery(), o);
          expect(view.asOf.lastIncludedSequence).toBe(k);
          expect(activeIds(view)).toEqual([scaleEventId(`c${k}`)]);
          expect(view.inactive).toHaveLength(k - 1);
        }
      }
    });

    it('is deterministic under input reordering for both distributions', () => {
      for (const history of [
        scaleHistory(distributionA(2000)),
        scaleHistory(distributionB(2000, 300)),
      ]) {
        const expected = JSON.stringify(resolve(history));
        for (const seed of [21, 22])
          expect(
            JSON.stringify(
              resolve({ ...history, entries: shuffled(history.entries, seed) }),
            ),
          ).toBe(expected);
      }
    });

    it('returns a deeply frozen view at scale', () => {
      const view = resolve(scaleHistory(distributionB(2000, 300)));
      const stack: unknown[] = [view];
      let objects = 0;
      while (stack.length > 0) {
        const value = stack.pop();
        if (value === null || typeof value !== 'object') continue;
        objects += 1;
        expect(Object.isFrozen(value)).toBe(true);
        stack.push(...Object.values(value));
      }
      expect(objects).toBeGreaterThan(10_000);
    });
  },
);

describe(
  'R2 preserves validation inside large histories',
  { timeout: SCALE_TIMEOUT_MS },
  () => {
    const big = (extra: ScaleSpec[]) =>
      scaleHistory([...distributionA(2000), ...extra]);

    it('still rejects R1 contradictions: self, forward and mispaired references', () => {
      // Self references (event and own evidence).
      invalidHistory(() =>
        resolve(big([spec(2001, { target: toEvent('c2001') })])),
      );
      invalidHistory(() =>
        resolve(big([spec(2001, { target: toOwnEvidence('c2001') })])),
      );
      // Forward references, including to additional evidence.
      invalidHistory(() =>
        resolve(big([spec(2001, { target: toEvent('c2002') }), spec(2002)])),
      );
      invalidHistory(() =>
        resolve(
          big([
            spec(2001, { target: toEvidence('c2002_extra', 'c2002') }),
            spec(2002, { extraEvidence: [scaleEvidenceId('c2002_extra')] }),
          ]),
        ),
      );
      // Known evidence named with the wrong event, and a known event with
      // evidence it does not own.
      invalidHistory(() =>
        resolve(big([spec(2001, { target: toEvidence('c5', 'c6') })])),
      );
      invalidHistory(() =>
        resolve(
          big([
            spec(2001, {
              target: {
                kind: 'evidence',
                reference: {
                  evidenceId: 'evidence_external_9',
                  eventId: 'event_c5',
                },
              },
            }),
          ]),
        ),
      );
      // The valid counterparts resolve.
      expect(() =>
        resolve(big([spec(2001, { target: toEvidence('c5', 'c5') })])),
      ).not.toThrow();
    });

    it('still rejects duplicate, unpaired or mismatched evidence and own-evidence text or time drift', () => {
      const last = (mutate: (entry: ScaleEntry) => void) => {
        const history = big([
          spec(2001, { extraEvidence: [scaleEvidenceId('c2001_extra')] }),
        ]);
        mutate(history.entries.at(-1)!);
        return history;
      };
      const event = (e: ScaleEntry) => e.event as Record<string, any>;
      // Duplicate evidence ID named by the event.
      invalidHistory(() =>
        resolve(
          last((e) => event(e).evidenceIds.push(scaleEvidenceId('c2001'))),
        ),
      );
      // A record the event does not name (same count).
      invalidHistory(() =>
        resolve(
          last((e) => (e.evidence[1]!.id = scaleEvidenceId('c2001_other'))),
        ),
      );
      // A record missing.
      invalidHistory(() => resolve(last((e) => e.evidence.pop())));
      // A record naming an evidence ID already used by another correction.
      invalidHistory(() =>
        resolve(
          last((e) => {
            event(e).evidenceIds[1] = scaleEvidenceId('c7');
            e.evidence[1]!.id = scaleEvidenceId('c7');
          }),
        ),
      );
      // Own evidence text or time drift.
      invalidHistory(() =>
        resolve(
          last(
            (e) => ((e.evidence[0]!.content as any).text = 'Synthetic c2001 '),
          ),
        ),
      );
      invalidHistory(() =>
        resolve(last((e) => (e.evidence[0]!.recordedAt = scaleTime(2002)))),
      );
      // The unmodified history resolves.
      expect(() => resolve(last(() => undefined))).not.toThrow();
    });
  },
);

describe(
  'R2 linkage step does linear work (deterministic read count, not a timer)',
  { timeout: SCALE_TIMEOUT_MS },
  () => {
    type Applicable = Parameters<typeof linkSupersessions>[0][number];

    /** Counts every property read on the array, its items and everything below. */
    function counted(entries: readonly ScaleEntry[]) {
      const reads = { count: 0 };
      const wrap = (value: unknown): unknown =>
        value === null || typeof value !== 'object'
          ? value
          : new Proxy(value, {
              get(target, key, receiver) {
                reads.count += 1;
                return wrap(Reflect.get(target, key, receiver));
              },
            });
      const items = entries.map((entry) => ({
        entry: { sequence: entry.sequence, event: entry.event },
        label: 'current_session',
        origin: { sessionId: S, taskId: null },
      }));
      return {
        reads,
        plain: items as unknown as Applicable[],
        proxied: wrap(items) as Applicable[],
      };
    }

    const cases: [string, readonly ScaleEntry[]][] = [
      [
        'thousands of unlinked corrections',
        scaleHistory(distributionA(6000)).entries,
      ],
      [
        'long chains with branching links',
        scaleHistory(distributionB(6000, 1000)).entries,
      ],
      [
        'unlinked corrections naming external events and permission corrections',
        scaleHistory(
          Array.from({ length: 6000 }, (_, i) =>
            spec(i + 1, {
              target: external(i % 5),
              category: i % 4 === 0 ? 'permission' : 'fact',
            }),
          ),
        ).entries,
      ],
    ];

    for (const [name, entries] of cases)
      it(`reads a bounded number of properties per correction: ${name}`, () => {
        const { reads, plain, proxied } = counted(entries);
        const result = linkSupersessions(proxied);
        expect(result).toEqual(linkSupersessions(plain));
        // A pairwise or nested full scan reads on the order of n^2/2 (here
        // about 18 million) properties; the indexed pass about a dozen per
        // correction.
        expect(reads.count).toBeLessThanOrEqual(30 * entries.length);
        expect(reads.count).toBeGreaterThanOrEqual(entries.length);
      });

    it('links only to earlier items on its own: never itself, a later item, a permission correction or additional evidence', () => {
      // Self and forward links never reach this step through the resolver
      // (R1 validation rejects them); they are fed to it directly here so
      // the linkage step refuses them by itself too.
      const entries = scaleHistory([
        spec(1, { target: toEvent('c1') }),
        spec(2, { target: toOwnEvidence('c2') }),
        spec(3, { target: toEvent('c4') }),
        spec(4, {
          target: toOwnEvidence('c5'),
          extraEvidence: [scaleEvidenceId('c4_extra')],
        }),
        spec(5),
        spec(6, { category: 'permission' }),
        spec(7, { target: toEvent('c6') }),
        spec(8, { target: toEvidence('c4_extra', 'c4') }),
        spec(9, { target: toOwnEvidence('c5') }),
        spec(10, { category: 'permission', target: toEvent('c9') }),
      ]).entries;
      expect([...linkSupersessions(counted(entries).plain)]).toEqual([
        ['event_c5', ['event_c9']],
      ]);
    });
  },
);

describe('R2 stays pure at scale', { timeout: SCALE_TIMEOUT_MS }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads no clock, randomness, timer or network while resolving a large history', () => {
    const history = scaleHistory(distributionB(3000, 500));
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis.crypto, 'randomUUID'),
    ];
    const view = resolve(history);
    expect(view.supersessions.length).toBeGreaterThan(0);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    // The input is not mutated.
    expect(JSON.stringify(history)).toBe(
      JSON.stringify(scaleHistory(distributionB(3000, 500))),
    );
  });

  it('owner-scopes the history: a foreign-owner query is refused', () => {
    invalidHistory(() =>
      resolve(scaleHistory(distributionA(100)), {
        ...scaleQuery(),
        ownerId: 'owner_other',
      }),
    );
    expect(SCALE_OWNER).toBe('owner_scale');
  });
});
