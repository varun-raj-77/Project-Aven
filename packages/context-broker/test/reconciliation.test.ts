import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_BROKER_CONFIG_V2,
  CONTEXT_SOURCE_KINDS,
  ContextBrokerError,
  ContextCandidateSchema,
  createContextBroker,
  EXCLUSION_REASONS,
  RANKING_FACTORS,
  RANKING_WEIGHTS_BASIS_POINTS,
  SOURCE_COLLECTION_DEADLINE_MS,
  STOPWORDS_V1,
  type ContextAssembly,
  type ContextSource,
  type ContextSourceCollectOptions,
} from '../src/index.ts';
import { SOURCE_KIND_REFERENCE_KINDS } from '../src/config.ts';
import {
  activeTask,
  assemble,
  evidence,
  instruction,
  memorySource,
  OTHER_OWNER,
  OWNER,
  ownerState,
  PROVENANCE,
  request,
  selectedIds,
  traceOf,
} from './fixtures.ts';

// SYNTHETIC data only. Regressions for the AVEN-008 independent-review
// corrections (H1-H4, M1-M6) and the async-settlement determinism finding.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SECRET = 'SECRET-TOKEN-7731';

async function failure(
  run: () => Promise<unknown>,
): Promise<ContextBrokerError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextBrokerError);
    return error as ContextBrokerError;
  }
  throw new Error('expected the assembly to fail');
}

/** The public surface of an error must be fixed, typed and secret-free. */
function expectSanitized(error: ContextBrokerError, code: string) {
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(error.message).not.toContain('SECRET');
  expect(JSON.stringify(error)).not.toContain('SECRET');
  expect(String(error)).not.toContain('SECRET');
}

describe('H1 source-collection deadline', () => {
  it('times out a never-resolving source with a typed error and clears its timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const stuck: ContextSource = {
      sourceId: 'stuck',
      kind: 'episode_history',
      collect: (_query, options: ContextSourceCollectOptions) => {
        signal = options.signal;
        return new Promise<never>(() => {});
      },
    };
    const pending = createContextBroker({
      sources: [stuck, memorySource('ok', 'episode_history', [])],
    })
      .assemble(request('Budget review'))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SOURCE_COLLECTION_DEADLINE_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Settled by now: a missing deadline yields 'still-pending', not a hang.
    const error = (await Promise.race([
      pending,
      Promise.resolve('still-pending'),
    ])) as ContextBrokerError;
    expect(error).toBeInstanceOf(ContextBrokerError);
    expect(error).toMatchObject({ code: 'source_timeout', sourceId: 'stuck' });
    expect(error.cause).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('assembles normally when sources finish before the deadline, leaving no timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = createContextBroker({
      sources: [
        {
          sourceId: 'slow',
          kind: 'episode_history',
          collect: (_query, options: ContextSourceCollectOptions) => {
            signal = options.signal;
            return new Promise((resolve) => {
              setTimeout(
                () => resolve([evidence('a', 'Budget review notes')]),
                SOURCE_COLLECTION_DEADLINE_MS - 10,
              );
            });
          },
        },
      ],
    }).assemble(request('Budget review'));
    await vi.advanceTimersByTimeAsync(SOURCE_COLLECTION_DEADLINE_MS - 10);
    const result = await pending;
    expect(selectedIds(result)).toEqual(['a']);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps freshness on the request referenceTime however long collection takes', async () => {
    const candidates = () => [
      evidence('old', 'Budget review notes', {
        timestamps: { recordedAt: '2026-07-03T12:00:00Z' },
      }),
    ];
    const immediate = await assemble(
      [memorySource('episodes', 'episode_history', candidates)],
      request('Budget review'),
    );
    vi.useFakeTimers({ now: new Date('2031-06-01T00:00:00Z') });
    const pending = createContextBroker({
      sources: [
        {
          sourceId: 'episodes',
          kind: 'episode_history',
          collect: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(candidates()), 4000),
            ),
        },
      ],
    }).assemble(request('Budget review'));
    await vi.advanceTimersByTimeAsync(4000);
    const delayed = await pending;
    expect(traceOf(delayed, 'old').freshness).toEqual({
      anchor: 'recordedAt',
      ageMilliseconds: 90 * 86_400_000,
      factor: 0.5,
    });
    expect(JSON.stringify(delayed)).toBe(JSON.stringify(immediate));
  });
});

describe('Async settlement order never changes the result (determinism regression)', () => {
  function deferredSources() {
    const resolvers: Record<string, () => void> = {};
    const data: Record<string, unknown[]> = {
      alpha: [
        evidence('a1', 'Budget review notes for alpha'),
        ownerState('a2', 'Budget cadence', 'validated'),
      ],
      beta: [evidence('b1', 'Quarterly budget review')],
      gamma: [
        evidence('g1', 'Review checklist budget', {
          signals: { confidence: 0.9, salience: 0.1, negativeRetrieval: 0 },
        }),
      ],
      delta: [instruction('d1', 'Keep the budget review short')],
    };
    const kinds: Record<string, ContextSource['kind']> = {
      alpha: 'episode_history',
      beta: 'episode_history',
      gamma: 'episode_history',
      delta: 'active_task',
    };
    const sources: ContextSource[] = Object.keys(data).map((id) => ({
      sourceId: id,
      kind: kinds[id]!,
      collect: () =>
        new Promise<readonly unknown[]>((resolve) => {
          resolvers[id] = () => resolve(data[id]!);
        }),
    }));
    return { sources, resolvers };
  }

  it('produces byte-identical bundle, ordering, trace and scores for every settlement order', async () => {
    const orders = [
      ['alpha', 'beta', 'gamma', 'delta'],
      ['delta', 'gamma', 'beta', 'alpha'],
      ['gamma', 'alpha', 'delta', 'beta'],
      ['beta', 'delta', 'alpha', 'gamma'],
    ];
    const outputs: string[] = [];
    for (const order of orders) {
      const { sources, resolvers } = deferredSources();
      const pending = createContextBroker({ sources }).assemble(
        request('Budget review'),
      );
      for (const id of order) {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        resolvers[id]!();
      }
      const result: ContextAssembly = await pending;
      expect(result.bundle.items.length).toBeGreaterThan(1);
      outputs.push(JSON.stringify(result));
    }
    expect(new Set(outputs).size).toBe(1);
  });
});

describe('H4 conservative bounded scope', () => {
  const recruiterScope = {
    kind: 'bounded' as const,
    domain: 'outreach',
    qualifiers: { recipient: 'recruiter' },
  };

  it('does not apply a recruiter-specific item when only the domain is established', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState(
            'recruiter-short',
            'Outreach notes should be short',
            'trusted',
            {
              scope: recruiterScope,
            },
          ),
        ]),
      ],
      request('Write the outreach notes', {
        taskDescriptor: { domain: 'outreach' },
      }),
    );
    const entry = traceOf(result, 'recruiter-short');
    expect(entry.relevance.matchedContentTermCount).toBeGreaterThan(0);
    expect(entry.scope).toEqual({
      status: 'unresolved',
      matched: ['domain'],
      mismatched: [],
      unresolved: ['recipient'],
    });
    expect(entry.exclusionReason).toBe('scope_unresolved');
    expect(result.bundle.items).toEqual([]);
  });

  it('applies it once every declared restriction is established', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState(
            'recruiter-short',
            'Outreach notes should be short',
            'trusted',
            {
              scope: recruiterScope,
            },
          ),
        ]),
      ],
      request('Write the outreach notes', {
        taskDescriptor: {
          domain: 'Outreach',
          qualifiers: { recipient: 'recruiter' },
        },
      }),
    );
    expect(traceOf(result, 'recruiter-short').scope.status).toBe('label_match');
    expect(selectedIds(result)).toEqual(['recruiter-short']);
  });

  it('does not let an exact task binding erase an unresolved restriction', async () => {
    const result = await assemble(
      [
        memorySource('active', 'active_task', [
          activeTask('bound', 'Open loop for outreach', undefined, {
            scope: recruiterScope,
          }),
          activeTask('bound-plain', 'Open loop for outreach'),
        ]),
      ],
      request('Write the outreach notes', {
        taskDescriptor: { domain: 'outreach' },
      }),
    );
    expect(traceOf(result, 'bound').taskBinding).toBe('matches');
    expect(traceOf(result, 'bound').exclusionReason).toBe('scope_unresolved');
    expect(traceOf(result, 'bound-plain').scope.status).toBe('task_match');
    expect(selectedIds(result)).toEqual(['bound-plain']);
  });
});

describe('M1 identity deduplication', () => {
  const text = 'Budget review notes';

  it('keeps one slot for the same candidate ID offered by three sources', async () => {
    const same = evidence('shared', text);
    const result = await assemble(
      ['s1', 's2', 's3'].map((id) =>
        memorySource(id, 'episode_history', [same]),
      ),
      request('Budget review'),
    );
    expect(result.bundle.items.map((i) => [i.sourceId, i.candidateId])).toEqual(
      [['s1', 'shared']],
    );
    for (const id of ['s2', 's3']) {
      const dup = result.trace.candidates.find((c) => c.sourceId === id)!;
      expect(dup.exclusionReason).toBe('duplicate_identity');
      expect(dup.duplicateOf).toEqual({
        sourceId: 's1',
        candidateId: 'shared',
      });
    }
  });

  it('keeps one slot for the same evidence reference under different aliases', async () => {
    const base = evidence('alias-0', text);
    const aliases = Array.from({ length: 10 }, (_, i) => ({
      ...base,
      candidateId: `alias-${i}`,
    }));
    const distinct = Array.from({ length: 3 }, (_, i) =>
      evidence(`distinct-${i}`, `${text} ${i}`),
    );
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', aliases.slice(0, 5)),
        memorySource('external', 'episode_history', aliases.slice(5)),
        memorySource('other', 'episode_history', distinct),
      ],
      request('Budget review'),
    );
    const ids = selectedIds(result);
    expect(ids.filter((id) => id.startsWith('alias-'))).toEqual(['alias-0']);
    expect(ids.filter((id) => id.startsWith('distinct-')).sort()).toEqual([
      'distinct-0',
      'distinct-1',
      'distinct-2',
    ]);
    expect(result.bundle.items).toHaveLength(4);
    expect(result.trace.totals.excludedByReason.duplicate_identity).toBe(9);
  });

  it('deduplicates the same learned item version, not different versions', async () => {
    const v1 = ownerState('pref-a', 'Budget review cadence', 'trusted');
    const sameVersion = { ...v1, candidateId: 'pref-b' };
    const otherVersion = {
      ...v1,
      candidateId: 'pref-c',
      reference: {
        kind: 'owner_state' as const,
        reference: { learnedItemId: 'learned_synpref-a', version: 2 },
        lifecycle: 'trusted' as const,
      },
    };
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [v1, sameVersion]),
        memorySource('procedures', 'procedure', [otherVersion]),
      ],
      request('Budget review'),
    );
    expect(traceOf(result, 'pref-b').exclusionReason).toBe(
      'duplicate_identity',
    );
    expect(selectedIds(result).sort()).toEqual(['pref-a', 'pref-c']);
  });

  it('fails closed, deterministically, when duplicates disagree', async () => {
    const original = evidence('dup', text);
    const altered = {
      ...original,
      candidateId: 'dup-alias',
      signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
    };
    const sameIdDifferentContent = { ...original, text: 'Different content' };
    for (const sources of [
      [
        memorySource('a', 'episode_history', [original]),
        memorySource('b', 'episode_history', [altered]),
      ],
      [
        memorySource('b', 'episode_history', [altered]),
        memorySource('a', 'episode_history', [original]),
      ],
      [
        memorySource('a', 'episode_history', [original]),
        memorySource('b', 'episode_history', [sameIdDifferentContent]),
      ],
    ]) {
      const error = await failure(() => assemble(sources, request('Budget')));
      expect(error).toMatchObject({
        code: 'conflicting_duplicate',
        sourceId: 'b',
      });
    }
  });
});

describe('M3 direct owner-provenance consistency', () => {
  const run = (
    candidate: unknown,
    kind: ContextSource['kind'] = 'episode_history',
  ) =>
    assemble(
      [memorySource('src', kind, [candidate])],
      request('Budget review'),
    );

  it('accepts direct owner evidence citing its own event', async () => {
    const result = await run(evidence('ok', 'Budget review notes'));
    expect(selectedIds(result)).toEqual(['ok']);
  });

  it('rejects direct owner evidence citing a different event', async () => {
    const mismatched = evidence('bad', 'Budget review notes', {
      provenance: {
        kind: 'explicit_owner_statement',
        ownerId: OWNER,
        sourceEventId: 'event_someone_else',
      },
    });
    expect((await failure(() => run(mismatched))).code).toBe(
      'invalid_candidate',
    );
    const instructionMismatch = instruction(
      'bad-i',
      'Budget review notes',
      undefined,
      {
        provenance: {
          kind: 'explicit_owner_correction',
          ownerId: OWNER,
          sourceEventId: 'event_other',
        },
      },
    );
    expect(
      (await failure(() => run(instructionMismatch, 'active_task'))).code,
    ).toBe('invalid_candidate');
  });

  it('rejects owner-origin provenance naming another owner', async () => {
    const otherOwner = evidence('bad', 'Budget review notes', {
      provenance: PROVENANCE.ownerStatement('bad', OTHER_OWNER),
    });
    expect((await failure(() => run(otherOwner))).code).toBe(
      'invalid_candidate',
    );
  });

  it('accepts a learned reference whose provenance cites a separate supporting event', async () => {
    const learned = ownerState('learned', 'Budget review cadence', 'trusted', {
      provenance: {
        kind: 'explicit_owner_statement',
        ownerId: OWNER,
        sourceEventId: 'event_supporting_statement',
      },
    });
    const result = await run(learned, 'owner_state');
    expect(selectedIds(result)).toEqual(['learned']);
  });
});

describe('M4 trace does not echo request-derived strings', () => {
  it('keeps query and matched terms out of the trace, counting them instead', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('a', `Quillwort marigold ${SECRET.toLowerCase()} notes`),
        ]),
      ],
      request(`Quillwort marigold with ${SECRET}`),
    );
    const trace = JSON.stringify(result.trace).toLowerCase();
    for (const term of ['secret', '7731', 'quillwort', 'marigold'])
      expect(trace).not.toContain(term);
    expect(result.trace.query).toEqual({
      termCount: 5,
      contentTermCount: 5,
      qualifierTermCount: 0,
    });
    expect(traceOf(result, 'a').relevance.matchedTermCount).toBe(5);
  });
});

describe('M5 exported configuration is frozen at runtime', () => {
  it('rejects runtime mutation of exported collections and later calls are unchanged', async () => {
    const run = () =>
      assemble(
        [
          memorySource('episodes', 'episode_history', [
            evidence('a', 'Budget review notes'),
            ownerState('b', 'Budget cadence', 'observed'),
          ]),
        ],
        request('Budget review'),
      );
    const before = JSON.stringify(await run());
    const attempts: (() => void)[] = [
      () => (RANKING_FACTORS as unknown as string[]).push('extra'),
      () => (RANKING_FACTORS as unknown as string[]).splice(0, 1),
      () => ((RANKING_FACTORS as unknown as string[])[0] = 'trust'),
      () => (CONTEXT_SOURCE_KINDS as unknown as string[]).push('anything'),
      () => (CONTEXT_SOURCE_KINDS as unknown as string[]).splice(0, 5),
      () => ((CONTEXT_SOURCE_KINDS as unknown as string[])[4] = 'owner_state'),
      () =>
        ((RANKING_WEIGHTS_BASIS_POINTS as Record<string, number>).relevance =
          0),
      () =>
        (
          CONTEXT_BROKER_CONFIG_V2.relevance
            .tokenizerSteps as unknown as string[]
        ).push('x'),
      () =>
        ((
          CONTEXT_BROKER_CONFIG_V2.scope.factors as Record<string, number>
        ).unknown = 1),
      () =>
        (SOURCE_KIND_REFERENCE_KINDS.permitted_external as string[]).push(
          'owner_state',
        ),
      () => (EXCLUSION_REASONS as string[]).splice(0, 1),
      () => (STOPWORDS_V1 as string[]).push('budget'),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
    expect(JSON.stringify(await run())).toBe(before);
  });

  it('keeps the broker’s own schemas independent of the exported schema objects', async () => {
    const original = ContextCandidateSchema.safeParse;
    (ContextCandidateSchema as { safeParse: unknown }).safeParse = () => ({
      success: true,
      data: {},
    });
    try {
      const error = await failure(() =>
        assemble(
          [memorySource('episodes', 'episode_history', [{ ownerId: OWNER }])],
          request('Budget review'),
        ),
      );
      expect(error.code).toBe('invalid_candidate');
    } finally {
      (ContextCandidateSchema as { safeParse: unknown }).safeParse = original;
    }
  });
});

describe('M6 sanitized typed errors for malformed source data', () => {
  it('rejects a sparse collection and an undefined hole as invalid_candidate', async () => {
    for (const collection of [
      // eslint-style note: sparse on purpose.
      new Array(1),
      [evidence('a', 'Budget'), undefined],
    ]) {
      const error = await failure(() =>
        assemble(
          [memorySource('holes', 'episode_history', collection)],
          request('Budget review'),
        ),
      );
      expectSanitized(error, 'invalid_candidate');
      expect(error.sourceId).toBe('holes');
    }
  });

  it('never leaks a secret from a throwing candidate getter', async () => {
    const own = evidence('g', 'Budget');
    const withGetter = {
      ...own,
      get text(): string {
        throw new Error(SECRET);
      },
    };
    const nested = {
      ...own,
      scope: {
        kind: 'unknown',
        get reason(): string {
          throw new Error(SECRET);
        },
      },
    };
    const ownerGetter = {
      get ownerId(): string {
        throw new Error(SECRET);
      },
    };
    for (const candidate of [withGetter, nested, ownerGetter]) {
      const error = await failure(() =>
        assemble(
          [memorySource('getters', 'episode_history', [candidate])],
          request('Budget review'),
        ),
      );
      expectSanitized(error, 'invalid_candidate');
    }
  });

  it('never leaks a secret from a throwing registration getter or a hostile options object', () => {
    const throwing = {
      kind: 'owner_state',
      collect: () => [],
      get sourceId(): string {
        throw new Error(SECRET);
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SECRET);
        },
      },
    );
    for (const options of [
      { sources: [throwing] },
      proxy,
      {
        get sources(): unknown {
          throw new ContextBrokerError('invalid_request');
        },
      },
    ]) {
      let caught: unknown;
      try {
        createContextBroker(options as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ContextBrokerError);
      expectSanitized(caught as ContextBrokerError, 'invalid_configuration');
    }
  });

  it('never leaks a secret from a throwing request getter', async () => {
    const hostile = {
      ...request('Budget review'),
      get request(): string {
        throw new Error(SECRET);
      },
    };
    const error = await failure(() =>
      createContextBroker({ sources: [] }).assemble(hostile as never),
    );
    expectSanitized(error, 'invalid_request');
  });

  it('replaces any adapter-thrown broker error spoof with a fixed broker error', async () => {
    const spoof = new ContextBrokerError('invalid_request');
    (spoof as { message: string }).message = SECRET;
    const spoofGetter = {
      ...evidence('s', 'Budget'),
      get text(): string {
        throw spoof;
      },
    };
    const fromCollect = await failure(() =>
      assemble(
        [
          {
            sourceId: 'spoof',
            kind: 'episode_history',
            collect: () => {
              throw spoof;
            },
          },
        ],
        request('Budget review'),
      ),
    );
    expectSanitized(fromCollect, 'source_failure');
    expect(fromCollect).not.toBe(spoof);
    const fromGetter = await failure(() =>
      assemble(
        [memorySource('spoof', 'episode_history', [spoofGetter])],
        request('Budget review'),
      ),
    );
    expectSanitized(fromGetter, 'invalid_candidate');
    expect(fromGetter).not.toBe(spoof);
  });
});

describe('H3 final: public error locations never reflect foreign records', () => {
  const foreign = (n: number, prefix = 'f') =>
    Array.from({ length: n }, (_, i) =>
      evidence(`${prefix}${i}`, 'Foreign synthetic record', {
        ownerId: OTHER_OWNER,
        provenance: PROVENANCE.ownerStatement(`${prefix}${i}`, OTHER_OWNER),
      }),
    );
  // Recognizably foreign by owner, otherwise malformed (still just dropped).
  const malformedForeign = (n: number) =>
    Array.from({ length: n }, () => ({
      ownerId: OTHER_OWNER,
      text: 42,
      get signals(): never {
        throw new Error(SECRET);
      },
    }));
  const invalidOwn = () => ({
    ...evidence('bad-own', 'Budget review notes'),
    unexpected: true,
  });
  const throwingOwner = () => ({
    get ownerId(): string {
      throw new Error(SECRET);
    },
  });
  const publicError = async (collection: readonly unknown[]) => {
    const error = await failure(() =>
      assemble(
        [memorySource('source', 'episode_history', collection)],
        request('Budget review'),
      ),
    );
    expectSanitized(error, error.code);
    return {
      json: JSON.stringify(error),
      code: error.code,
      sourceId: error.sourceId,
      candidateIndex: error.candidateIndex,
      message: error.message,
    };
  };

  it('keeps an invalid owner candidate at owner-local index 0 with 0 or 499 foreign records before it', async () => {
    const alone = await publicError([invalidOwn()]);
    const padded = await publicError([...foreign(499), invalidOwn()]);
    expect(alone.candidateIndex).toBe(0);
    expect(padded).toEqual(alone);
    expect(padded.json).not.toContain('499');
  });

  it('omits the index when ownership cannot be read, with or without 37 foreign records', async () => {
    const alone = await publicError([throwingOwner()]);
    const padded = await publicError([...foreign(37), throwingOwner()]);
    expect(alone.code).toBe('invalid_candidate');
    expect(alone.candidateIndex).toBeUndefined();
    expect(padded).toEqual(alone);
    expect(padded.json).not.toContain('37');
  });

  it('omits the index for early unreadable elements (hole, throwing proxy)', async () => {
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
      },
    );
    for (const element of [undefined, throwingProxy]) {
      const alone = await publicError([element]);
      const padded = await publicError([...foreign(12), element]);
      expect(alone.candidateIndex).toBeUndefined();
      expect(padded).toEqual(alone);
    }
  });

  it('omits the index when reading the array element itself throws (array proxy)', async () => {
    const trapLast = (items: unknown[]) =>
      new Proxy([...items, null], {
        get(target, key, receiver) {
          if (key === String(items.length)) throw new Error(SECRET);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const alone = await publicError(trapLast([]));
    const padded = await publicError(trapLast(foreign(9)));
    expect(alone.code).toBe('invalid_candidate');
    expect(alone.candidateIndex).toBeUndefined();
    expect(padded).toEqual(alone);
    expect(padded.json).not.toContain('9');
  });

  it('is unaffected by malformed but recognizable foreign records', async () => {
    const alone = await publicError([invalidOwn()]);
    const padded = await publicError([
      ...malformedForeign(20),
      invalidOwn(),
      ...malformedForeign(5),
    ]);
    expect(padded).toEqual(alone);
  });

  it('keeps an owner-local index stable when foreign records are inserted before or between owner records', async () => {
    const valid = evidence('good-own', 'Budget review notes');
    const baseline = await publicError([valid, invalidOwn()]);
    expect(baseline.candidateIndex).toBe(1);
    for (const n of [0, 50, 499]) {
      const before = await publicError([
        ...foreign(n, 'a'),
        valid,
        invalidOwn(),
      ]);
      const between = await publicError([
        valid,
        ...foreign(n, 'b'),
        invalidOwn(),
      ]);
      const both = await publicError([
        ...foreign(Math.floor(n / 2), 'c'),
        valid,
        ...foreign(Math.ceil(n / 2), 'd'),
        invalidOwn(),
      ]);
      for (const result of [before, between, both])
        expect(result, String(n)).toEqual(baseline);
    }
  });

  it('uses the owner-local index for post-filter schema and score-metadata failures', async () => {
    const badSignals = evidence('bad-signals', 'Budget review notes', {
      signals: { confidence: Number.NaN, salience: 0.5, negativeRetrieval: 0 },
    });
    const alone = await publicError([badSignals]);
    const padded = await publicError([...foreign(30), badSignals]);
    expect(alone).toMatchObject({
      code: 'invalid_score_metadata',
      candidateIndex: 0,
    });
    expect(padded).toEqual(alone);
    // A throwing getter on an OWNER record (ownership read succeeded) fails
    // in the snapshot step and also reports only its owner-local index.
    const ownWithGetter = {
      ...evidence('getter-own', 'Budget'),
      get text(): string {
        throw new Error(SECRET);
      },
    };
    const getterAlone = await publicError([ownWithGetter]);
    const getterPadded = await publicError([...foreign(44), ownWithGetter]);
    expect(getterAlone).toMatchObject({
      code: 'invalid_candidate',
      candidateIndex: 0,
    });
    expect(getterPadded).toEqual(getterAlone);
  });

  it('serializes no foreign ID, owner, count or total in any public error', async () => {
    const padded = await publicError([...foreign(499), invalidOwn()]);
    for (const leak of [OTHER_OWNER, 'f498', '499', '500', 'Foreign synthetic'])
      expect(padded.json).not.toContain(leak);
    expect(Object.keys(JSON.parse(padded.json)).sort()).toEqual([
      'candidateIndex',
      'code',
      'name',
      'sourceId',
    ]);
  });
});
