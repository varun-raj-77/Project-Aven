# Risk register

Planning assessment as of 2026-10-04, grounded in the Master Description.
Severity is qualitative judgment, not measured probability. All runtime risks
remain open.

| ID  | Area and risk                                                                  | Severity | Evidence/gate to resolve                                                       | Status           |
| --- | ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------ | ---------------- |
| R01 | Technical/product: C does not beat strong B                                    | High     | Pre-specified paired A/B/C held-out results and honest iterations              | Open             |
| R02 | Technical: scope leakage/stale learning                                        | High     | Application/non-application, counterexamples, supersession regressions         | Open             |
| R03 | Safety: prediction becomes unauthorized action or Root mutation                | Critical | Fixed external policy, real tool-boundary tests, exact approvals, audit        | Open             |
| R04 | Safety: injection or memory poisoning launders trust                           | Critical | Source/taint propagation, denied promotion, adversarial fixture tests          | Open             |
| R05 | Research: held-out leakage, weak baseline, self-scoring, post-hoc thresholds   | High     | Frozen splits/configs, independent scoring, B tuning parity, failed-run record | Open             |
| R06 | Privacy: personal evidence leakage; erasure conflicts with append-only storage | High     | Consent/minimization, local storage/egress design, explicit erasure ADR        | Open             |
| R07 | Usability: review burden exceeds attention saved                               | High     | Count/time owner effort for every arm; observe approval fatigue                | Open             |
| R08 | Cost/latency: experiment or daily use is impractical                           | Medium   | Token/cost/latency accounting, fixed budgets and escalation gates              | Open             |
| R09 | Technical: provider swap breaks continuity or rollback                         | High     | Versioned model-swap/rebuild/rollback evaluation                               | Open             |
| R10 | Product/market: alternatives converge; portability not valued                  | Medium   | Concrete user behavior and periodic future market review                       | Open             |
| R11 | Brand/legal: codename or data use creates conflict                             | Medium   | Check before public commercial branding/data release                           | Open             |
| R12 | Scope: speculative agents/affect/self-modification distract from v0.1          | High     | Milestone gates, approved architecture changes, future backlog                 | Active guardrail |
| R13 | Research: small dependent sample exaggerates evidence                          | High     | Case-level paired analysis, uncertainty, no independence claim for repeats     | Open             |
| R14 | Engineering: repository checks mistaken for runtime controls                   | High     | Explicit implementation status and deployment-boundary threat review           | Active guardrail |

The maintainer reviews this register at each experiment freeze and promotion
milestone. Record new evidence and decisions with source/run references. A
future critical control failure halts the affected run; preserving that failure
is part of experimental integrity. No mitigation is considered demonstrated in
AVEN-001.
