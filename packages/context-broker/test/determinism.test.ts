import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ContextCandidate, type ContextSource } from '../src/index.ts';
import {
  activeTask,
  assemble,
  evidence,
  external,
  GLOBAL_SCOPE,
  instruction,
  memorySource,
  OTHER_OWNER,
  ownerState,
  PROVENANCE,
  request,
  traceOf,
} from './fixtures.ts';

// SYNTHETIC mixed fixture covering every reference kind and many exclusions.

function corpus(): Record<string, ContextCandidate[]> {
  return {
    store: [
      ownerState(
        'pref-trusted',
        'Weekly planning notes stay brief',
        'trusted',
        {
          scope: { kind: 'bounded', domain: 'planning' },
        },
      ),
      ownerState('pref-old', 'Weekly planning notes are long', 'superseded'),
      ownerState('pref-revoked', 'Planning in the evening', 'revoked'),
      ownerState('pref-global', 'Use plain language in planning', 'validated', {
        scope: GLOBAL_SCOPE,
        signals: { confidence: 0.7, salience: 0.2, negativeRetrieval: 0.3 },
      }),
      ownerState(
        'pref-other-domain',
        'Weekly planning for the garden',
        'trusted',
        {
          scope: { kind: 'bounded', domain: 'gardening' },
        },
      ),
    ],
    episodes: [
      evidence('ep-1', 'Last weekly planning ran over time', {
        timestamps: { recordedAt: '2026-06-01T00:00:00Z' },
      }),
      evidence('ep-2', 'Planning notes from the offsite', {
        provenance: PROVENANCE.modelInference(),
        timestamps: { recordedAt: '2026-09-15T00:00:00Z' },
      }),
      evidence('ep-foreign', 'Weekly planning notes', {
        ownerId: OTHER_OWNER,
        provenance: PROVENANCE.ownerStatement('ep-foreign', OTHER_OWNER),
      }),
      evidence('ep-unrelated', 'Bicycle maintenance log'),
    ],
    active: [
      activeTask('task-state', 'Open loop: share agenda'),
      instruction('task-instruction', 'Keep the weekly notes under a page'),
    ],
    web: [external('page', 'Generic weekly planning template')],
  };
}

const KINDS: Record<string, ContextSource['kind']> = {
  store: 'owner_state',
  episodes: 'episode_history',
  active: 'active_task',
  web: 'permitted_external',
};

function sources(shuffle: boolean): ContextSource[] {
  const data = corpus();
  const list = Object.entries(data).map(([id, items]) =>
    memorySource(id, KINDS[id]!, shuffle ? [...items].reverse() : items),
  );
  return shuffle ? list.reverse() : list;
}

const REQUEST = request('Draft the weekly planning notes', {
  taskDescriptor: { domain: 'planning' },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AVEN-008 determinism (A, AL)', () => {
  it('produces byte-identical bundle and trace for identical input (A)', async () => {
    const runs = await Promise.all(
      Array.from({ length: 3 }, () => assemble(sources(false), REQUEST)),
    );
    const json = runs.map((r) => JSON.stringify(r));
    expect(new Set(json).size).toBe(1);
    // Sanity: the fixture exercises selection and several exclusion paths.
    const reasons = runs[0]!.trace.candidates.map((c) => c.exclusionReason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        null,
        'superseded',
        'revoked',
        'scope_mismatch',
        'no_relevance_channel',
      ]),
    );
  });

  it('does not depend on source registration order or candidate order', async () => {
    const forward = await assemble(sources(false), REQUEST);
    const shuffled = await assemble(sources(true), REQUEST);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });

  it('never reads the wall clock or randomness (AL)', async () => {
    const baseline = JSON.stringify(await assemble(sources(false), REQUEST));
    let tick = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 86_400_000));
    vi.spyOn(Math, 'random').mockImplementation(() => (tick % 7) / 7);
    vi.spyOn(performance, 'now').mockImplementation(() => (tick += 1));
    vi.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z') });
    try {
      expect(JSON.stringify(await assemble(sources(false), REQUEST))).toBe(
        baseline,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives freshness only from the explicit reference time (AL)', async () => {
    const later = await assemble(sources(false), {
      ...REQUEST,
      referenceTime: '2026-12-30T12:00:00Z',
    });
    const now = await assemble(sources(false), REQUEST);
    const sameInstant = await assemble(sources(false), {
      ...REQUEST,
      referenceTime: '2026-10-01T14:00:00+02:00',
    });
    const f = (r: typeof now, id: string) => traceOf(r, id).freshness!.factor;
    expect(f(now, 'task-state')).toBe(1);
    expect(f(later, 'task-state')).toBe(0.5);
    expect(f(later, 'ep-1')).toBeLessThan(f(now, 'ep-1'));
    // The same instant in another offset notation gives the same ranking.
    expect(sameInstant.trace.ranking).toEqual(now.trace.ranking);
  });
});
