import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BROKER_CONFIG_V2,
  RANKING_FACTORS,
  RANKING_WEIGHTS_BASIS_POINTS,
  type ContextCandidate,
  type RankingFactor,
} from '../src/index.ts';
import {
  activeTask,
  assemble,
  evidence,
  external,
  GLOBAL_SCOPE,
  instruction,
  memorySource,
  OWNER,
  ownerState,
  PROVENANCE,
  request,
  selectedIds,
  traceOf,
} from './fixtures.ts';

// SYNTHETIC text only. Weights and factor tables are the pre-specified v1
// values; they were not tuned on AVEN-007 cases or model results.

const REQUEST = 'Draft the quarterly budget summary';

describe('AVEN-008 ranking v1 configuration (pre-specified, pinned)', () => {
  it('uses exactly the pre-specified factor weights, totalling 1.00', () => {
    expect(RANKING_WEIGHTS_BASIS_POINTS).toEqual({
      relevance: 4000,
      scope: 2000,
      provenance: 1000,
      confidence: 1000,
      freshness: 700,
      salience: 700,
      trust: 600,
    });
    expect(
      RANKING_FACTORS.reduce((s, f) => s + RANKING_WEIGHTS_BASIS_POINTS[f], 0),
    ).toBe(10000);
    expect(RANKING_FACTORS).toEqual([
      'relevance',
      'scope',
      'provenance',
      'confidence',
      'freshness',
      'salience',
      'trust',
    ]);
  });

  it('pins the whole versioned configuration object (v2, weights unchanged)', () => {
    expect(CONTEXT_BROKER_CONFIG_V2).toEqual({
      brokerVersion: 'aven-008-context-broker-v2',
      configVersion: 'aven-008-context-broker-config-v2',
      supersedes: {
        configVersion: 'aven-008-context-broker-config-v1',
        status: 'reviewed_pre_freeze_candidate_never_frozen',
        reviewedCommit: '630369a45e05f7720db5c7a4ce10d9276465babd',
        supersededBefore: 'aven-009_and_condition_c_existed',
        realModelResultInformedChange: false,
      },
      relevance: {
        version: 'aven-008-lexical-coverage-v1',
        tokenizer: 'aven-008-tokenizer-v1',
        tokenizerSteps: [
          'unicode_nfkc',
          'lowercase_locale_independent',
          'expand_negative_contractions_to_not',
          'split_on_non_letter_mark_number',
          'remove_STOPWORDS_V1',
          'harman_s_plural_fold',
        ],
        metric: 'unique_query_term_coverage',
        scoredText: 'included_item_text',
      },
      weightsBasisPoints: {
        relevance: 4000,
        scope: 2000,
        provenance: 1000,
        confidence: 1000,
        freshness: 700,
        salience: 700,
        trust: 600,
      },
      scope: {
        version: 'aven-008-scope-v2',
        boundedRule: 'every_declared_restriction_satisfied',
        unresolvedRestriction: 'ineligible',
        taskBindingClearsUnresolved: false,
        uncertainRule:
          'every_possibility_satisfied_else_unresolved_or_mismatch',
        sessionWideScope: 'not_representable_deferred',
        factors: {
          task_match: 1,
          label_match: 1,
          global: 0.5,
          unknown: 0.25,
          uncertain: 0.25,
        },
      },
      provenanceFactors: {
        explicit_owner_statement: 1,
        explicit_owner_correction: 1,
        owner_approval: 1,
        system_generated: 0.6,
        model_inference: 0.4,
        tool_result: 0.3,
        external_content: 0.2,
      },
      trustFactors: {
        label_untrusted: 0,
        label_potentially_untrusted: 0.25,
        owner_state_trusted: 1,
        owner_state_validated: 0.75,
        owner_state_observed: 0.5,
        current_instruction: 1,
        active_task_state: 0.5,
        evidence: 0.5,
      },
      provenanceConsistency: [
        'owner_origin_provenance_owner_equals_candidate_owner',
        'direct_owner_origin_evidence_event_equals_provenance_source_event',
      ],
      freshness: {
        halfLifeDays: 90,
        anchor: 'lastValidatedAt_else_recordedAt',
        clock: 'request_reference_time',
      },
      negativeRetrieval: {
        penalty: 'multiplicative_one_minus_signal',
        suppressionValue: 1,
      },
      deduplication: {
        keys: [
          'candidateId',
          'evidence_reference_evidenceId',
          'learned_reference_learnedItemId_and_version',
        ],
        consistentDuplicates: 'keep_first_by_sourceId_then_candidateId',
        inconsistentDuplicates: 'fail_closed_conflicting_duplicate',
      },
      eligibility: [
        'recognizable_foreign_owner_dropped_before_validation_and_quotas',
        'identity_duplicate_excluded',
        'lifecycle_not_superseded',
        'lifecycle_not_revoked',
        'timestamps_not_after_reference_time',
        'task_binding_matches_request_task',
        'scope_not_explicit_mismatch',
        'scope_not_unresolved',
        'negative_retrieval_below_suppression_value',
        'at_least_one_relevance_channel',
      ],
      relevanceChannels: ['lexical_content_term', 'task', 'scope_label'],
      ordering: [
        'final_score_descending',
        'sourceId_ascending_code_unit',
        'candidateId_ascending_code_unit',
      ],
      scoreDecimals: 9,
      budget: {
        maxSelectedItems: 10,
        maxContextChars: 10000,
        maxItemChars: 1600,
        policy: 'rank_order_skip_non_fitting_stop_at_item_limit',
        itemTruncation: 'code_point_prefix',
      },
      collection: {
        deadlineMilliseconds: 5000,
        deadlineScope: 'one_deadline_per_assemble_call_all_sources',
        rawResourceLimits: {
          maxRawItemsPerSource: 10000,
          maxRawItemsTotal: 40000,
        },
        ownerContextQuotas: {
          maxSources: 16,
          maxCandidatesPerSource: 500,
          maxTotalCandidates: 2000,
        },
        sourceFailurePolicy: 'fail_closed_whole_assembly',
        foreignOwnerPolicy: 'drop_recognizable_foreign_first_no_trace',
        errorPolicy: 'fixed_code_and_message_no_cause',
      },
      limits: {
        maxRequestChars: 8000,
        maxCandidateTextChars: 20000,
        maxLabelChars: 256,
        maxMetadataChars: 1000,
        maxLocalIdChars: 128,
      },
      trace: {
        version: 'aven-008-trace-v2',
        content: 'owner_local_ids_codes_counts_numbers_only',
        excludes: [
          'item_text',
          'request_derived_terms',
          'foreign_owner_ids_counts_or_totals',
        ],
      },
      characterUnit: 'unicode_code_point',
    });
    expect(Object.isFrozen(CONTEXT_BROKER_CONFIG_V2)).toBe(true);
    expect(Object.isFrozen(CONTEXT_BROKER_CONFIG_V2.scope.factors)).toBe(true);
    expect(
      Object.isFrozen(CONTEXT_BROKER_CONFIG_V2.relevance.tokenizerSteps),
    ).toBe(true);
  });
});

describe('AVEN-008 ranking behavior (unchanged from v1)', () => {
  it('orders by lexical coverage when everything else is equal (D)', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('a-quarter', 'Budget notes'),
          evidence('b-half', 'Quarterly budget figures'),
          evidence('c-full', 'Quarterly budget summary draft'),
        ]),
      ],
      request(REQUEST),
    );
    expect(selectedIds(result)).toEqual(['c-full', 'b-half', 'a-quarter']);
    expect(
      ['c-full', 'b-half', 'a-quarter'].map(
        (id) => traceOf(result, id).relevance.score,
      ),
    ).toEqual([1, 0.5, 0.25]);
    // Full worked example: owner statement, unknown scope, evidence trust,
    // confidence/salience 0.5, age 0.
    expect(traceOf(result, 'c-full').score).toEqual({
      factors: {
        relevance: 1,
        scope: 0.25,
        provenance: 1,
        confidence: 0.5,
        freshness: 1,
        salience: 0.5,
        trust: 0.5,
      },
      contributions: {
        relevance: 0.4,
        scope: 0.05,
        provenance: 0.1,
        confidence: 0.05,
        freshness: 0.07,
        salience: 0.035,
        trust: 0.03,
      },
      composite: 0.735,
      negativeRetrieval: 0,
      negativePenalty: 0,
      final: 0.735,
    });
  });

  it('derives provenance factors from the frozen provenance kind only (I)', async () => {
    const text = 'Quarterly budget summary';
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('statement', text),
          evidence('correction', text, {
            provenance: PROVENANCE.ownerCorrection('correction'),
          }),
          evidence('approval', text, {
            provenance: {
              kind: 'owner_approval',
              ownerId: OWNER,
              sourceEventId: 'event_synapproval',
            },
          }),
          evidence('system', text, {
            provenance: PROVENANCE.systemGenerated(),
          }),
          evidence('model', text, { provenance: PROVENANCE.modelInference() }),
          evidence('tool', text, { provenance: PROVENANCE.toolResult('tool') }),
          external('web', text),
        ]),
      ],
      request(REQUEST),
    );
    const factor = (id: string) =>
      traceOf(result, id).score!.factors.provenance;
    expect(
      [
        'statement',
        'correction',
        'approval',
        'system',
        'model',
        'tool',
        'web',
      ].map(factor),
    ).toEqual([1, 1, 1, 0.6, 0.4, 0.3, 0.2]);
    expect(selectedIds(result).slice(-4)).toEqual([
      'system',
      'model',
      'tool',
      'web',
    ]);
  });

  it('derives trust from lifecycle and provenance labels; taint overrides lifecycle (M)', async () => {
    const text = 'Quarterly budget summary';
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('trusted', text, 'trusted'),
          ownerState('validated', text, 'validated'),
          ownerState('observed', text, 'observed'),
          ownerState('tainted-trusted', text, 'trusted', {
            provenance: PROVENANCE.externalContent(),
          }),
          ownerState('tool-trusted', text, 'trusted', {
            provenance: PROVENANCE.toolResult('tool-trusted'),
          }),
        ]),
        memorySource('active', 'active_task', [
          activeTask('active', text),
          instruction('instruction', text),
        ]),
        memorySource('episodes', 'episode_history', [evidence('raw', text)]),
      ],
      request(REQUEST),
    );
    const trust = (id: string) => [
      traceOf(result, id).trustBasis,
      traceOf(result, id).score!.factors.trust,
    ];
    expect(trust('trusted')).toEqual(['owner_state_trusted', 1]);
    expect(trust('validated')).toEqual(['owner_state_validated', 0.75]);
    expect(trust('observed')).toEqual(['owner_state_observed', 0.5]);
    expect(trust('tainted-trusted')).toEqual(['label_untrusted', 0]);
    expect(trust('tool-trusted')).toEqual([
      'label_potentially_untrusted',
      0.25,
    ]);
    expect(trust('active')).toEqual(['active_task_state', 0.5]);
    expect(trust('instruction')).toEqual(['current_instruction', 1]);
    expect(trust('raw')).toEqual(['evidence', 0.5]);
  });

  it('computes freshness from the reference time with a 90-day half-life (K)', async () => {
    const text = 'Quarterly budget summary';
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('d0', text),
          evidence('d90', text, {
            timestamps: { recordedAt: '2026-07-03T12:00:00Z' },
          }),
          evidence('d180', text, {
            timestamps: { recordedAt: '2026-04-04T12:00:00Z' },
          }),
          evidence('revalidated', text, {
            timestamps: {
              recordedAt: '2025-01-01T00:00:00Z',
              lastValidatedAt: '2026-07-03T12:00:00Z',
            },
          }),
        ]),
      ],
      request(REQUEST),
    );
    expect(traceOf(result, 'd0').freshness!.factor).toBe(1);
    expect(traceOf(result, 'd90').freshness).toEqual({
      anchor: 'recordedAt',
      ageMilliseconds: 90 * 86_400_000,
      factor: 0.5,
    });
    expect(traceOf(result, 'd180').freshness!.factor).toBe(0.25);
    expect(traceOf(result, 'revalidated').freshness).toEqual({
      anchor: 'lastValidatedAt',
      ageMilliseconds: 90 * 86_400_000,
      factor: 0.5,
    });
    expect(selectedIds(result)).toEqual(['d0', 'd90', 'revalidated', 'd180']);
  });

  /**
   * (N, plus I/J/K/L/M) For every factor, two candidates differ ONLY in that
   * factor. The ID tie-break favors the worse one, so the better one can rank
   * first only because of the factor; swapping the inputs changes nothing.
   */
  const pairs: Record<RankingFactor, [ContextCandidate, ContextCandidate]> = {
    relevance: [
      evidence('b', 'Quarterly budget summary draft'),
      evidence('a', 'Quarterly notes'),
    ],
    scope: [
      evidence('b', 'Quarterly budget', { scope: GLOBAL_SCOPE }),
      evidence('a', 'Quarterly budget'),
    ],
    provenance: [
      evidence('b', 'Quarterly budget'),
      evidence('a', 'Quarterly budget', {
        provenance: PROVENANCE.systemGenerated(),
      }),
    ],
    confidence: [
      evidence('b', 'Quarterly budget', {
        signals: { confidence: 0.9, salience: 0.5, negativeRetrieval: 0 },
      }),
      evidence('a', 'Quarterly budget', {
        signals: { confidence: 0.1, salience: 0.5, negativeRetrieval: 0 },
      }),
    ],
    freshness: [
      evidence('b', 'Quarterly budget'),
      evidence('a', 'Quarterly budget', {
        timestamps: { recordedAt: '2026-01-01T00:00:00Z' },
      }),
    ],
    salience: [
      evidence('b', 'Quarterly budget', {
        signals: { confidence: 0.5, salience: 0.9, negativeRetrieval: 0 },
      }),
      evidence('a', 'Quarterly budget', {
        signals: { confidence: 0.5, salience: 0.1, negativeRetrieval: 0 },
      }),
    ],
    trust: [
      ownerState('b', 'Quarterly budget', 'trusted'),
      ownerState('a', 'Quarterly budget', 'observed'),
    ],
  };

  for (const factor of RANKING_FACTORS)
    it(`lets ${factor} alone change the order (N)`, async () => {
      const [better, worse] = pairs[factor];
      const kind = factor === 'trust' ? 'owner_state' : 'episode_history';
      for (const order of [
        [worse, better],
        [better, worse],
      ]) {
        const result = await assemble(
          [memorySource('source', kind, order)],
          request(REQUEST),
        );
        expect(selectedIds(result)).toEqual(['b', 'a']);
        const b = traceOf(result, 'b').score!.factors;
        const a = traceOf(result, 'a').score!.factors;
        for (const other of RANKING_FACTORS)
          if (other === factor) expect(b[other]).toBeGreaterThan(a[other]);
          else expect(b[other], other).toBe(a[other]);
      }
    });

  it('breaks exact score ties by sourceId, then candidateId, by code unit (T)', async () => {
    const text = 'Quarterly budget summary';
    const build = (reverse: boolean) => {
      const one = [
        evidence('z', text),
        evidence('y', text),
        evidence('Z', text),
      ];
      // A distinct item (identical text, distinct identity) in another source.
      const two = [evidence('zz', text)];
      const sources = [
        memorySource(
          'source-b',
          'episode_history',
          reverse ? [...one].reverse() : one,
        ),
        memorySource('source-a', 'episode_history', two),
      ];
      return assemble(
        reverse ? [...sources].reverse() : sources,
        request(REQUEST),
      );
    };
    const forward = await build(false);
    const backward = await build(true);
    expect(forward.trace.selected).toEqual([
      { rank: 1, sourceId: 'source-a', candidateId: 'zz' },
      { rank: 2, sourceId: 'source-b', candidateId: 'Z' },
      { rank: 3, sourceId: 'source-b', candidateId: 'y' },
      { rank: 4, sourceId: 'source-b', candidateId: 'z' },
    ]);
    expect(new Set(forward.trace.ranking.map((r) => r.final)).size).toBe(1);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it('exposes every score component, consistent between bundle and trace (AJ)', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('one', 'Quarterly budget summary', {
            signals: {
              confidence: 0.3,
              salience: 0.8,
              negativeRetrieval: 0.25,
            },
            timestamps: { recordedAt: '2026-08-01T00:00:00Z' },
          }),
          evidence('two', 'Draft summary', { scope: GLOBAL_SCOPE }),
        ]),
      ],
      request(REQUEST),
    );
    expect(result.bundle.items).toHaveLength(2);
    for (const item of result.bundle.items) {
      const s = item.score;
      expect(Object.keys(s.factors)).toEqual([...RANKING_FACTORS]);
      expect(Object.keys(s.contributions)).toEqual([...RANKING_FACTORS]);
      let sum = 0;
      for (const f of RANKING_FACTORS) {
        expect(s.factors[f]).toBeGreaterThanOrEqual(0);
        expect(s.factors[f]).toBeLessThanOrEqual(1);
        expect(s.contributions[f]).toBeCloseTo(
          (RANKING_WEIGHTS_BASIS_POINTS[f] / 10000) * s.factors[f],
          9,
        );
        sum += s.contributions[f];
      }
      expect(s.composite).toBeCloseTo(sum, 9);
      expect(s.final).toBeCloseTo(s.composite * (1 - s.negativeRetrieval), 8);
      expect(s.final + s.negativePenalty).toBeCloseTo(s.composite, 9);
      expect(traceOf(result, item.candidateId).score).toEqual(s);
    }
  });
});
