import { describe, expect, it } from 'vitest';
import {
  assemble,
  evidence,
  OTHER_OWNER,
  OWNER,
  ownerState,
  PROVENANCE,
  memorySource,
  request,
  selectedIds,
} from './fixtures.ts';

// SYNTHETIC owners and text only.
const REQUEST = 'Draft the venue booking checklist for the spring offsite';

describe('AVEN-008 owner isolation (hard invariant, enforced by the broker)', () => {
  it('never selects another owner’s exact match over the requesting owner’s weaker match (B)', async () => {
    const foreignExact = evidence('foreign-exact', REQUEST, {
      ownerId: OTHER_OWNER,
      provenance: PROVENANCE.ownerStatement('foreign-exact', OTHER_OWNER),
      signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
    });
    const ownWeak = evidence('own-weak', 'Venue notes from last year', {
      signals: { confidence: 0.1, salience: 0.1, negativeRetrieval: 0 },
    });
    const result = await assemble(
      [
        memorySource('owner-store', 'owner_state', []),
        memorySource('episodes', 'episode_history', [foreignExact, ownWeak]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own-weak']);
    expect(result.trace.candidates.map((c) => c.candidateId)).toEqual([
      'own-weak',
    ]);
    expect(result.trace.ranking.map((r) => r.candidateId)).toEqual([
      'own-weak',
    ]);
    const episodes = result.trace.sources.find(
      (s) => s.sourceId === 'episodes',
    )!;
    expect(episodes).toMatchObject({
      returned: 2,
      foreignOwnerExcluded: 1,
      considered: 1,
    });
    // No trace of the foreign record's ID or text, anywhere.
    const json = JSON.stringify(result);
    expect(json).not.toContain('foreign-exact');
    expect(json).not.toContain(OTHER_OWNER);
    // The foreign text equals the request text, which the output never holds.
    expect(json).not.toContain(REQUEST);
  });

  it('excludes a same-owner candidate whose owner-origin provenance names another owner', async () => {
    const laundered = ownerState('laundered', REQUEST, 'trusted', {
      provenance: PROVENANCE.ownerStatement('laundered', OTHER_OWNER),
    });
    const correctionFromOther = evidence('correction-other', REQUEST, {
      provenance: PROVENANCE.ownerCorrection('correction-other', OTHER_OWNER),
    });
    const own = evidence('own', 'Spring offsite venue shortlist');
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [laundered]),
        memorySource('episodes', 'episode_history', [correctionFromOther, own]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own']);
    expect(result.trace.totals).toMatchObject({
      returned: 3,
      foreignOwnerExcluded: 0,
      ownerProvenanceMismatchExcluded: 2,
      considered: 1,
    });
    expect(JSON.stringify(result)).not.toContain('laundered');
  });

  it('serves nothing when a source returns only another owner’s records', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('b1', REQUEST, {
            ownerId: OTHER_OWNER,
            provenance: PROVENANCE.systemGenerated(),
          }),
        ]),
      ],
      request(REQUEST),
    );
    expect(result.bundle.items).toEqual([]);
    expect(result.trace.candidates).toEqual([]);
    expect(result.trace.totals.foreignOwnerExcluded).toBe(1);
  });

  it('lets no foreign record change any ranking value, statistic or selection (C)', async () => {
    const own = [
      evidence('a1', 'Venue booking deposit is due Friday'),
      evidence('a2', 'Checklist template for offsites', {
        signals: { confidence: 0.9, salience: 0.2, negativeRetrieval: 0 },
      }),
      ownerState('a3', 'Spring planning cadence', 'validated'),
      evidence('a4', 'Unrelated: gardening reminder'),
    ];
    const foreign = Array.from({ length: 40 }, (_, i) =>
      evidence(`b${i}`, i % 2 === 0 ? REQUEST : `${REQUEST} venue venue`, {
        ownerId: OTHER_OWNER,
        provenance: PROVENANCE.ownerStatement(`b${i}`, OTHER_OWNER),
        signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
      }),
    );
    const alone = await assemble(
      [memorySource('episodes', 'episode_history', own)],
      request(REQUEST),
    );
    const mixed = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          ...foreign.slice(0, 20),
          ...own,
          ...foreign.slice(20),
        ]),
      ],
      request(REQUEST),
    );
    expect(JSON.stringify(mixed.bundle)).toBe(JSON.stringify(alone.bundle));
    expect(JSON.stringify(mixed.trace.candidates)).toBe(
      JSON.stringify(alone.trace.candidates),
    );
    expect(mixed.trace.ranking).toEqual(alone.trace.ranking);
    expect(mixed.trace.query).toEqual(alone.trace.query);
    expect(mixed.trace.budget).toEqual(alone.trace.budget);
    // Only the isolation counters differ.
    expect(mixed.trace.totals.foreignOwnerExcluded).toBe(40);
    expect(alone.trace.totals.foreignOwnerExcluded).toBe(0);
    expect({
      ...mixed.trace.totals,
      returned: 0,
      foreignOwnerExcluded: 0,
    }).toEqual({ ...alone.trace.totals, returned: 0, foreignOwnerExcluded: 0 });
  });

  it('passes every source the requesting owner only, in a frozen query', async () => {
    const source = memorySource('episodes', 'episode_history', []);
    await assemble([source], request(REQUEST));
    expect(source.queries).toHaveLength(1);
    const query = source.queries[0]!;
    expect(query.ownerId).toBe(OWNER);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.task)).toBe(true);
    expect(Object.isFrozen(query.taskDescriptor)).toBe(true);
    expect(() => {
      (query as { ownerId: string }).ownerId = OTHER_OWNER;
    }).toThrow(TypeError);
  });
});
