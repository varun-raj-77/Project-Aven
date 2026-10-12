import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_BROKER_ERROR_CODES,
  ContextBrokerError,
  createContextBroker,
  type ContextCandidate,
  type ContextRequest,
  type ContextSource,
  type ContextSourceKind,
} from '@aven/context-broker';
import { openStorage } from '@aven/storage';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assembleWithCorrections,
  CORRECTION_INSTRUCTION_SOURCE_ID,
  type CorrectionAssemblyOutcome,
} from '../src/context-source/index.ts';
import {
  brokerCode,
  verifyExposure,
  type RequiredInstruction,
} from '../src/context-source/integration.ts';
import { CorrectionError } from '../src/index.ts';
import {
  readCorrectionHistory,
  recordOwnerCorrection,
} from '../src/ledger/index.ts';
import {
  A,
  f,
  options,
  OTHER_TASK,
  SESSION,
  snapshot,
  submission,
  TASK,
  world,
} from './recorder-fixtures.ts';
import {
  SCALE_OTHER_SESSION,
  SCALE_OWNER,
  SCALE_SESSION,
  SCALE_TASKS,
  scaleEventId,
  scaleEvidenceId,
  scaleHistory,
  scaleTime,
  type ScaleSpec,
  type ScaleTarget,
} from './scale-fixtures.ts';

/*
 * AVEN-010 patch 6: correction-aware assembly through the REAL frozen
 * AVEN-008 Context Broker, with exposure verification. Every owner, session,
 * task, identifier and text is SYNTHETIC. These are mechanics tests of
 * selection and verification; no model consumes any bundle here.
 */

const OWNER = SCALE_OWNER;
const S = SCALE_SESSION;
const S2 = SCALE_OTHER_SESSION;
const [T1, T2, T3] = SCALE_TASKS as [string, string, string];
const REF = '2026-10-02T00:00:00Z';
const BASE_TIME = '2026-09-01T00:00:00Z';
const ASK = 'Draft the quarterly report summary';
const INSTRUCTION_SOURCE = CORRECTION_INSTRUCTION_SOURCE_ID;
const scratch = mkdtempSync(join(tmpdir(), 'aven-p6-context-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Exposed = Extract<CorrectionAssemblyOutcome, { status: 'exposed' }>;
type NotExposed = Extract<CorrectionAssemblyOutcome, { status: 'not_exposed' }>;

const request = (
  taskId = T1,
  sessionId = S,
  text = ASK,
  referenceTime = REF,
): ContextRequest => ({
  ownerId: OWNER,
  task: { sessionId, taskId },
  request: text,
  referenceTime,
  taskDescriptor: {},
});

const spec = (seq: number, over: Partial<ScaleSpec> = {}): ScaleSpec => ({
  seq,
  name: `c${seq}`,
  kind: 'current_task',
  session: S,
  task: T1,
  category: 'communication',
  target: { kind: 'unidentified', description: `Synthetic target ${seq}` },
  ...over,
});
const history = (...specs: ScaleSpec[]) => scaleHistory(specs);

const evidenceRef = (n: string) => ({
  evidenceId: `evidence_base_${n}`,
  eventId: `event_base_${n}`,
});
const toEvidence = (n: string): ScaleTarget => ({
  kind: 'evidence',
  reference: evidenceRef(n),
});
const toState = (id: string, version: number): ScaleTarget => ({
  kind: 'owner_state',
  reference: { learnedItemId: `learned_${id}`, version },
});
const toCorrection = (seq: number): ScaleTarget => ({
  kind: 'event',
  eventId: scaleEventId(`c${seq}`),
});

/** A frozen base evidence candidate (owner statement, global scope). */
function evidenceCandidate(
  n: string,
  text = `Synthetic note on the ${ASK.toLowerCase()} ${n}`,
  owner = OWNER,
  ref = evidenceRef(n),
): ContextCandidate {
  return deepFrozen({
    candidateId: `base-evidence-${n}`,
    ownerId: owner,
    reference: { kind: 'evidence', reference: ref },
    provenance: {
      kind: 'explicit_owner_statement',
      ownerId: owner,
      sourceEventId: ref.eventId,
    },
    scope: { kind: 'global', explicitDeclaration: 'Synthetic: everywhere' },
    text,
    timestamps: { recordedAt: BASE_TIME },
    signals: { confidence: 0.5, salience: 0.5, negativeRetrieval: 0 },
  });
}

/** A frozen base owner-state candidate (trusted, system generated). */
function stateCandidate(
  id: string,
  version: number,
  text = `Synthetic preference for the ${ASK.toLowerCase()}`,
): ContextCandidate {
  return deepFrozen({
    candidateId: `base-state-${id}-v${version}`,
    ownerId: OWNER,
    reference: {
      kind: 'owner_state',
      reference: { learnedItemId: `learned_${id}`, version },
      lifecycle: 'trusted',
    },
    provenance: {
      kind: 'system_generated',
      component: 'synthetic',
      version: '1',
      derivedFrom: [],
    },
    scope: { kind: 'global', explicitDeclaration: 'Synthetic: everywhere' },
    text,
    timestamps: { recordedAt: BASE_TIME },
    signals: { confidence: 0.5, salience: 0.5, negativeRetrieval: 0 },
  });
}

function deepFrozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFrozen(child);
    Object.freeze(value);
  }
  return value;
}

function source(
  sourceId: string,
  kind: ContextSourceKind,
  items: readonly unknown[],
  mode: 'sync' | 'async' = 'sync',
): ContextSource {
  return Object.freeze({
    sourceId,
    kind,
    collect: () => (mode === 'sync' ? items : Promise.resolve(items)),
  });
}

const assemble = (
  h: unknown,
  sources: readonly ContextSource[] = [],
  req: ContextRequest = request(),
  throughSequence: number | null = null,
) =>
  assembleWithCorrections({
    history: h,
    request: req,
    sources,
    throughSequence,
  });

function exposed(outcome: CorrectionAssemblyOutcome): Exposed {
  expect(outcome.status).toBe('exposed');
  return outcome as Exposed;
}
function notExposed(outcome: CorrectionAssemblyOutcome): NotExposed {
  expect(outcome.status).toBe('not_exposed');
  expect(outcome).not.toHaveProperty('bundle');
  return outcome as NotExposed;
}
const instructionItems = (o: Exposed) =>
  o.bundle.items.filter((i) => i.sourceId === INSTRUCTION_SOURCE);
const traceOf = (o: Exposed | NotExposed, candidateId: string) =>
  o.trace!.candidates.find((c) => c.candidateId === candidateId)!;
const exposedEvents = (o: Exposed) => o.exposed.map((e) => e.correctionEventId);

describe('assembleWithCorrections: instructions through the real Broker', () => {
  it('1. leaves base Broker selection unchanged when there are no corrections', async () => {
    const sources = [
      source('episodes', 'episode_history', [
        evidenceCandidate('a'),
        evidenceCandidate('b'),
      ]),
      source('state', 'owner_state', [stateCandidate('pref', 1)]),
    ];
    const outcome = exposed(await assemble(history(), sources));
    const plain = await createContextBroker({ sources }).assemble(request());
    expect(JSON.stringify(outcome.bundle)).toBe(JSON.stringify(plain.bundle));
    expect(JSON.stringify(outcome.trace.candidates)).toBe(
      JSON.stringify(plain.trace.candidates),
    );
    expect(outcome.exposed).toEqual([]);
    expect(outcome.trace.sources.map((s) => s.sourceId)).toEqual([
      INSTRUCTION_SOURCE,
      'episodes',
      'state',
    ]);
  });

  it('2. selects a current_task correction exactly: identity, binding, provenance, scope, text, time and signals', async () => {
    const text = '  Synthetic: keep it to three bullets — exactly.\n\tNo more.';
    const outcome = exposed(
      await assemble(history(spec(1, { instruction: text })), [
        source('episodes', 'episode_history', [evidenceCandidate('a')]),
      ]),
    );
    const [item] = instructionItems(outcome);
    expect(outcome.exposed).toEqual([
      {
        correctionEventId: scaleEventId('c1'),
        evidenceId: scaleEvidenceId('c1'),
        candidateId: item!.candidateId,
      },
    ]);
    expect(item!.candidateId).toMatch(/^correction:[0-9a-f]{64}$/);
    expect(item!.sourceKind).toBe('active_task');
    expect(item!.reference).toEqual({
      kind: 'current_instruction',
      evidence: {
        evidenceId: scaleEvidenceId('c1'),
        eventId: scaleEventId('c1'),
      },
      task: { sessionId: S, taskId: T1 },
    });
    expect(item!.provenance).toEqual({
      kind: 'explicit_owner_correction',
      ownerId: OWNER,
      sourceEventId: scaleEventId('c1'),
    });
    expect(item!.scope).toEqual({ kind: 'bounded', taskId: T1 });
    expect(item!.text).toBe(text);
    expect(item!.truncated).toBe(false);
    expect(item!.recordedAt).toBe(scaleTime(1));
    expect(traceOf(outcome, item!.candidateId).signals).toEqual({
      confidence: 1,
      salience: 1,
      negativeRetrieval: 0,
    });
    // The original behavior is never rendered anywhere.
    expect(JSON.stringify(outcome)).not.toContain('Synthetic original');
  });

  it('3-5. projects a current_session correction onto the requesting task of that session only', async () => {
    const h = history(spec(1, { kind: 'current_session', task: T1 }));
    for (const task of [T1, T2, 'task_scale_later']) {
      const outcome = exposed(await assemble(h, [], request(task)));
      const [item] = instructionItems(outcome);
      // Bound to the REQUESTING task, never to the origin task.
      expect(item!.reference).toMatchObject({
        task: { sessionId: S, taskId: task },
      });
      expect(item!.scope).toEqual({ kind: 'bounded', taskId: task });
      expect(exposedEvents(outcome)).toEqual([scaleEventId('c1')]);
    }
    for (const req of [request(T3, S2), request(T1, S2)]) {
      const outcome = exposed(await assemble(h, [], req));
      expect(instructionItems(outcome)).toEqual([]);
      expect(outcome.exposed).toEqual([]);
    }
  });

  it('6. applies an unspecified correction only to its origin task', async () => {
    const h = history(spec(1, { kind: 'unspecified', task: T2 }));
    expect(exposedEvents(exposed(await assemble(h, [], request(T2))))).toEqual([
      scaleEventId('c1'),
    ]);
    expect(exposed(await assemble(h, [], request(T1))).exposed).toEqual([]);
  });

  it('7-9. injects only the superseding end of a chain, with no resurrection', async () => {
    const h = history(
      spec(1, { instruction: 'Synthetic first' }),
      spec(2, { target: toCorrection(1), instruction: 'Synthetic second' }),
      spec(3, {
        target: {
          kind: 'evidence',
          reference: {
            evidenceId: scaleEvidenceId('c2'),
            eventId: scaleEventId('c2'),
          },
        },
        instruction: 'Synthetic third',
      }),
    );
    const outcome = exposed(await assemble(h));
    expect(exposedEvents(outcome)).toEqual([scaleEventId('c3')]);
    expect(instructionItems(outcome).map((i) => i.text)).toEqual([
      'Synthetic third',
    ]);
  });

  it('10-11. never injects a permission correction, which suppresses nothing', async () => {
    const h = history(
      spec(1, {
        category: 'permission',
        target: toEvidence('a'),
        instruction: 'Synthetic: you may send it without asking.',
      }),
    );
    const outcome = exposed(
      await assemble(h, [
        source('episodes', 'episode_history', [evidenceCandidate('a')]),
      ]),
    );
    expect(instructionItems(outcome)).toEqual([]);
    expect(outcome.exposed).toEqual([]);
    const base = traceOf(outcome, 'base-evidence-a');
    expect(base.signals.negativeRetrieval).toBe(0);
    expect(base.selection).toBe('selected');
    expect(JSON.stringify(outcome)).not.toContain('without asking');
  });

  it('18. keeps overlapping same-target corrections as separate instructions', async () => {
    const h = history(
      spec(1, { target: toEvidence('a'), instruction: 'Synthetic one' }),
      spec(2, { target: toEvidence('a'), instruction: 'Synthetic one' }),
    );
    const outcome = exposed(
      await assemble(h, [
        source('episodes', 'episode_history', [evidenceCandidate('a')]),
      ]),
    );
    expect(exposedEvents(outcome)).toEqual([
      scaleEventId('c1'),
      scaleEventId('c2'),
    ]);
    expect(instructionItems(outcome)).toHaveLength(2);
    expect(traceOf(outcome, 'base-evidence-a').exclusionReason).toBe(
      'negative_signal_suppressed',
    );
  });

  it('20-22. isolates foreign candidates, uses several sync and async sources, and is deterministic', async () => {
    const foreign = evidenceCandidate(
      'a',
      'Synthetic foreign note',
      'owner_other',
    );
    const sources = [
      source('episodes', 'episode_history', [evidenceCandidate('a'), foreign]),
      source('state', 'owner_state', [stateCandidate('pref', 1)], 'async'),
      source('external', 'permitted_external', []),
    ];
    const h = history(spec(1, { target: toEvidence('a') }));
    const first = exposed(await assemble(h, sources));
    const second = exposed(await assemble(h, sources));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain('owner_other');
    expect(first.trace.candidates.map((c) => c.candidateId).sort()).toEqual(
      [
        'base-evidence-a',
        'base-state-pref-v1',
        instructionItems(first)[0]!.candidateId,
      ].sort(),
    );
    expect(traceOf(first, 'base-state-pref-v1').selection).toBe('selected');
  });
});

describe('assembleWithCorrections: exact-target suppression', () => {
  const sources = () => [
    source('episodes', 'episode_history', [
      evidenceCandidate('a'),
      evidenceCandidate('b', undefined, OWNER, {
        evidenceId: 'evidence_base_b',
        eventId: 'event_base_a',
      }),
      evidenceCandidate('c'),
    ]),
    source('state', 'owner_state', [
      stateCandidate('pref', 1),
      stateCandidate('pref', 2),
      stateCandidate('other', 1),
    ]),
  ];
  const signalsOf = (o: Exposed) =>
    Object.fromEntries(
      o.trace.candidates
        .filter((c) => c.sourceId !== INSTRUCTION_SOURCE)
        .map((c) => [
          c.candidateId,
          [c.signals.negativeRetrieval, c.exclusionReason],
        ]),
    );

  it('12-17. suppresses exactly the targeted evidence and state version, and nothing else', async () => {
    const outcome = exposed(
      await assemble(
        history(
          spec(1, { target: toEvidence('a') }),
          spec(2, { target: toState('pref', 2) }),
          spec(3, { target: { kind: 'event', eventId: 'event_base_c' } }),
          spec(4, {
            target: { kind: 'unidentified', description: 'Synthetic c' },
          }),
        ),
        sources(),
      ),
    );
    expect(signalsOf(outcome)).toEqual({
      'base-evidence-a': [1, 'negative_signal_suppressed'],
      // Same event, different evidence ID: untouched.
      'base-evidence-b': [0, null],
      // An event target names no comparable candidate reference.
      'base-evidence-c': [0, null],
      'base-state-pref-v1': [0, null],
      'base-state-pref-v2': [1, 'negative_signal_suppressed'],
      'base-state-other-v1': [0, null],
    });
  });

  it('never suppresses from an inactive, out-of-scope or permission correction, or from supporting evidence', async () => {
    const outcome = exposed(
      await assemble(
        history(
          // Superseded: its target is no longer suppressed.
          spec(1, { target: toEvidence('a') }),
          spec(2, { target: toCorrection(1) }),
          // Another task's correction.
          spec(3, { task: T2, target: toEvidence('b') }),
          // Permission.
          spec(4, { category: 'permission', target: toState('pref', 1) }),
          // Supporting evidence of a correction is not a suppression rule.
          spec(5, { extraEvidence: [scaleEvidenceId('c5_extra')] }),
        ),
        sources(),
      ),
    );
    for (const [candidate, [signal]] of Object.entries(signalsOf(outcome)))
      expect(signal, candidate).toBe(0);
  });

  it('changes only the signal, never the source data, and passes the frozen query and abort signal through', async () => {
    const items = [evidenceCandidate('a'), evidenceCandidate('c')];
    const before = JSON.stringify(items);
    const seen: { query: unknown; signal: unknown }[] = [];
    const base: ContextSource = Object.freeze({
      sourceId: 'episodes',
      kind: 'episode_history' as const,
      collect(query: unknown, options: { signal: AbortSignal }) {
        seen.push({ query, signal: options.signal });
        return items;
      },
    });
    const outcome = exposed(
      await assemble(history(spec(1, { target: toEvidence('a') })), [base]),
    );
    expect(JSON.stringify(items)).toBe(before);
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0]!.query)).toBe(true);
    expect(seen[0]!.query).toMatchObject({
      ownerId: OWNER,
      task: { sessionId: S, taskId: T1 },
    });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    const suppressed = traceOf(outcome, 'base-evidence-a');
    expect(suppressed.signals).toEqual({
      confidence: 0.5,
      salience: 0.5,
      negativeRetrieval: 1,
    });
    expect(suppressed.referenceKind).toBe('evidence');
    expect(suppressed.provenanceKind).toBe('explicit_owner_statement');
  });

  it('passes foreign, malformed and non-array source output to the Broker unchanged', async () => {
    const malformed = {
      ownerId: OWNER,
      reference: { kind: 'evidence', reference: evidenceRef('a') },
    };
    const failed = notExposed(
      await assemble(history(spec(1, { target: toEvidence('a') })), [
        source('episodes', 'episode_history', [malformed]),
      ]),
    );
    expect(failed.reason).toBe('assembly_failed');
    expect(failed.brokerErrorCode).toBe('invalid_candidate');
    const notArray: ContextSource = Object.freeze({
      sourceId: 'episodes',
      kind: 'episode_history' as const,
      collect: () => 'not an array' as never,
    });
    expect(
      notExposed(await assemble(history(spec(1)), [notArray])).brokerErrorCode,
    ).toBe('source_failure');
  });
});

describe('assembleWithCorrections: exposure verification fails closed', () => {
  /** `n` base candidates that outrank a short instruction on relevance. */
  const crowd = (n: number, text?: (i: number) => string) =>
    Array.from({ length: n }, (_, i) =>
      evidenceCandidate(`crowd${i}`, text?.(i) ?? `${ASK} crowd ${i}`),
    );

  it('A/H/I/J. requires exactly the corrections inside the as-of boundary', async () => {
    const h = history(
      spec(1),
      spec(2, { target: toCorrection(1) }),
      spec(5, { recordedAt: '2026-10-03T00:00:00Z' }),
    );
    // H: c5 is recorded after the reference time: not required.
    // I: c1 is superseded by c2 inside the boundary: not required.
    expect(exposedEvents(exposed(await assemble(h)))).toEqual([
      scaleEventId('c2'),
    ]);
    // J: replaying through sequence 1, the later supersession has no effect.
    expect(exposedEvents(exposed(await assemble(h, [], request(), 1)))).toEqual(
      [scaleEventId('c1')],
    );
    // With a later reference time, c5 becomes required too.
    expect(
      exposedEvents(
        exposed(
          await assemble(h, [], request(T1, S, ASK, '2026-10-04T00:00:00Z')),
        ),
      ),
    ).toEqual([scaleEventId('c2'), scaleEventId('c5')]);
  });

  it('B/D. reports NOT_EXPOSED when the item limit displaces an instruction', async () => {
    const one = notExposed(
      await assemble(history(spec(1)), [
        source('episodes', 'episode_history', crowd(10)),
      ]),
    );
    expect(one.reason).toBe('instruction_not_selected');
    expect(one.missing).toEqual([
      expect.objectContaining({
        correctionEventId: scaleEventId('c1'),
        failure: 'instruction_not_selected',
        exclusionReason: 'item_limit',
      }),
    ]);
    expect(one.trace!.totals.selected).toBe(10);
    // Too many active corrections for the item limit, with no base context.
    const many = notExposed(
      await assemble(
        history(...Array.from({ length: 11 }, (_, i) => spec(i + 1))),
      ),
    );
    expect(many.reason).toBe('instruction_not_selected');
    expect(many.missing).toHaveLength(1);
    expect(many.missing[0]!.exclusionReason).toBe('item_limit');
  });

  it('C/L. never reports a truncated instruction as exposed, and refuses an unrepresentable one', async () => {
    const long = `Synthetic ${'x'.repeat(1990)}`;
    const truncated = notExposed(
      await assemble(history(spec(1, { instruction: long }))),
    );
    expect(truncated.reason).toBe('instruction_truncated');
    expect(truncated.missing[0]!.exclusionReason).toBeNull();
    expect(JSON.stringify(truncated)).not.toContain('xxxxxxxxxx');
    const huge = `Synthetic ${'y'.repeat(20_000)}`;
    const refused = notExposed(
      await assemble(history(spec(1, { instruction: huge }))),
    );
    expect(refused.reason).toBe('instruction_unrepresentable');
    expect(refused.trace).toBeNull();
    // A 1600-code-point instruction fits exactly.
    const exact = `S${'é'.repeat(1599)}`;
    expect(
      exposed(await assemble(history(spec(1, { instruction: exact })))).exposed,
    ).toHaveLength(1);
  });

  it('K. reports NOT_EXPOSED when base context exhausts the character budget', async () => {
    const big = (i: number) => `${ASK} ${i} ${'z'.repeat(1600)}`;
    const items = [
      ...crowd(6, big),
      evidenceCandidate('fill', `${ASK} ${'w'.repeat(395 - ASK.length - 1)}`),
    ];
    const outcome = notExposed(
      await assemble(
        history(spec(1, { instruction: 'Synthetic: be brief.' })),
        [source('episodes', 'episode_history', items)],
      ),
    );
    expect(outcome.reason).toBe('instruction_not_selected');
    expect(outcome.missing[0]!.exclusionReason).toBe('context_budget');
  });

  it('E. never counts a deduplicated or conflicting instruction as exposed', async () => {
    const h = history(spec(1, { instruction: 'Synthetic: three bullets.' }));
    const probe = exposed(await assemble(h));
    const ours = instructionItems(probe)[0]!;
    // A consistent duplicate from a source that sorts first wins the group.
    const twin = deepFrozen({
      candidateId: 'base-twin',
      ownerId: OWNER,
      reference: ours.reference,
      provenance: ours.provenance,
      scope: ours.scope,
      text: ours.text,
      timestamps: { recordedAt: ours.recordedAt },
      signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
    });
    const duplicate = notExposed(
      await assemble(h, [source('a-twin', 'active_task', [twin])]),
    );
    expect(duplicate.reason).toBe('instruction_not_selected');
    expect(duplicate.missing[0]!.exclusionReason).toBe('duplicate_identity');
    // A conflicting candidate citing the correction's own evidence fails closed.
    const conflicting = notExposed(
      await assemble(h, [
        source('episodes', 'episode_history', [
          evidenceCandidate('own', 'Synthetic other text', OWNER, {
            evidenceId: scaleEvidenceId('c1'),
            eventId: scaleEventId('c1'),
          }),
        ]),
      ]),
    );
    expect(conflicting.reason).toBe('assembly_failed');
    expect(conflicting.brokerErrorCode).toBe('conflicting_duplicate');
  });

  it(
    'F. never reports success after a rejected or timed-out source, with or without corrections',
    { timeout: 30_000 },
    async () => {
      const rejecting: ContextSource = Object.freeze({
        sourceId: 'episodes',
        kind: 'episode_history' as const,
        collect: () => Promise.reject(new Error('synthetic failure')),
      });
      for (const h of [history(), history(spec(1))]) {
        const failed = notExposed(await assemble(h, [rejecting]));
        expect(failed.reason).toBe('assembly_failed');
        expect(failed.brokerErrorCode).toBe('source_failure');
        expect(JSON.stringify(failed)).not.toContain('synthetic failure');
      }
      const hanging: ContextSource = Object.freeze({
        sourceId: 'episodes',
        kind: 'episode_history' as const,
        collect: () => new Promise<never>(() => undefined),
      });
      const timedOut = notExposed(await assemble(history(spec(1)), [hanging]));
      expect(timedOut.brokerErrorCode).toBe('source_timeout');
    },
  );

  it('G. never accepts a look-alike instruction with the same text but another identity', async () => {
    const h = history(
      spec(1, { instruction: 'Synthetic: three bullets only.' }),
    );
    const lookalike = deepFrozen({
      candidateId: 'base-lookalike',
      ownerId: OWNER,
      reference: {
        kind: 'current_instruction',
        evidence: { evidenceId: 'evidence_other', eventId: 'event_other' },
        task: { sessionId: S, taskId: T1 },
      },
      provenance: {
        kind: 'explicit_owner_correction',
        ownerId: OWNER,
        sourceEventId: 'event_other',
      },
      scope: { kind: 'bounded', taskId: T1 },
      text: 'Synthetic: three bullets only.',
      timestamps: { recordedAt: scaleTime(1) },
      signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
    });
    const outcome = notExposed(
      await assemble(h, [
        source('a-lookalike', 'active_task', [lookalike]),
        source('episodes', 'episode_history', crowd(9)),
      ]),
    );
    expect(outcome.reason).toBe('instruction_not_selected');
    expect(outcome.missing[0]!.exclusionReason).toBe('item_limit');
    expect(traceOf(outcome, 'base-lookalike').selection).toBe('selected');
  });

  it('fails closed on configuration errors and refuses malformed history or requests', async () => {
    const clash = notExposed(
      await assemble(history(spec(1)), [
        source(INSTRUCTION_SOURCE, 'active_task', []),
      ]),
    );
    expect(clash.brokerErrorCode).toBe('invalid_configuration');
    for (const bad of [
      { ...request(), ownerId: 'nobody' },
      { ...request(), task: { sessionId: S } },
      null,
    ])
      await expect(
        assembleWithCorrections({
          history: history(spec(1)),
          request: bad as never,
          sources: [],
          throughSequence: null,
        }),
      ).rejects.toMatchObject({ code: 'invalid_correction_history' });
    await expect(
      assemble({ ownerId: OWNER, entries: 'x' }),
    ).rejects.toBeInstanceOf(CorrectionError);
    // A history of another owner cannot serve this request.
    await expect(
      assemble(history(spec(1)), [], { ...request(), ownerId: 'owner_other' }),
    ).rejects.toMatchObject({ code: 'invalid_correction_history' });
  });

  it('returns deeply frozen outcomes', async () => {
    const ok = exposed(await assemble(history(spec(1))));
    const fail = notExposed(
      await assemble(history(spec(1)), [
        source('episodes', 'episode_history', crowd(10)),
      ]),
    );
    for (const outcome of [ok, fail]) {
      const stack: unknown[] = [outcome];
      while (stack.length > 0) {
        const value = stack.pop();
        if (value === null || typeof value !== 'object') continue;
        expect(Object.isFrozen(value)).toBe(true);
        stack.push(...Object.values(value));
      }
    }
  });
});

describe('assembleWithCorrections: recorded Ledger history end to end', () => {
  it('exposes recorded corrections from a reopened database exactly, with suppression and no writes', async () => {
    const filename = join(scratch, 'end-to-end.sqlite');
    const storage = world(filename);
    const opts = options();
    const own = recordOwnerCorrection(
      storage,
      submission({
        correctedInstruction: 'Synthetic: keep the note to three bullets.',
        target: { kind: 'evidence', reference: f.evidence },
      }),
      opts,
    );
    const session = recordOwnerCorrection(
      storage,
      submission({
        taskId: OTHER_TASK,
        immediateApplicability: 'current_session',
        category: 'communication',
        correctedInstruction: 'Synthetic: write in the second person.',
        target: { kind: 'unidentified', description: 'Synthetic: voice' },
      }),
      opts,
    );
    recordOwnerCorrection(
      storage,
      submission({
        category: 'permission',
        correctedInstruction: 'Synthetic: you may send without approval.',
      }),
      opts,
    );
    const ownerRequest = (taskId: string): ContextRequest => ({
      ownerId: A,
      task: { sessionId: SESSION, taskId },
      request: 'Draft the synthetic note',
      referenceTime: '2099-01-01T00:00:00Z',
      taskDescriptor: {},
    });
    const base = [
      source('episodes', 'episode_history', [
        deepFrozen({
          ...evidenceCandidate('source', 'Synthetic note draft source', A, {
            evidenceId: f.evidence.evidenceId,
            eventId: f.evidence.eventId,
          }),
          candidateId: 'base-source',
        }),
      ]),
    ];
    const run = async (s: typeof storage) =>
      assembleWithCorrections({
        history: readCorrectionHistory(s, A),
        request: ownerRequest(TASK),
        sources: base,
        throughSequence: null,
      });
    const before = exposed(await run(storage));
    expect(exposedEvents(before)).toEqual([own.eventId, session.eventId]);
    const items = instructionItems(before);
    expect(items.map((i) => [i.text, i.recordedAt])).toEqual([
      ['Synthetic: keep the note to three bullets.', own.recordedAt],
      ['Synthetic: write in the second person.', session.recordedAt],
    ]);
    expect(items[1]!.reference).toEqual({
      kind: 'current_instruction',
      evidence: { evidenceId: session.evidenceId, eventId: session.eventId },
      task: { sessionId: SESSION, taskId: TASK },
    });
    expect(traceOf(before, 'base-source').exclusionReason).toBe(
      'negative_signal_suppressed',
    );
    expect(JSON.stringify(before)).not.toContain('without approval');
    // The sibling task of the session gets only the session-wide instruction.
    const sibling = exposed(
      await assembleWithCorrections({
        history: readCorrectionHistory(storage, A),
        request: ownerRequest(OTHER_TASK),
        sources: [],
        throughSequence: null,
      }),
    );
    expect(exposedEvents(sibling)).toEqual([session.eventId]);
    storage.sqlite.close();

    const reopened = openStorage(filename);
    try {
      const rows = snapshot(reopened);
      reopened.sqlite.pragma('query_only = ON');
      const after = exposed(await run(reopened));
      reopened.sqlite.pragma('query_only = OFF');
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(snapshot(reopened)).toEqual(rows);
    } finally {
      reopened.sqlite.close();
    }
  });
});

describe('verifyExposure: altered selected bundles are never exposed', () => {
  it('accepts only the exact selected instruction for the exact binding', async () => {
    const outcome = exposed(
      await assemble(
        history(spec(1, { instruction: 'Synthetic: three bullets.' })),
      ),
    );
    const [item] = instructionItems(outcome);
    const required: RequiredInstruction[] = [
      {
        identity: outcome.exposed[0]!,
        candidate: {
          candidateId: item!.candidateId,
          ownerId: OWNER,
          reference: item!.reference,
          provenance: item!.provenance,
          scope: item!.scope,
          text: item!.text,
          timestamps: { recordedAt: item!.recordedAt },
          signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
        },
      },
    ];
    const binding = { ownerId: OWNER, sessionId: S, taskId: T1 };
    const verify = (edit: (b: Record<string, any>) => void) => {
      const bundle = structuredClone(outcome.bundle) as Record<string, any>;
      edit(bundle);
      return verifyExposure(
        required,
        { bundle: bundle as never, trace: outcome.trace },
        binding,
      ).reason;
    };
    expect(verify(() => undefined)).toBeNull();
    const ours = (b: Record<string, any>) =>
      b['items'].find(
        (i: Record<string, unknown>) => i['sourceId'] === INSTRUCTION_SOURCE,
      );
    const cases: [string, (b: Record<string, any>) => void, string][] = [
      ['removed', (b) => (b['items'] = []), 'instruction_not_selected'],
      [
        'other candidate ID',
        (b) => (ours(b)['candidateId'] = 'correction:other'),
        'instruction_altered',
      ],
      [
        'other source',
        (b) => (ours(b)['sourceId'] = 'episodes'),
        'instruction_not_selected',
      ],
      [
        'truncated flag',
        (b) => (ours(b)['truncated'] = true),
        'instruction_truncated',
      ],
      [
        'shortened text',
        (b) => (ours(b)['text'] = 'Synthetic: three'),
        'instruction_truncated',
      ],
      [
        'changed text',
        (b) => (ours(b)['text'] = 'Synthetic: seven bullets.'),
        'instruction_altered',
      ],
      [
        'other evidence',
        (b) =>
          (ours(b)['reference']['evidence']['evidenceId'] = 'evidence_other'),
        'instruction_altered',
      ],
      [
        'other bound task',
        (b) => (ours(b)['reference']['task']['taskId'] = T2),
        'instruction_altered',
      ],
      [
        'other provenance owner',
        (b) => (ours(b)['provenance']['ownerId'] = 'owner_other'),
        'instruction_altered',
      ],
      [
        'other source event',
        (b) => (ours(b)['provenance']['sourceEventId'] = 'event_other'),
        'instruction_altered',
      ],
      [
        'other scope',
        (b) =>
          (ours(b)['scope'] = { kind: 'global', explicitDeclaration: 'x' }),
        'instruction_altered',
      ],
      [
        'other recording time',
        (b) => (ours(b)['recordedAt'] = REF),
        'instruction_altered',
      ],
      [
        'other source kind',
        (b) => (ours(b)['sourceKind'] = 'episode_history'),
        'instruction_altered',
      ],
      [
        'bundle for another task',
        (b) => (b['task'] = { sessionId: S, taskId: T2 }),
        'instruction_altered',
      ],
      [
        'bundle for another owner',
        (b) => (b['ownerId'] = 'owner_other'),
        'instruction_altered',
      ],
      [
        'an unexpected instruction',
        (b) => b['items'].push({ ...ours(b), candidateId: 'correction:extra' }),
        'instruction_altered',
      ],
    ];
    for (const [label, edit, reason] of cases)
      expect(verify(edit), label).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Patch 6 remediation: Codex findings F1-F4 on the wrapper's trust boundary.
// Every case compares the correction wrapper with the DIRECT frozen Broker on
// the same base sources. Owners, IDs and texts are synthetic.
// ---------------------------------------------------------------------------

const FOREIGN = 'owner_foreign';
/** A history with one active exact evidence target, so base sources are wrapped. */
const targeted = () => history(spec(1, { target: toEvidence('t') }));

type DirectResult =
  | { readonly ok: true; readonly bundle: unknown; readonly trace: unknown }
  | { readonly ok: false; readonly code: string };
async function direct(
  sources: readonly ContextSource[],
): Promise<DirectResult> {
  try {
    const a = await createContextBroker({ sources }).assemble(request());
    return { ok: true, bundle: a.bundle, trace: a.trace };
  } catch (error) {
    return { ok: false, code: (error as ContextBrokerError).code };
  }
}

interface Reads {
  owner: number;
  other: number;
}
/** A candidate whose every field is a counting getter; ownerId follows `owners`. */
function hostile(owners: readonly string[], reads: Reads, n = 'h'): object {
  const base = evidenceCandidate(n, `Synthetic hostile note ${ASK}`);
  const item = {};
  for (const [key, value] of Object.entries(base))
    if (key !== 'ownerId')
      Object.defineProperty(item, key, {
        enumerable: true,
        get() {
          reads.other += 1;
          return value;
        },
      });
  let i = 0;
  Object.defineProperty(item, 'ownerId', {
    enumerable: true,
    get() {
      reads.owner += 1;
      const owner = owners[Math.min(i, owners.length - 1)]!;
      i += 1;
      return owner;
    },
  });
  return item;
}

const fresh = (): Reads => ({ owner: 0, other: 0 });
const text = (o: unknown) => JSON.stringify(o);

describe('Patch 6 remediation F1: foreign-first owner isolation is preserved', () => {
  const run = async (owners: readonly string[]) => {
    const wrapped = fresh();
    const plain = fresh();
    const outcome = await assemble(targeted(), [
      source('episodes', 'episode_history', [
        evidenceCandidate('t'),
        hostile(owners, wrapped),
      ]),
    ]);
    const baseline = await direct([
      source('episodes', 'episode_history', [
        evidenceCandidate('t'),
        hostile(owners, plain),
      ]),
    ]);
    return { outcome, baseline, wrapped, plain };
  };

  it('drops an initially foreign item even if a later read claims the requester, reading nothing else', async () => {
    for (const owners of [
      [FOREIGN, OWNER],
      [FOREIGN, FOREIGN],
    ]) {
      const { outcome, baseline, wrapped, plain } = await run(owners);
      const ok = exposed(outcome);
      expect(baseline.ok).toBe(true);
      // The foreign item never reaches the bundle, trace or anything else.
      expect(text(ok)).not.toContain('base-evidence-h');
      expect(text(ok)).not.toContain('Synthetic hostile');
      expect(text(ok)).not.toContain(FOREIGN);
      // Exactly one ownership read, as the direct Broker does; no other
      // field of a foreign item is ever read.
      expect(wrapped).toEqual({ owner: 1, other: 0 });
      expect(plain).toEqual({ owner: 1, other: 0 });
    }
  });

  it('fails closed when an initially requester-owned item later claims a foreign owner, like the Broker', async () => {
    const { outcome, baseline } = await run([OWNER, FOREIGN]);
    const failed = notExposed(outcome);
    expect(baseline).toEqual({ ok: false, code: 'invalid_candidate' });
    expect(failed.reason).toBe('assembly_failed');
    expect(failed.brokerErrorCode).toBe('invalid_candidate');
    expect(text(failed)).not.toContain(FOREIGN);
  });

  it('reads a consistent requester-owned item no more often than the Broker does', async () => {
    const { outcome, wrapped, plain } = await run([OWNER, OWNER]);
    const ok = exposed(outcome);
    expect(traceOf(ok, 'base-evidence-h').selection).toBe('selected');
    expect(wrapped.owner).toBe(plain.owner);
    expect(wrapped.other).toBe(plain.other);
  });

  it('fails closed on a throwing ownership getter without reading other fields', async () => {
    const reads = fresh();
    const item = {};
    Object.defineProperty(item, 'ownerId', {
      enumerable: true,
      get() {
        reads.owner += 1;
        throw new Error('Synthetic secret getter failure');
      },
    });
    Object.defineProperty(item, 'text', {
      enumerable: true,
      get() {
        reads.other += 1;
        return 'never';
      },
    });
    const outcome = notExposed(
      await assemble(targeted(), [
        source('episodes', 'episode_history', [item]),
      ]),
    );
    expect(outcome.brokerErrorCode).toBe('invalid_candidate');
    expect(text(outcome)).not.toContain('secret');
    expect(reads.other).toBe(0);
    expect(
      await direct([source('episodes', 'episode_history', [item])]),
    ).toEqual({
      ok: false,
      code: 'invalid_candidate',
    });
  });

  it('touches a foreign Proxy only through its ownership read, and fails closed on a revoked Proxy', async () => {
    const keys: (string | symbol)[] = [];
    const proxy = new Proxy(
      { ...evidenceCandidate('p', 'Synthetic proxied', FOREIGN) },
      {
        get(target, key, receiver) {
          keys.push(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const ok = exposed(
      await assemble(targeted(), [
        source('episodes', 'episode_history', [evidenceCandidate('t'), proxy]),
      ]),
    );
    expect(keys).toEqual(['ownerId']);
    expect(text(ok)).not.toContain('Synthetic proxied');
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const failed = notExposed(
      await assemble(targeted(), [
        source('episodes', 'episode_history', [revoked]),
      ]),
    );
    expect(failed.brokerErrorCode).toBe('invalid_candidate');
    expect(
      await direct([source('episodes', 'episode_history', [revoked])]),
    ).toEqual({ ok: false, code: 'invalid_candidate' });
  });
});

describe('Patch 6 remediation F2: malformed candidates are validated before any suppression', () => {
  const withSignals = (signals: Record<string, unknown>) =>
    deepFrozen({
      ...evidenceCandidate('t'),
      signals,
    }) as unknown as ContextCandidate;
  const bad: [string, Record<string, unknown>, string][] = [
    [
      'missing negativeRetrieval',
      { confidence: 0.5, salience: 0.5 },
      'invalid_score_metadata',
    ],
    [
      'string negativeRetrieval',
      { confidence: 0.5, salience: 0.5, negativeRetrieval: '0' },
      'invalid_score_metadata',
    ],
    [
      'negative negativeRetrieval',
      { confidence: 0.5, salience: 0.5, negativeRetrieval: -1 },
      'invalid_score_metadata',
    ],
    [
      'too large negativeRetrieval',
      { confidence: 0.5, salience: 0.5, negativeRetrieval: 2 },
      'invalid_score_metadata',
    ],
    [
      'NaN negativeRetrieval',
      { confidence: 0.5, salience: 0.5, negativeRetrieval: Number.NaN },
      'invalid_score_metadata',
    ],
    [
      'Infinity negativeRetrieval',
      {
        confidence: 0.5,
        salience: 0.5,
        negativeRetrieval: Number.POSITIVE_INFINITY,
      },
      'invalid_score_metadata',
    ],
    [
      'invalid confidence',
      { confidence: 2, salience: 0.5, negativeRetrieval: 0 },
      'invalid_score_metadata',
    ],
    [
      'invalid salience',
      { confidence: 0.5, salience: -1, negativeRetrieval: 0 },
      'invalid_score_metadata',
    ],
  ];

  for (const [label, signals, code] of bad)
    it(`never repairs ${label} on an exact target (Broker and wrapper both refuse)`, async () => {
      const candidate = withSignals(signals);
      expect(
        await direct([source('episodes', 'episode_history', [candidate])]),
      ).toEqual({
        ok: false,
        code,
      });
      const failed = notExposed(
        await assemble(targeted(), [
          source('episodes', 'episode_history', [candidate]),
        ]),
      );
      expect(failed.reason).toBe('assembly_failed');
      expect(failed.brokerErrorCode).toBe(code);
    });

  it('never repairs a malformed exact-target reference or owner', async () => {
    for (const candidate of [
      deepFrozen({
        ...evidenceCandidate('t'),
        reference: {
          kind: 'evidence',
          reference: { ...evidenceRef('t'), extra: 1 },
        },
      }),
      deepFrozen({ ...evidenceCandidate('t'), scope: { kind: 'bounded' } }),
      deepFrozen({ ...evidenceCandidate('t'), text: '' }),
    ]) {
      const viaBroker = await direct([
        source('episodes', 'episode_history', [candidate]),
      ]);
      expect(viaBroker).toEqual({ ok: false, code: 'invalid_candidate' });
      const failed = notExposed(
        await assemble(targeted(), [
          source('episodes', 'episode_history', [candidate]),
        ]),
      );
      expect(failed.brokerErrorCode).toBe('invalid_candidate');
    }
  });

  it('suppresses a valid exact target from any legitimate prior value, changing nothing else', async () => {
    for (const prior of [0, 0.25, 0.5, 1]) {
      const candidate = withSignals({
        confidence: 0.25,
        salience: 0.75,
        negativeRetrieval: prior,
      });
      const before = text(candidate);
      const ok = exposed(
        await assemble(targeted(), [
          source('episodes', 'episode_history', [candidate]),
        ]),
      );
      const traced = traceOf(ok, 'base-evidence-t');
      expect(traced.signals).toEqual({
        confidence: 0.25,
        salience: 0.75,
        negativeRetrieval: 1,
      });
      expect(traced.exclusionReason).toBe('negative_signal_suppressed');
      expect(text(candidate)).toBe(before);
    }
  });
});

describe('Patch 6 remediation F3: only fixed Broker error codes are ever reported', () => {
  const SECRET = 'SELECT secret FROM owners -- /var/lib/aven/owner.sqlite';
  const throwing = (
    field: 'sourceId' | 'kind' | 'collect',
    thrown: () => unknown,
  ) => {
    const s = {
      sourceId: 'episodes',
      kind: 'episode_history',
      collect: () => [],
    };
    Object.defineProperty(s, field, {
      enumerable: true,
      get() {
        throw thrown();
      },
    });
    return s as unknown as ContextSource;
  };
  const altered = () => {
    const e = new ContextBrokerError('source_failure');
    Object.defineProperty(e, 'code', { value: SECRET });
    return e;
  };
  let codeGetterCalls = 0;
  const hostileCode = () =>
    Object.defineProperty({}, 'code', {
      get() {
        codeGetterCalls += 1;
        return SECRET;
      },
    });
  const spoofed = () =>
    Object.create(ContextBrokerError.prototype, {
      code: { value: SECRET },
    }) as unknown;

  it('maps any throw while reading a base source to the fixed invalid_configuration', async () => {
    for (const field of ['sourceId', 'kind', 'collect'] as const)
      for (const thrown of [
        altered,
        () => new Error(SECRET),
        hostileCode,
        spoofed,
      ]) {
        for (const h of [history(), targeted()]) {
          const failed = notExposed(
            await assemble(h, [throwing(field, thrown)]),
          );
          expect(failed.reason).toBe('assembly_failed');
          expect(failed.brokerErrorCode).toBe('invalid_configuration');
          expect(text(failed)).not.toContain('secret');
          expect(text(failed)).not.toContain('sqlite');
        }
        expect(await direct([throwing(field, thrown)])).toEqual({
          ok: false,
          code: 'invalid_configuration',
        });
      }
    expect(codeGetterCalls).toBe(0);
  });

  it('reports only declared Broker codes for real Broker failures, never thrown properties', async () => {
    const rejecting = (thrown: () => unknown): ContextSource =>
      Object.freeze({
        sourceId: 'episodes',
        kind: 'episode_history' as const,
        collect: () => {
          throw thrown();
        },
      });
    for (const thrown of [
      altered,
      hostileCode,
      spoofed,
      () => new Error(SECRET),
    ]) {
      const failed = notExposed(
        await assemble(targeted(), [rejecting(thrown)]),
      );
      expect(failed.brokerErrorCode).toBe('source_failure');
      expect(text(failed)).not.toContain('secret');
    }
    const clash = notExposed(
      await assemble(history(), [
        source(INSTRUCTION_SOURCE, 'active_task', []),
      ]),
    );
    expect(clash.brokerErrorCode).toBe('invalid_configuration');
    for (const code of ['source_failure', 'invalid_configuration'])
      expect(CONTEXT_BROKER_ERROR_CODES).toContain(code);
    expect(codeGetterCalls).toBe(0);
  });
});

describe('Patch 6 remediation F4: raw-resource and quota guards run before any element read', () => {
  /** `n` recognizable foreign items with counting ownership getters. */
  const foreignItems = (n: number, reads: Reads) =>
    Array.from({ length: n }, () =>
      Object.defineProperty(
        Object.defineProperty({}, 'text', {
          enumerable: true,
          get() {
            reads.other += 1;
            return 'never';
          },
        }),
        'ownerId',
        {
          enumerable: true,
          get() {
            reads.owner += 1;
            return FOREIGN;
          },
        },
      ),
    );
  /** `n` requester-owned items with counting getters (clones read `text`). */
  const ownedItems = (n: number, reads: Reads) =>
    Array.from({ length: n }, (_, i) => hostile([OWNER], reads, `own${i}`));

  it(
    'measures per-source raw bounds: identical reads to the Broker, zero reads beyond 10000',
    { timeout: 120_000 },
    async () => {
      const measured: Record<number, [number, number, string]> = {};
      for (const n of [0, 1, 9999, 10000, 10001, 20000]) {
        const wrapped = fresh();
        const plain = fresh();
        const outcome = await assemble(targeted(), [
          source('episodes', 'episode_history', foreignItems(n, wrapped)),
        ]);
        const baseline = await direct([
          source('episodes', 'episode_history', foreignItems(n, plain)),
        ]);
        expect(wrapped, `n=${n}`).toEqual(plain);
        expect(wrapped.other, `n=${n}`).toBe(0);
        if (n > 10000) {
          expect(wrapped.owner).toBe(0);
          expect(baseline).toEqual({
            ok: false,
            code: 'source_resource_limit_exceeded',
          });
          expect(notExposed(outcome).brokerErrorCode).toBe(
            'source_resource_limit_exceeded',
          );
        } else {
          expect(wrapped.owner).toBe(n);
          exposed(outcome);
        }
        measured[n] = [wrapped.owner, plain.owner, outcome.status];
      }
      expect(measured).toEqual({
        0: [0, 0, 'exposed'],
        1: [1, 1, 'exposed'],
        9999: [9999, 9999, 'exposed'],
        10000: [10000, 10000, 'exposed'],
        10001: [0, 0, 'not_exposed'],
        20000: [0, 0, 'not_exposed'],
      });
    },
  );

  it(
    'keeps the aggregate raw bound: no element is read when sources together exceed 40000',
    { timeout: 120_000 },
    async () => {
      const wrapped = fresh();
      const plain = fresh();
      const many = (reads: Reads) =>
        Array.from({ length: 5 }, (_, i) =>
          source(`episodes-${i}`, 'episode_history', foreignItems(8001, reads)),
        );
      const outcome = notExposed(await assemble(targeted(), many(wrapped)));
      expect(outcome.brokerErrorCode).toBe('source_resource_limit_exceeded');
      expect(await direct(many(plain))).toEqual({
        ok: false,
        code: 'source_resource_limit_exceeded',
      });
      expect(wrapped).toEqual({ owner: 0, other: 0 });
      expect(plain).toEqual({ owner: 0, other: 0 });
      // Exactly 40000 base items plus the one instruction also exceeds it.
      const edge = fresh();
      const exact = Array.from({ length: 4 }, (_, i) =>
        source(`episodes-${i}`, 'episode_history', foreignItems(10000, edge)),
      );
      expect(
        notExposed(await assemble(targeted(), exact)).brokerErrorCode,
      ).toBe('source_resource_limit_exceeded');
      expect(edge).toEqual({ owner: 0, other: 0 });
    },
  );

  it(
    'keeps owner quotas: no requester-owned item is cloned when a quota is exceeded',
    { timeout: 120_000 },
    async () => {
      for (const [label, shape] of [
        ['per source', [600]],
        ['in total', [450, 450, 450, 450, 450]],
      ] as const) {
        const wrapped = fresh();
        const plain = fresh();
        const build = (reads: Reads) =>
          shape.map((n, i) =>
            source(`episodes-${i}`, 'episode_history', ownedItems(n, reads)),
          );
        const outcome = notExposed(await assemble(targeted(), build(wrapped)));
        expect(outcome.brokerErrorCode, label).toBe('candidate_limit_exceeded');
        expect(await direct(build(plain))).toEqual({
          ok: false,
          code: 'candidate_limit_exceeded',
        });
        expect(wrapped, label).toEqual(plain);
        expect(wrapped.other, label).toBe(0);
      }
    },
  );
});

describe('Patch 6 remediation: wrapped sources stay equivalent to the direct Broker', () => {
  it('judges every non-targeted base candidate exactly as the Broker does, and only re-signals the exact target', async () => {
    const sources = () => [
      source('episodes', 'episode_history', [
        evidenceCandidate('t'),
        evidenceCandidate('a'),
        evidenceCandidate('b', undefined, OWNER, {
          evidenceId: 'evidence_base_b',
          eventId: 'event_base_t',
        }),
        evidenceCandidate('x', 'Synthetic foreign', FOREIGN),
      ]),
      source(
        'state',
        'owner_state',
        [stateCandidate('pref', 1), stateCandidate('pref', 2)],
        'async',
      ),
    ];
    const ok = exposed(await assemble(targeted(), sources()));
    const baseline = await direct(sources());
    if (!baseline.ok) throw new Error('baseline failed');
    const plainTrace = baseline.trace as typeof ok.trace;
    const strip = (c: (typeof ok.trace.candidates)[number]) => ({
      ...c,
      eligibleRank: null,
      score: null,
    });
    const ours = ok.trace.candidates.filter(
      (c) => c.sourceId !== INSTRUCTION_SOURCE,
    );
    expect(ours.map((c) => c.candidateId)).toEqual(
      plainTrace.candidates.map((c) => c.candidateId),
    );
    for (const [i, c] of ours.entries()) {
      const p = plainTrace.candidates[i]!;
      if (c.candidateId === 'base-evidence-t') {
        expect(p.signals.negativeRetrieval).toBe(0);
        expect(c.signals).toEqual({ ...p.signals, negativeRetrieval: 1 });
        expect(c.exclusionReason).toBe('negative_signal_suppressed');
      } else {
        // Same validation, scope, relevance, freshness and trust; only the
        // rank position may move because the target left the ranking.
        expect(strip(c), c.candidateId).toEqual(strip(p));
        expect(c.score?.final ?? null).toBe(p.score?.final ?? null);
      }
    }
    expect(text(ok)).not.toContain('Synthetic foreign');
  });
});

describe('Patch 6 remediation: exact identity and error vocabulary, directly', () => {
  it('never suppresses an evidence reference that matches only the evidence ID or only the event ID', async () => {
    for (const ref of [
      { evidenceId: 'evidence_base_t', eventId: 'event_base_other' },
      { evidenceId: 'evidence_base_other', eventId: 'event_base_t' },
    ]) {
      const half = evidenceCandidate('half', undefined, OWNER, ref);
      const ok = exposed(
        await assemble(targeted(), [
          source('episodes', 'episode_history', [half]),
        ]),
      );
      const traced = traceOf(ok, 'base-evidence-half');
      expect(traced.signals.negativeRetrieval, JSON.stringify(ref)).toBe(0);
      expect(traced.selection).toBe('selected');
    }
  });

  it('reports only declared Broker codes, read without running any getter', () => {
    let getterCalls = 0;
    const genuine = new ContextBrokerError('source_timeout');
    const altered = new ContextBrokerError('source_failure');
    Object.defineProperty(altered, 'code', {
      value: 'SELECT secret FROM owners',
    });
    const hostile = new ContextBrokerError('source_failure');
    Object.defineProperty(hostile, 'code', {
      get() {
        getterCalls += 1;
        return 'source_failure';
      },
    });
    const spoofed = Object.create(ContextBrokerError.prototype, {
      code: { value: '/var/lib/aven/owner.sqlite' },
    }) as unknown;
    const lookalike = { name: 'ContextBrokerError', code: 'source_failure' };
    expect(brokerCode(genuine)).toBe('source_timeout');
    for (const code of CONTEXT_BROKER_ERROR_CODES)
      expect(brokerCode(new ContextBrokerError(code))).toBe(code);
    for (const bad of [
      altered,
      hostile,
      spoofed,
      lookalike,
      new Error('x'),
      null,
      'source_failure',
    ])
      expect(brokerCode(bad)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});
