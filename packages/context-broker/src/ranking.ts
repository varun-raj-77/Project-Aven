import {
  FRESHNESS_HALF_LIFE_DAYS,
  MILLISECONDS_PER_DAY,
  PROVENANCE_FACTORS,
  RANKING_FACTORS,
  RANKING_WEIGHTS_BASIS_POINTS,
  SCOPE_FACTORS,
  TRUST_FACTORS,
  WEIGHT_BASIS_POINTS_TOTAL,
  type RankingFactor,
} from './config.ts';
import type { ScopeStatus } from './scope.ts';
import type { ParsedContextCandidate } from './types.ts';
import { quantize } from './util.ts';

/**
 * Ranking (unchanged from config v1): one transparent, fixed composite rule.
 *
 *   composite = sum over the seven factors of weight * factor
 *   final     = composite * (1 - negativeRetrieval)
 *
 * Every factor is in [0, 1] and is reported. Eligibility (owner, lifecycle,
 * reference time, task binding, scope mismatch, hard negative suppression,
 * relevance floor) is decided BEFORE ranking and is never a low score.
 */

export type ScopeFactorStatus = Exclude<ScopeStatus, 'mismatch' | 'unresolved'>;

export function scopeFactor(status: ScopeFactorStatus): number {
  return SCOPE_FACTORS[status];
}

/** From the frozen provenance kind only; candidate prose is never read. */
export function provenanceFactor(candidate: ParsedContextCandidate): number {
  return PROVENANCE_FACTORS[candidate.provenance.kind];
}

export type TrustBasis = keyof typeof TRUST_FACTORS;

/**
 * Trust basis from frozen structured metadata only. A provenance trust label
 * (`untrusted` or `potentially_untrusted`) takes precedence over any lifecycle
 * claim, so tainted content can never rank as trusted state.
 */
export function trustBasis(candidate: ParsedContextCandidate): TrustBasis {
  const provenance = candidate.provenance;
  if (provenance.kind === 'external_content') return 'label_untrusted';
  if (provenance.kind === 'tool_result') return 'label_potentially_untrusted';
  const reference = candidate.reference;
  switch (reference.kind) {
    case 'owner_state':
      if (reference.lifecycle === 'trusted') return 'owner_state_trusted';
      if (reference.lifecycle === 'validated') return 'owner_state_validated';
      // Superseded/revoked never reach ranking (eligibility); observed is
      // the only remaining active lifecycle.
      return 'owner_state_observed';
    case 'current_instruction':
      return 'current_instruction';
    case 'active_task_state':
      return 'active_task_state';
    case 'evidence':
      return 'evidence';
  }
}

export function trustFactor(basis: TrustBasis): number {
  return TRUST_FACTORS[basis];
}

export interface FreshnessAssessment {
  readonly anchor: 'recordedAt' | 'lastValidatedAt';
  readonly ageMilliseconds: number;
  readonly factor: number;
}

/**
 * Exponential freshness from the explicit reference time. Callers exclude
 * candidates timestamped after the reference time before calling this, so the
 * age is never negative.
 */
export function freshness(
  candidate: ParsedContextCandidate,
  referenceTime: string,
): FreshnessAssessment {
  const validated = candidate.timestamps.lastValidatedAt;
  const anchor = validated === undefined ? 'recordedAt' : 'lastValidatedAt';
  const ageMilliseconds = Math.max(
    0,
    Date.parse(referenceTime) -
      Date.parse(validated ?? candidate.timestamps.recordedAt),
  );
  const halfLife = FRESHNESS_HALF_LIFE_DAYS * MILLISECONDS_PER_DAY;
  return Object.freeze({
    anchor,
    ageMilliseconds,
    factor: quantize(0.5 ** (ageMilliseconds / halfLife)),
  });
}

export interface ScoreBreakdown {
  /** Each factor value in [0, 1]. */
  readonly factors: Readonly<Record<RankingFactor, number>>;
  /** weight * factor for each factor; their sum is `composite`. */
  readonly contributions: Readonly<Record<RankingFactor, number>>;
  readonly composite: number;
  readonly negativeRetrieval: number;
  /** composite - final. */
  readonly negativePenalty: number;
  readonly final: number;
}

export function score(
  factors: Readonly<Record<RankingFactor, number>>,
  negativeRetrieval: number,
): ScoreBreakdown {
  const contributions = {} as Record<RankingFactor, number>;
  let sum = 0;
  for (const factor of RANKING_FACTORS) {
    const contribution = quantize(
      (RANKING_WEIGHTS_BASIS_POINTS[factor] * factors[factor]) /
        WEIGHT_BASIS_POINTS_TOTAL,
    );
    contributions[factor] = contribution;
    sum += contribution;
  }
  const composite = quantize(sum);
  const final = quantize(composite * (1 - negativeRetrieval));
  return Object.freeze({
    factors: Object.freeze({ ...factors }),
    contributions: Object.freeze(contributions),
    composite,
    negativeRetrieval,
    negativePenalty: quantize(composite - final),
    final,
  });
}
