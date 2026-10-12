import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as c from '@aven/contracts';
import {
  ContextBrokerError,
  CONTEXT_BROKER_ERROR_CODES,
  createContextBroker,
  MAX_RAW_ITEMS_PER_SOURCE,
  MAX_RAW_ITEMS_TOTAL,
  MAX_SOURCES,
  type ContextCandidate,
  type ContextSource,
  type TraceCandidate,
} from '@aven/context-broker';
import { createLedger, type LedgerError } from '@aven/ledger';
import { openStorage, type Storage } from '@aven/storage';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  assembleWithCorrections,
  CORRECTION_INSTRUCTION_SOURCE_ID,
  type CorrectionAssemblyOutcome,
} from '../src/context-source/index.ts';
import {
  CORRECTION_ERROR_CODES,
  CorrectionError,
  resolveImmediateCorrections,
  type CorrectionErrorCode,
} from '../src/index.ts';
import {
  buildCorrectionEvidenceIndex,
  readCorrectionHistory,
  recordOwnerCorrection,
} from '../src/ledger/index.ts';
import {
  A,
  ASK,
  B,
  BINDINGS,
  buildScenario,
  comparable,
  directCorrection,
  evidenceCandidate,
  LEDGER_EPOCH_MS,
  logicalState,
  named,
  occurred,
  ordinary,
  OTHER_TASK,
  pipeline,
  REFERENCE_TIME,
  scenarioRequest,
  scenarioSources,
  SECOND_SESSION,
  SECOND_TASK,
  SESSION,
  stateCandidate,
  staticSource,
  TASK,
  TEXT,
  totalChanges,
} from './cross-layer-fixtures.ts';
import { observed, submission, world } from './recorder-fixtures.ts';

/*
 * AVEN-010 patch 7: CROSS-LAYER validation of the accepted pipeline
 *
 *   recordOwnerCorrection -> frozen append-only Ledger (real SQLite)
 *   -> readCorrectionHistory -> buildCorrectionEvidenceIndex
 *   -> resolveImmediateCorrections -> assembleWithCorrections
 *   -> frozen AVEN-008 Context Broker -> verified selected ContextBundle
 *
 * Every owner, session, task, identifier, time and text is SYNTHETIC. The
 * Ledger recording clock is fixed with a fake `Date` while writing, so every
 * stored timestamp is deterministic. These are mechanics tests of recording,
 * replay, resolution, selection and verification: no model consumes any
 * bundle, and nothing here is an experiment result.
 */

type Json = Record<string, unknown>;
type Exposed = Extract<CorrectionAssemblyOutcome, { status: 'exposed' }>;
type NotExposed = Extract<CorrectionAssemblyOutcome, { status: 'not_exposed' }>;

const INSTRUCTION = CORRECTION_INSTRUCTION_SOURCE_ID;
const scratch = mkdtempSync(join(tmpdir(), 'aven-p7-cross-layer-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const dbFile = (tag: string) => join(scratch, `${tag}-${++counter}.sqlite`);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const replayScript = fileURLToPath(
  new URL('./cross-layer-replay.ts', import.meta.url),
);

/** Deterministic Ledger recording time of write step `n`. */
const at = (n: number) => new Date(LEDGER_EPOCH_MS + n * 60_000).toISOString();

/** Runs `fn` with the Ledger's recording clock fixed (fake `Date` only). */
function clocked<T>(fn: (tick: (step: number) => void) => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    return fn((step) => vi.setSystemTime(LEDGER_EPOCH_MS + step * 60_000));
  } finally {
    vi.useRealTimers();
  }
}

const scenarioDb = (filename = dbFile('scenario')) =>
  clocked((tick) => buildScenario(filename, tick));

/** A small world whose writes each advance the fixed clock by one minute. */
function smallWorld(filename = ':memory:') {
  let step = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LEDGER_EPOCH_MS);
  let storage: Storage;
  try {
    storage = world(filename);
  } finally {
    vi.useRealTimers();
  }
  const write = <T>(fn: () => T): T => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LEDGER_EPOCH_MS + ++step * 60_000);
    try {
      return fn();
    } finally {
      vi.useRealTimers();
    }
  };
  const record = (name: string, over: Json, owner = A) =>
    write(() =>
      recordOwnerCorrection(
        storage,
        submission({
          ownerId: owner,
          originalBehavior: `${TEXT.originalPrefix} ${name}`,
          correctedInstruction: `Synthetic ${name}: quarterly report rule.`,
          ...over,
        }),
        named(name, occurred(step)),
      ),
    );
  return { storage, write, record };
}

const oracleCandidateId = (
  owner: string,
  sessionId: string,
  taskId: string,
  eventId: string,
  evidenceId: string,
) =>
  `correction:${createHash('sha256')
    .update(
      JSON.stringify([
        'aven-010-correction-instruction-id-v1',
        owner,
        sessionId,
        taskId,
        eventId,
        evidenceId,
      ]),
      'utf8',
    )
    .digest('hex')}`;

function exposed(outcome: CorrectionAssemblyOutcome): Exposed {
  expect(outcome.status).toBe('exposed');
  return outcome as Exposed;
}
function notExposed(outcome: CorrectionAssemblyOutcome): NotExposed {
  expect(outcome.status).toBe('not_exposed');
  expect(outcome).not.toHaveProperty('bundle');
  return outcome as NotExposed;
}
const instructionTexts = (o: Exposed) =>
  o.bundle.items.filter((i) => i.sourceId === INSTRUCTION).map((i) => i.text);
/** Every traced candidate as `sourceId/candidateId -> exclusion reason`. */
const exclusions = (trace: { candidates: readonly TraceCandidate[] }) =>
  Object.fromEntries(
    trace.candidates.map((t) => [
      `${t.sourceId}/${t.candidateId}`,
      t.exclusionReason,
    ]),
  );
const traced = (
  o: { trace: { candidates: readonly TraceCandidate[] } | null },
  id: string,
) => o.trace!.candidates.find((t) => t.candidateId === id)!;

const FORBIDDEN_IN_ERRORS = [
  'event_',
  'evidence_',
  'owner_',
  'session_',
  'task_',
  'Synthetic',
  'SELECT',
  'sqlite',
  'SQLITE',
  scratch,
];

/** A fixed CorrectionError: exact code, fixed message, no cause, no leak. */
function fixedError(caught: unknown, code: CorrectionErrorCode) {
  expect(caught).toBeInstanceOf(CorrectionError);
  const error = caught as CorrectionError;
  expect(error.code).toBe(code);
  expect('cause' in error).toBe(false);
  expect(Object.keys(JSON.parse(JSON.stringify(error)) as Json)).toEqual([
    'name',
    'code',
    'message',
  ]);
  expect(error.message).toBe(new CorrectionError(code).message);
  for (const text of FORBIDDEN_IN_ERRORS)
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(text);
}
function expectSyncError(fn: () => unknown, code: CorrectionErrorCode) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  fixedError(caught, code);
}
async function expectAsyncError(
  fn: () => Promise<unknown>,
  code: CorrectionErrorCode,
) {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  fixedError(caught, code);
}

const SOURCE_REF = { evidenceId: 'evidence_source', eventId: 'event_source' };
const LEARNED = { learnedItemId: 'learned_synthetic', version: 1 };

/** The scenario's resolved corrections, independently written out. */
const resolvedFixture = {
  c1: {
    sequence: 4,
    eventId: 'event_c1',
    evidence: { evidenceId: 'evidence_c1', eventId: 'event_c1' },
    recordedAt: at(1),
    category: 'communication',
    applicability: 'current_task',
    origin: { sessionId: SESSION, taskId: TASK },
    target: { kind: 'evidence', reference: SOURCE_REF },
  },
  c2: {
    sequence: 6,
    eventId: 'event_c2',
    evidence: { evidenceId: 'evidence_c2', eventId: 'event_c2' },
    recordedAt: at(3),
    category: 'preference',
    applicability: 'current_session',
    origin: { sessionId: SESSION, taskId: TASK },
    target: { kind: 'owner_state', reference: LEARNED },
  },
  c3: {
    sequence: 7,
    eventId: 'event_c3',
    evidence: { evidenceId: 'evidence_c3', eventId: 'event_c3' },
    recordedAt: at(4),
    category: 'fact',
    applicability: 'unspecified_origin_task',
    origin: { sessionId: SESSION, taskId: OTHER_TASK },
    target: { kind: 'unidentified', description: 'Synthetic: the deadline' },
  },
  c4: {
    sequence: 8,
    eventId: 'event_c4',
    evidence: { evidenceId: 'evidence_c4', eventId: 'event_c4' },
    recordedAt: at(5),
    category: 'permission',
    applicability: 'current_session',
    origin: { sessionId: SESSION, taskId: TASK },
    target: { kind: 'unidentified', description: 'Synthetic: sending email' },
  },
  c5: {
    sequence: 10,
    eventId: 'event_c5',
    evidence: { evidenceId: 'evidence_c5', eventId: 'event_c5' },
    recordedAt: at(7),
    category: 'procedure',
    applicability: 'current_task',
    origin: { sessionId: SESSION, taskId: TASK },
    target: { kind: 'event', eventId: 'event_c3' },
  },
  c6: {
    sequence: 11,
    eventId: 'event_c6',
    evidence: { evidenceId: 'evidence_c6', eventId: 'event_c6' },
    recordedAt: at(8),
    category: 'communication',
    applicability: 'current_task',
    origin: { sessionId: SESSION, taskId: TASK },
    target: {
      kind: 'evidence',
      reference: { evidenceId: 'evidence_c1', eventId: 'event_c1' },
    },
  },
  c7: {
    sequence: 12,
    eventId: 'event_c7',
    evidence: { evidenceId: 'evidence_c7', eventId: 'event_c7' },
    recordedAt: at(9),
    category: 'communication',
    applicability: 'current_task',
    origin: { sessionId: SESSION, taskId: TASK },
    target: {
      kind: 'evidence',
      reference: { evidenceId: 'evidence_c5_note', eventId: 'event_c5' },
    },
  },
} as const;
const activeFixture = (name: keyof typeof resolvedFixture) => ({
  ...resolvedFixture[name],
  correctedInstruction: TEXT[name],
});

/** Scenario sources plus one owner-A candidate citing c5's supporting evidence. */
const C5_NOTE = evidenceCandidate(
  A,
  'base-evidence-c5-note',
  { evidenceId: 'evidence_c5_note', eventId: 'event_c5' },
  'Synthetic owner-alpha quarterly report appendix note',
);
const withNote = () => [
  ...scenarioSources(),
  staticSource('notes', 'episode_history', [C5_NOTE]),
];

describe('cross-layer: real file-backed SQLite, end to end', () => {
  it('records, replays, indexes, resolves and exposes the scenario with exact expected values', async () => {
    const { storage, scenario } = scenarioDb();
    try {
      // --- Ledger: owner-local sequences with gaps, exact stored records.
      const ledger = createLedger(storage, c.OwnerIdSchema.parse(A));
      expect(
        ['event_unrelated_one', 'event_unrelated_two'].map(
          (id) => ledger.getEvent(c.EventIdSchema.parse(id))!.sequence,
        ),
      ).toEqual([5, 9]);
      const history = readCorrectionHistory(storage, A);
      expect(history.ownerId).toBe(A);
      expect(history.entries.map((e) => e.sequence)).toEqual([
        4, 6, 7, 8, 10, 11, 12,
      ]);
      const events = history.entries.map((e) => e.event as c.ExperienceEvent);
      expect(events.map((e) => e.id)).toEqual([
        'event_c1',
        'event_c2',
        'event_c3',
        'event_c4',
        'event_c5',
        'event_c6',
        'event_c7',
      ]);
      expect(events.map((e) => e.recordedAt)).toEqual(
        [1, 3, 4, 5, 7, 8, 9].map(at),
      );
      // Occurrence time runs against sequence; sequence alone orders.
      expect(Date.parse(events[0]!.occurredAt)).toBeGreaterThan(
        Date.parse(events[3]!.occurredAt),
      );
      const payload = (e: c.ExperienceEvent) =>
        (e as Extract<c.ExperienceEvent, { eventType: 'owner_correction' }>)
          .payload;
      expect(events.map((e) => payload(e).correctedInstruction)).toEqual([
        TEXT.c1,
        TEXT.c2,
        TEXT.c3,
        TEXT.c4,
        TEXT.c5,
        TEXT.c6,
        TEXT.c7,
      ]);
      // The original behavior is preserved exactly as recorded.
      expect(events.map((e) => payload(e).originalBehavior)).toEqual([
        `${TEXT.originalPrefix} the draft of c1`,
        `${TEXT.originalPrefix} the draft of c2`,
        `${TEXT.originalPrefix} the draft of c3`,
        `${TEXT.originalPrefix} the draft of c4`,
        'Synthetic original behavior of c5',
        `${TEXT.originalPrefix} the draft of c6`,
        `${TEXT.originalPrefix} the draft of c7`,
      ]);
      const c5 = history.entries[4]!;
      expect(
        c5.evidence.map((r) => {
          const e = r as c.EvidenceRecord;
          return [e.id, e.eventId, e.content, e.recordedAt];
        }),
      ).toEqual([
        [
          'evidence_c5',
          'event_c5',
          { kind: 'recorded_text', text: TEXT.c5 },
          at(7),
        ],
        [
          'evidence_c5_note',
          'event_c5',
          { kind: 'recorded_text', text: 'Synthetic supporting note 1' },
          at(7),
        ],
      ]);
      expect(scenario.a.c5.sequence).toBe(10);

      // --- Index: exact identities, own versus supporting.
      const index = buildCorrectionEvidenceIndex(history);
      expect(index.corrections).toEqual(
        (['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] as const).map((n) => ({
          eventId: `event_${n}`,
          sequence: resolvedFixture[n].sequence,
          ownEvidenceId: `evidence_${n}`,
          supportingEvidenceIds: n === 'c5' ? ['evidence_c5_note'] : [],
        })),
      );
      expect(index.evidence('evidence_c5_note')).toEqual({
        evidenceId: 'evidence_c5_note',
        eventId: 'event_c5',
        sequence: 10,
        role: 'supporting',
      });
      expect(index.evidence('evidence_c6')!.role).toBe('own');
      // Ordinary Ledger evidence is not correction evidence.
      expect(index.evidence('evidence_source')).toBeUndefined();
      expect(index.evidence('evidence_unrelated_one')).toBeUndefined();

      // --- Resolution, for every binding.
      const view = (sessionId: string, taskId: string) =>
        resolveImmediateCorrections(
          history,
          { ownerId: A, sessionId, taskId },
          { referenceTime: REFERENCE_TIME, throughSequence: null },
        );
      const task = view(SESSION, TASK);
      expect(task.asOf).toEqual({
        referenceTime: REFERENCE_TIME,
        throughSequence: null,
        lastIncludedSequence: 12,
      });
      expect(task.active).toEqual(
        (['c2', 'c5', 'c6', 'c7'] as const).map(activeFixture),
      );
      expect(task.inactive).toEqual([
        {
          ...resolvedFixture.c1,
          reason: 'superseded_by_correction',
          supersededBy: ['event_c6'],
        },
        { ...resolvedFixture.c4, reason: 'deferred_to_root', supersededBy: [] },
      ]);
      expect(task.supersessions).toEqual([
        { supersededEventId: 'event_c1', byEventId: 'event_c6' },
      ]);
      expect(task.overlaps).toEqual([]);
      expect(task.suppressionTargets).toEqual([
        { target: resolvedFixture.c2.target, byEventIds: ['event_c2'] },
        { target: resolvedFixture.c5.target, byEventIds: ['event_c5'] },
        { target: resolvedFixture.c6.target, byEventIds: ['event_c6'] },
        { target: resolvedFixture.c7.target, byEventIds: ['event_c7'] },
      ]);
      const sibling = view(SESSION, OTHER_TASK);
      expect(sibling.active).toEqual(
        (['c2', 'c3'] as const).map(activeFixture),
      );
      expect(sibling.inactive).toEqual([
        { ...resolvedFixture.c4, reason: 'deferred_to_root', supersededBy: [] },
      ]);
      expect(sibling.supersessions).toEqual([]);
      expect(sibling.suppressionTargets).toEqual([
        { target: resolvedFixture.c2.target, byEventIds: ['event_c2'] },
      ]);
      const other = view(SECOND_SESSION, SECOND_TASK);
      expect([other.active, other.inactive, other.suppressionTargets]).toEqual([
        [],
        [],
        [],
      ]);
      expect(other.asOf.lastIncludedSequence).toBe(12);

      // --- Assembly through the real Broker, verified.
      const run = async (sessionId: string, taskId: string) =>
        exposed(
          await assembleWithCorrections({
            history,
            request: scenarioRequest(A, sessionId, taskId),
            sources: withNote(),
            throughSequence: null,
          }),
        );
      const id = (sessionId: string, taskId: string, n: keyof typeof TEXT) =>
        oracleCandidateId(A, sessionId, taskId, `event_${n}`, `evidence_${n}`);
      const t = await run(SESSION, TASK);
      expect(t.exposed).toEqual(
        (['c2', 'c5', 'c6', 'c7'] as const).map((n) => ({
          correctionEventId: `event_${n}`,
          evidenceId: `evidence_${n}`,
          candidateId: id(SESSION, TASK, n),
        })),
      );
      const c6Item = t.bundle.items.find(
        (i) => i.candidateId === id(SESSION, TASK, 'c6'),
      )!;
      expect({
        sourceId: c6Item.sourceId,
        sourceKind: c6Item.sourceKind,
        reference: c6Item.reference,
        provenance: c6Item.provenance,
        scope: c6Item.scope,
        recordedAt: c6Item.recordedAt,
        text: c6Item.text,
        truncated: c6Item.truncated,
      }).toEqual({
        sourceId: INSTRUCTION,
        sourceKind: 'active_task',
        reference: {
          kind: 'current_instruction',
          evidence: { evidenceId: 'evidence_c6', eventId: 'event_c6' },
          task: { sessionId: SESSION, taskId: TASK },
        },
        provenance: {
          kind: 'explicit_owner_correction',
          ownerId: A,
          sourceEventId: 'event_c6',
        },
        scope: { kind: 'bounded', taskId: TASK },
        recordedAt: at(8),
        text: TEXT.c6,
        truncated: false,
      });
      expect([...instructionTexts(t)].sort()).toEqual(
        [TEXT.c2, TEXT.c5, TEXT.c6, TEXT.c7].sort(),
      );
      expect(exclusions(t.trace)).toEqual({
        [`${INSTRUCTION}/${id(SESSION, TASK, 'c2')}`]: null,
        [`${INSTRUCTION}/${id(SESSION, TASK, 'c5')}`]: null,
        [`${INSTRUCTION}/${id(SESSION, TASK, 'c6')}`]: null,
        [`${INSTRUCTION}/${id(SESSION, TASK, 'c7')}`]: null,
        'episodes/base-evidence-source': null,
        'episodes/base-evidence-unrelated': null,
        'notes/base-evidence-c5-note': 'negative_signal_suppressed',
        'state/base-state-v1': 'negative_signal_suppressed',
        'state/base-state-v2': null,
      });
      const s = await run(SESSION, OTHER_TASK);
      expect(s.exposed.map((e) => e.correctionEventId)).toEqual([
        'event_c2',
        'event_c3',
      ]);
      expect(exclusions(s.trace)).toEqual({
        [`${INSTRUCTION}/${id(SESSION, OTHER_TASK, 'c2')}`]: null,
        [`${INSTRUCTION}/${id(SESSION, OTHER_TASK, 'c3')}`]: null,
        'episodes/base-evidence-source': null,
        'episodes/base-evidence-unrelated': null,
        'notes/base-evidence-c5-note': null,
        'state/base-state-v1': 'negative_signal_suppressed',
        'state/base-state-v2': null,
      });
      // The same correction gets a different candidate per requesting task.
      expect(id(SESSION, TASK, 'c2')).not.toBe(id(SESSION, OTHER_TASK, 'c2'));
      const o = await run(SECOND_SESSION, SECOND_TASK);
      expect(o.exposed).toEqual([]);
      expect(Object.values(exclusions(o.trace))).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      // Nothing of owner B and nothing of any original behavior or
      // permission correction text is ever selected or traced for owner A.
      for (const outcome of [t, s, o]) {
        const json = JSON.stringify(outcome);
        for (const leak of [
          'owner-beta',
          TEXT.b1,
          TEXT.b2,
          TEXT.originalPrefix,
          'Synthetic original behavior',
          TEXT.c4,
          B,
        ])
          expect(json).not.toContain(leak);
      }
      // Owner B's history is its own, with the same identifier text.
      const historyB = readCorrectionHistory(storage, B);
      expect(
        historyB.entries.map((e) => [
          e.sequence,
          (e.event as c.ExperienceEvent).id,
          (e.event as c.ExperienceEvent).ownerId,
        ]),
      ).toEqual([
        [13, 'event_c1', B],
        [14, 'event_c2', B],
      ]);
      const b = exposed(
        (await pipeline(storage, B, SESSION, TASK, withNote())).outcome,
      );
      expect([...instructionTexts(b)].sort()).toEqual(
        [TEXT.b1, TEXT.b2].sort(),
      );
      expect(JSON.stringify(b)).not.toContain('owner-alpha');
      expect(JSON.stringify(b)).not.toContain('Synthetic C');
    } finally {
      storage.close();
    }
  });

  it('is deterministic: two independent databases and repeated runs give byte-identical results', async () => {
    const first = scenarioDb();
    const second = scenarioDb();
    try {
      for (const owner of [A, B])
        for (const [sessionId, taskId] of BINDINGS) {
          const one = comparable(
            await pipeline(first.storage, owner, sessionId, taskId),
          );
          const again = comparable(
            await pipeline(first.storage, owner, sessionId, taskId),
          );
          const two = comparable(
            await pipeline(second.storage, owner, sessionId, taskId),
          );
          expect(again).toBe(one);
          expect(two).toBe(one);
        }
      expect(logicalState(first.storage)).toEqual(logicalState(second.storage));
    } finally {
      first.storage.close();
      second.storage.close();
    }
  });

  it('carries a chain across three replay pages to the one exposed instruction', async () => {
    const w = smallWorld(dbFile('pages'));
    try {
      let previous = w.record('chain1', {});
      for (let i = 2; i <= 230; i += 1) {
        previous = w.record(`chain${i}`, {
          target:
            i % 2 === 0
              ? { kind: 'event', eventId: previous.eventId }
              : {
                  kind: 'evidence',
                  reference: {
                    evidenceId: previous.evidenceId,
                    eventId: previous.eventId,
                  },
                },
        });
        if (i % 50 === 0) w.write(() => ordinary(w.storage, A, `gap${i}`));
      }
      const { storage: watched, calls } = observed(w.storage);
      const r = await pipeline(watched, A, SESSION, TASK, []);
      expect(
        calls.filter((call) =>
          /^SELECT sequence, record_json FROM experience_events WHERE/.test(
            call.sql,
          ),
        ).length,
      ).toBe(3); // 230 corrections: pages of 100, 100 and 30
      expect(r.history.entries).toHaveLength(230);
      expect(r.view.active.map((a) => a.eventId)).toEqual([previous.eventId]);
      expect(r.view.inactive).toHaveLength(229);
      expect(exposed(r.outcome).exposed).toEqual([
        {
          correctionEventId: previous.eventId,
          evidenceId: previous.evidenceId,
          candidateId: oracleCandidateId(
            A,
            SESSION,
            TASK,
            previous.eventId,
            previous.evidenceId,
          ),
        },
      ]);
      expect(instructionTexts(exposed(r.outcome))).toEqual([
        'Synthetic chain230: quarterly report rule.',
      ]);
    } finally {
      w.storage.close();
    }
  }, 120_000);
});

describe('cross-layer: scope and supersession through the real Ledger (A-M)', () => {
  it('A-D, G, K: scenario scope, own-evidence supersession and supporting-evidence references', async () => {
    const { storage } = scenarioDb();
    try {
      const active = async (owner: string, sessionId: string, taskId: string) =>
        (await pipeline(storage, owner, sessionId, taskId)).view.active.map(
          (a) => a.eventId,
        );
      // A. current_task corrections (c5, c6, c7) reach their exact task only.
      expect(await active(A, SESSION, TASK)).toEqual([
        'event_c2',
        'event_c5',
        'event_c6',
        'event_c7',
      ]);
      // B. current_session (c2) reaches the sibling task; D. unspecified (c3)
      // applies only to its origin task, OTHER_TASK.
      expect(await active(A, SESSION, OTHER_TASK)).toEqual([
        'event_c2',
        'event_c3',
      ]);
      // C. current_session never crosses into another session.
      expect(await active(A, SECOND_SESSION, SECOND_TASK)).toEqual([]);
      const view = (await pipeline(storage, A, SESSION, TASK)).view;
      // G. c6 names c1's exact own evidence: c1 is superseded.
      expect(view.supersessions).toEqual([
        { supersededEventId: 'event_c1', byEventId: 'event_c6' },
      ]);
      // K. c7 names c5's SUPPORTING evidence: c5 stays active.
      expect(view.active.map((a) => a.eventId)).toContain('event_c5');
      // D4: c5 names c3's event, but c3 is not applicable to TASK and c5 is
      // not applicable to OTHER_TASK: no supersession in either scope.
      const sibling = (await pipeline(storage, A, SESSION, OTHER_TASK)).view;
      expect(sibling.supersessions).toEqual([]);
      expect(sibling.active.map((a) => a.eventId)).toContain('event_c3');
    } finally {
      storage.close();
    }
  });

  it('E. an unspecified correction with no origin task is recorded but has no effect anywhere', async () => {
    const w = smallWorld();
    const e = w.write(() =>
      directCorrection(w.storage, A, {
        name: 'e1',
        instruction: 'Synthetic E1: quarterly report without origin.',
        applicability: { kind: 'unspecified' },
        envelope: null,
        target: { kind: 'evidence', reference: SOURCE_REF },
      }),
    );
    const history = readCorrectionHistory(w.storage, A);
    expect(history.entries.map((x) => x.sequence)).toEqual([e.sequence]);
    for (const [sessionId, taskId] of BINDINGS) {
      const r = await pipeline(
        w.storage,
        A,
        sessionId,
        taskId,
        scenarioSources(),
      );
      expect([
        r.view.active,
        r.view.inactive,
        r.view.suppressionTargets,
      ]).toEqual([[], [], []]);
      const o = exposed(r.outcome);
      expect(o.exposed).toEqual([]);
      expect(traced(o, 'base-evidence-source').signals.negativeRetrieval).toBe(
        0,
      );
    }
  });

  it('F, H, I. explicit event and own-evidence links chain, branch and never resurrect', async () => {
    const w = smallWorld();
    const h1 = w.record('h1', {
      target: { kind: 'evidence', reference: SOURCE_REF },
    });
    const h2 = w.record('h2', {
      target: { kind: 'event', eventId: h1.eventId },
    });
    const h3 = w.record('h3', {
      target: {
        kind: 'evidence',
        reference: { evidenceId: h2.evidenceId, eventId: h2.eventId },
      },
    });
    const h4 = w.record('h4', {
      target: { kind: 'event', eventId: h1.eventId },
    });
    const r = await pipeline(w.storage, A, SESSION, TASK, scenarioSources());
    expect(r.view.active.map((a) => a.eventId)).toEqual([
      h3.eventId,
      h4.eventId,
    ]);
    expect(
      r.view.inactive.map((i) => [i.eventId, i.reason, i.supersededBy]),
    ).toEqual([
      [h1.eventId, 'superseded_by_correction', [h2.eventId, h4.eventId]],
      [h2.eventId, 'superseded_by_correction', [h3.eventId]],
    ]);
    // I. h1 stays superseded although h2 is itself superseded; its target
    // (event_source evidence) is no longer suppressed.
    const o = exposed(r.outcome);
    expect(o.exposed.map((e) => e.correctionEventId)).toEqual([
      h3.eventId,
      h4.eventId,
    ]);
    expect(traced(o, 'base-evidence-source').signals.negativeRetrieval).toBe(0);
    expect(traced(o, 'base-evidence-source').exclusionReason).toBeNull();
    expect(instructionTexts(o)).not.toContain(
      'Synthetic h1: quarterly report rule.',
    );
  });

  it('J. several active corrections with one exact target all stay active, overlap is exposed, nothing is chosen', async () => {
    const w = smallWorld();
    const j1 = w.record('j1', {
      category: 'preference',
      target: { kind: 'owner_state', reference: LEARNED },
      correctedInstruction: 'Synthetic J1: quarterly report in a table.',
    });
    const j2 = w.record('j2', {
      category: 'preference',
      target: { kind: 'owner_state', reference: LEARNED },
      correctedInstruction: 'Synthetic J2: quarterly report as prose.',
    });
    const r = await pipeline(w.storage, A, SESSION, TASK, scenarioSources());
    expect(r.view.active.map((a) => a.eventId)).toEqual([
      j1.eventId,
      j2.eventId,
    ]);
    expect(r.view.supersessions).toEqual([]);
    expect(r.view.overlaps).toEqual([
      {
        target: { kind: 'owner_state', reference: LEARNED },
        eventIds: [j1.eventId, j2.eventId],
      },
    ]);
    expect(r.view.suppressionTargets).toEqual([
      {
        target: { kind: 'owner_state', reference: LEARNED },
        byEventIds: [j1.eventId, j2.eventId],
      },
    ]);
    const o = exposed(r.outcome);
    expect([...instructionTexts(o)].sort()).toEqual([
      'Synthetic J1: quarterly report in a table.',
      'Synthetic J2: quarterly report as prose.',
    ]);
    expect(traced(o, 'base-state-v1').exclusionReason).toBe(
      'negative_signal_suppressed',
    );
  });

  it('L. a correction after the as-of boundary never changes an earlier result', async () => {
    const filename = dbFile('as-of');
    const w = smallWorld(filename);
    try {
      const l1 = w.record('l1', {
        target: { kind: 'evidence', reference: SOURCE_REF },
      });
      w.write(() => ordinary(w.storage, A, 'gap'));
      const l2 = w.record('l2', {
        category: 'preference',
        immediateApplicability: 'current_session',
        target: { kind: 'owner_state', reference: LEARNED },
      });
      const boundaryTime = l2.recordedAt;
      const early = await Promise.all(
        BINDINGS.map(([s, t]) =>
          pipeline(w.storage, A, s, t, scenarioSources(), null, boundaryTime),
        ),
      );
      // Later corrections: one supersedes l1, one supersedes l2 by own
      // evidence, one adds a new instruction.
      const l3 = w.record('l3', {
        target: { kind: 'event', eventId: l1.eventId },
      });
      w.record('l4', {
        immediateApplicability: 'current_session',
        target: {
          kind: 'evidence',
          reference: { evidenceId: l2.evidenceId, eventId: l2.eventId },
        },
      });
      w.record('l5', { taskId: OTHER_TASK });
      for (const [i, [s, t]] of BINDINGS.entries()) {
        // Same reference time: identical history-dependent results.
        const later = await pipeline(
          w.storage,
          A,
          s,
          t,
          scenarioSources(),
          null,
          boundaryTime,
        );
        expect(JSON.stringify(later.view)).toBe(JSON.stringify(early[i]!.view));
        expect(JSON.stringify(later.outcome)).toBe(
          JSON.stringify(early[i]!.outcome),
        );
        // Same sequence boundary at the later reference time: the same
        // corrections and the same bundle.
        const bySequence = await pipeline(
          w.storage,
          A,
          s,
          t,
          scenarioSources(),
          l2.sequence,
        );
        expect(bySequence.view.asOf.lastIncludedSequence).toBe(l2.sequence);
        expect(JSON.stringify(bySequence.view.active)).toBe(
          JSON.stringify(early[i]!.view.active),
        );
        expect(JSON.stringify(bySequence.view.suppressionTargets)).toBe(
          JSON.stringify(early[i]!.view.suppressionTargets),
        );
      }
      const early0 = exposed(early[0]!.outcome);
      expect(early0.exposed.map((e) => e.correctionEventId)).toEqual([
        l1.eventId,
        l2.eventId,
      ]);
      expect(traced(early0, 'base-evidence-source').exclusionReason).toBe(
        'negative_signal_suppressed',
      );
      // Without a boundary the later corrections apply.
      const now = await pipeline(
        w.storage,
        A,
        SESSION,
        TASK,
        scenarioSources(),
      );
      expect(now.view.active.map((a) => a.eventId)).toEqual([
        l3.eventId,
        'event_l4',
      ]);
    } finally {
      w.storage.close();
    }
  });

  it('M. a permission correction is deferred to Root: never active, never exposed, never suppresses or supersedes, writes nothing', async () => {
    const w = smallWorld();
    const p0 = w.record('p0', {
      target: { kind: 'unidentified', description: 'Synthetic: the summary' },
    });
    const p1 = w.record('p1', {
      category: 'permission',
      target: { kind: 'evidence', reference: SOURCE_REF },
      correctedInstruction:
        'Synthetic P1: you may publish the quarterly report.',
    });
    const p2 = w.record('p2', {
      category: 'permission',
      target: { kind: 'event', eventId: p0.eventId },
      correctedInstruction:
        'Synthetic P2: you may delete the quarterly report.',
    });
    const p3 = w.record('p3', {
      category: 'permission',
      immediateApplicability: 'current_session',
      target: { kind: 'owner_state', reference: LEARNED },
      correctedInstruction: 'Synthetic P3: you may share the quarterly report.',
    });
    const before = logicalState(w.storage);
    const changes = totalChanges(w.storage);
    for (const taskId of [TASK, OTHER_TASK]) {
      const r = await pipeline(
        w.storage,
        A,
        SESSION,
        taskId,
        scenarioSources(),
      );
      const permissions = taskId === TASK ? [p1, p2, p3] : [p3];
      expect(r.view.inactive).toEqual(
        permissions.map((p) =>
          expect.objectContaining({
            eventId: p.eventId,
            category: 'permission',
            reason: 'deferred_to_root',
            supersededBy: [],
          }),
        ),
      );
      expect(r.view.supersessions).toEqual([]);
      expect(r.view.suppressionTargets).toEqual([]);
      const o = exposed(r.outcome);
      expect(o.exposed.map((e) => e.correctionEventId)).toEqual(
        taskId === TASK ? [p0.eventId] : [],
      );
      for (const id of ['base-evidence-source', 'base-state-v1']) {
        expect(traced(o, id).signals.negativeRetrieval).toBe(0);
        expect(traced(o, id).exclusionReason).toBeNull();
      }
      const json = JSON.stringify(o);
      for (const p of [p1, p2, p3]) expect(json).not.toContain(p.eventId);
      expect(json).not.toContain('you may');
    }
    // Recording a permission correction created no approval, policy,
    // lifecycle or owner-state record, and reading changed nothing at all.
    for (const table of [
      'owner_approvals',
      'policy_decisions',
      'lifecycle_records',
      'learned_owner_state',
    ])
      expect(
        before.rows[table]!.filter((row) => row.includes('event_p1')),
      ).toEqual([]);
    expect(before.rows['owner_approvals']).toEqual([]);
    expect(before.rows['policy_decisions']).toEqual([]);
    expect(logicalState(w.storage)).toEqual(before);
    expect(totalChanges(w.storage)).toBe(changes);
  });
});

describe('cross-layer: owner and evidence integrity', () => {
  it('keeps owners apart when every identifier text is shared, and refuses cross-owner reads', async () => {
    const { storage } = scenarioDb();
    try {
      const a = readCorrectionHistory(storage, A);
      const b = readCorrectionHistory(storage, B);
      expect(JSON.stringify(a)).not.toContain(B);
      expect(JSON.stringify(b)).not.toContain(`"${A}"`);
      // A's history with B's request (or the reverse) is refused, never mixed.
      await expectAsyncError(
        () =>
          assembleWithCorrections({
            history: a,
            request: scenarioRequest(B, SESSION, TASK),
            sources: [],
            throughSequence: null,
          }),
        'invalid_correction_history',
      );
      expectSyncError(
        () =>
          resolveImmediateCorrections(
            b,
            { ownerId: A, sessionId: SESSION, taskId: TASK },
            { referenceTime: REFERENCE_TIME, throughSequence: null },
          ),
        'invalid_correction_history',
      );
      // Each owner's index holds only its own identities.
      expect(buildCorrectionEvidenceIndex(b).evidence('evidence_c5_note')).toBe(
        undefined,
      );
      expect(
        buildCorrectionEvidenceIndex(b).correction('event_c1')!.sequence,
      ).toBe(13);
      expect(
        buildCorrectionEvidenceIndex(a).correction('event_c1')!.sequence,
      ).toBe(4);
    } finally {
      storage.close();
    }
  });

  it('refuses duplicate correction and evidence identities at recording, changing nothing', () => {
    const { storage } = scenarioDb();
    try {
      const before = logicalState(storage);
      expectSyncError(
        () =>
          recordOwnerCorrection(
            storage,
            submission({ correctedInstruction: 'Synthetic duplicate' }),
            named('c1', occurred(1)),
          ),
        'identifier_collision',
      );
      const direct = (name: string, ownEvidence?: string) =>
        directCorrection(storage, A, {
          name,
          ...(ownEvidence === undefined ? {} : { ownEvidence }),
          instruction: `Synthetic duplicate ${name}`,
          applicability: {
            kind: 'current_task',
            task: { sessionId: SESSION, taskId: TASK },
          },
          envelope: { sessionId: SESSION, taskId: TASK },
        });
      const ledgerCode = (fn: () => unknown) => {
        try {
          fn();
        } catch (error) {
          return (error as LedgerError).code;
        }
        return 'no error';
      };
      // An existing correction event ID, and an existing evidence ID under a
      // new event ID: the frozen Ledger refuses both before any write.
      expect(ledgerCode(() => direct('c2'))).toBe('duplicate_event');
      expect(ledgerCode(() => direct('dup_evidence', 'evidence_c1'))).toBe(
        'invalid_reference',
      );
      expect(logicalState(storage)).toEqual(before);
      // The same identifier text stays available to the other owner.
      recordOwnerCorrection(
        storage,
        submission({
          ownerId: B,
          correctedInstruction: 'Synthetic owner-beta c7',
        }),
        named('c7', occurred(1)),
      );
      const after = logicalState(storage);
      expect(
        after.rows['experience_events']!.length -
          before.rows['experience_events']!.length,
      ).toBe(1);
      expect(readCorrectionHistory(storage, A).entries).toHaveLength(7);
      expect(readCorrectionHistory(storage, B).entries).toHaveLength(3);
    } finally {
      storage.close();
    }
  });

  it('fails closed on inconsistent histories derived from real Ledger data, with no partial view', async () => {
    const { storage } = scenarioDb();
    let history: Json;
    try {
      history = JSON.parse(
        JSON.stringify(readCorrectionHistory(storage, A)),
      ) as Json;
    } finally {
      storage.close();
    }
    const entries = () =>
      (JSON.parse(JSON.stringify(history)) as { entries: Json[] }).entries;
    const variants: [string, () => unknown][] = [
      [
        'duplicate event',
        () => {
          const e = entries();
          e[6] = {
            ...e[6]!,
            event: e[5]!['event'],
            evidence: e[5]!['evidence'],
          };
          return { ownerId: A, entries: e };
        },
      ],
      [
        'duplicate sequence',
        () => {
          const e = entries();
          e[6]!['sequence'] = e[5]!['sequence'];
          return { ownerId: A, entries: e };
        },
      ],
      [
        'evidence moved to another correction',
        () => {
          const e = entries();
          const moved = (e[4]!['evidence'] as Json[]).pop()!;
          (e[5]!['evidence'] as Json[]).push(moved);
          return { ownerId: A, entries: e };
        },
      ],
      [
        'foreign evidence owner',
        () => {
          const e = entries();
          const ev = (e[0]!['evidence'] as Json[])[0]!;
          ev['ownerId'] = B;
          (ev['provenance'] as Json)['ownerId'] = B;
          return { ownerId: A, entries: e };
        },
      ],
      [
        'altered own evidence text',
        () => {
          const e = entries();
          const content = (e[2]!['evidence'] as Json[])[0]!['content'] as Json;
          content['text'] = `${String(content['text'])} `;
          return { ownerId: A, entries: e };
        },
      ],
      [
        'missing own evidence',
        () => {
          const e = entries();
          e[3]!['evidence'] = [];
          return { ownerId: A, entries: e };
        },
      ],
      [
        'missing supporting evidence',
        () => {
          const e = entries();
          (e[4]!['evidence'] as Json[]).pop();
          return { ownerId: A, entries: e };
        },
      ],
      [
        'history relabelled to another owner',
        () => ({ ownerId: B, entries: entries() }),
      ],
    ];
    for (const [label, make] of variants) {
      const bad = make();
      expectSyncError(
        () => buildCorrectionEvidenceIndex(bad),
        'invalid_correction_history',
      );
      expectSyncError(
        () =>
          resolveImmediateCorrections(
            bad,
            { ownerId: A, sessionId: SESSION, taskId: TASK },
            { referenceTime: REFERENCE_TIME, throughSequence: null },
          ),
        'invalid_correction_history',
      );
      await expectAsyncError(
        () =>
          assembleWithCorrections({
            history: bad,
            request: scenarioRequest(A, SESSION, TASK),
            sources: scenarioSources(),
            throughSequence: null,
          }),
        'invalid_correction_history',
      );
      expect(label).toBeTruthy();
    }
  });

  /** Test-only tampering of a throwaway database (frozen guards disabled). */
  function tamper(storage: Storage, sql: string, ...values: unknown[]) {
    const db = storage.sqlite;
    for (const trigger of [
      'experience_events_no_update',
      'evidence_no_update',
      'evidence_no_delete',
    ])
      db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    db.pragma('ignore_check_constraints = ON');
    db.pragma('foreign_keys = OFF');
    db.prepare(sql).run(...values);
    db.pragma('foreign_keys = ON');
    db.pragma('ignore_check_constraints = OFF');
  }

  it('refuses tampered stored history (altered own text, missing own evidence) and leaves other owners readable', () => {
    for (const make of [
      (s: Storage) =>
        tamper(
          s,
          "UPDATE evidence SET record_json = json_set(record_json, '$.content.text', 'Synthetic tampered') WHERE owner_id = ? AND record_id = ?",
          A,
          'evidence_c6',
        ),
      (s: Storage) =>
        tamper(
          s,
          'DELETE FROM evidence WHERE owner_id = ? AND record_id = ?',
          A,
          'evidence_c3',
        ),
    ]) {
      const { storage } = scenarioDb(':memory:');
      make(storage);
      expectSyncError(
        () => readCorrectionHistory(storage, A),
        'invalid_correction_history',
      );
      expect(readCorrectionHistory(storage, B).entries).toHaveLength(2);
      storage.close();
    }
  });

  it('refuses corruption on a LATER replay page: no partial history after the first page was read', () => {
    const w = smallWorld();
    for (let i = 1; i <= 150; i += 1)
      w.record(`page${i}`, {
        target: { kind: 'unidentified', description: `Synthetic ${i}` },
      });
    tamper(
      w.storage,
      "UPDATE experience_events SET record_json = json_set(record_json, '$.payload.category', 'tampered') WHERE owner_id = ? AND record_id = ?",
      A,
      'event_page130',
    );
    const { storage: watched, calls } = observed(w.storage);
    expectSyncError(
      () => readCorrectionHistory(watched, A),
      'invalid_correction_history',
    );
    // The first page (100 corrections) was read and the failure came from
    // the second page; nothing was returned.
    expect(
      calls.filter((call) =>
        /^SELECT sequence, record_json FROM experience_events WHERE/.test(
          call.sql,
        ),
      ).length,
    ).toBe(2);
  });

  it('maps unknown owners, closed storage and failed Ledger reads to fixed codes', () => {
    const { storage } = scenarioDb(':memory:');
    expectSyncError(
      () => readCorrectionHistory(storage, 'owner_unknown'),
      'unknown_binding',
    );
    expectSyncError(
      () => readCorrectionHistory(storage, 'not an owner'),
      'invalid_correction_history',
    );
    // A failing SQLite connection (raw driver error with SQL text).
    const failing = {
      ...storage,
      sqlite: new Proxy(storage.sqlite, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              if (sql.startsWith('SELECT sequence'))
                throw new Error(`SQLITE_BUSY: database is locked (${sql})`);
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    } as Storage;
    expectSyncError(() => readCorrectionHistory(failing, A), 'storage_failure');
    storage.close();
    expectSyncError(() => readCorrectionHistory(storage, A), 'storage_failure');
    expect(CORRECTION_ERROR_CODES).toContain('storage_failure');
  });
});

describe('cross-layer: exposure verification through the real Broker', () => {
  it('exposes exactly selected instructions and refuses displaced, over-limit, truncated and unrepresentable ones', async () => {
    const w = smallWorld();
    // One exposed: covered by the scenario. Two, one displaced by base
    // context that outranks it and fills the character budget.
    const x = w.record('x', {
      correctedInstruction: `${ASK} briefly.`,
    });
    const y = w.record('y', {
      correctedInstruction: `Synthetic Y ${'unrelated '.repeat(99)}`.trim(),
    });
    const heavy = Array.from({ length: 6 }, (_, i) =>
      evidenceCandidate(
        A,
        `heavy-${i}`,
        { evidenceId: `evidence_heavy_${i}`, eventId: `event_heavy_${i}` },
        `${ASK} ${i} ${'w'.repeat(1600)}`,
        { confidence: 1, salience: 1, negativeRetrieval: 0 },
      ),
    );
    const displaced = notExposed(
      (
        await pipeline(w.storage, A, SESSION, TASK, [
          staticSource('heavy', 'episode_history', heavy),
        ])
      ).outcome,
    );
    expect(displaced.reason).toBe('instruction_not_selected');
    expect(displaced.missing).toEqual([
      {
        correctionEventId: y.eventId,
        evidenceId: y.evidenceId,
        candidateId: oracleCandidateId(
          A,
          SESSION,
          TASK,
          y.eventId,
          y.evidenceId,
        ),
        failure: 'instruction_not_selected',
        exclusionReason: 'context_budget',
      },
    ]);
    expect(
      traced(
        displaced,
        oracleCandidateId(A, SESSION, TASK, x.eventId, x.evidenceId),
      ).selection,
    ).toBe('selected');
    // Without the heavy context both are exposed.
    expect(
      exposed((await pipeline(w.storage, A, SESSION, TASK, [])).outcome)
        .exposed,
    ).toHaveLength(2);
  });

  it('refuses the 11th active instruction (item limit) and never reports it exposed', async () => {
    const w = smallWorld();
    const all = Array.from({ length: 11 }, (_, i) =>
      w.record(`m${i + 1}`, {
        correctedInstruction: `Synthetic M${i + 1}: quarterly report rule ${i + 1}.`,
      }),
    );
    const o = notExposed(
      (await pipeline(w.storage, A, SESSION, TASK, [])).outcome,
    );
    expect(o.reason).toBe('instruction_not_selected');
    expect(o.missing).toHaveLength(1);
    expect(o.missing[0]!.exclusionReason).toBe('item_limit');
    expect(all.map((r) => r.eventId)).toContain(
      o.missing[0]!.correctionEventId,
    );
    expect(o.trace!.selected).toHaveLength(10);
    // Ten are still enough.
    const ten = await pipeline(
      w.storage,
      A,
      SESSION,
      TASK,
      [],
      all[9]!.sequence,
    );
    expect(exposed(ten.outcome).exposed).toHaveLength(10);
  });

  it('counts code points: 1600 fits, 1601 is truncated and refused, and a too-long stored text is unrepresentable', async () => {
    const w = smallWorld();
    const fits = `S${'\u{1d538}'.repeat(1599)}`;
    expect([...fits]).toHaveLength(1600);
    const r1600 = w.record('cp1600', { correctedInstruction: fits });
    const ok = exposed(
      (await pipeline(w.storage, A, SESSION, TASK, [])).outcome,
    );
    expect(instructionTexts(ok)).toEqual([fits]);
    expect(ok.bundle.items[0]!.originalChars).toBe(1600);
    const r1601 = w.record('cp1601', { correctedInstruction: `${fits}!` });
    const cut = notExposed(
      (await pipeline(w.storage, A, SESSION, TASK, [])).outcome,
    );
    expect(cut.reason).toBe('instruction_truncated');
    expect(cut.missing.map((m) => m.correctionEventId)).toEqual([
      r1601.eventId,
    ]);
    expect(JSON.stringify(cut)).not.toContain('\u{1d538}'.repeat(8));
    expect(r1600.sequence).toBeLessThan(r1601.sequence);
    // A stored instruction the Broker cannot represent (over its candidate
    // text limit; only a direct Ledger append can store one).
    const v = smallWorld();
    v.write(() =>
      directCorrection(v.storage, A, {
        name: 'huge',
        instruction: `Synthetic ${'y'.repeat(20_000)}`,
        applicability: {
          kind: 'current_task',
          task: { sessionId: SESSION, taskId: TASK },
        },
        envelope: { sessionId: SESSION, taskId: TASK },
      }),
    );
    const huge = notExposed(
      (await pipeline(v.storage, A, SESSION, TASK, [])).outcome,
    );
    expect(huge.reason).toBe('instruction_unrepresentable');
    expect(huge.trace).toBeNull();
    expect(huge.missing[0]!.correctionEventId).toBe('event_huge');
  });

  it('never counts a duplicated or conflicting instruction identity as exposed', async () => {
    const w = smallWorld();
    const r = w.record('d1', { correctedInstruction: `${ASK} in bullets.` });
    const candidateId = oracleCandidateId(
      A,
      SESSION,
      TASK,
      r.eventId,
      r.evidenceId,
    );
    const copy: ContextCandidate = {
      candidateId,
      ownerId: A,
      reference: {
        kind: 'current_instruction',
        evidence: { evidenceId: r.evidenceId, eventId: r.eventId },
        task: { sessionId: SESSION, taskId: TASK },
      },
      provenance: {
        kind: 'explicit_owner_correction',
        ownerId: A,
        sourceEventId: r.eventId,
      },
      scope: { kind: 'bounded', taskId: TASK },
      text: `${ASK} in bullets.`,
      timestamps: { recordedAt: r.recordedAt },
      signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
    };
    // A consistent duplicate kept from an earlier-sorting source.
    const dup = notExposed(
      (
        await pipeline(w.storage, A, SESSION, TASK, [
          staticSource('aaa-copy', 'active_task', [copy]),
        ])
      ).outcome,
    );
    expect(dup.reason).toBe('instruction_not_selected');
    expect(dup.missing[0]!.exclusionReason).toBe('duplicate_identity');
    // A conflicting duplicate fails the whole assembly.
    for (const conflicting of [
      { ...copy, text: 'Synthetic altered copy of the quarterly report' },
      evidenceCandidate(
        A,
        'base-own-evidence',
        { evidenceId: r.evidenceId, eventId: r.eventId },
        `${ASK} in bullets.`,
      ),
    ]) {
      const failed = notExposed(
        (
          await pipeline(w.storage, A, SESSION, TASK, [
            staticSource(
              'zzz-copy',
              conflicting.reference.kind === 'evidence'
                ? 'episode_history'
                : 'active_task',
              [conflicting],
            ),
          ])
        ).outcome,
      );
      expect(failed.reason).toBe('assembly_failed');
      expect(failed.brokerErrorCode).toBe('conflicting_duplicate');
      expect(failed.trace).toBeNull();
    }
  });

  it('reports source rejection and timeout as assembly failures, never exposure', async () => {
    const { storage } = scenarioDb(':memory:');
    try {
      const rejecting: ContextSource = {
        sourceId: 'rejecting',
        kind: 'episode_history',
        collect: () => Promise.reject(new Error('Synthetic SELECT failure')),
      };
      const rejected = notExposed(
        (await pipeline(storage, A, SESSION, TASK, [...withNote(), rejecting]))
          .outcome,
      );
      expect([rejected.reason, rejected.brokerErrorCode]).toEqual([
        'assembly_failed',
        'source_failure',
      ]);
      expect(JSON.stringify(rejected)).not.toContain('SELECT');
      const hung: ContextSource = {
        sourceId: 'hung',
        kind: 'episode_history',
        collect: () => new Promise(() => undefined),
      };
      const started = performance.now();
      const timedOut = notExposed(
        (await pipeline(storage, A, SESSION, TASK, [...withNote(), hung]))
          .outcome,
      );
      expect([timedOut.reason, timedOut.brokerErrorCode]).toEqual([
        'assembly_failed',
        'source_timeout',
      ]);
      expect(performance.now() - started).toBeLessThan(8000);
    } finally {
      storage.close();
    }
  }, 20_000);
});

describe('cross-layer: exact-target suppression safety', () => {
  function suppressionWorld() {
    const w = smallWorld();
    w.write(() => ordinary(w.storage, A, 'perm_target'));
    w.write(() => ordinary(w.storage, A, 'inactive_target'));
    const s1 = w.record('s1', {
      target: { kind: 'evidence', reference: SOURCE_REF },
    });
    const s2 = w.record('s2', {
      target: { kind: 'owner_state', reference: LEARNED },
    });
    const s3 = w.record('s3', {
      target: { kind: 'event', eventId: 'event_source' },
    });
    const s4 = w.record('s4', {
      target: {
        kind: 'unidentified',
        description: 'Synthetic owner-alpha decoy quarterly report',
      },
    });
    w.record('s5', {
      category: 'permission',
      target: {
        kind: 'evidence',
        reference: {
          evidenceId: 'evidence_perm_target',
          eventId: 'event_perm_target',
        },
      },
    });
    const s6 = w.record('s6', {
      target: {
        kind: 'evidence',
        reference: {
          evidenceId: 'evidence_inactive_target',
          eventId: 'event_inactive_target',
        },
      },
    });
    w.record('s7', { target: { kind: 'event', eventId: s6.eventId } });
    w.write(() =>
      directCorrection(w.storage, A, {
        name: 'z',
        instruction: 'Synthetic Z: quarterly report with a note.',
        applicability: {
          kind: 'current_task',
          task: { sessionId: SESSION, taskId: TASK },
        },
        envelope: { sessionId: SESSION, taskId: TASK },
        supporting: ['note'],
      }),
    );
    return { w, s1, s2, s3, s4 };
  }

  const ev = (id: string, evidenceId: string, eventId: string, text?: string) =>
    evidenceCandidate(
      A,
      id,
      { evidenceId, eventId },
      text ?? `Synthetic owner-alpha quarterly report ${id}`,
    );
  const st = (id: string, learnedItemId: string, version: number) =>
    stateCandidate(
      A,
      id,
      learnedItemId,
      version,
      `Synthetic owner-alpha quarterly report ${id}`,
    );

  it('suppresses only exact evidence (evidence AND event) and exact owner-state (item AND version) targets', async () => {
    const { w, s1, s4 } = suppressionWorld();
    const history = readCorrectionHistory(w.storage, A);
    const one = async (candidate: ContextCandidate) => {
      const kind =
        candidate.reference.kind === 'owner_state'
          ? 'owner_state'
          : 'episode_history';
      const o = exposed(
        await assembleWithCorrections({
          history,
          request: scenarioRequest(A, SESSION, TASK),
          sources: [staticSource('base', kind, [candidate])],
          throughSequence: null,
        }),
      );
      const t = traced(o, candidate.candidateId);
      return [t.signals.negativeRetrieval, t.exclusionReason];
    };
    const suppressed = [1, 'negative_signal_suppressed'];
    const kept = [0, null];
    const cases: [string, ContextCandidate, unknown[]][] = [
      [
        'exact evidence',
        ev('exact', 'evidence_source', 'event_source'),
        suppressed,
      ],
      [
        'same evidence, other event',
        ev('other-event', 'evidence_source', 'event_other'),
        kept,
      ],
      [
        'same event, other evidence',
        ev('other-evidence', 'evidence_other', 'event_source'),
        kept,
      ],
      ['exact owner state', st('state-v1', 'learned_synthetic', 1), suppressed],
      [
        'same item, other version',
        st('state-v2', 'learned_synthetic', 2),
        kept,
      ],
      ['other item, same version', st('state-other', 'learned_other', 1), kept],
      [
        'unrelated',
        ev('unrelated', 'evidence_unrelated', 'event_unrelated'),
        kept,
      ],
      [
        'inactive (superseded) target',
        ev('inactive', 'evidence_inactive_target', 'event_inactive_target'),
        kept,
      ],
      [
        'permission target',
        ev('permission', 'evidence_perm_target', 'event_perm_target'),
        kept,
      ],
      [
        'event-only target (event_source)',
        ev('event-only', 'evidence_event_only', 'event_source'),
        kept,
      ],
      [
        'supporting evidence nobody targets',
        ev('supporting', 'evidence_z_note', 'event_z'),
        kept,
      ],
      [
        'text equal to an unidentified target and to an instruction',
        ev(
          'decoy',
          'evidence_decoy',
          'event_decoy',
          'Synthetic owner-alpha decoy quarterly report',
        ),
        kept,
      ],
      [
        'text equal to an active instruction',
        ev(
          'instruction-text',
          'evidence_text',
          'event_text',
          'Synthetic s1: quarterly report rule.',
        ),
        kept,
      ],
    ];
    for (const [label, candidate, expected] of cases)
      expect([label, ...(await one(candidate))]).toEqual([label, ...expected]);
    expect(s1.eventId).toBe('event_s1');
    expect(s4.eventId).toBe('event_s4');
  });

  it('keeps normal Broker semantics for every non-targeted candidate, mutates nothing in place and never repairs invalid signals', async () => {
    const { w } = suppressionWorld();
    const history = readCorrectionHistory(w.storage, A);
    const mutable = (cand: ContextCandidate) =>
      JSON.parse(JSON.stringify(cand)) as ContextCandidate;
    const episodes = [
      ev('exact', 'evidence_source', 'event_source'),
      ev('other-evidence', 'evidence_other', 'event_source'),
      ev('unrelated', 'evidence_unrelated', 'event_unrelated'),
      ev('permission', 'evidence_perm_target', 'event_perm_target'),
    ].map(mutable);
    const states = [
      st('state-v1', 'learned_synthetic', 1),
      st('state-v2', 'learned_synthetic', 2),
    ].map(mutable);
    const pristine = JSON.stringify([episodes, states]);
    const sources = () => [
      staticSource('episodes', 'episode_history', episodes),
      staticSource('state', 'owner_state', states),
    ];
    const o = exposed(
      await assembleWithCorrections({
        history,
        request: scenarioRequest(A, SESSION, TASK),
        sources: sources(),
        throughSequence: null,
      }),
    );
    expect(JSON.stringify([episodes, states])).toBe(pristine);
    const plain = await createContextBroker({ sources: sources() }).assemble(
      scenarioRequest(A, SESSION, TASK),
    );
    const strip = (t: TraceCandidate) => {
      const { eligibleRank: _r, selection: _s, ...rest } = t as unknown as Json;
      return rest;
    };
    for (const p of plain.trace.candidates) {
      const mine = o.trace.candidates.find(
        (t) => t.sourceId === p.sourceId && t.candidateId === p.candidateId,
      )!;
      if (p.candidateId === 'exact' || p.candidateId === 'state-v1') {
        expect(mine.signals).toEqual({ ...p.signals, negativeRetrieval: 1 });
        expect(mine.exclusionReason).toBe('negative_signal_suppressed');
      } else {
        expect(strip(mine)).toEqual(strip(p));
        expect(mine.exclusionReason).toBeNull();
      }
    }
    // Invalid signals on a TARGETED candidate are rejected, as without
    // corrections; the wrapper never repairs them into the suppression value.
    for (const signals of [
      { confidence: 0.5, salience: 0.5, negativeRetrieval: 2 },
      { confidence: 0.5, salience: 0.5, negativeRetrieval: -0.5 },
      { confidence: Number.NaN, salience: 0.5, negativeRetrieval: 0 },
    ]) {
      const bad = {
        ...ev('exact', 'evidence_source', 'event_source'),
        signals,
      };
      const failed = notExposed(
        await assembleWithCorrections({
          history,
          request: scenarioRequest(A, SESSION, TASK),
          sources: [staticSource('episodes', 'episode_history', [bad])],
          throughSequence: null,
        }),
      );
      let plainCode: unknown;
      try {
        await createContextBroker({
          sources: [staticSource('episodes', 'episode_history', [bad])],
        }).assemble(scenarioRequest(A, SESSION, TASK));
      } catch (error) {
        plainCode = (error as ContextBrokerError).code;
      }
      expect(failed.brokerErrorCode).toBe(plainCode);
      expect(failed.brokerErrorCode).toBe('invalid_score_metadata');
    }
  });
});

describe('cross-layer: restart, fresh process and read-only replay', () => {
  it('reproduces every result after close and reopen, on a query_only connection that changes nothing', async () => {
    const filename = dbFile('restart');
    const built = scenarioDb(filename);
    const before: Record<string, string> = {};
    for (const owner of [A, B])
      for (const [s, t] of BINDINGS)
        before[`${owner}|${s}|${t}`] = comparable(
          await pipeline(built.storage, owner, s, t),
        );
    built.storage.close();

    const reopened = openStorage(filename);
    try {
      reopened.sqlite.pragma('query_only = ON');
      const state = logicalState(reopened);
      const schema = reopened.sqlite
        .prepare(
          'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
        )
        .all();
      const changes = totalChanges(reopened);
      const { storage: watched, calls } = observed(reopened);
      for (const owner of [A, B])
        for (const [s, t] of BINDINGS) {
          // Each phase separately: replay, index, resolution, assembly.
          const history = readCorrectionHistory(watched, owner);
          expect(totalChanges(reopened)).toBe(changes);
          buildCorrectionEvidenceIndex(history);
          resolveImmediateCorrections(
            history,
            { ownerId: owner, sessionId: s, taskId: t },
            { referenceTime: REFERENCE_TIME, throughSequence: null },
          );
          expect(totalChanges(reopened)).toBe(changes);
          expect(comparable(await pipeline(watched, owner, s, t))).toBe(
            before[`${owner}|${s}|${t}`],
          );
        }
      expect(totalChanges(reopened)).toBe(changes);
      expect(logicalState(reopened)).toEqual(state);
      expect(
        reopened.sqlite
          .prepare(
            'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
          )
          .all(),
      ).toEqual(schema);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.sql).toMatch(/^SELECT /);
      // query_only is really enforced on this connection: a write fails
      // closed and records nothing.
      expectSyncError(
        () =>
          recordOwnerCorrection(
            reopened,
            submission({ correctedInstruction: 'Synthetic refused write' }),
            named('refused', occurred(1)),
          ),
        'storage_failure',
      );
      expect(logicalState(reopened)).toEqual(state);
      expect(totalChanges(reopened)).toBe(changes);
    } finally {
      reopened.close();
    }
  });

  it('reproduces every result in a separate, fresh Node process on a query_only connection', async () => {
    const filename = dbFile('fresh');
    const built = scenarioDb(filename);
    const expected: Record<string, string> = {};
    for (const owner of [A, B])
      for (const [s, t] of BINDINGS)
        expected[`${owner}|${s}|${t}`] = comparable(
          await pipeline(built.storage, owner, s, t),
        );
    const stateBefore = JSON.stringify(logicalState(built.storage));
    built.storage.close();
    const output = execFileSync(process.execPath, [replayScript, filename], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      maxBuffer: 64 * 1024 * 1024,
    });
    const child = JSON.parse(output) as {
      pid: number;
      queryOnly: number;
      changesBefore: number;
      changesAfter: number;
      stateBefore: string;
      stateAfter: string;
      results: Record<string, string>;
    };
    expect(child.pid).not.toBe(process.pid);
    expect(child.queryOnly).toBe(1);
    expect(child.changesAfter).toBe(child.changesBefore);
    expect(child.stateAfter).toBe(child.stateBefore);
    expect(child.stateBefore).toBe(stateBefore);
    expect(Object.keys(child.results).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const key of Object.keys(expected))
      expect(child.results[key], key).toBe(expected[key]);
  }, 60_000);
});

describe('cross-layer: hostile source regressions (F1-F4, N1, N2) with active suppression', () => {
  /** The scenario's real history for TASK: four active exact targets. */
  async function history() {
    const { storage } = scenarioDb(':memory:');
    try {
      return readCorrectionHistory(storage, A);
    } finally {
      storage.close();
    }
  }
  const run = async (h: unknown, sources: readonly unknown[]) =>
    assembleWithCorrections({
      history: h,
      request: scenarioRequest(A, SESSION, TASK),
      sources: sources as ContextSource[],
      throughSequence: null,
    });

  it('F1. never reads beyond the owner field of a foreign record and keeps foreign text out', async () => {
    const h = await history();
    let reads = 0;
    const foreign = watched(
      stateCandidate(
        B,
        'base-state-v1',
        'learned_synthetic',
        1,
        'Synthetic owner-beta secret',
      ),
      () => {
        reads += 1;
      },
    );
    const o = exposed(
      await run(h, [
        staticSource('state', 'owner_state', [
          foreign,
          stateCandidate(
            A,
            'base-state-v1',
            'learned_synthetic',
            1,
            'Synthetic owner-alpha quarterly report tone',
          ),
        ]),
      ]),
    );
    expect(reads).toBe(0);
    expect(JSON.stringify(o)).not.toContain('owner-beta');
    expect(traced(o, 'base-state-v1').exclusionReason).toBe(
      'negative_signal_suppressed',
    );
  });

  it('F2. validates before suppression: a malformed exact-target candidate is rejected, not repaired', async () => {
    const h = await history();
    const malformed = {
      ...stateCandidate(
        A,
        'base-state-v1',
        'learned_synthetic',
        1,
        'Synthetic quarterly report',
      ),
      unexpected: true,
    };
    const o = notExposed(
      await run(h, [staticSource('state', 'owner_state', [malformed])]),
    );
    expect([o.reason, o.brokerErrorCode]).toEqual([
      'assembly_failed',
      'invalid_candidate',
    ]);
  });

  it('F3. reports only the Broker vocabulary, never a forged code or caller text', async () => {
    const h = await history();
    const forged = Object.create(ContextBrokerError.prototype) as Json;
    forged['code'] = 'Synthetic SELECT * FROM evidence';
    const throwing: ContextSource = {
      sourceId: 'throwing',
      kind: 'episode_history',
      collect: () => {
        throw forged;
      },
    };
    const o = notExposed(await run(h, [throwing]));
    expect(CONTEXT_BROKER_ERROR_CODES).toContain(o.brokerErrorCode);
    expect(o.brokerErrorCode).toBe('source_failure');
    expect(JSON.stringify(o)).not.toContain('SELECT');
    const unreadable = Object.defineProperty({}, 'collect', {
      get() {
        throw new Error('Synthetic getter failure');
      },
    });
    const bad = notExposed(await run(h, [unreadable]));
    expect([bad.reason, bad.brokerErrorCode]).toEqual([
      'assembly_failed',
      'invalid_configuration',
    ]);
  });

  /**
   * A plain-object copy whose every field except `ownerId` is an enumerable
   * accessor counting reads. Unlike a Proxy (which structuredClone refuses
   * without running a trap), a clone of it reads every field.
   */
  function watched(candidate: ContextCandidate, onRead: () => void): object {
    const copy: Record<string, unknown> = { ownerId: candidate.ownerId };
    for (const [key, value] of Object.entries(candidate))
      if (key !== 'ownerId')
        Object.defineProperty(copy, key, {
          enumerable: true,
          get() {
            onRead();
            return value;
          },
        });
    return copy;
  }

  /** An array that counts element reads (its length is read freely). */
  function counted(length: number, element: () => unknown) {
    const reads = { elements: 0 };
    const target: unknown[] = [];
    target.length = length;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads.elements += 1;
          return element();
        }
        return Reflect.get(t, key, receiver) as unknown;
      },
    });
    return { proxy, reads };
  }

  it('F4. reads no element of an over-limit raw collection, per source or in aggregate', async () => {
    const h = await history();
    const item = () =>
      stateCandidate(A, 'x', 'learned_x', 1, 'Synthetic quarterly report');
    const over = counted(MAX_RAW_ITEMS_PER_SOURCE + 1, item);
    const o = notExposed(
      await run(h, [staticSource('state', 'owner_state', over.proxy)]),
    );
    expect(o.brokerErrorCode).toBe('source_resource_limit_exceeded');
    expect(over.reads.elements).toBe(0);
    // Four full sources reach the aggregate limit with the instructions.
    const per = MAX_RAW_ITEMS_TOTAL / 4;
    const parts = Array.from({ length: 4 }, () => counted(per, item));
    const agg = notExposed(
      await run(
        h,
        parts.map((p, i) => staticSource(`s${i}`, 'owner_state', p.proxy)),
      ),
    );
    expect(agg.brokerErrorCode).toBe('source_resource_limit_exceeded');
    expect(parts.reduce((n, p) => n + p.reads.elements, 0)).toBe(0);
  });

  it('F4. clones no item when same-owner candidates exceed the per-source quota', async () => {
    const h = await history();
    let deepReads = 0;
    const item = () =>
      watched(
        stateCandidate(A, 'q', 'learned_q', 1, 'Synthetic quarterly report'),
        () => {
          deepReads += 1;
        },
      );
    const quota = counted(501, item);
    const o = notExposed(
      await run(h, [staticSource('state', 'owner_state', quota.proxy)]),
    );
    expect(o.brokerErrorCode).toBe('candidate_limit_exceeded');
    expect(deepReads).toBe(0);
  });

  it('N1. refuses more than MAX_SOURCES - 1 base sources before reading any of them', async () => {
    const h = await history();
    let reads = 0;
    const spy = () =>
      new Proxy(staticSource('spy', 'episode_history', []), {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const list = Array.from({ length: MAX_SOURCES }, spy);
    let elementReads = 0;
    const sources = new Proxy(list, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) elementReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const o = notExposed(await run(h, sources));
    expect([o.reason, o.brokerErrorCode]).toEqual([
      'assembly_failed',
      'invalid_configuration',
    ]);
    expect([reads, elementReads]).toEqual([0, 0]);
    // MAX_SOURCES - 1 base sources are still accepted.
    const ok = await run(
      h,
      Array.from({ length: MAX_SOURCES - 1 }, (_, i) =>
        staticSource(`ok${i}`, 'episode_history', []),
      ),
    );
    expect(ok.status).toBe('exposed');
  });

  it('N2. bounds an unrepresentable raw length without reading or allocating it', async () => {
    const h = await history();
    let elementReads = 0;
    const huge = new Proxy([] as unknown[], {
      get(target, key, receiver) {
        if (key === 'length') return Number.MAX_SAFE_INTEGER;
        if (typeof key === 'string' && /^\d+$/.test(key)) elementReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const o = notExposed(
      await run(h, [staticSource('huge', 'owner_state', huge)]),
    );
    expect(o.brokerErrorCode).toBe('source_resource_limit_exceeded');
    expect(elementReads).toBe(0);
  });

  it('releases every barrier: successful siblings never hang beside rejected, malformed, delayed, hung or aborted sources', async () => {
    const h = await history();
    const good = () =>
      staticSource('good', 'owner_state', [
        stateCandidate(
          A,
          'base-state-v1',
          'learned_synthetic',
          1,
          'Synthetic owner-alpha quarterly report tone',
        ),
      ]);
    const later = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const cases: [string, ContextSource, string, number][] = [
      [
        'rejected',
        {
          sourceId: 'z',
          kind: 'episode_history',
          collect: () =>
            later(20, null).then(() => Promise.reject(new Error('Synthetic'))),
        },
        'source_failure',
        2000,
      ],
      [
        'malformed',
        {
          sourceId: 'z',
          kind: 'episode_history',
          collect: () => later(20, 'not an array' as never),
        },
        'source_failure',
        2000,
      ],
      [
        'delayed',
        {
          sourceId: 'z',
          kind: 'episode_history',
          collect: () => later(50, []),
        },
        'exposed',
        2000,
      ],
      [
        'hung',
        {
          sourceId: 'z',
          kind: 'episode_history',
          collect: () => new Promise(() => undefined),
        },
        'source_timeout',
        8000,
      ],
      [
        'aborted',
        {
          sourceId: 'z',
          kind: 'episode_history',
          collect: (_q, { signal }) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () =>
                reject(new Error('Synthetic aborted')),
              ),
            ),
        },
        'source_timeout',
        8000,
      ],
    ];
    for (const [label, sibling, expected, limit] of cases) {
      const started = performance.now();
      const o = await run(h, [good(), sibling]);
      const elapsed = performance.now() - started;
      expect([
        label,
        o.status === 'exposed' ? 'exposed' : o.brokerErrorCode,
      ]).toEqual([label, expected]);
      expect(elapsed, label).toBeLessThan(limit);
      if (o.status === 'exposed')
        expect(traced(o, 'base-state-v1').exclusionReason).toBe(
          'negative_signal_suppressed',
        );
    }
  }, 30_000);
});
