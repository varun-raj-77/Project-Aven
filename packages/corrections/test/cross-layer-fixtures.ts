/*
 * AVEN-010 patch 7: SYNTHETIC fixtures for the cross-layer validation
 * campaign (`cross-layer.test.ts`), its fresh-process replay
 * (`cross-layer-replay.ts`) and its diagnostic benchmark
 * (`bench/cross-layer.bench.ts`). Every owner, session, task, identifier,
 * time and text is invented and deterministic. This module imports no test
 * runner, so a separate Node process can rebuild exactly the same sources
 * and requests. It sets up test databases only: the direct Ledger appends
 * below produce correction shapes the recorder never does (supporting
 * evidence, no envelope task), and are test setup, not a production path.
 */
import * as c from '@aven/contracts';
import type {
  ContextCandidate,
  ContextRequest,
  ContextSource,
  ContextSourceKind,
} from '@aven/context-broker';
import { createLedger, type EventInput } from '@aven/ledger';
import type { Storage } from '@aven/storage';
import {
  assembleWithCorrections,
  type CorrectionAssemblyOutcome,
} from '../src/context-source/index.ts';
import {
  resolveImmediateCorrections,
  type ImmediateCorrectionView,
} from '../src/index.ts';
import {
  buildCorrectionEvidenceIndex,
  readCorrectionHistory,
  recordOwnerCorrection,
  type CorrectionReceipt,
  type CorrectionRecordingOptions,
  type PersistedCorrectionHistory,
} from '../src/ledger/index.ts';
import {
  A,
  as,
  B,
  f,
  OTHER_TASK,
  SECOND_SESSION,
  SECOND_TASK,
  SESSION,
  snapshot,
  submission,
  TASK,
  world,
} from './recorder-fixtures.ts';

export { A, B, OTHER_TASK, SECOND_SESSION, SECOND_TASK, SESSION, TASK };
type Json = Record<string, unknown>;

/** The synthetic Ledger recording clock: one minute per write from here. */
export const LEDGER_EPOCH_MS = Date.UTC(2026, 9, 5, 9, 0, 0);
/** A reference time after every scenario write. */
export const REFERENCE_TIME = '2026-10-06T00:00:00Z';
/** The request every scenario assembly uses (its words drive relevance). */
export const ASK = 'Summarize the quarterly report for the review';
/** Time of every synthetic base candidate. */
export const BASE_TIME = '2026-09-01T00:00:00Z';

/** Deterministic recorder options: exact IDs and an occurrence clock. */
export function named(
  name: string,
  occurredAt: string,
): CorrectionRecordingOptions {
  return {
    now: () => new Date(occurredAt),
    generateId: (prefix) => `${prefix}_${name}`,
  };
}

/** Occurrence times run BACKWARDS against Ledger sequence. */
export const occurred = (step: number) =>
  new Date(Date.UTC(2026, 0, 31) - step * 60_000).toISOString();

/** One unrelated owner-request event (a Ledger sequence gap for corrections). */
export function ordinary(storage: Storage, owner: string, name: string) {
  const eventId = `event_${name}`;
  const evidenceId = `evidence_${name}`;
  const provenance = {
    kind: 'explicit_owner_statement',
    ownerId: owner,
    sourceEventId: eventId,
  };
  const { recordedAt: _r, ...event } = as(owner, {
    kind: 'experience_event',
    ownerId: f.owner,
    metadata: f.metadata,
    id: eventId,
    task: f.task,
    occurredAt: f.time,
    recordedAt: f.later,
    evidenceIds: [evidenceId],
    eventType: 'owner_request',
    payload: { instruction: 'Synthetic unrelated request', task: f.task },
    provenance,
  }) as Json;
  const { recordedAt: _e, ...evidence } = as(owner, {
    ...f.recordedEvidence,
    id: evidenceId,
    eventId,
    provenance,
  }) as unknown as Json;
  return createLedger(storage, c.OwnerIdSchema.parse(owner)).appendEvent(
    event as unknown as EventInput,
    { evidence: [evidence as never] },
  );
}

export interface DirectSpec {
  readonly name: string;
  /** The own evidence ID; defaults to `evidence_<name>`. */
  readonly ownEvidence?: string;
  readonly instruction: string;
  readonly category?: string;
  readonly target?: Json;
  readonly applicability:
    | { kind: 'current_task'; task: { sessionId: string; taskId: string } }
    | { kind: 'current_session'; sessionId: string }
    | { kind: 'unspecified' };
  /** The envelope binding; `null` records no envelope task. */
  readonly envelope: { sessionId: string; taskId: string } | null;
  /** Suffixes of supporting evidence records (`evidence_<name>_<suffix>`). */
  readonly supporting?: readonly string[];
}

/**
 * Test-only DIRECT Ledger append of one owner_correction event, for shapes
 * the recorder never produces. The frozen Ledger still validates it.
 */
export function directCorrection(
  storage: Storage,
  owner: string,
  spec: DirectSpec,
) {
  const eventId = `event_${spec.name}`;
  const own = spec.ownEvidence ?? `evidence_${spec.name}`;
  const supporting = (spec.supporting ?? []).map(
    (s) => `evidence_${spec.name}_${s}`,
  );
  const metadata = {
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    creation: { component: '@aven/corrections', version: 'synthetic' },
  };
  const origin = {
    kind: 'explicit_owner_correction',
    ownerId: owner,
    sourceEventId: eventId,
  };
  const stored = createLedger(
    storage,
    c.OwnerIdSchema.parse(owner),
  ).appendEvent(
    {
      kind: 'experience_event',
      ownerId: owner,
      metadata,
      id: eventId,
      occurredAt: '2026-01-01T00:00:00.000Z',
      ...(spec.envelope === null ? {} : { task: spec.envelope }),
      evidenceIds: [own, ...supporting],
      eventType: 'owner_correction',
      payload: {
        kind: 'owner_correction',
        ownerId: owner,
        metadata,
        evidence: { evidenceId: own, eventId },
        provenance: origin,
        category: spec.category ?? 'communication',
        target: spec.target ?? {
          kind: 'unidentified',
          description: `Synthetic target of ${spec.name}`,
        },
        originalBehavior: `Synthetic original behavior of ${spec.name}`,
        correctedInstruction: spec.instruction,
        immediateApplicability: spec.applicability,
        durableScopeHint: { kind: 'unknown', reason: 'Synthetic: unknown' },
      },
      provenance: origin,
    } as unknown as EventInput,
    {
      evidence: [own, ...supporting].map((id, i) => ({
        kind: 'recorded_evidence',
        ownerId: owner,
        metadata,
        id,
        eventId,
        provenance: origin,
        content: {
          kind: 'recorded_text',
          text: i === 0 ? spec.instruction : `Synthetic supporting note ${i}`,
        },
      })) as never[],
    },
  );
  return { eventId, own, supporting, sequence: stored.sequence };
}

/** The scenario's texts. Owner B reuses every identifier with its own text. */
export const TEXT = Object.freeze({
  c1: 'Synthetic C1: summarize the quarterly report in three bullets.',
  c2: 'Synthetic C2: do not reuse the saved quarterly report tone.',
  c3: 'Synthetic C3: the quarterly report deadline is Friday.',
  c4: 'Synthetic C4: you may email the quarterly report to everyone.',
  c5: 'Synthetic C5: attach the quarterly report appendix.',
  c6: 'Synthetic C6: summarize the quarterly report in five bullets.',
  c7: 'Synthetic C7: keep the quarterly report review neutral.',
  b1: 'Synthetic owner-beta: summarize the quarterly report as a table.',
  b2: 'Synthetic owner-beta: email the quarterly report review today.',
  originalPrefix: 'Synthetic original:',
});

export interface Scenario {
  /** Owner A's correction receipts or direct appends, by scenario name. */
  readonly a: Readonly<
    Record<
      'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7',
      { eventId: string; evidenceId: string; sequence: number }
    >
  >;
  readonly aSupporting: string;
  readonly b: Readonly<
    Record<
      'b1' | 'b2',
      { eventId: string; evidenceId: string; sequence: number }
    >
  >;
}

const fromReceipt = (r: CorrectionReceipt) => ({
  eventId: r.eventId,
  evidenceId: r.evidenceId,
  sequence: r.sequence,
});

/**
 * The cross-layer scenario on a real (file-backed) SQLite database. `tick`
 * runs before every Ledger write so a caller can fix the recording clock.
 *
 * Owner A (owner-local sequences; unrelated events leave gaps):
 *   c1 current_task TASK, communication, target evidence (event_source)
 *   -- unrelated event
 *   c2 current_session SESSION, preference, target owner_state learned_synthetic v1
 *   c3 unspecified, origin OTHER_TASK, fact, unidentified target
 *   c4 permission, current_session SESSION, unidentified target
 *   -- unrelated event
 *   c5 current_task TASK (direct, one supporting evidence), procedure, target event c3
 *   c6 current_task TASK, communication, target c1's own evidence
 *   c7 current_task TASK, communication, target c5's SUPPORTING evidence
 * Owner B reuses the same session, task and correction identifier text.
 */
export function buildScenario(
  filename: string,
  tick: (step: number) => void = () => undefined,
): { storage: Storage; scenario: Scenario } {
  let step = 0;
  const next = () => {
    step += 1;
    tick(step);
    return step;
  };
  tick(0);
  const storage = world(filename);
  const rec = (owner: string, name: string, over: Json) =>
    fromReceipt(
      recordOwnerCorrection(
        storage,
        submission({
          ownerId: owner,
          originalBehavior: `${TEXT.originalPrefix} the draft of ${name}`,
          ...over,
        }),
        named(name, occurred(next())),
      ),
    );
  const c1 = rec(A, 'c1', {
    category: 'communication',
    target: { kind: 'evidence', reference: f.evidence },
    correctedInstruction: TEXT.c1,
    immediateApplicability: 'current_task',
  });
  next();
  ordinary(storage, A, 'unrelated_one');
  const c2 = rec(A, 'c2', {
    category: 'preference',
    target: { kind: 'owner_state', reference: f.learnedRef },
    correctedInstruction: TEXT.c2,
    immediateApplicability: 'current_session',
  });
  const c3 = rec(A, 'c3', {
    taskId: OTHER_TASK,
    category: 'fact',
    target: { kind: 'unidentified', description: 'Synthetic: the deadline' },
    correctedInstruction: TEXT.c3,
    immediateApplicability: 'unspecified',
  });
  const c4 = rec(A, 'c4', {
    category: 'permission',
    target: { kind: 'unidentified', description: 'Synthetic: sending email' },
    correctedInstruction: TEXT.c4,
    immediateApplicability: 'current_session',
  });
  next();
  ordinary(storage, A, 'unrelated_two');
  next();
  const c5Direct = directCorrection(storage, A, {
    name: 'c5',
    instruction: TEXT.c5,
    category: 'procedure',
    target: { kind: 'event', eventId: c3.eventId },
    applicability: {
      kind: 'current_task',
      task: { sessionId: SESSION, taskId: TASK },
    },
    envelope: { sessionId: SESSION, taskId: TASK },
    supporting: ['note'],
  });
  const c5 = {
    eventId: c5Direct.eventId,
    evidenceId: c5Direct.own,
    sequence: c5Direct.sequence,
  };
  const c6 = rec(A, 'c6', {
    category: 'communication',
    target: {
      kind: 'evidence',
      reference: { evidenceId: c1.evidenceId, eventId: c1.eventId },
    },
    correctedInstruction: TEXT.c6,
    immediateApplicability: 'current_task',
  });
  const c7 = rec(A, 'c7', {
    category: 'communication',
    target: {
      kind: 'evidence',
      reference: { evidenceId: c5Direct.supporting[0]!, eventId: c5.eventId },
    },
    correctedInstruction: TEXT.c7,
    immediateApplicability: 'current_task',
  });
  // Owner B: the same identifier text (c1, c2), its own texts and targets.
  const b1 = rec(B, 'c1', {
    category: 'communication',
    target: { kind: 'evidence', reference: f.evidence },
    correctedInstruction: TEXT.b1,
    immediateApplicability: 'current_session',
  });
  const b2 = rec(B, 'c2', {
    category: 'preference',
    target: { kind: 'owner_state', reference: f.learnedRef },
    correctedInstruction: TEXT.b2,
    immediateApplicability: 'current_task',
  });
  return {
    storage,
    scenario: {
      a: { c1, c2, c3, c4, c5, c6, c7 },
      aSupporting: c5Direct.supporting[0]!,
      b: { b1, b2 },
    },
  };
}

function deepFrozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFrozen(child);
    Object.freeze(value);
  }
  return value;
}

/** A frozen base evidence candidate (owner statement, global scope). */
export function evidenceCandidate(
  owner: string,
  candidateId: string,
  ref: { evidenceId: string; eventId: string },
  text: string,
  signals = { confidence: 0.5, salience: 0.5, negativeRetrieval: 0 },
): ContextCandidate {
  return deepFrozen({
    candidateId,
    ownerId: owner,
    reference: { kind: 'evidence', reference: { ...ref } },
    provenance: {
      kind: 'explicit_owner_statement',
      ownerId: owner,
      sourceEventId: ref.eventId,
    },
    scope: { kind: 'global', explicitDeclaration: 'Synthetic: everywhere' },
    text,
    timestamps: { recordedAt: BASE_TIME },
    signals: { ...signals },
  });
}

/** A frozen base owner-state candidate (trusted, system generated). */
export function stateCandidate(
  owner: string,
  candidateId: string,
  learnedItemId: string,
  version: number,
  text: string,
  signals = { confidence: 0.5, salience: 0.5, negativeRetrieval: 0 },
): ContextCandidate {
  return deepFrozen({
    candidateId,
    ownerId: owner,
    reference: {
      kind: 'owner_state',
      reference: { learnedItemId, version },
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
    signals: { ...signals },
  });
}

export function staticSource(
  sourceId: string,
  kind: ContextSourceKind,
  items: readonly unknown[],
): ContextSource {
  return Object.freeze({ sourceId, kind, collect: () => items });
}

/**
 * The scenario's base sources: owner A's evidence for `event_source`, owner
 * A's learned_synthetic v1 and v2, an unrelated note, and owner B records
 * reusing the same identifiers and candidate IDs (foreign to owner A).
 */
export function scenarioSources(): ContextSource[] {
  const statement = (owner: string, tag: string) =>
    evidenceCandidate(
      owner,
      'base-evidence-source',
      f.evidence,
      `Synthetic ${tag} note on the quarterly report source`,
    );
  return [
    staticSource('episodes', 'episode_history', [
      statement(B, 'owner-beta'),
      statement(A, 'owner-alpha'),
      evidenceCandidate(
        A,
        'base-evidence-unrelated',
        {
          evidenceId: 'evidence_unrelated_one',
          eventId: 'event_unrelated_one',
        },
        'Synthetic owner-alpha quarterly report review checklist',
      ),
    ]),
    staticSource('state', 'owner_state', [
      stateCandidate(
        A,
        'base-state-v1',
        f.learnedRef.learnedItemId,
        1,
        'Synthetic owner-alpha saved quarterly report tone v1',
      ),
      stateCandidate(
        A,
        'base-state-v2',
        f.learnedRef.learnedItemId,
        2,
        'Synthetic owner-alpha saved quarterly report tone v2',
      ),
      stateCandidate(
        B,
        'base-state-v1',
        f.learnedRef.learnedItemId,
        1,
        'Synthetic owner-beta saved quarterly report tone v1',
      ),
    ]),
  ];
}

export const scenarioRequest = (
  owner: string,
  sessionId: string,
  taskId: string,
  referenceTime = REFERENCE_TIME,
): ContextRequest => ({
  ownerId: owner,
  task: { sessionId, taskId },
  request: ASK,
  referenceTime,
  taskDescriptor: {},
});

export const BINDINGS: readonly (readonly [string, string])[] = [
  [SESSION, TASK],
  [SESSION, OTHER_TASK],
  [SECOND_SESSION, SECOND_TASK],
];

export interface PipelineResult {
  readonly history: PersistedCorrectionHistory;
  readonly index: ReturnType<typeof buildCorrectionEvidenceIndex>;
  readonly view: ImmediateCorrectionView;
  readonly outcome: CorrectionAssemblyOutcome;
}

/**
 * The whole read pipeline for one binding: Ledger replay, evidence index,
 * pure resolution and correction-aware Broker assembly with verification.
 */
export async function pipeline(
  storage: Storage,
  owner: string,
  sessionId: string,
  taskId: string,
  sources: readonly ContextSource[] = scenarioSources(),
  throughSequence: number | null = null,
  referenceTime = REFERENCE_TIME,
): Promise<PipelineResult> {
  const history = readCorrectionHistory(storage, owner);
  const index = buildCorrectionEvidenceIndex(history);
  const view = resolveImmediateCorrections(
    history,
    { ownerId: owner, sessionId, taskId },
    { referenceTime, throughSequence },
  );
  const outcome = await assembleWithCorrections({
    history,
    request: scenarioRequest(owner, sessionId, taskId, referenceTime),
    sources,
    throughSequence,
  });
  return { history, index, view, outcome };
}

/** A stable, comparable digest of a pipeline result (JSON, index flattened). */
export function comparable(result: PipelineResult) {
  return JSON.stringify({
    history: result.history,
    index: {
      ownerId: result.index.ownerId,
      corrections: result.index.corrections,
      evidence: result.index.corrections.flatMap((c) =>
        [c.ownEvidenceId, ...c.supportingEvidenceIds].map((id) =>
          result.index.evidence(id),
        ),
      ),
    },
    view: result.view,
    outcome: result.outcome,
  });
}

/** Every row of every table, plus SQLite's own change counter. */
export function logicalState(storage: Storage) {
  return {
    rows: snapshot(storage),
    schemaVersion: storage.sqlite.pragma('user_version', { simple: true }),
  };
}
export const totalChanges = (storage: Storage): number =>
  (
    storage.sqlite.prepare('SELECT total_changes() AS n').get() as {
      n: number;
    }
  ).n;
