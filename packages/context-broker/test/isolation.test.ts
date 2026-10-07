import { describe, expect, it } from 'vitest';
import {
  ContextBrokerError,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_RAW_ITEMS_PER_SOURCE,
  MAX_TOTAL_CANDIDATES,
} from '../src/index.ts';
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
const foreignRecord = (id: string, text = REQUEST) =>
  evidence(id, text, {
    ownerId: OTHER_OWNER,
    provenance: PROVENANCE.ownerStatement(id, OTHER_OWNER),
    signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
  });
const ownRecord = () => evidence('own', 'Venue booking notes');

describe('AVEN-008 owner isolation (hard invariant, enforced by the broker)', () => {
  it('never selects another owner’s exact match over the requesting owner’s weaker match (B)', async () => {
    const ownWeak = evidence('own-weak', 'Venue notes from last year', {
      signals: { confidence: 0.1, salience: 0.1, negativeRetrieval: 0 },
    });
    const result = await assemble(
      [
        memorySource('owner-store', 'owner_state', []),
        memorySource('episodes', 'episode_history', [
          foreignRecord('foreign-exact'),
          ownWeak,
        ]),
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
    expect(result.trace.sources).toEqual([
      { sourceId: 'episodes', kind: 'episode_history', considered: 1 },
      { sourceId: 'owner-store', kind: 'owner_state', considered: 0 },
    ]);
    // No trace of the foreign record's ID, owner or text, anywhere.
    const json = JSON.stringify(result);
    expect(json).not.toContain('foreign-exact');
    expect(json).not.toContain(OTHER_OWNER);
    expect(json).not.toContain(REQUEST);
  });

  it('reveals nothing about foreign records: foreign-only equals empty (H3)', async () => {
    const foreignOnly = await assemble(
      [
        memorySource(
          'episodes',
          'episode_history',
          Array.from({ length: 30 }, (_, i) => foreignRecord(`b${i}`)),
        ),
      ],
      request(REQUEST),
    );
    const empty = await assemble(
      [memorySource('episodes', 'episode_history', [])],
      request(REQUEST),
    );
    expect(foreignOnly.bundle.items).toEqual([]);
    expect(JSON.stringify(foreignOnly)).toBe(JSON.stringify(empty));
    for (const key of [
      'returned',
      'foreignOwnerExcluded',
      'ownerProvenanceMismatchExcluded',
    ])
      expect(JSON.stringify(foreignOnly)).not.toContain(key);
  });

  it('lets no foreign record change any part of the output (C, H3)', async () => {
    const own = [
      evidence('a1', 'Venue booking deposit is due Friday'),
      evidence('a2', 'Checklist template for offsites', {
        signals: { confidence: 0.9, salience: 0.2, negativeRetrieval: 0 },
      }),
      ownerState('a3', 'Spring planning cadence', 'validated'),
      evidence('a4', 'Unrelated: gardening reminder'),
    ];
    const foreign = Array.from({ length: 40 }, (_, i) =>
      foreignRecord(`b${i}`, i % 2 === 0 ? REQUEST : `${REQUEST} venue venue`),
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
    // Byte-identical bundle AND trace: no isolation counter exists any more.
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(alone));
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

describe('AVEN-008 foreign records are dropped before owner quotas and validation (H2)', () => {
  it('serves the owner when a source returns 500 foreign records plus 1 own', async () => {
    const result = await assemble(
      [
        memorySource('flood', 'episode_history', [
          ...Array.from({ length: MAX_CANDIDATES_PER_SOURCE }, (_, i) =>
            foreignRecord(`b${i}`),
          ),
          ownRecord(),
        ]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own']);
    expect(result.trace.sources).toEqual([
      { sourceId: 'flood', kind: 'episode_history', considered: 1 },
    ]);
  });

  it('serves the owner when more than the total quota of foreign records arrives across sources', async () => {
    const perSource = 600;
    const sources = ['a', 'b', 'c', 'd'].map((id) =>
      memorySource(
        id,
        'episode_history',
        Array.from({ length: perSource }, (_, i) => foreignRecord(`${id}${i}`)),
      ),
    );
    expect(sources.length * perSource).toBeGreaterThan(MAX_TOTAL_CANDIDATES);
    const result = await assemble(
      [...sources, memorySource('mine', 'episode_history', [ownRecord()])],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own']);
  });

  it('ignores a foreign record that reuses the owner’s candidate ID', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          foreignRecord('own'),
          ownRecord(),
        ]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own']);
    expect(result.bundle.items[0]!.text).toBe('Venue booking notes');
  });

  it('never validates or reads a recognizable foreign record beyond its owner ID', async () => {
    let textRead = false;
    const malformedForeign = {
      ownerId: OTHER_OWNER,
      candidateId: 'not a valid id!',
      signals: { confidence: Number.NaN },
      get text(): string {
        textRead = true;
        throw new Error('SECRET-FOREIGN-TEXT');
      },
    };
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          malformedForeign,
          ownRecord(),
        ]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['own']);
    expect(textRead).toBe(false);
  });

  it('keeps the raw resource bound, separate from owner quotas and without counts', async () => {
    const error = await assemble(
      [
        memorySource(
          'pathological',
          'episode_history',
          Array.from({ length: MAX_RAW_ITEMS_PER_SOURCE + 1 }, () => ({
            ownerId: OTHER_OWNER,
          })),
        ),
      ],
      request(REQUEST),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextBrokerError);
    expect(error).toMatchObject({
      code: 'source_resource_limit_exceeded',
      sourceId: 'pathological',
    });
    expect((error as Error).message).not.toMatch(/\d/);
  });

  it('fails closed on an item whose owner cannot be recognized', async () => {
    for (const item of [
      { ...ownRecord(), ownerId: 'owner B' },
      { text: 'no owner at all' },
    ]) {
      const error = await assemble(
        [memorySource('episodes', 'episode_history', [item, ownRecord()])],
        request(REQUEST),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'invalid_candidate',
        sourceId: 'episodes',
      });
      // Ownership was never established: no public position (H3).
      expect((error as ContextBrokerError).candidateIndex).toBeUndefined();
    }
  });
});
