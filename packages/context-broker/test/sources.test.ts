import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BROKER_ERROR_CODES,
  ContextBrokerError,
  createContextBroker,
  MAX_CANDIDATES_PER_SOURCE,
  MAX_SOURCES,
  MAX_TOTAL_CANDIDATES,
  type ContextSource,
} from '../src/index.ts';
import {
  activeTask,
  assemble,
  evidence,
  external,
  instruction,
  memorySource,
  OTHER_OWNER,
  ownerState,
  PROVENANCE,
  request,
  selectedIds,
} from './fixtures.ts';

// SYNTHETIC sources and text only.

const ok = () =>
  memorySource('ok', 'episode_history', [evidence('ok-1', 'Budget')]);

async function failure(
  sources: readonly ContextSource[],
): Promise<ContextBrokerError> {
  try {
    await assemble(sources, request('budget'));
  } catch (error) {
    expect(error).toBeInstanceOf(ContextBrokerError);
    return error as ContextBrokerError;
  }
  throw new Error('expected the assembly to fail');
}

describe('AVEN-008 source failure policy: fail closed, typed, observable (Z)', () => {
  it('fails the whole assembly when a source throws or rejects, without leaking its error', async () => {
    const secret = 'provider stack trace with SECRET-TOKEN-123';
    for (const collect of [
      () => {
        throw new Error(secret);
      },
      () => Promise.reject(new Error(secret)),
      () => Promise.reject(secret),
    ]) {
      const error = await failure([
        ok(),
        { sourceId: 'broken', kind: 'owner_state', collect },
      ]);
      expect(error.code).toBe('source_failure');
      expect(error.sourceId).toBe('broken');
      expect(error.message).not.toContain('SECRET');
      expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });

  it('wraps a source that throws a spoofed broker error as source_failure', async () => {
    const error = await failure([
      {
        sourceId: 'spoof',
        kind: 'owner_state',
        collect: () => {
          throw new ContextBrokerError('invalid_request');
        },
      },
    ]);
    expect(error.code).toBe('source_failure');
    expect(error.sourceId).toBe('spoof');
  });

  it('rejects a non-array collection as a source failure', async () => {
    for (const value of [null, undefined, 'text', { length: 1, 0: {} }, 42]) {
      const error = await failure([
        memorySource('weird', 'owner_state', () => value),
      ]);
      expect(error.code).toBe('source_failure');
    }
  });

  it('reports the first failing source in sourceId order, deterministically', async () => {
    const bad = (id: string): ContextSource => ({
      sourceId: id,
      kind: 'owner_state',
      collect: () => {
        throw new Error(id);
      },
    });
    for (const order of [
      [bad('b-src'), bad('a-src'), ok()],
      [ok(), bad('a-src'), bad('b-src')],
    ])
      expect((await failure(order)).sourceId).toBe('a-src');
  });

  it('queries no source when the request is invalid', async () => {
    const source = ok();
    const broker = createContextBroker({ sources: [source] });
    for (const bad of [
      { ...request('budget'), ownerId: 'not-an-owner' },
      { ...request('budget'), referenceTime: 'yesterday' },
      { ...request('budget'), request: '   ' },
      { ...request('budget'), request: 'x'.repeat(8001) },
      { ...request('budget'), extra: true },
      { ...request('budget'), taskDescriptor: { domain: 'x', topic: 'y' } },
      { ...request('budget'), taskDescriptor: undefined },
    ])
      await expect(
        broker.assemble(bad as Parameters<typeof broker.assemble>[0]),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(source.queries).toEqual([]);
  });

  it('rejects invalid source configuration at construction', () => {
    const configs: unknown[] = [
      undefined,
      {},
      { sources: 'x' },
      { sources: [], extra: 1 },
      { sources: [{ sourceId: 'x', kind: 'owner_state' }] },
      { sources: [{ sourceId: 'x', kind: 'web', collect: () => [] }] },
      { sources: [{ sourceId: '', kind: 'owner_state', collect: () => [] }] },
      { sources: [ok(), ok()] },
      {
        sources: Array.from({ length: MAX_SOURCES + 1 }, (_, i) =>
          memorySource(`s${i}`, 'owner_state', []),
        ),
      },
    ];
    for (const config of configs)
      expect(
        () =>
          createContextBroker(
            config as Parameters<typeof createContextBroker>[0],
          ),
        JSON.stringify(config),
      ).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
    expect(
      createContextBroker({
        sources: Array.from({ length: MAX_SOURCES }, (_, i) =>
          memorySource(`s${String(i).padStart(2, '0')}`, 'owner_state', []),
        ),
      }).sources,
    ).toHaveLength(MAX_SOURCES);
  });

  it('reads source ID and kind once, at registration', async () => {
    const source = { ...memorySource('fixed', 'episode_history', []) } as {
      sourceId: string;
      kind: string;
    } & ContextSource;
    const broker = createContextBroker({ sources: [source] });
    source.sourceId = 'changed';
    source.kind = 'permitted_external';
    const result = await broker.assemble(request('budget'));
    expect(result.trace.sources).toEqual([
      expect.objectContaining({ sourceId: 'fixed', kind: 'episode_history' }),
    ]);
    expect(broker.sources).toEqual([
      { sourceId: 'fixed', kind: 'episode_history' },
    ]);
  });

  it('exposes only the declared stable error codes with fixed messages', () => {
    expect(CONTEXT_BROKER_ERROR_CODES).toEqual([
      'invalid_configuration',
      'invalid_request',
      'source_failure',
      'source_timeout',
      'source_resource_limit_exceeded',
      'candidate_limit_exceeded',
      'invalid_candidate',
      'invalid_score_metadata',
      'conflicting_duplicate',
    ]);
    const error = new ContextBrokerError('invalid_candidate', {
      sourceId: 's',
    });
    expect(error.message).toBe(
      'A context candidate is malformed; no context was assembled',
    );
    // v2 keeps no cause at all.
    expect(error.cause).toBeUndefined();
    expect(Object.isFrozen(CONTEXT_BROKER_ERROR_CODES)).toBe(true);
    expect(error.name).toBe('ContextBrokerError');
  });
});

describe('AVEN-008 collection bounds and flooding (Y)', () => {
  const many = (prefix: string, n: number, ownerId?: string) =>
    Array.from({ length: n }, (_, i) =>
      evidence(`${prefix}${i}`, 'Budget review notes', {
        ...(ownerId === undefined
          ? {}
          : {
              ownerId,
              provenance: PROVENANCE.ownerStatement(`${prefix}${i}`, ownerId),
            }),
      }),
    );

  it('accepts exactly the per-source cap and rejects one more', async () => {
    const atCap = await assemble(
      [
        memorySource(
          'flood',
          'episode_history',
          many('c', MAX_CANDIDATES_PER_SOURCE),
        ),
      ],
      request('budget review'),
    );
    expect(atCap.trace.sources[0]!.considered).toBe(500);
    expect(atCap.bundle.items).toHaveLength(10);
    const error = await failure([
      memorySource(
        'flood',
        'episode_history',
        many('c', MAX_CANDIDATES_PER_SOURCE + 1),
      ),
    ]);
    expect(error.code).toBe('candidate_limit_exceeded');
    expect(error.sourceId).toBe('flood');
  });

  it('bounds the total across sources before any validation or ranking', async () => {
    const perSource = Math.floor(MAX_TOTAL_CANDIDATES / 5) + 1;
    expect(perSource).toBeLessThanOrEqual(MAX_CANDIDATES_PER_SOURCE);
    const sources = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      // Source 'e' is also malformed: the total bound is checked first.
      memorySource(id, 'episode_history', () =>
        id === 'e'
          ? Array.from({ length: perSource }, () => ({}))
          : many(id, perSource),
      ),
    );
    const error = await failure(sources);
    expect(error.code).toBe('candidate_limit_exceeded');
    expect(error.sourceId).toBeUndefined();
  });

  it('never counts foreign records against the owner-context quota (H2)', async () => {
    const result = await assemble(
      [
        memorySource('noisy', 'episode_history', [
          ...many('b', MAX_CANDIDATES_PER_SOURCE, OTHER_OWNER),
          ...many('own', MAX_CANDIDATES_PER_SOURCE),
        ]),
      ],
      request('budget review'),
    );
    expect(result.trace.sources[0]!.considered).toBe(MAX_CANDIDATES_PER_SOURCE);
    const overflow = await failure([
      memorySource('noisy', 'episode_history', [
        ...many('b', 10, OTHER_OWNER),
        ...many('own', MAX_CANDIDATES_PER_SOURCE + 1),
      ]),
    ]);
    expect(overflow.code).toBe('candidate_limit_exceeded');
  });

  it('lets one noisy source fill at most the global item limit', async () => {
    const result = await assemble(
      [
        memorySource('noisy', 'episode_history', many('n', 400)),
        memorySource('quiet', 'owner_state', [
          ownerState('quiet-1', 'Budget review cadence', 'trusted'),
        ]),
      ],
      request('budget review'),
    );
    expect(result.bundle.items).toHaveLength(10);
    expect(result.bundle.budget.itemLimitExclusions).toBeGreaterThan(0);
  });
});

describe('AVEN-008 malformed candidates fail closed (AM, AN)', () => {
  it('rejects NaN, Infinity, out-of-range and non-numeric signals as invalid_score_metadata', async () => {
    for (const signals of [
      { confidence: Number.NaN, salience: 0.5, negativeRetrieval: 0 },
      {
        confidence: 0.5,
        salience: Number.POSITIVE_INFINITY,
        negativeRetrieval: 0,
      },
      {
        confidence: 0.5,
        salience: 0.5,
        negativeRetrieval: Number.NEGATIVE_INFINITY,
      },
      { confidence: -0.01, salience: 0.5, negativeRetrieval: 0 },
      { confidence: 0.5, salience: 1.01, negativeRetrieval: 0 },
      { confidence: '0.5', salience: 0.5, negativeRetrieval: 0 },
      { confidence: 0.5, salience: 0.5 },
      { confidence: 0.5, salience: 0.5, negativeRetrieval: 0, trust: 1 },
    ]) {
      const error = await failure([
        memorySource('episodes', 'episode_history', [
          evidence('bad', 'Budget', { signals: signals as never }),
        ]),
      ]);
      expect(error.code, JSON.stringify(signals)).toBe(
        'invalid_score_metadata',
      );
      expect(error.candidateIndex).toBe(0);
    }
  });

  it('rejects unknown or malformed fields as invalid_candidate', async () => {
    const base = evidence('bad', 'Budget');
    const variants: unknown[] = [
      { ...base, trustOverride: 1 },
      { ...base, score: 0.99 },
      { ...base, reference: { ...base.reference, priority: 'high' } },
      { ...base, ownerId: 'owner B' },
      { ...base, text: '' },
      { ...base, text: 'x'.repeat(20001) },
      { ...base, timestamps: { recordedAt: 'last week' } },
      {
        ...base,
        timestamps: {
          recordedAt: '2026-09-02T00:00:00Z',
          lastValidatedAt: '2026-09-01T00:00:00Z',
        },
      },
      { ...base, scope: { kind: 'bounded' } },
      { ...base, scope: undefined },
      { ...base, provenance: { kind: 'explicit_owner_statement' } },
      {
        ...base,
        scope: { kind: 'bounded', domain: 'd'.repeat(257) },
      },
      { ...base, scope: { kind: 'unknown', reason: 'r'.repeat(1001) } },
      {
        ...base,
        provenance: {
          ...PROVENANCE.externalContent(),
          source: 's'.repeat(1001),
        },
      },
      'just a string',
      null,
    ];
    for (const candidate of variants) {
      const error = await failure([
        memorySource('episodes', 'episode_history', [candidate]),
      ]);
      expect(error.code, JSON.stringify(candidate)?.slice(0, 80)).toBe(
        'invalid_candidate',
      );
    }
  });

  it('rejects duplicate candidate IDs within one source', async () => {
    const error = await failure([
      memorySource('episodes', 'episode_history', [
        evidence('dup', 'Budget'),
        evidence('dup', 'Budget again'),
      ]),
    ]);
    expect(error).toMatchObject({
      code: 'invalid_candidate',
      sourceId: 'episodes',
      candidateIndex: 1,
    });
  });
});

describe('AVEN-008 provenance laundering is rejected structurally', () => {
  it('lets a permitted external source return only external/tool evidence', async () => {
    for (const candidate of [
      evidence('claims-owner', 'Budget'),
      evidence('claims-system', 'Budget', {
        provenance: PROVENANCE.systemGenerated(),
      }),
      ownerState('claims-state', 'Budget', 'trusted', {
        provenance: PROVENANCE.externalContent(),
      }),
      instruction('claims-instruction', 'Budget'),
    ]) {
      const error = await failure([
        memorySource('web', 'permitted_external', [candidate]),
      ]);
      expect(error.code, candidate.candidateId).toBe('invalid_candidate');
    }
    const result = await assemble(
      [
        memorySource('web', 'permitted_external', [
          external('page', 'Budget page'),
          evidence('tool', 'Budget tool output', {
            provenance: PROVENANCE.toolResult('tool'),
          }),
        ]),
      ],
      request('budget'),
    );
    expect(selectedIds(result).sort()).toEqual(['page', 'tool']);
  });

  it('accepts only reference kinds declared for each source kind', async () => {
    const cases: [ContextSource['kind'], unknown][] = [
      ['episode_history', instruction('i', 'Budget')],
      ['episode_history', activeTask('t', 'Budget')],
      ['owner_state', evidence('e', 'Budget')],
      ['procedure', activeTask('t', 'Budget')],
      ['active_task', ownerState('s', 'Budget')],
    ];
    for (const [kind, candidate] of cases)
      expect(
        (await failure([memorySource('src', kind, [candidate])])).code,
      ).toBe('invalid_candidate');
  });

  it('requires owner instruction provenance for a current instruction', async () => {
    const error = await failure([
      memorySource('active', 'active_task', [
        instruction('model-says', 'Budget', undefined, {
          provenance: PROVENANCE.modelInference(),
        }),
      ]),
    ]);
    expect(error.code).toBe('invalid_candidate');
  });
});
