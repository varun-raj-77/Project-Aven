# Threat model: v0.1 planning baseline

Source: Master Description sections 5-6, 11, and 24. This describes controls to
implement and test; AVEN-001 has no runtime enforcing them.

## Assets and trust boundaries

Protect owner identity, personal events/state, credentials, action authority,
trusted versions, protected evaluation cases, and audit/rebuild integrity. Treat
owner-authenticated instructions, Root policy, model hypotheses, tool results,
and external content as distinct sources. Models, retrieved content, candidate
learning, and indexes cannot grant authority. Developer filesystem access is not
an Aven permission.

Root controls tool access, secrets, sandbox/egress, promotion, rollback, and the
eval vault outside LLM reasoning. Separate modules are conceptual boundaries
only. In-process versus separate-process Root and OS/storage isolation remain
open; tests must describe what the chosen deployment actually protects.

## Threats and required evidence

| Threat                                          | Required control principle                                                                         | Future test/evidence                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Prompt injection or forged owner instructions   | Untrusted content remains data; authenticated, externally enforced policy gates execution          | Inject instructions into fixtures/history/tool output; observe proposals and actual allowed/denied actions |
| Memory poisoning, laundered trust               | Preserve provenance/taint through candidates and retrieval; untrusted evidence cannot self-promote | Poisoned evidence stays untrusted; inspect lineage and failed promotion                                    |
| Scope creep/stale preferences                   | Narrow scope, counterexamples, current instruction precedence, negative retrieval, supersession    | Matching/nonmatching, stale, conflicting, and correction cases                                             |
| Excessive agency or permission creep            | Deny by default outside granted scope; exact approval, expiry, loop/budget limits                  | High-confidence predicted intent and replayed approvals never authorize a different action                 |
| Root mutation or self-promotion                 | Restrict write/access paths externally; independent evaluator and Root-controlled promotion        | Attempted mutation/promotion is denied and audited; inspect real containment                               |
| Secret/private data leakage                     | Keep credentials outside ordinary context; minimum retrieval and controlled egress                 | Canary data and outbound-path tests in a fake environment                                                  |
| False success, destructive action               | One reversible toy tool and an action-specific verifier                                            | Simulate tool failure, partial execution, and false model success; verifier determines outcome             |
| Eval leakage or scorer gaming                   | Protected final cases, separate promotion cases, locked independent scorer                         | Access attempts fail; hash/access logs confirm no tuning on final cases                                    |
| Ledger tampering or missing provenance          | Append-only recording, owner/version/trust identifiers, recoverable derived state                  | Mutation attempts, corruption/rebuild checks, trace audits                                                 |
| Model drift or rollback failure                 | Stamp configurations; compatibility evals; versioned rollback/fallback                             | Model-swap, regression, and bad-promotion rollback cases                                                   |
| Approval fatigue or supervision masking failure | Risk-based controls; count/time all review, labeling, interruptions, and profile edits             | Compare net owner attention across B/C and report burden rather than hiding it                             |

## Experiment containment

EXP-001 uses synthetic or explicitly consented non-sensitive scenarios and one
bounded sandbox action. No production inbox, real sending/purchases, real
external credentials, or unrestricted egress. Scoring distinguishes denied
attempts, unauthorized executions, approved executions, and unverifiable
outcomes. A zero failure observation cannot establish general safety.

Stop a future run for unauthorized execution, Root/policy hash change, eval
leakage, unexpected egress, or private-data exposure. Preserve evidence, contain
the run, and record failure; do not silently retry until it disappears.

## Open decisions

Root isolation and action binding; authenticated owner/session semantics;
storage/audit tamper resistance; protected eval-vault enforcement; trust
propagation; privacy-preserving erasure versus append-only history;
backup/export; provider data handling. Public dataset scaffolding and
`.gitignore` are not access control.
