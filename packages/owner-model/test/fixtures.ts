/**
 * SYNTHETIC test fixtures for AVEN-009 owner-model tests. Every owner, ID and
 * text below is invented for mechanics checks; none describes a real owner,
 * preference or history. Builders return fresh, unfrozen objects so a test
 * can mutate its own copy.
 */
export const OWNER = 'owner_synthetic_a';
export const FOREIGN = 'owner_synthetic_b';
export const OTHER_FOREIGN = 'owner_synthetic_c';

export const T0 = '2026-10-01T09:00:00Z';
export const T1 = '2026-10-02T09:00:00Z';
export const T2 = '2026-10-03T09:00:00Z';
export const T3 = '2026-10-04T09:00:00Z';

type Json = Record<string, unknown>;

export const CONTENT: Record<string, Json> = {
  fact: {
    category: 'fact',
    subject: 'Synthetic subject',
    assertion: 'Synthetic assertion',
  },
  preference: {
    category: 'preference',
    subject: 'Synthetic outreach',
    desiredBehavior: 'Synthetic short reply',
  },
  episode: {
    category: 'episode',
    summary: 'Synthetic episode summary',
    occurredAt: T0,
    originalEvidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
  },
  intent_pattern: {
    category: 'intent_pattern',
    cue: 'synthetic cue',
    interpretedIntent: 'Synthetic interpretation',
  },
  procedure: {
    category: 'procedure',
    objective: 'Synthetic objective',
    steps: [
      { instruction: 'Synthetic step one' },
      { instruction: 'Synthetic step two', precondition: 'Synthetic gate' },
    ],
  },
};

export function metadata(recordVersion: number, createdAt = T0): Json {
  return {
    schemaVersion: 1,
    recordVersion,
    createdAt,
    creation: { component: '@aven/owner-model/test', version: 'synthetic' },
  };
}

function ownerProvenance(ownerId: string): Json {
  return {
    kind: 'explicit_owner_statement',
    ownerId,
    sourceEventId: 'event_s1',
  };
}

export function durable(
  options: {
    id?: string;
    version?: number;
    createdAt?: string;
    category?: keyof typeof CONTENT;
    ownerId?: string;
  } = {},
): Json {
  const ownerId = options.ownerId ?? OWNER;
  return {
    kind: 'durable_owner_state',
    ownerId,
    metadata: metadata(options.version ?? 1, options.createdAt ?? T0),
    id: options.id ?? 'learned_s1',
    content: structuredClone(CONTENT[options.category ?? 'fact']),
    scope: { kind: 'bounded', domain: 'synthetic domain' },
    provenance: ownerProvenance(ownerId),
    evidence: {
      support: 'limited',
      supportingEvidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
      counterexamples: [{ evidenceId: 'evidence_s2', eventId: 'event_s2' }],
      sourceIndependence: { status: 'unassessed' },
      inferenceCertainty: 'not_applicable',
      ownerConfirmation: { status: 'not_requested' },
    },
    lifecycle: { status: 'observed' },
  };
}

export function activeTask(
  options: {
    id?: string;
    version?: number;
    createdAt?: string;
    ownerId?: string;
  } = {},
): Json {
  const ownerId = options.ownerId ?? OWNER;
  return {
    kind: 'active_task_state',
    ownerId,
    metadata: metadata(options.version ?? 1, options.createdAt ?? T0),
    id: options.id ?? 'learned_t1',
    task: { sessionId: 'session_s1', taskId: 'task_s1' },
    objective: 'Synthetic task objective',
    openLoops: ['Synthetic open loop'],
    sourceEvidence: [{ evidenceId: 'evidence_s1', eventId: 'event_s1' }],
    provenance: ownerProvenance(ownerId),
    lifecycle: { status: 'active' },
  };
}

/** A valid record for another owner (it must be dropped unread). */
export function foreign(index: number, ownerId = FOREIGN): Json {
  return durable({ id: `learned_f${index}`, ownerId });
}

/** Deterministic permutation (seeded LCG); tests never use Math.random. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed >>> 0 || 1;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** True when every object and array reachable from `value` is frozen. */
export function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deeplyFrozen);
}
