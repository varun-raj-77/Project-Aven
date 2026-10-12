import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as c from '@aven/contracts';
import { createLedger, type EventInput } from '@aven/ledger';
import { deserializeContract, openStorage, type Storage } from '@aven/storage';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CorrectionError,
  resolveImmediateCorrections,
  type CorrectionErrorCode,
  type ImmediateCorrectionView,
} from '../src/index.ts';
import {
  buildCorrectionEvidenceIndex,
  readCorrectionHistory,
  recordOwnerCorrection,
  type CorrectionReceipt,
} from '../src/ledger/index.ts';
import {
  A,
  as,
  B,
  CLOCK,
  count,
  f,
  observed,
  options,
  OTHER_TASK,
  SECOND_SESSION,
  SECOND_TASK,
  SESSION,
  snapshot,
  submission,
  TASK,
  world,
} from './recorder-fixtures.ts';

/*
 * AVEN-010 patch 5: the read-only Ledger correction history and the
 * correction-evidence index. Every owner, session, task, identifier and text
 * is SYNTHETIC; databases are throwaway SQLite files or in-memory databases.
 * These are mechanics tests of reading and resolving recorded history.
 */

type Json = Record<string, unknown>;
const FAR = '2099-01-01T00:00:00Z';
const SOURCE_EVENT = f.evidence.eventId;
const scratch = mkdtempSync(join(tmpdir(), 'aven-p5-history-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function expectError(fn: () => unknown, code: CorrectionErrorCode) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CorrectionError);
  expect((caught as CorrectionError).code).toBe(code);
  expect('cause' in (caught as object)).toBe(false);
  return caught as CorrectionError;
}

const view = (
  history: unknown,
  sessionId: string,
  taskId: string,
  asOf: { referenceTime: string; throughSequence: number | null } = {
    referenceTime: FAR,
    throughSequence: null,
  },
  ownerId = A,
): ImmediateCorrectionView =>
  resolveImmediateCorrections(history, { ownerId, sessionId, taskId }, asOf);

/**
 * An INDEPENDENT reader for comparison: raw owner-scoped SQL over the stored
 * rows, deserialized with the frozen storage contracts (test-only).
 */
function rawHistory(storage: Storage, owner: string) {
  const rows = storage.sqlite
    .prepare(
      "SELECT sequence, record_json FROM experience_events WHERE owner_id = ? AND event_type = 'owner_correction' ORDER BY sequence",
    )
    .all(owner) as { sequence: number; record_json: string }[];
  return {
    ownerId: owner,
    entries: rows.map((row) => {
      const event = deserializeContract('experience_events', row.record_json);
      const evidence = (
        storage.sqlite
          .prepare(
            'SELECT record_json FROM evidence WHERE owner_id = ? AND event_id = ? ORDER BY record_id',
          )
          .all(owner, event.id) as { record_json: string }[]
      ).map((e) => deserializeContract('evidence', e.record_json));
      return { sequence: row.sequence, event, evidence };
    }),
  };
}

/** One ordinary owner-request event (unrelated to corrections), via the Ledger. */
function ordinary(storage: Storage, owner: string, n: number) {
  const eventId = `event_ordinary_${n}`;
  const evidenceId = `evidence_ordinary_${n}`;
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
  createLedger(storage, c.OwnerIdSchema.parse(owner)).appendEvent(
    event as unknown as EventInput,
    { evidence: [evidence as never] },
  );
}

/**
 * Test-only DIRECT Ledger append of an owner_correction event, for shapes
 * the recorder never produces (supporting evidence, inconsistent own text).
 */
function directCorrection(
  storage: Storage,
  owner: string,
  spec: {
    readonly name: string;
    readonly instruction: string;
    readonly ownText?: string;
    readonly supporting?: readonly string[];
    readonly target?: Json;
  },
) {
  const eventId = `event_${spec.name}`;
  const own = `evidence_${spec.name}`;
  const supporting = (spec.supporting ?? []).map(
    (s) => `evidence_${spec.name}_${s}`,
  );
  const metadata = {
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: CLOCK,
    creation: { component: '@aven/corrections', version: 'synthetic' },
  };
  const origin = {
    kind: 'explicit_owner_correction',
    ownerId: owner,
    sourceEventId: eventId,
  };
  const task = { sessionId: SESSION, taskId: TASK };
  createLedger(storage, c.OwnerIdSchema.parse(owner)).appendEvent(
    {
      kind: 'experience_event',
      ownerId: owner,
      metadata,
      id: eventId,
      occurredAt: CLOCK,
      task,
      evidenceIds: [own, ...supporting],
      eventType: 'owner_correction',
      payload: {
        kind: 'owner_correction',
        ownerId: owner,
        metadata,
        evidence: { evidenceId: own, eventId },
        provenance: origin,
        category: 'communication',
        target: spec.target ?? {
          kind: 'unidentified',
          description: 'Synthetic: the earlier draft',
        },
        originalBehavior: 'Synthetic original behavior',
        correctedInstruction: spec.instruction,
        immediateApplicability: { kind: 'current_task', task },
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
          text:
            i === 0
              ? (spec.ownText ?? spec.instruction)
              : `Synthetic supporting note ${i}`,
        },
      })) as never[],
    },
  );
  return { eventId, own, supporting };
}

const eventTarget = (eventId: string) => ({ kind: 'event', eventId });
const evidenceTarget = (evidenceId: string, eventId: string) => ({
  kind: 'evidence',
  reference: { evidenceId, eventId },
});

describe('readCorrectionHistory: basics and fixed failures', () => {
  it('reads an empty history as a frozen, resolvable value', () => {
    const storage = world();
    const history = readCorrectionHistory(storage, A);
    expect(history).toEqual({ ownerId: A, entries: [] });
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.entries)).toBe(true);
    expect(view(history, SESSION, TASK).active).toEqual([]);
    expect(buildCorrectionEvidenceIndex(history).corrections).toEqual([]);
  });

  it('reads one correction exactly as stored: sequence, event, own evidence, text and time', () => {
    const storage = world();
    const instruction = '  Synthetic: exact text — kept\twith spacing.\n';
    const receipt = recordOwnerCorrection(
      storage,
      submission({ correctedInstruction: instruction }),
      options(),
    );
    const history = readCorrectionHistory(storage, A);
    expect(history).toEqual(rawHistory(storage, A));
    expect(history.entries).toHaveLength(1);
    const [entry] = history.entries;
    expect(entry!.sequence).toBe(receipt.sequence);
    const event = entry!.event as c.ExperienceEvent;
    expect(event.id).toBe(receipt.eventId);
    expect(event.recordedAt).toBe(receipt.recordedAt);
    if (event.eventType !== 'owner_correction') throw new Error('type');
    expect(event.payload.correctedInstruction).toBe(instruction);
    expect(event.payload.target).toEqual(eventTarget(SOURCE_EVENT));
    expect(entry!.evidence).toEqual([
      expect.objectContaining({
        id: receipt.evidenceId,
        eventId: receipt.eventId,
        recordedAt: receipt.recordedAt,
        content: { kind: 'recorded_text', text: instruction },
      }),
    ]);
  });

  it('fails closed with fixed, non-disclosing codes', () => {
    const storage = world();
    recordOwnerCorrection(storage, submission(), options());
    const unknown = expectError(
      () => readCorrectionHistory(storage, 'owner_gamma'),
      'unknown_binding',
    );
    expect(JSON.stringify(unknown)).not.toContain('owner_gamma');
    for (const bad of ['not_an_owner', '', 7, null, undefined, { id: A }])
      expectError(
        () => readCorrectionHistory(storage, bad),
        'invalid_correction_history',
      );
    for (const notStorage of [null, undefined, {}, { sqlite: {} }, 'db'])
      expectError(
        () => readCorrectionHistory(notStorage as never, A),
        'storage_failure',
      );
    // Inside another transaction the frozen Ledger refuses to read.
    storage.sqlite.prepare('BEGIN').run();
    expectError(() => readCorrectionHistory(storage, A), 'storage_failure');
    storage.sqlite.prepare('ROLLBACK').run();
    expect(readCorrectionHistory(storage, A).entries).toHaveLength(1);
    // A closed database.
    const closed = world();
    closed.sqlite.close();
    expectError(() => readCorrectionHistory(closed, A), 'storage_failure');
  });
});

describe('readCorrectionHistory: complete paginated replay', () => {
  /** Records `n` corrections with an unrelated event after every 7th. */
  function populated(n: number) {
    const storage = world();
    const opts = options();
    const receipts: CorrectionReceipt[] = [];
    for (let i = 1; i <= n; i += 1) {
      receipts.push(
        recordOwnerCorrection(
          storage,
          submission({
            immediateApplicability:
              i % 3 === 0 ? 'current_session' : 'current_task',
            taskId: i % 2 === 0 ? TASK : OTHER_TASK,
            target: {
              kind: 'unidentified',
              description: `Synthetic correction ${i}`,
            },
            correctedInstruction: `Synthetic instruction ${i}`,
          }),
          // Occurrence times run BACKWARDS against Ledger sequence, so any
          // ordering by occurrence time instead of sequence is visible.
          { ...opts, now: () => new Date(Date.parse(CLOCK) - i * 1000) },
        ),
      );
      if (i % 7 === 0) ordinary(storage, A, i);
    }
    return { storage, receipts };
  }

  /** Page queries the Ledger issued for the correction replay. */
  const pageQueries = (calls: { sql: string }[]) =>
    calls.filter((call) =>
      /^SELECT sequence, record_json FROM experience_events WHERE/.test(
        call.sql,
      ),
    ).length;

  for (const n of [1, 99, 100, 101, 200, 250])
    it(`returns every correction, once, in sequence order across pages (${n})`, () => {
      const { storage, receipts } = populated(n);
      const { storage: watched, calls } = observed(storage);
      const history = readCorrectionHistory(watched, A);
      expect(history.entries.map((e) => e.sequence)).toEqual(
        receipts.map((r) => r.sequence),
      );
      expect(
        history.entries.map((e) => (e.event as c.ExperienceEvent).id),
      ).toEqual(receipts.map((r) => r.eventId));
      // Each page holds at most 100; a last page that is exactly full is not
      // followed by an empty extra page.
      expect(pageQueries(calls)).toBe(Math.max(1, Math.ceil(n / 100)));
      // Ledger sequence gaps from unrelated events are preserved.
      if (n >= 8)
        expect(
          history.entries[7]!.sequence - history.entries[6]!.sequence,
        ).toBe(2);
    });

  it(
    'reads more than 1000 corrections with gaps, matching an independent raw read exactly',
    { timeout: 120_000 },
    () => {
      const n = 1205;
      const { storage, receipts } = populated(n);
      const { storage: watched, calls } = observed(storage);
      const history = readCorrectionHistory(watched, A);
      expect(history.entries).toHaveLength(n);
      expect(pageQueries(calls)).toBe(13);
      const sequences = history.entries.map((e) => e.sequence);
      expect(new Set(sequences).size).toBe(n);
      expect(sequences).toEqual([...sequences].sort((x, y) => x - y));
      expect(sequences).toEqual(receipts.map((r) => r.sequence));
      expect(sequences.at(-1)).toBe(receipts.at(-1)!.sequence);
      const occurred = history.entries.map((e) =>
        Date.parse((e.event as c.ExperienceEvent).occurredAt),
      );
      expect(occurred[0]!).toBeGreaterThan(occurred.at(-1)!);
      expect(JSON.stringify(history)).toBe(
        JSON.stringify(rawHistory(storage, A)),
      );
      // Resolved views agree with the independent read.
      for (const [session, task] of [
        [SESSION, TASK],
        [SESSION, OTHER_TASK],
        [SECOND_SESSION, SECOND_TASK],
      ] as const)
        expect(JSON.stringify(view(history, session, task))).toBe(
          JSON.stringify(view(rawHistory(storage, A), session, task)),
        );
      const index = buildCorrectionEvidenceIndex(history);
      expect(index.corrections).toHaveLength(n);
      expect(index.evidence(receipts[1100]!.evidenceId)).toEqual({
        evidenceId: receipts[1100]!.evidenceId,
        eventId: receipts[1100]!.eventId,
        sequence: receipts[1100]!.sequence,
        role: 'own',
      });
    },
  );

  it('keeps the boundary captured when the read began: a correction appended mid-read is excluded, a fresh read sees it', () => {
    const { storage, receipts } = populated(150);
    let late: CorrectionReceipt | undefined;
    let transactions = 0;
    // Appends one correction through the REAL connection just before the
    // Ledger opens its second page's read transaction.
    const sqlite = new Proxy(storage.sqlite, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'transaction')
          return (fn: () => unknown) => {
            transactions += 1;
            if (transactions === 2 && late === undefined)
              late = recordOwnerCorrection(
                storage,
                submission({ correctedInstruction: 'Synthetic late' }),
                options({}, 900),
              );
            return target.transaction(fn);
          };
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const during = readCorrectionHistory({ ...storage, sqlite } as Storage, A);
    expect(late).toBeDefined();
    expect(during.entries.map((e) => e.sequence)).toEqual(
      receipts.map((r) => r.sequence),
    );
    const after = readCorrectionHistory(storage, A);
    expect(after.entries).toHaveLength(151);
    expect(after.entries.at(-1)!.sequence).toBe(late!.sequence);
  });
});

describe('readCorrectionHistory: owner isolation', () => {
  it('reads only the requested owner, even with identical identifier text across owners', () => {
    const storage = world();
    const a1 = recordOwnerCorrection(
      storage,
      submission({ correctedInstruction: 'Synthetic: owner A text' }),
      options(),
    );
    const b1 = recordOwnerCorrection(
      storage,
      submission({
        ownerId: B,
        correctedInstruction: 'Synthetic: owner B text',
        immediateApplicability: 'current_session',
      }),
      options(),
    );
    // Same identifier text, different owners and content.
    expect(b1.eventId).toBe(a1.eventId);
    expect(b1.evidenceId).toBe(a1.evidenceId);
    const a = readCorrectionHistory(storage, A);
    const b = readCorrectionHistory(storage, B);
    expect(a).toEqual(rawHistory(storage, A));
    expect(b).toEqual(rawHistory(storage, B));
    expect(JSON.stringify(a)).not.toContain('owner B text');
    expect(JSON.stringify(a)).not.toContain(B);
    expect(JSON.stringify(b)).not.toContain('owner A text');
    expect(a.entries[0]!.sequence).toBe(a1.sequence);
    expect(b.entries[0]!.sequence).toBe(b1.sequence);
    const index = buildCorrectionEvidenceIndex(a);
    expect(index.ownerId).toBe(A);
    expect(index.evidence(a1.evidenceId)!.sequence).toBe(a1.sequence);
    // B's session-wide correction targets B's event with the same ID text as
    // A's source event; it never reaches A's view or suppression targets.
    const aView = view(a, SESSION, OTHER_TASK);
    expect(aView.active).toEqual([]);
    expect(aView.suppressionTargets).toEqual([]);
    expect(
      view(b, SESSION, OTHER_TASK, undefined, B).active.map((x) => x.eventId),
    ).toEqual([b1.eventId]);
    // A history cannot be resolved or indexed under another owner.
    expectError(
      () => view(a, SESSION, TASK, undefined, B),
      'invalid_correction_history',
    );
    expectError(
      () =>
        buildCorrectionEvidenceIndex({
          ownerId: A,
          entries: [...a.entries, ...b.entries],
        }),
      'invalid_correction_history',
    );
  });
});

describe('readCorrectionHistory: real recorded chains resolve exactly', () => {
  function chainWorld(filename = ':memory:') {
    const storage = world(filename);
    const opts = options();
    const rec = (overrides: Json) =>
      recordOwnerCorrection(storage, submission(overrides), opts);
    const c1 = rec({ target: eventTarget(SOURCE_EVENT) });
    const c2 = rec({ target: eventTarget(c1.eventId) });
    const c3 = rec({ target: evidenceTarget(c2.evidenceId, c2.eventId) });
    const c4 = rec({ target: eventTarget(c3.eventId) });
    const c5 = rec({
      taskId: OTHER_TASK,
      immediateApplicability: 'current_session',
      target: eventTarget(SOURCE_EVENT),
    });
    const c6 = rec({ target: eventTarget(SOURCE_EVENT) });
    const c7 = rec({
      immediateApplicability: 'unspecified',
      target: { kind: 'unidentified', description: 'Synthetic: tone' },
    });
    const c8 = rec({
      category: 'permission',
      immediateApplicability: 'current_session',
      target: evidenceTarget(f.evidence.evidenceId, SOURCE_EVENT),
    });
    const c9 = rec({
      sessionId: SECOND_SESSION,
      taskId: SECOND_TASK,
      target: eventTarget(c4.eventId),
    });
    const s10 = directCorrection(storage, A, {
      name: 'supported',
      instruction: 'Synthetic: supported instruction',
      supporting: ['note'],
    });
    const c11 = rec({
      target: evidenceTarget(s10.supporting[0]!, s10.eventId),
    });
    const c12 = rec({
      target: {
        kind: 'owner_state',
        reference: { learnedItemId: f.learnedRef.learnedItemId, version: 1 },
      },
    });
    return { storage, c1, c2, c3, c4, c5, c6, c7, c8, c9, s10, c11, c12 };
  }

  const ids = (items: readonly { eventId: string }[]) =>
    items.map((i) => i.eventId);
  const inactive = (v: ImmediateCorrectionView) =>
    v.inactive.map((i) => [i.eventId, i.reason, [...i.supersededBy]]);

  it('resolves the loaded history to the independently expected views for every binding', () => {
    const w = chainWorld();
    const history = readCorrectionHistory(w.storage, A);
    expect(history).toEqual(rawHistory(w.storage, A));

    const t = view(history, SESSION, TASK);
    expect(ids(t.active)).toEqual([
      w.c4.eventId,
      w.c5.eventId,
      w.c6.eventId,
      w.c7.eventId,
      w.s10.eventId,
      w.c11.eventId,
      w.c12.eventId,
    ]);
    expect(inactive(t)).toEqual([
      [w.c1.eventId, 'superseded_by_correction', [w.c2.eventId]],
      [w.c2.eventId, 'superseded_by_correction', [w.c3.eventId]],
      [w.c3.eventId, 'superseded_by_correction', [w.c4.eventId]],
      [w.c8.eventId, 'deferred_to_root', []],
    ]);
    expect(t.supersessions).toEqual([
      { supersededEventId: w.c1.eventId, byEventId: w.c2.eventId },
      { supersededEventId: w.c2.eventId, byEventId: w.c3.eventId },
      { supersededEventId: w.c3.eventId, byEventId: w.c4.eventId },
    ]);
    expect(t.overlaps).toEqual([
      {
        target: eventTarget(SOURCE_EVENT),
        eventIds: [w.c5.eventId, w.c6.eventId],
      },
    ]);
    expect(t.suppressionTargets).toEqual([
      { target: eventTarget(w.c3.eventId), byEventIds: [w.c4.eventId] },
      {
        target: eventTarget(SOURCE_EVENT),
        byEventIds: [w.c5.eventId, w.c6.eventId],
      },
      {
        target: evidenceTarget(w.s10.supporting[0]!, w.s10.eventId),
        byEventIds: [w.c11.eventId],
      },
      {
        target: {
          kind: 'owner_state',
          reference: { learnedItemId: f.learnedRef.learnedItemId, version: 1 },
        },
        byEventIds: [w.c12.eventId],
      },
    ]);
    expect(
      t.active.find((a) => a.eventId === w.c7.eventId)!.applicability,
    ).toBe('unspecified_origin_task');

    // A sibling task of the same session: only the session-wide corrections.
    const sibling = view(history, SESSION, OTHER_TASK);
    expect(ids(sibling.active)).toEqual([w.c5.eventId]);
    expect(inactive(sibling)).toEqual([[w.c8.eventId, 'deferred_to_root', []]]);
    expect(sibling.suppressionTargets).toEqual([
      { target: eventTarget(SOURCE_EVENT), byEventIds: [w.c5.eventId] },
    ]);
    // A later task of that session sees the same session-wide corrections.
    expect(ids(view(history, SESSION, 'task_later').active)).toEqual([
      w.c5.eventId,
    ]);
    // Another session: its own correction, which names c4 but never
    // supersedes it outside its own scope.
    const second = view(history, SECOND_SESSION, SECOND_TASK);
    expect(ids(second.active)).toEqual([w.c9.eventId]);
    expect(second.inactive).toEqual([]);

    // Every binding: the loaded history and the independent raw read agree.
    for (const [session, task] of [
      [SESSION, TASK],
      [SESSION, OTHER_TASK],
      [SECOND_SESSION, SECOND_TASK],
      [SESSION, 'task_later'],
    ] as const)
      expect(JSON.stringify(view(history, session, task))).toBe(
        JSON.stringify(view(rawHistory(w.storage, A), session, task)),
      );
  });

  it('applies explicit as-of boundaries (throughSequence and referenceTime) to the loaded history', () => {
    const w = chainWorld();
    const history = readCorrectionHistory(w.storage, A);
    const through = view(history, SESSION, TASK, {
      referenceTime: FAR,
      throughSequence: w.c2.sequence,
    });
    expect(ids(through.active)).toEqual([w.c2.eventId]);
    expect(inactive(through)).toEqual([
      [w.c1.eventId, 'superseded_by_correction', [w.c2.eventId]],
    ]);
    expect(through.asOf.lastIncludedSequence).toBe(w.c2.sequence);
    // Before the first correction was recorded: nothing.
    const before = new Date(Date.parse(w.c1.recordedAt) - 1).toISOString();
    expect(
      view(history, SESSION, TASK, {
        referenceTime: before,
        throughSequence: null,
      }).asOf.lastIncludedSequence,
    ).toBeNull();
    // At c1's recording instant: the longest prefix recorded by then.
    const at = view(history, SESSION, TASK, {
      referenceTime: w.c1.recordedAt,
      throughSequence: null,
    });
    const recorded = history.entries.map(
      (e) => (e.event as c.ExperienceEvent).recordedAt,
    );
    let prefix = 0;
    while (
      prefix < recorded.length &&
      Date.parse(recorded[prefix]!) <= Date.parse(w.c1.recordedAt)
    )
      prefix += 1;
    expect(at.asOf.lastIncludedSequence).toBe(
      history.entries[prefix - 1]!.sequence,
    );
  });

  it('indexes every correction and evidence record, own versus supporting, by exact identity', () => {
    const w = chainWorld();
    const history = readCorrectionHistory(w.storage, A);
    const index = buildCorrectionEvidenceIndex(history);
    expect(index.ownerId).toBe(A);
    expect(index.corrections.map((x) => x.sequence)).toEqual(
      history.entries.map((e) => e.sequence),
    );
    expect(index.correction(w.s10.eventId)).toEqual({
      eventId: w.s10.eventId,
      sequence: history.entries.find(
        (e) => (e.event as c.ExperienceEvent).id === w.s10.eventId,
      )!.sequence,
      ownEvidenceId: w.s10.own,
      supportingEvidenceIds: w.s10.supporting,
    });
    expect(index.evidence(w.s10.own)!.role).toBe('own');
    expect(index.evidence(w.s10.supporting[0])).toEqual({
      evidenceId: w.s10.supporting[0],
      eventId: w.s10.eventId,
      sequence: index.correction(w.s10.eventId)!.sequence,
      role: 'supporting',
    });
    expect(index.evidence(w.c2.evidenceId)).toEqual({
      evidenceId: w.c2.evidenceId,
      eventId: w.c2.eventId,
      sequence: w.c2.sequence,
      role: 'own',
    });
    expect(index.correction(w.c2.eventId)!.supportingEvidenceIds).toEqual([]);
    // Ordinary (non-correction) history and foreign or unknown identities
    // are not in the index; non-string keys are never looked up.
    for (const key of [
      SOURCE_EVENT,
      f.evidence.evidenceId,
      'event_unknown',
      'evidence_unknown',
      w.c2.evidenceId.toUpperCase(),
      ` ${w.c2.evidenceId}`,
    ]) {
      expect(index.correction(key), key).toBeUndefined();
      expect(index.evidence(key), key).toBeUndefined();
    }
    for (const key of [undefined, null, 1, {}, [w.c2.eventId]]) {
      expect(index.correction(key)).toBeUndefined();
      expect(index.evidence(key)).toBeUndefined();
    }
    // An event ID is not an evidence ID, nor the reverse.
    expect(index.evidence(w.c2.eventId)).toBeUndefined();
    expect(index.correction(w.c2.evidenceId)).toBeUndefined();
  });
});

describe('readCorrectionHistory: restart, read-only and immutability', () => {
  it('reproduces the same history and views after closing and reopening the database', () => {
    const filename = join(scratch, `restart-${++counter}.sqlite`);
    const w = (() => {
      const storage = world(filename);
      const opts = options();
      const r1 = recordOwnerCorrection(
        storage,
        submission({ correctedInstruction: 'Synthetic: persisted one' }),
        opts,
      );
      const r2 = recordOwnerCorrection(
        storage,
        submission({ target: eventTarget(r1.eventId) }),
        opts,
      );
      return { storage, r1, r2 };
    })();
    const before = readCorrectionHistory(w.storage, A);
    const beforeView = view(before, SESSION, TASK);
    w.storage.sqlite.close();

    const reopened = openStorage(filename);
    try {
      const rows = snapshot(reopened);
      const changes = () =>
        (
          reopened.sqlite.prepare('SELECT total_changes() AS n').get() as {
            n: number;
          }
        ).n;
      const initial = changes();
      const counts = Object.fromEntries(
        ['experience_events', 'evidence', 'corrections'].map((t) => [
          t,
          count(reopened, t),
        ]),
      );
      // Reads must work on a connection that refuses every write.
      reopened.sqlite.pragma('query_only = ON');
      const { storage: watched, calls } = observed(reopened);
      const after = readCorrectionHistory(watched, A);
      buildCorrectionEvidenceIndex(after);
      reopened.sqlite.pragma('query_only = OFF');
      expect(after).toEqual(before);
      expect(JSON.stringify(view(after, SESSION, TASK))).toBe(
        JSON.stringify(beforeView),
      );
      const [first, second] = after.entries;
      expect(first!.sequence).toBe(w.r1.sequence);
      expect(second!.sequence).toBe(w.r2.sequence);
      expect((first!.event as c.ExperienceEvent).recordedAt).toBe(
        w.r1.recordedAt,
      );
      expect((first!.evidence[0] as c.EvidenceRecord).content).toEqual({
        kind: 'recorded_text',
        text: 'Synthetic: persisted one',
      });
      // Nothing was written: no changes, identical rows and counts, and only
      // SELECT statements were issued.
      expect(changes()).toBe(initial);
      expect(snapshot(reopened)).toEqual(rows);
      for (const [t, n] of Object.entries(counts))
        expect(count(reopened, t), t).toBe(n);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.sql).toMatch(/^SELECT /);
    } finally {
      reopened.sqlite.close();
    }
  });

  it('returns detached, deeply frozen values that callers cannot change', () => {
    const w = (() => {
      const storage = world();
      const r = recordOwnerCorrection(storage, submission(), options());
      return { storage, r };
    })();
    const history = readCorrectionHistory(w.storage, A);
    const pristine = JSON.stringify(history);
    const entry = history.entries[0]!;
    const attempts: (() => void)[] = [
      () => {
        (history as unknown as Json)['ownerId'] = B;
      },
      () => {
        (history.entries as unknown[]).push({});
      },
      () => {
        (entry as unknown as Json)['sequence'] = 99;
      },
      () => {
        ((entry.event as Json)['payload'] as Json)['correctedInstruction'] =
          'tampered';
      },
      () => {
        ((entry.evidence[0] as Json)['content'] as Json)['text'] = 'tampered';
      },
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
    expect(JSON.stringify(history)).toBe(pristine);
    const again = readCorrectionHistory(w.storage, A);
    expect(again).not.toBe(history);
    expect(JSON.stringify(again)).toBe(pristine);

    const index = buildCorrectionEvidenceIndex(history);
    const record = index.evidence(w.r.evidenceId)!;
    for (const attempt of [
      () => {
        (index as unknown as Json)['correction'] = () => undefined;
      },
      () => {
        (index.corrections as unknown[]).push({});
      },
      () => {
        (record as unknown as Json)['role'] = 'supporting';
      },
      () => {
        (record as unknown as Json)['eventId'] = 'event_other';
      },
      () => {
        (index.correction(w.r.eventId)!.supportingEvidenceIds as string[]).push(
          'evidence_forged',
        );
      },
    ])
      expect(attempt).toThrow(TypeError);
    expect(index.evidence(w.r.evidenceId)).toEqual({
      evidenceId: w.r.evidenceId,
      eventId: w.r.eventId,
      sequence: w.r.sequence,
      role: 'own',
    });
    // No mutable collection is exposed.
    for (const value of Object.values(index))
      expect(value instanceof Map || value instanceof Set).toBe(false);
    expect(Object.keys(index).sort()).toEqual([
      'correction',
      'corrections',
      'evidence',
      'ownerId',
    ]);
  });
});

describe('readCorrectionHistory: corrupt or inconsistent stored history fails closed', () => {
  it('refuses a stored correction whose own evidence does not hold its exact instruction', () => {
    const storage = world();
    recordOwnerCorrection(storage, submission(), options());
    directCorrection(storage, A, {
      name: 'drifted',
      instruction: 'Synthetic: the instruction',
      ownText: 'Synthetic: the instruction ',
    });
    recordOwnerCorrection(storage, submission(), options({}, 50));
    expectError(
      () => readCorrectionHistory(storage, A),
      'invalid_correction_history',
    );
    // Owner B's history is unaffected and still readable.
    expect(readCorrectionHistory(storage, B).entries).toEqual([]);
  });

  it('refuses a stored correction that targets itself', () => {
    const storage = world();
    directCorrection(storage, A, {
      name: 'self',
      instruction: 'Synthetic: self',
      target: eventTarget('event_self'),
    });
    expectError(
      () => readCorrectionHistory(storage, A),
      'invalid_correction_history',
    );
  });

  it('refuses stored rows that no longer deserialize (test-only tampering of a scratch database)', () => {
    const storage = world();
    const r = recordOwnerCorrection(storage, submission(), options());
    // The frozen schema forbids updates and checks contract validity; this
    // throwaway database disables both only to simulate on-disk corruption.
    storage.sqlite.prepare('DROP TRIGGER evidence_no_update').run();
    storage.sqlite.pragma('ignore_check_constraints = ON');
    storage.sqlite
      .prepare(
        "UPDATE evidence SET record_json = json_set(record_json, '$.content.kind', 'tampered') WHERE owner_id = ? AND record_id = ?",
      )
      .run(A, r.evidenceId);
    const error = expectError(
      () => readCorrectionHistory(storage, A),
      'invalid_correction_history',
    );
    expect(JSON.stringify(error)).not.toContain(r.evidenceId);
  });
});

describe('buildCorrectionEvidenceIndex: hostile and inconsistent input', () => {
  const base = () => {
    const storage = world();
    const opts = options();
    recordOwnerCorrection(storage, submission(), opts);
    const s = directCorrection(storage, A, {
      name: 'supported',
      instruction: 'Synthetic: supported',
      supporting: ['note'],
    });
    recordOwnerCorrection(storage, submission(), opts);
    return { history: readCorrectionHistory(storage, A), s };
  };
  const copy = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as {
      ownerId: string;
      entries: { sequence: number; event: Json; evidence: Json[] }[];
    };

  it('accepts a valid history and rejects every inconsistent variant', () => {
    const { history, s } = base();
    expect(buildCorrectionEvidenceIndex(history).corrections).toHaveLength(3);
    const variants: [string, (h: ReturnType<typeof copy>) => void][] = [
      [
        'duplicate evidence identity across corrections',
        (h) => {
          h.entries[2]!.evidence.push({
            ...h.entries[1]!.evidence[1]!,
            eventId: (h.entries[2]!.event as Json)['id'],
          });
          (h.entries[2]!.event['evidenceIds'] as string[]).push(
            s.supporting[0]!,
          );
        },
      ],
      [
        'duplicate event identity',
        (h) => {
          h.entries.push({ ...h.entries[0]!, sequence: 999 });
        },
      ],
      [
        'duplicate sequence',
        (h) => {
          h.entries[1]!.sequence = h.entries[0]!.sequence;
        },
      ],
      [
        'evidence owned by another correction',
        (h) => {
          h.entries[1]!.evidence[1]!['eventId'] = (h.entries[0]!.event as Json)[
            'id'
          ];
        },
      ],
      [
        'missing supporting evidence record',
        (h) => {
          h.entries[1]!.evidence.pop();
        },
      ],
      [
        'own evidence time drift',
        (h) => {
          h.entries[0]!.evidence[0]!['recordedAt'] = FAR;
        },
      ],
      [
        'foreign owner entry',
        (h) => {
          h.ownerId = B;
        },
      ],
    ];
    for (const [label, mutate] of variants) {
      const h = copy(history);
      mutate(h);
      expectError(
        () => buildCorrectionEvidenceIndex(h),
        'invalid_correction_history',
      );
      expect(label).toBeTruthy();
    }
  });

  it('refuses proxies, accessors and non-plain input without running caller code', () => {
    const { history } = base();
    let touched = false;
    const proxy = new Proxy(copy(history), {
      get(target, key, receiver) {
        touched = true;
        return Reflect.get(target, key, receiver);
      },
    });
    expectError(
      () => buildCorrectionEvidenceIndex(proxy),
      'invalid_correction_history',
    );
    expect(touched).toBe(false);
    const accessor = copy(history);
    Object.defineProperty(accessor, 'ownerId', {
      get() {
        touched = true;
        return A;
      },
      enumerable: true,
    });
    expectError(
      () => buildCorrectionEvidenceIndex(accessor),
      'invalid_correction_history',
    );
    expect(touched).toBe(false);
    for (const bad of [null, undefined, 1, 'history', [], { ownerId: A }])
      expectError(
        () => buildCorrectionEvidenceIndex(bad),
        'invalid_correction_history',
      );
  });
});
