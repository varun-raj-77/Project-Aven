// SYNTHETIC fixtures only: fictional owners, profile notes and history. No real
// owner data, provider or credential. The scripted runtime is test-only.
import type { ModelConfiguration } from '@aven/contracts';
import {
  createScriptedModelRuntime,
  type ScriptedModelRuntime,
  type ScriptedStep,
} from '@aven/runtime/testing';
import type {
  BaselineInput,
  HistoryRecord,
  OwnerProfile,
} from '../src/index.ts';

export const OWNER = 'owner_syn_fixture';
export const OTHER_OWNER = 'owner_syn_other';

export const MODEL: ModelConfiguration = {
  providerId: 'synthetic-provider',
  modelId: 'synthetic-model',
  modelVersion: '2026-10-01',
  configurationId: 'synthetic-config-shared',
};
export const RUNTIME = { identifier: 'synthetic-runtime', version: '1.0.0' };

export function scripted(
  script: readonly ScriptedStep[] | ((call: number) => ScriptedStep) = () => ({
    kind: 'respond',
    text: 'Synthetic response.',
  }),
): ScriptedModelRuntime {
  return createScriptedModelRuntime({
    runtime: RUNTIME,
    model: MODEL,
    script:
      typeof script === 'function' ? (_request, call) => script(call) : script,
  });
}

export function record(
  eventId: string,
  text: string,
  occurredAt = '2026-05-01T10:00:00Z',
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    ownerId: OWNER,
    eventId,
    role: 'owner',
    text,
    occurredAt,
    ...overrides,
  };
}

export const PROFILE: OwnerProfile = {
  ownerId: OWNER,
  entries: [
    {
      id: 'pentry_fixture_1',
      text: 'For recruiter outreach, keep messages concise.',
    },
    { id: 'pentry_fixture_2', text: 'Usually write concise responses.' },
  ],
};

export const HISTORY: HistoryRecord[] = [
  record(
    'event_syn_fixture_01',
    'Help me reply to a recruiter about a data engineering role.',
    '2026-04-01T09:00:00Z',
  ),
  record(
    'event_syn_fixture_02',
    'Here is a short recruiter reply that asks one question.',
    '2026-04-01T09:01:00Z',
    { role: 'assistant' },
  ),
  record(
    'event_syn_fixture_03',
    'What should I pack for a hiking trip?',
    '2026-04-05T12:00:00Z',
  ),
];

export const INPUT: BaselineInput = {
  ownerId: OWNER,
  request: 'Draft a reply to the recruiter about the data engineering role.',
  profile: PROFILE,
  history: HISTORY,
};

/** Recursively freezes a value so a test can detect any attempted mutation. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Parses the BASELINE_CONTEXT_V1 JSON payload out of an assembled message. */
export function contextPayload(content: string): {
  profile: { id: string; text: string }[];
  history: {
    eventId: string;
    role: string;
    occurredAt: string;
    text: string;
    truncated: boolean;
  }[];
} {
  const start = content.indexOf('{');
  return JSON.parse(content.slice(start)) as ReturnType<typeof contextPayload>;
}

/** Resolves after pending microtasks and timers have had a chance to run. */
export const tick = (ms = 0) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
