// SYNTHETIC fixtures only: fictional owners, tasks and context text. No real
// owner data, preference, provider or credential. Nothing here is derived from
// the AVEN-007 dataset, and no relevance or ranking value was tuned against it.
import {
  createContextBroker,
  type ContextAssembly,
  type ContextCandidate,
  type ContextRequest,
  type ContextSource,
  type ContextSourceKind,
  type ContextSourceQuery,
} from '../src/index.ts';

export const OWNER = 'owner_syn_broker_a';
export const OTHER_OWNER = 'owner_syn_broker_b';
export const SESSION = 'session_syn_broker_1';
export const TASK = 'task_syn_broker_1';
export const OTHER_SESSION = 'session_syn_broker_2';
export const OTHER_TASK = 'task_syn_broker_2';
export const REFERENCE_TIME = '2026-10-01T12:00:00Z';

export const SIGNALS = Object.freeze({
  confidence: 0.5,
  salience: 0.5,
  negativeRetrieval: 0,
});

export function request(
  text: string,
  overrides: Partial<ContextRequest> = {},
): ContextRequest {
  return {
    ownerId: OWNER,
    task: { sessionId: SESSION, taskId: TASK },
    request: text,
    referenceTime: REFERENCE_TIME,
    taskDescriptor: {},
    ...overrides,
  };
}

/** Deterministic ASCII suffix for AVEN-002 IDs derived from a local ID. */
export function slug(id: string): string {
  return `syn${id.replace(/[^A-Za-z0-9_-]/g, 'u')}`.slice(0, 100);
}

const ownerStatement = (id: string, ownerId = OWNER) => ({
  kind: 'explicit_owner_statement' as const,
  ownerId,
  sourceEventId: `event_${slug(id)}`,
});

export const PROVENANCE = {
  ownerStatement,
  ownerCorrection: (id: string, ownerId = OWNER) => ({
    kind: 'explicit_owner_correction' as const,
    ownerId,
    sourceEventId: `event_${slug(id)}`,
  }),
  systemGenerated: () => ({
    kind: 'system_generated' as const,
    component: 'synthetic-adapter',
    version: '1.0.0',
    derivedFrom: [],
  }),
  modelInference: () => ({
    kind: 'model_inference' as const,
    model: {
      providerId: 'synthetic-provider',
      modelId: 'synthetic-model',
      modelVersion: '2026-10-01',
      configurationId: 'synthetic-config',
    },
    derivedFrom: [],
    sourceCoverage: 'unknown' as const,
  }),
  toolResult: (id: string) => ({
    kind: 'tool_result' as const,
    toolId: 'synthetic-tool',
    sourceEventId: `event_${slug(id)}`,
    trust: 'potentially_untrusted' as const,
  }),
  externalContent: () => ({
    kind: 'external_content' as const,
    source: 'synthetic-external-site',
    capturedAt: '2026-09-30T12:00:00Z',
    trust: 'untrusted' as const,
  }),
};

export const UNKNOWN_SCOPE = Object.freeze({
  kind: 'unknown' as const,
  reason: 'Synthetic fixture: scope not declared',
});
export const GLOBAL_SCOPE = Object.freeze({
  kind: 'global' as const,
  explicitDeclaration: 'Synthetic fixture: declared applicable to every task',
});

/** Raw recorded evidence with owner-statement provenance and unknown scope. */
export function evidence(
  id: string,
  text: string,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    candidateId: id,
    ownerId: OWNER,
    reference: {
      kind: 'evidence',
      reference: {
        evidenceId: `evidence_${slug(id)}`,
        eventId: `event_${slug(id)}`,
      },
    },
    provenance: ownerStatement(id),
    scope: UNKNOWN_SCOPE,
    text,
    timestamps: { recordedAt: REFERENCE_TIME },
    signals: { ...SIGNALS },
    ...overrides,
  };
}

export function ownerState(
  id: string,
  text: string,
  lifecycle:
    'observed' | 'validated' | 'trusted' | 'superseded' | 'revoked' = 'trusted',
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return evidence(id, text, {
    reference: {
      kind: 'owner_state',
      reference: { learnedItemId: `learned_${slug(id)}`, version: 1 },
      lifecycle,
    },
    ...overrides,
  });
}

export function activeTask(
  id: string,
  text: string,
  task: { sessionId: string; taskId: string } = {
    sessionId: SESSION,
    taskId: TASK,
  },
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return evidence(id, text, {
    reference: {
      kind: 'active_task_state',
      reference: { learnedItemId: `learned_${slug(id)}`, version: 1 },
      task,
    },
    provenance: PROVENANCE.systemGenerated(),
    ...overrides,
  });
}

export function instruction(
  id: string,
  text: string,
  task: { sessionId: string; taskId: string } = {
    sessionId: SESSION,
    taskId: TASK,
  },
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return evidence(id, text, {
    reference: {
      kind: 'current_instruction',
      evidence: {
        evidenceId: `evidence_${slug(id)}`,
        eventId: `event_${slug(id)}`,
      },
      task,
    },
    ...overrides,
  });
}

export function external(
  id: string,
  text: string,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return evidence(id, text, {
    provenance: PROVENANCE.externalContent(),
    ...overrides,
  });
}

export interface MemorySource extends ContextSource {
  readonly queries: ContextSourceQuery[];
}

/** An in-memory, read-only test source. It records the queries it receives. */
export function memorySource(
  sourceId: string,
  kind: ContextSourceKind,
  candidates: readonly unknown[] | (() => unknown),
): MemorySource {
  const queries: ContextSourceQuery[] = [];
  return {
    sourceId,
    kind,
    queries,
    collect(query) {
      queries.push(query);
      return (
        typeof candidates === 'function' ? candidates() : candidates
      ) as readonly unknown[];
    },
  };
}

export async function assemble(
  sources: readonly ContextSource[],
  req: ContextRequest,
): Promise<ContextAssembly> {
  return createContextBroker({ sources }).assemble(req);
}

export function selectedIds(assembly: ContextAssembly): string[] {
  return assembly.bundle.items.map((i) => i.candidateId);
}

export function traceOf(assembly: ContextAssembly, candidateId: string) {
  const found = assembly.trace.candidates.find(
    (c) => c.candidateId === candidateId,
  );
  if (!found) throw new Error(`no trace entry for ${candidateId}`);
  return found;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** A string of exactly `n` code points built from `unit` (repeated) and padding. */
export function codePoints(n: number, unit = 'x'): string {
  return Array.from({ length: n }, () => unit).join('');
}
