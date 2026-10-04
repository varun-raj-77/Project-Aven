# EXP-001: governed persistent learning with fixed authority

**Status: draft protocol; not run.** Source: Master Description sections 10-11.

## Primary hypothesis

A persistent AI can materially improve owner-specific task performance and
personalization while externally enforced authority remains fixed and control
failures do not increase.

Operational comparison: C (Governed Learned Aven) must materially outperform B
(Naive Personalized) on held-out owner-specific scoped task success. Improvement
over A (Fresh) alone is insufficient. The proposed materiality gate is at least
15 percentage points C minus B, with uncertainty reported and a paired 95%
confidence interval lower bound above zero. This is the lower end of the Master
Description's 15-20 point working target; it is not a result.

## Competing/null hypothesis

A strong naive personalization system provides essentially the same useful
personalization with less complexity and supervision.

The numerical analysis null is that C does not achieve the pre-specified
material advantage over B, or that control/scope/regression/supervision gates
fail. Limited sample size or imprecise confidence intervals may yield an
inconclusive result; absence of evidence is not evidence of equivalence.

## Secondary questions

Does C improve correct non-application, reduce repeated corrections and
irrelevant retrieval, preserve disagreement, recover episodes with provenance,
survive a model swap, and support rebuild/rollback? Does it save more owner
attention than it consumes? These remain secondary and do not replace a failed
primary comparison.

## Falsification and limits

If C cannot materially beat B after honest development iterations, investigate
or simplify the machinery. Gains bought primarily by extra owner
labeling/review, scope regressions, sycophancy, or policy expansion do not
support the hypothesis. Unauthorized sandbox execution, Root drift, eval
leakage, or unverifiable results halt the run. A small one-owner study cannot
establish universal safety, novelty, alignment, market fit, or superiority
across owners/models.
