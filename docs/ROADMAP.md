# Roadmap: capability gates

Source: Master Description sections 14, 19-20. Milestone IDs below deliberately
follow the newer source; the older Strands-first AVEN-007 order is superseded.
The eight-week outline is a planning reference, not a delivery promise.

| ID       | Deliverable                                           | Gate / status                                                                                          |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AVEN-001 | Repository/bootstrap, principles, experiment manifest | Foundation complete; formatting/typecheck/manifest and 12 tests passed; stop                           |
| AVEN-002 | Shared typed contracts                                | Implemented; strict schemas and contract checks; no runtime enforcement                                |
| AVEN-003 | Database schema                                       | Frozen at `aven-003`; SQLite migrations and owner/version/trust/lineage integrity                      |
| AVEN-004 | Append-only Experience Ledger                         | Frozen at `aven-004`; atomic appends, owner-bound reads, replay, inspection; rebuild tests in AVEN-009 |
| AVEN-005 | Chat/session API                                      | Frozen at `aven-005`; loopback sessions, tasks, owner messages via Ledger, history; no model           |
| AVEN-006 | Model/runtime abstraction                             | Frozen at `aven-006`; replaceable runtime boundary, `model_inference` output; no live provider         |
| AVEN-007 | Naive Personalized baseline and prebuilt eval dataset | Frozen at `aven-007`; A/B baselines, dataset v2 (48 dev / 16 held-out); `not_run`                      |
| AVEN-008 | Context Broker                                        | Frozen at `aven-008` (`4ea1bc5`); config v2 after independent review; transient candidates only        |
| AVEN-009 | Typed Owner Model                                     | Frozen at `aven-009` (`80057a2`); read-only typed owner state, lineage, views, rebuild, Broker sources |
| AVEN-010 | Correction events and immediate session override      | In progress (isolated branch); linked correction, immediate override, durable candidate separation     |
| AVEN-011 | Action Proposal schema                                | Pending; typed request distinct from permission                                                        |
| AVEN-012 | Root Policy Gateway                                   | Pending; external ALLOW/DENY/REQUIRE_OWNER_APPROVAL                                                    |
| AVEN-013 | One sandbox tool and verifier                         | Pending; bounded action and observed outcome                                                           |
| AVEN-014 | Learning Hypothesis generator                         | Pending; narrow candidate or no useful lesson                                                          |
| AVEN-015 | Replay/counterexample/held-out Eval Harness           | Pending; independent scoring and leak controls                                                         |
| AVEN-016 | Shadow/offline comparison                             | Pending; trusted behavior acts; candidates do not                                                      |
| AVEN-017 | Promotion controller                                  | Pending; Root/owner-controlled version selection                                                       |
| AVEN-018 | Rollback/supersession                                 | Pending; tested reversal and stale-state handling                                                      |
| AVEN-019 | Model-swap continuity and why trace                   | Pending; state survives; explanation cites evidence                                                    |
| AVEN-020 | Frozen end-to-end A/B/C experiment                    | Pending; untouched final cases, full outcomes and limitations; evaluate before expansion               |

No framework adapter is required; one is optional only when it directly serves
the experiment. AVEN-008 is frozen at tag `aven-008` (corrected anchor
`4ea1bc537a55604cf2414fbe3886323934207382`). AVEN-009 is frozen at tag
`aven-009` (`80057a217adb90132c5b6bc1c6a5c0f798db08c5`) after final external
review and Windows validation (runner options
`--maxWorkers=2 --testTimeout=30000`; no code change); see
[the AVEN-009 report](AVEN_009_REPORT.md), which keeps its pre-freeze status
header and pre-attribution commit SHAs as historical record. SHAs such as
`4174080` cited in frozen documents refer to the archived pre-attribution
history. Current authorization covers AVEN-010 only, patch by patch on an
isolated branch (working plan and accepted decisions in `AGENTS.md`); it is not
merged, not tagged and not frozen. AVEN-011 and later remain unauthorized and
not started. No milestone so far adds a live-model adapter, runs the frozen A/B
baselines against a real model or makes a C-versus-B claim; a later, explicitly
authorized step may add the first justified adapter behind the AVEN-006
interface.

## Longer-term gates, all deferred

| Stage                      | Evidence required before expansion                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| v0.1 Learning Core         | C materially beats B with controlled authority and acceptable burden, or a clean negative result |
| v0.2 Continuity            | Vague-cue episodic recall, provenance, and model continuity                                      |
| v0.3 Bounded Action        | Root, one safe integration, verification, healthy approval UX                                    |
| v0.5 Owner Alpha           | Reliable one-owner use over weeks; backup/export/error recovery                                  |
| v0.7 Closed Alpha          | 5-20 owners with neutral onboarding and isolation                                                |
| v0.9 Private Beta          | Privacy/erasure/telemetry/cost/migration discipline for 50-200 owners                            |
| v1.0 Personal Intelligence | Persistent relationship, governed learning, inspectability, selective integrations               |
| v1.5 Delegated Work        | Background usefulness without unhealthy approval burden                                          |
| v2.x Skill/Tool Factory    | Contained candidate creation, independent evaluation, external promotion                         |
| Research branches          | Stable core, separate contained protocols and evidence/ethics gates                              |
