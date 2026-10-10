/*
 * AVEN-010 Codex remediation R2: SYNTHETIC, non-production correction
 * histories for the resolver's scale, equivalence and complexity tests and
 * for `packages/corrections/bench/resolve.bench.ts`. Every owner, ID, time
 * and text here is synthetic and deterministic (a fixed-seed generator, no
 * clock or randomness). Entries are built directly in the frozen AVEN-002
 * `owner_correction` shape without schema parsing, so generation stays cheap
 * at 40,000 entries; the tests check that generated entries parse under the
 * frozen schemas. Text is deliberately short.
 */

export const SCALE_OWNER = 'owner_scale';
export const SCALE_SESSION = 'session_scale';
export const SCALE_OTHER_SESSION = 'session_scale_other';
export const SCALE_TASK = 'task_scale';
export const SCALE_TASKS = ['task_scale', 'task_scale_two', 'task_scale_three'];
export const SCALE_CATEGORIES = [
  'fact',
  'scope',
  'preference',
  'intent',
  'procedure',
  'communication',
  'permission',
] as const;
export const SCALE_FAR_FUTURE = '2031-01-01T00:00:00Z';

const BASE_MS = Date.UTC(2026, 9, 1);

/** Synthetic recording time of sequence `seq` (whole seconds, `Z`). */
export const scaleTime = (seq: number) =>
  new Date(BASE_MS + seq * 1000).toISOString().replace('.000Z', 'Z');
export const scaleEventId = (name: string) => `event_${name}`;
export const scaleEvidenceId = (name: string) => `evidence_${name}`;

export type ScaleTarget =
  | { kind: 'event'; eventId: string }
  | { kind: 'evidence'; reference: { evidenceId: string; eventId: string } }
  | {
      kind: 'owner_state';
      reference: { learnedItemId: string; version: number };
    }
  | { kind: 'unidentified'; description: string };

export interface ScaleSpec {
  readonly seq: number;
  readonly name: string;
  readonly kind: 'current_task' | 'current_session' | 'unspecified';
  readonly session: string;
  readonly task: string;
  /** `null` omits the envelope; `undefined` uses `session`/`task`. */
  readonly envelope?: { sessionId: string; taskId: string } | null | undefined;
  readonly category: (typeof SCALE_CATEGORIES)[number];
  readonly target: ScaleTarget;
  readonly extraEvidence?: readonly string[];
  readonly recordedAt?: string;
}

export interface ScaleEntry {
  readonly sequence: number;
  readonly event: Record<string, unknown>;
  readonly evidence: Record<string, unknown>[];
}

/** One frozen-shape owner_correction entry (synthetic, unparsed). */
export function scaleEntry(spec: ScaleSpec): ScaleEntry {
  const id = scaleEventId(spec.name);
  const recordedAt = spec.recordedAt ?? scaleTime(spec.seq);
  const origin = () => ({
    kind: 'explicit_owner_correction',
    ownerId: SCALE_OWNER,
    sourceEventId: id,
  });
  const metadata = () => ({
    schemaVersion: 1,
    recordVersion: 1,
    createdAt: recordedAt,
    creation: { component: '@aven/corrections', version: 'synthetic' },
  });
  const envelope =
    spec.envelope === undefined
      ? { sessionId: spec.session, taskId: spec.task }
      : spec.envelope;
  const applicability =
    spec.kind === 'current_task'
      ? {
          kind: spec.kind,
          task: { sessionId: spec.session, taskId: spec.task },
        }
      : spec.kind === 'current_session'
        ? { kind: spec.kind, sessionId: spec.session }
        : { kind: spec.kind };
  const own = scaleEvidenceId(spec.name);
  const evidenceIds = [own, ...(spec.extraEvidence ?? [])];
  const instruction = `Synthetic ${spec.name}`;
  const event = {
    kind: 'experience_event',
    ownerId: SCALE_OWNER,
    metadata: metadata(),
    id,
    occurredAt: recordedAt,
    recordedAt,
    ...(envelope === null ? {} : { task: { ...envelope } }),
    evidenceIds,
    eventType: 'owner_correction',
    payload: {
      kind: 'owner_correction',
      ownerId: SCALE_OWNER,
      metadata: metadata(),
      evidence: { evidenceId: own, eventId: id },
      provenance: origin(),
      category: spec.category,
      target: structuredClone(spec.target),
      originalBehavior: 'Synthetic original',
      correctedInstruction: instruction,
      immediateApplicability: applicability,
      durableScopeHint: {
        kind: 'global',
        explicitDeclaration: 'Synthetic hint only',
      },
    },
    provenance: origin(),
  };
  const evidence = evidenceIds.map((evidenceId) => ({
    kind: 'recorded_evidence',
    ownerId: SCALE_OWNER,
    metadata: metadata(),
    id: evidenceId,
    eventId: id,
    recordedAt,
    provenance: origin(),
    content: { kind: 'recorded_text', text: instruction },
  }));
  return { sequence: spec.seq, event, evidence };
}

const sessionWide = (seq: number, target: ScaleTarget): ScaleSpec => ({
  seq,
  name: `c${seq}`,
  kind: 'current_session',
  session: SCALE_SESSION,
  task: SCALE_TASKS[seq % SCALE_TASKS.length]!,
  category: 'communication',
  target,
});

const ownEvidenceOf = (seq: number): ScaleTarget => ({
  kind: 'evidence',
  reference: {
    evidenceId: scaleEvidenceId(`c${seq}`),
    eventId: scaleEventId(`c${seq}`),
  },
});
const eventOf = (seq: number): ScaleTarget => ({
  kind: 'event',
  eventId: scaleEventId(`c${seq}`),
});

/**
 * Distribution A: `n` current-session corrections in one session, each with
 * its own unique `unidentified` target. Nothing links, nothing overlaps and
 * nothing suppresses; every correction is active for every task of the
 * session. A pairwise linkage search does n(n-1)/2 comparisons here.
 */
export function distributionA(n: number): ScaleSpec[] {
  return Array.from({ length: n }, (_, i) =>
    sessionWide(i + 1, { kind: 'unidentified', description: `u${i + 1}` }),
  );
}

/**
 * Distribution B: `n` current-session corrections forming long chains with
 * branching explicit links. Chains of `chainLength` start at an unidentified
 * head; each later link targets the previous correction, alternating event
 * ID and exact own evidence; every 7th link instead branches back to the
 * correction two places earlier (which already has a superseder), so some
 * corrections are superseded by two later ones.
 */
export function distributionB(n: number, chainLength = 1000): ScaleSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    const position = i % chainLength;
    if (position === 0)
      return sessionWide(seq, {
        kind: 'unidentified',
        description: `head${seq}`,
      });
    if (position >= 2 && seq % 7 === 0)
      return sessionWide(seq, eventOf(seq - 2));
    return sessionWide(
      seq,
      seq % 2 === 0 ? eventOf(seq - 1) : ownEvidenceOf(seq - 1),
    );
  });
}

export const scaleHistory = (specs: readonly ScaleSpec[]) => ({
  ownerId: SCALE_OWNER,
  entries: specs.map(scaleEntry),
});
export const scaleQuery = (taskId = SCALE_TASK, sessionId = SCALE_SESSION) => ({
  ownerId: SCALE_OWNER,
  sessionId,
  taskId,
});
export const scaleAsOf = (
  referenceTime = SCALE_FAR_FUTURE,
  throughSequence: number | null = null,
) => ({ referenceTime, throughSequence });

/** A small fixed-seed PRNG (mulberry32): deterministic, no global state. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
