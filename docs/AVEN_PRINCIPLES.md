# Aven principles

Source: Master Project Description, 2026-10-03, especially sections 3-6 and 25;
the current AVEN-001 request adds explicit initial-scope constraints. These are
design requirements to test and enforce later, not claims about this scaffold.

1. **Start neutral.** No fabricated owner personality, habits, history, or
   preferences.
2. **Learn per owner.** Personal evidence/state does not become a global
   profile.
3. **Preserve raw experience.** The Experience Ledger is append-only;
   corrections append evidence rather than silently rewriting history. Derived
   state and indexes must be traceable and rebuildable. Erasure/retention design
   remains unresolved.
4. **Context is task-specific.** Context is not memory; retrieve relevant,
   permitted evidence using scope, confidence, freshness, trust, provenance, and
   supersession.
5. **Learning begins as a hypothesis.** Candidate generation is not trust.
   Evaluate through replay, counterexamples, protected held-out cases,
   independent scoring, and controlled promotion. The generator cannot be its
   sole evaluator.
6. **Corrections are high-value evidence.** Apply explicit current/session
   corrections immediately when authorized; evaluate durable behavior
   separately. Link the correction to the corrected behavior and reduce
   superseded retrieval salience.
7. **Infer the narrowest supported scope first.** Examples are illustrative
   unless explicitly made requirements. Correct non-application matters as much
   as use.
8. **No useful lesson is valid.** Never force an interaction to yield durable
   learning.
9. **Prediction does not create permission.** Absence of prohibition is not
   authorization.
10. **Aven proposes; Root decides.** Root owns authentication, permissions,
    secrets, audit integrity, eval-vault access, sandbox/egress, trusted
    versions, promotion, and rollback. Root policy operates outside
    probabilistic model reasoning.
11. **Aven may never directly alter Root.** No self-granted permissions or
    promotion. More capability must not silently grant more authority.
12. **Consequential execution requires verification.** An attempted action, an
    action proposal, a model's success narrative, and a verified result are
    distinct.
13. **Learned behavior is versioned, supersedable, and reversible.** Preserve
    evidence and lineage; monitor promotion, roll back regressions, and use
    trusted fallback.
14. **Models are replaceable.** State, evidence, identity, and policy belong
    above a provider/runtime adapter. Compatibility must be re-evaluated after
    swaps.
15. **One owner-facing Aven.** Prefer memory, procedure, skill, deterministic
    tool, then a specialist only if evidence requires it. Specialists are not in
    the initial architecture; they cannot alter Root or promote themselves.
16. **Production self-modification is outside v0.1.** Future creation in
    containment never grants authority to trust or deploy the result.
17. **Use risk-based control.** Granted low-risk reads can be automatic;
    higher-risk actions depend on policy and exact, expiring approval where
    appropriate. Measure attention cost; asking for everything is not the
    product objective.
18. **Fallback stays explicit.** Within permitted scope: current owner
    instruction -> previous trusted behavior -> neutral behavior -> ask when
    consequence justifies interruption. Do not speculate merely to appear
    personalized.
19. **Record observable evidence.** Intent summaries, context references,
    proposals, policy/approval, execution/verification, corrections, and
    candidate/version IDs; do not depend on hidden chain-of-thought for audit.
20. **C must materially beat B.** Preserve a strong naive baseline. Complexity,
    supervision, privacy, cost, latency, and control regressions count against
    gains.
21. **Report honest uncertainty.** Negative results count. No unearned claims of
    novelty, safety, alignment, consciousness, or superiority.
22. **Protect v0.1 scope.** Investigate ideas that invalidate a current
    assumption; otherwise backlog them. Architecture changes require evidence
    and approval.

The testable first slice is correction -> scoped candidate -> provenance ->
correct application/non-application -> controlled evaluation/promotion/rollback
-> model continuity, with one bounded sandbox action decision. A directory named
`root` does not itself implement an authority boundary.
