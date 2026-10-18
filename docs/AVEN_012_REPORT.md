# AVEN-012 report: Root Policy Gateway

Status recorded **2026-10-18, by the final status amendment**: **all four
AVEN-012 implementation patches were independently approved, committed by the
owner and passed GitHub CI** (section R). The approved implementation head of
`aven-012/root-policy-gateway` is `6b5fd65baf5417908678b1468e09c13f52c31dac`.
AVEN-012 is **implemented and awaiting final acceptance, merge and the annotated
`aven-012` tag**: it is not merged into `main`, not tagged and not frozen. This
amendment changes this report only and needs its own independent review. The
original Patches 3 and 4 were rejected on 2026-10-17 for findings F1 and F2 and
replaced by corrected candidates before any commit (section D). No model was
called. Nothing in this report is an experimental result, and no C-versus-B
learning advantage has been demonstrated.

Baseline: frozen AVEN-011, annotated tag `aven-011` (tag object
`56a0e883b17b03be080af50ce5f60c692d409b83`), commit
`44ba416d90624be67fde2fab31c716e8298648bb`, which is also `main`. Package:
`packages/root-policy` (`@aven/root-policy`, version `aven-012-root-policy-v1`).
Package documentation:
[`packages/root-policy/README.md`](../packages/root-policy/README.md).

**Evidence classes.** This report keeps five kinds of evidence apart:

- **Repository evidence:** code and tests in the four committed patches that
  anyone can re-run.
- **Builder-reported:** results of commands the builder ran on the owner's
  Windows machine while preparing the candidates, including runs on disposable
  rehearsal commits in an isolated clone. Reviewers should re-run them.
- **Independent:** review verdicts and validation by the independent reviewer:
  Patch 1 approved (2026-10-16); Patch 2 approved and the original Patches 3 and
  4 rejected with findings F1 and F2 (2026-10-17); the corrected Patch 3
  approved (checks 2026-10-17, finalized 2026-10-18) and the corrected Patch 4
  approved (2026-10-18). This status amendment is not yet reviewed.
- **GitHub CI:** the repository's `Owner-first attribution` workflow on each
  owner commit; all four runs completed successfully (section R).
- **Pending:** steps that have not happened (section Q). They are never reported
  as passed.

## A. Purpose and milestone scope

Aven may propose actions; only Root evaluates authority. AVEN-012 adds a
Root-owned, deterministic policy gateway that returns `ALLOW`, `DENY` or
`REQUIRE_OWNER_APPROVAL` for AVEN-011 action proposals, reusing the frozen
AVEN-002 `ActionProposalSchema`, `ProposalBindingSchema`, `PolicyDecisionSchema`
and `OwnerApprovalSchema` and the frozen `policy_decision` experience event
unchanged. It is meant to serve the future AVEN-013 sandbox tool, and grants no
tool execution capability.

In scope:

- Root-controlled, versioned and digested policy definitions: a risk
  classification of every (operation, resource kind), a catalog of known tool
  actions and the one effect each really has, a high-risk mode, a maximum
  approval age, the approval-authentication mode and least-privilege grants;
- independent revalidation of AVEN-011 v1 proposals and recomputation of their
  exact binding;
- verification of owner approval records and deterministic evaluation;
- a gateway that evaluates recorded proposals read-only at a Root clock;
- one recorder that appends one `policy_decision` event through the frozen
  Ledger, with explicit uncertain outcomes and read-only reconciliation;
- successor attribution governance for the milestone.

Out of scope, and absent: tool execution or verification; real owner
authentication; OS-level or process isolation of Root; any owner-state write,
learning or promotion; API wiring; model or provider calls; exactly-once
recording; AVEN-013.

## B. Baseline, ancestry and governance

| Role                           | Commit or object                           | Notes                                                   |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------- |
| Frozen AVEN-010                | `76535d8647ee36e56bd2efd1a86642d1fc572ee7` | Annotated tag `aven-010` (tag object `4ef575c2…`)       |
| AVEN-011 baseline              | `c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be` | Owner-first attribution policy                          |
| AVEN-011 trusted reference T   | `3761c775b5650e353816b3395e4d71022398afd1` | Gate blob `8fe769e7…`; now pinned in the new gate       |
| Frozen AVEN-011 (`main`)       | `44ba416d90624be67fde2fab31c716e8298648bb` | Annotated tag `aven-011` (tag object `56a0e883…`)       |
| AVEN-012 trusted reference T12 | `f3ffdf7e72365b511541af596c82a27975534d59` | Owner commit of the approved Patch 1 (tree `b623b608…`) |
| AVEN-012 Patch 2               | `fd9b873b1bfc9fda7e231dff96ff30b86a09e00d` | Owner commit of the approved Patch 2 (tree `364db8d1…`) |
| AVEN-012 Patch 3               | `fad845c69b38025d8a9a2eabad9f9114180eba71` | Owner commit of corrected Patch 3 (tree `cce3de9b…`)    |
| AVEN-012 Patch 4 (head)        | `6b5fd65baf5417908678b1468e09c13f52c31dac` | Owner commit of corrected Patch 4 (tree `10b7e45a…`)    |

Patch 1 extends the owner-first attribution gate
(`tooling/attribution/check-post-aven010.mjs`) to governance version
`aven-012-governance-v1`. It closes the AVEN-011 era at the pinned `aven-011`
tag (exactly seven commits, rules unchanged, trusted reference `3761c77` pinned)
and judges every later commit against the `aven-011` tree: only the 33
enumerated `packages/root-policy/` files and `docs/AVEN_012_REPORT.md` may be
added; only the five shared files and the three governance files may be
modified; `package.json` and `pnpm-lock.yaml` may only reach the states Q0/Q1
and K0/K1; nothing that exists at `aven-011` can be reopened. Details:
[`docs/POST_AVEN010_COMMIT_ATTRIBUTION.md`](POST_AVEN010_COMMIT_ATTRIBUTION.md).

**The governance transition.** T's gate run with
`--governance-frozen-at 3761c77…` deliberately rejects any governance change
after T, so it rejects Patch 1 (`governance_change_after_trusted_reference`); it
also rejects Patches 2 to 4, whose files the AVEN-011 allowlist does not name.
This is the guard working. It was not bypassed, and the old frozen-at-T mode is
not presented as approving the amendment. Patch 1 is instead submitted for
independent review as a governance-only change, with preservation evidence
(section L). After its independent approval the owner committed it as `f3ffdf7`,
which is the AVEN-012 trusted reference T12; Patches 2 to 4 are evaluated with
T12's gate and
`--governance-frozen-at f3ffdf7e72365b511541af596c82a27975534d59`.

## C. Architecture and boundaries

| Entry                       | Depends on                                                             | Contents                                                                     |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@aven/root-policy` (root)  | `@aven/contracts`, `zod`, `node:crypto` (SHA-256), `node:util` (Proxy) | Policy registration, proposal revalidation, approval verification, decisions |
| `@aven/root-policy/ledger`  | adds `@aven/ledger`, `@aven/storage`                                   | Root gateway, read-only evaluation of recorded proposals, decision recorder  |
| `@aven/root-policy/testing` | the same as the root entry                                             | The synthetic approval authentication capability (test only)                 |

- **Independence from the proposing side.** A frozen AVEN-011 test
  (`packages/action-proposals/test/boundaries.test.ts`, "is imported by no other
  workspace package") fails if any other workspace manifest names
  `@aven/action-proposals`, and it is not one of the six historically excluded
  suites. Root therefore re-implements the AVEN-011 v1 validation rules and
  digest protocol instead of importing them, as the AVEN-011 report (section O)
  anticipates ("using `validateActionProposal` or its own validator"). The five
  AVEN-011 golden digest vectors and both rejected vectors, read as data, pin
  the two implementations to the same results.
- **A new package directory.** `packages/root` stays the untouched `.gitkeep`
  placeholder: the frozen AVEN-010 tripwire pins that tree.
- **Pure root entry.** It reads no clock, storage or network, generates no
  identifiers and runs no caller code (inert copies, depth, node, array and
  string limits).
- **The only write** is the recorder's single frozen `appendEvent`.
- **Recognition by identity.** Registered policies, the synthetic authentication
  capability, gateways and gateway evaluations are recognised by module-private
  registries, never by shape: copies and look-alikes are refused.
- **No dependents.** No workspace package imports `@aven/root-policy`.
- **Not isolation.** This is an in-process prototype. Module privacy is not
  OS-level security isolation: any code in the process can create its own
  policy, synthetic channel or gateway, and any code with storage access can
  append events, including `policy_decision` events.

## D. Patch plan and status

| Patch | Content                                                                                | Status (2026-10-18)                                                                                         |
| ----- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1     | Successor governance: gate, policy document, CI workflow, `AGENTS.md`                  | Approved; owner commit `f3ffdf7` (T12); CI passed                                                           |
| 2     | Pure Root policy engine, package scaffold, typecheck wiring, lockfile importer         | Approved; owner commit `fd9b873`; CI passed                                                                 |
| 3     | Gateway over recorded proposals, approval history checks, decision recorder, reconcile | Original rejected (F1); corrected candidate approved; owner commit `fad845c`; CI passed                     |
| 4     | Adversarial campaign, this report, status reconciliation, root description             | Original rejected (F2, and F1 in its tree); corrected candidate approved; owner commit `6b5fd65`; CI passed |

Each patch is one owner commit, reviewed and committed in order. The rejected
Patches 3 and 4 were never committed, so their corrections are revised
candidates rather than separate corrective commits.

### Independent findings and corrections

**F1 (Patch 3, high): a revocation beyond the recorder's history limit.** The
original recorder reread a relied-on approval's versions with a statement
limited to 65 rows and treated that possibly incomplete list as proof that no
version was revoked. The reviewer committed issued versions 2 to 65 and a
revoked version 66 through the frozen Ledger before recording; the original
recorder still wrote an approval-based `ALLOW`. Correction: before recording an
approval-based `ALLOW`, the recorder reads each relied-on approval's complete
version history, refuses more than 64 versions (the same v1 bound the evaluator
already enforced) with `invalid_history` instead of truncating, and refuses with
`stale_evaluation` any version that is not `issued` or any version set other
than exactly the one evaluated (history that grew or changed after evaluation).
The evaluator's per-approval overflow refusal is now also explicit. Regression
tests cover revocations at versions 2, 64, 65, 66, 67 and 80, issued growth to
2, 64, 65 and 66 versions, a 64-version positive boundary, owner isolation and
the exact reproduced attack, each asserting that a refusal writes no policy
decision. Against the original recorder blobs nine of them fail (the version-66
attack is recorded there); against the corrected blobs all pass.

**F2 (Patch 4, medium): the recording window was overstated.** The original
report and limitation notes said the recording window bounds the gap between the
recorder's precheck and the Ledger write. It does not: the Root clock is read
once on entry, and the window is an entry-time check of the evaluation's age. It
does not bound how long the prechecks and the append then take, and it does not
close the race with a revocation committed after the precheck. A
controlled-clock regression witness (Patch 3, `record.test.ts`) shows Root time
advancing 120 seconds past a one-second window during the first precheck read
while recording still succeeds. The documentation now states this guarantee
exactly; stronger atomic freshness enforcement would need its own reviewed
design.

## E. Root policy model

A definition (`format: 'aven-012-root-policy-definition-v1'`) is Root
configuration. `createRootPolicy` copies it inertly, validates it with a strict
schema and the Root invariants, deep-freezes it, computes its digest (SHA-256
over `AVEN-012-ROOT-POLICY-DIGEST-V1`, a NUL byte and the canonical JSON of the
definition) and registers it. Every decision's `issuer` (`kind: 'root'`,
`policyVersion`, `policyDigest`) comes only from the registered policy.

Root invariants (otherwise `invalid_policy`, so nothing is evaluated):

- each (operation, resource kind) is classified at most once, and every
  learned-state change and learning-lifecycle operation is `forbidden`;
- each (tool, action) is catalogued once with one classified effect that changes
  no learned owner state, and an irreversible action is never low risk;
- each grant names one catalogued **low-risk** action, one exact resource of its
  kind, one owner, an owner, session or task scope and a non-empty validity
  window, with a unique `grant_` identifier;
- `synthetic_test_only` approval authentication exactly when the synthetic
  capability is supplied.

`ROOT_V1_REFERENCE_RISK_TABLE` classifies all 50 pairs: reads and drafts low;
creating or modifying documents, files and messages medium; deleting, sending
and publishing them high; sandbox create and modify low, sandbox delete medium,
sandbox send and publish high; reading learned state medium; learned-state
changes and learning operations forbidden. `ROOT_DENY_ALL_POLICY_DEFINITION` is
the denial fallback: that table, an empty catalog and no grants, so every
proposal is `DENY` (`action_not_in_policy`).

## F. Revalidation and binding

`revalidateProposal` applies exactly the AVEN-011 v1 rules: an inert copy, the
frozen contract, well-formed Unicode, the v1 limits (depth 16, 2,048 nodes,
arrays of 256, strings of 20,000), the exact stamp
`{ component: '@aven/action-proposals', version: 'aven-011-action-proposals-v1' }`,
`recordVersion` 1, no learning-lifecycle operation, no non-read operation on
learned state, and the explicit owner, session and task. It recomputes the
binding: the identifier, version, protocol-v1 proposal digest (SHA-256 over
`AVEN-011-ACTION-PROPOSAL-DIGEST-V1`, NUL and RFC 8785-compatible canonical
JSON) and the declared parameters digest. A proposal outside the format is not
evaluated (`invalid_proposal`); one of another owner, session or task is
`binding_mismatch`.

## G. Evaluation rules

`evaluateActionProposal(policy, input)`; the first rule that applies decides:

1. proposal created after Root's evaluation time: `DENY`;
2. (tool, action) not in the policy catalog: `DENY`;
3. target of another kind than the catalogued effect, or requested authority not
   exactly that one effect on that target: `DENY`;
4. an effect that would change learned owner state: `DENY` (defense in depth);
5. effect unclassified or `forbidden`: `DENY`;
6. effective risk = Root's classification, raised, never lowered, by the
   declared risk (`unknown` counts as high) and by a declared reversibility
   worse than the catalog's (at least medium);
7. high effective risk under `highRisk: 'deny'`: `DENY`;
8. low effective risk and a matching, current, in-scope Root grant: `ALLOW`,
   basis `existing_grant` (`<policyVersion>#<grantId>`);
9. any verified owner approval: `ALLOW`, basis `owner_approval`;
10. otherwise `REQUIRE_OWNER_APPROVAL`, whose requirement names the exact
    binding and task.

Reasons come from a fixed vocabulary of 24 codes and are listed in rule order.
Cited `priorApprovalIds` are never authority (`cited_approvals_not_authority`).
The trusted inputs are the registered policy and the evaluation time from the
Root host; the proposal, the caller-allocated decision identifier and the
approval records are untrusted.

## H. Approvals and authentication

An approval may support an `ALLOW` only if every stored version names this
owner, exactly this binding (identifier, version, proposal digest, parameters
digest) and exactly this task; its versions agree on what they approve and when,
and none is revoked; it was issued no earlier than the proposal's creation and
not after Root's evaluation time, is unexpired (expiry exclusive) and no older
than the policy's maximum approval age (at most 30 days); and **a Root-held
authentication capability vouches for it**. Each failed condition is a fixed
reason (11 in all).

Stored approval records do not prove that an owner authenticated or consented:
their owner provenance is declared, never authenticated. AVEN-012 has no real
owner authentication. With `approvalAuthentication: 'unavailable'`, no approval
is ever verified, so approval-based `ALLOW` is impossible. The only capability
is the **synthetic test capability** from `@aven/root-policy/testing`, an
in-memory channel whose `attest` hook stands in for a future authenticated owner
interface in tests. A policy using it says so in its digested definition, and
every decision relying on it carries
`approval_authenticated_by_synthetic_test_capability`. No production trust is
claimed.

## I. Recorded proposals, decision recording and reconciliation

- **Gateway.** `createRootGateway({ policy, clock, recordingWindowSeconds? })`
  is Root host configuration. The Root clock is the only source of evaluation
  time.
- **Evaluation.** `evaluateRecordedProposal(gateway, storage, request)` takes
  only `{ ownerId, proposalEventId, decisionId }`. Inside one deferred SQLite
  read transaction it reads, owner-scoped with nine pinned `SELECT`s, the
  `action_proposed` event, its projection (equal to the payload) and its
  declared digest (equal to Root's recomputation), and every stored version of
  every approval bound to the proposal, including versions that name another
  binding. Each approval version must come from its own `owner_approval` event
  with an identical payload. Inconsistency is `invalid_history`. Earlier
  `policy_decisions` are never read as input.
- **Recording.** `recordRootDecision(gateway, storage, evaluation, { eventId })`
  accepts only an evaluation produced by the same gateway from the same storage
  connection. On entry it reads the Root clock once and requires it to lie
  within `[evaluatedAt, evaluatedAt + window]` (default 60 s), an entry-time
  check of the evaluation's age only. It then rechecks owner, task, the exact
  recorded binding, derivation evidence, unused identifiers and, for an
  approval-based `ALLOW`, each relied-on approval's complete current version
  history: more than 64 versions is `invalid_history`; a version that is not
  `issued`, or a version set other than the evaluated one, is
  `stale_evaluation`. It then makes one `appendEvent`: envelope task of the
  proposal, `occurredAt` the evaluation time, creation and provenance
  `@aven/root-policy` (`system_generated`, derived from the approval evidence an
  approval-based `ALLOW` relied on). Measured deltas of one recording:
  `experience_events` +1, `policy_decisions` +1, `record_keys` +2,
  `record_versions` +2, `record_references` +4, and nothing else.
- **Outcomes**, as AVEN-011, each failure carrying one of three:
  - `not_written` for every failure before the append can have started: invalid
    or foreign input, the entry-time age check, and Root's own read-only
    prechecks, including a `storage_failure` from a failed read or from a
    transaction the caller left open; and for a Ledger refusal reported before
    its transaction began (`rollback: 'not_started'`, including its
    `transaction_active` and `storage_failure`);
  - `rolled_back` for checks the Ledger raises in its open transaction and
    reports as rolled back (duplicate identifiers, rejected events or
    references, unknown owner, session or task, integrity failures, invalid
    input and cross-owner references);
  - `unknown` only when the append's effect is genuinely uncertain: a Ledger
    `storage_failure` reported during its transaction (it may not have executed
    ROLLBACK), a failed rollback, including a COMMIT that fails or takes effect
    and then raises, an unrecognised Ledger failure, a non-Ledger error from the
    append, and any failure after the append returned.

  The exact mapping is `ledgerFailure` in `src/ledger/record.ts`, pinned case by
  case in `test/record.test.ts`.

- **Reconciliation.**
  `reconcileRootDecisionRecording(storage, evaluation, { eventId })` only reads
  and returns `recorded`, `not_recorded`, `conflict` or `unresolved`. After
  `unknown`: close the connection, reopen, reconcile, and only after
  `not_recorded` evaluate again and record.

## J. Handoff to AVEN-013

AVEN-012 executes nothing. Every evaluation says `executes: false`,
`parameters.content: 'not_inspected'` and
`executionRequirement: 'recheck_parameter_bytes_and_root_decision_at_execution'`.
A future executor must:

- hash the real parameter bytes at use and compare them with the bound
  parameters digest;
- obtain a current Root evaluation rather than trusting a stored `ALLOW`: any
  code with storage access can append a `policy_decision` event, and a stored
  decision is a claim about one evaluation, never a standing permission;
- enforce single execution itself: Root does not consume approvals or decisions;
- keep the frozen storage rule that an execution record must cite a recorded
  `ALLOW` with the exact binding.

## K. Adversarial and mutation evidence

Repository evidence (`packages/root-policy/test/adversarial.test.ts`, synthetic,
hostile texts deliberate):

- a two-owner scenario on file-backed SQLite with seven proposals and six
  approval records, decided as the policy requires, recorded on one connection
  and reconciled on another;
- a fresh Node process on a `query_only` connection replays the whole pipeline
  byte-identically, with no change and an unchanged database;
- forged and look-alike capabilities, approvals attested by another channel or
  differing in one field, replay across proposals (every single-field
  re-proposal fails), stale, expired, not-yet-valid and revoked approvals;
- declared low risk for send, publish, delete and modify operations;
- cross-owner and cross-task references (the frozen storage itself refuses an
  approval bounded to another task);
- digest mismatches: a single-leaf sweep (24 leaves: 10 remain valid v1
  proposals and none is allowed, 14 are refused before evaluation) and a stored
  digest Root cannot reproduce;
- every uncatalogued (operation, resource kind) combination, and attempts to
  configure learning or learned-state changes;
- policy version changes and the deny-all fallback, including an `ALLOW`
  recorded under one version that grants nothing under the next;
- duplicate decision and event identifiers, read faults, a read-only connection
  and injected COMMIT faults, each reconciled truthfully;
- hostile proposal descriptions, locators, owner messages, action names and a
  forged `ALLOW` appended beside Root;
- approval history at and beyond the v1 bound on file-backed SQLite: the
  reproduced version-66 revocation and history growth after evaluation are
  refused with no policy decision written, while an unchanged 64-version history
  still records;
- a seeded sweep of 2,500 generated cases over five policies checking that every
  decision is schema-valid, issued by the registered policy and deterministic,
  that uncatalogued actions are `DENY`, that effective risk never falls below
  Root's, that a grant only allows low risk with a real matching grant, and that
  every approval-based `ALLOW` needs the synthetic capability and passes an
  independent oracle.

Builder mutation probe (not committed; builder-reported): 50 hand-written
mutants on the corrected source (the original 46, with the revocation-recheck
mutant retargeted to the corrected code, plus four aimed at the F1 correction),
each applied alone and judged by the whole package suite (308 tests): **47
killed, 3 surviving** (analysed below the table):

| Area                                | Mutants | Examples of what each mutant removed or weakened                                                                                                                                                             |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Evaluation rules (`evaluate.ts`)    | 17      | grant above low risk, declared-risk and reversibility escalation, requested-authority, target-kind and future-creation checks, every grant condition, unknown action, forbidden effect, unverified approvals |
| Approval verification               | 11      | revocation, binding, task bounds, expiry boundary, staleness, back-dating, not-yet-valid, missing authentication, version conflicts, owner, same-version duplicates                                          |
| Authentication capability           | 1       | the synthetic channel vouching for any approval                                                                                                                                                              |
| Proposal revalidation               | 3       | stamp, learned-state operations, owner/session/task binding                                                                                                                                                  |
| Policy invariants                   | 4       | grants above low risk, classifiable learned-state changes, irreversible low risk, grant windows                                                                                                              |
| Canonical JSON and exact time       | 2       | unsorted keys, reversed fraction order                                                                                                                                                                       |
| Gateway, history reads and recorder | 8       | declared-digest check, approval source events, revocation versions, foreign evaluations, recording window, revocation recheck, identifier prechecks, approval derivation                                     |
| Approval history bound (F1)         | 4       | the recorder's overflow refusal (killed), the whole evaluated-version-set comparison (killed), only its length half (survived), the evaluator's per-approval overflow refusal (survived)                     |

Survivors, each equivalent under the frozen append-only storage and the existing
bounds: removing the recorder's revoked-status check is masked by the
version-set comparison (a revocation after evaluation is always a new version,
and a revoked version at evaluation time is rejected by the evaluator); removing
only the length half of that comparison is masked by its per-version comparison
(versions cannot be deleted, so the history can only grow); removing the
evaluator's per-approval overflow refusal is masked by its 64-record total
bound. Both remain as defense in depth. The original 2026-10-15 probe (46 of 46
killed) ran on the original source and did not include the F1 guards. Mutants
are a sample chosen to target each guard, not an exhaustive or automated
mutation analysis, and passing them does not prove that every approval-history
guard holds (finding F1 was not covered by the original sample).

## L. Governance evidence (builder-reported)

Corrected candidates (2026-10-17), with the evaluator files checked out byte for
byte from the actual T12 commit (`check-post-aven010.mjs` blob `e8c752e1…`,
`attribution.ts` blob `aa033604…`), `--governance-frozen-at` T12, in an isolated
clone made from GitHub; corrected Patches 3 and 4 are disposable rehearsal
commits on the owner's actual Patch 2 commit:

| Candidate                            | Result                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Owner's Patch 2 commit `fd9b873`     | PASS (AVEN-012 milestone commits 2)                                                                                        |
| Corrected Patch 3 (tree `cce3de9b…`) | PASS (3)                                                                                                                   |
| Corrected Patch 4 (tree `10b7e45a…`) | PASS (4)                                                                                                                   |
| T12 gate `--self-test`               | PASS: 6 controls and 54 violations (open AVEN-011 era) and 6 controls and 44 violations (closed AVEN-011 and AVEN-012 era) |

No governance file, frozen source or frozen test changed in either corrected
patch.

Original preparation (2026-10-15), on disposable rehearsal commits of Patches 1
to 3 in an isolated clone (owner identity used only in that throwaway clone,
never pushed):

| Run                                                                  | Result                                                                                                                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T's gate (blob `8fe769e7…`), no frozen option, on Patch 1            | PASS: Patch 1 is a governance-only commit with unchanged `package.json` and lockfile                                                                                                                |
| T's gate with `--governance-frozen-at 3761c77…`, on Patch 1          | FAIL as designed: `governance_change_after_trusted_reference`                                                                                                                                       |
| T's gate, no frozen option, on Patch 2                               | FAIL as designed: unlisted `packages/root-policy/` paths                                                                                                                                            |
| New gate from rehearsal T12 = Patch 1, frozen at T12, on Patches 1-3 | PASS each; closed AVEN-011 era 7 commits, trusted `3761c77` pinned                                                                                                                                  |
| New gate frozen at `3761c77…`                                        | Refused: "is not an AVEN-012 milestone commit"                                                                                                                                                      |
| New gate on the real history at `aven-011`                           | PASS                                                                                                                                                                                                |
| New gate `--self-test`                                               | PASS: 9 owner-first, 4 + 14 direct state cases, CLI checks; 6 controls and 54 violations of the open AVEN-011 era (unchanged); 6 controls and 44 violations of the closed AVEN-011 and AVEN-012 era |

Frozen historical validation in isolated worktrees of the rehearsal clone
(builder-reported, Windows, `--maxWorkers=2 --testTimeout=30000`):

- at annotated tag `aven-011`: the unchanged complete `check` passed (2,066
  tests in 58 files) and T's own gate with `--governance-frozen-at 3761c77…`
  passed;
- at annotated tag `aven-010`: the unchanged complete `check` passed (1,899
  tests in 56 files) and the original `check-attribution.ts` passed (16 commits,
  0 failures).

The rehearsal tree IDs equal the trees of owner commits of the same bytes; the
owner's Patch 1 and Patch 2 commits indeed have the rehearsed trees `b623b608…`
and `364db8d1…`. The review bundles record every tree per patch.

## M. Reproducibility

Use Node 24 and pnpm 11.19.0; install with
`pnpm install --frozen-lockfile --ignore-scripts` (better-sqlite3 13 ships
prebuilt binaries).

| Command                                           | Purpose                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| `pnpm check`                                      | Prettier, all typechecks, experiment check, tests |
| `pnpm --filter @aven/root-policy test`            | Package tests only                                |
| `pnpm attribution:self-test`                      | Gate self-test (synthetic histories)              |
| `node tooling/attribution/check-post-aven010.mjs` | Gate, run from a trusted copy (see section B)     |

On Windows the frozen AVEN-009 to AVEN-011 paging and determinism tests can
exceed the 5-second default timeout under the default worker count; the
established runner options are `--maxWorkers=2 --testTimeout=30000` (a runner
adjustment, not a code change). Running scripts through `pnpm run` may trigger
pnpm 11's reinstall and edit `pnpm-workspace.yaml`; check `git status` and stage
explicit paths only.

## N. Validation status

| Check                                                    | Scope                                    | Result                                                                                                                                                                 | Class            |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Baseline `check`, literal default runner                 | untouched `aven-011` worktree            | 2,057 passed, 9 failed: all 9 are 5-second timeouts in frozen AVEN-009 to AVEN-011 paging and determinism tests                                                        | Builder-reported |
| Frozen `aven-011` `check` and T's gate                   | annotated tag `aven-011`                 | passed: 2,066 tests in 58 files; gate PASS                                                                                                                             | Builder-reported |
| Frozen `aven-010` `check` and original attribution check | annotated tag `aven-010`                 | passed: 1,899 tests in 56 files; original check PASS (16 commits)                                                                                                      | Builder-reported |
| Full `check` (Windows options)                           | rehearsal Patch 1                        | passed: 2,066 tests in 58 files; new gate frozen at rehearsal T12 PASS; self-test PASS                                                                                 | Builder-reported |
| Full `check` (Windows options)                           | rehearsal Patch 2                        | passed: 2,235 tests in 65 files                                                                                                                                        | Builder-reported |
| Full `check` (Windows options)                           | rehearsal Patch 3                        | passed: 2,325 tests in 68 files                                                                                                                                        | Builder-reported |
| Full `check` (Windows options)                           | rehearsal Patch 4                        | passed: 2,354 tests in 69 files; new gate frozen at rehearsal T12 PASS                                                                                                 | Builder-reported |
| Literal default-runner `check`                           | all four patches applied (worktree)      | 2,343 passed, 11 failed: all 11 are 5-second timeouts in frozen AVEN-009 to AVEN-011 paging and determinism tests (the baseline pattern); no `root-policy` test failed | Builder-reported |
| Six excluded historical suites                           | `aven-011` versus all four patches       | 190 passed and the same 6 failed (of 196) at both, identical failure set (obsolete frozen expectations); no frozen test edited, no exclusion added                     | Builder-reported |
| Gate self-test                                           | Patch 1 gate                             | passed (see section L)                                                                                                                                                 | Builder-reported |
| Separability                                             | patches applied with `git apply --index` | each patch, applied in order to `aven-011`, reproduces its recorded result tree (see the review bundles)                                                               | Builder-reported |
| Full `check` (Windows options)                           | corrected Patch 3 (rehearsal)            | passed: 2,341 tests in 68 files                                                                                                                                        | Builder-reported |
| Full `check` (Windows options)                           | corrected Patch 4                        | passed: 2,374 tests in 69 files                                                                                                                                        | Builder-reported |
| F1 negative control                                      | original Patch 3 recorder blobs          | 9 of the new F1 tests fail; the version-66 attack is recorded as ALLOW there                                                                                           | Builder-reported |
| F1 and F2 regressions                                    | corrected blobs                          | 20 of 20 pass (16 in `record.test.ts`, 4 in the campaign)                                                                                                              | Builder-reported |
| Reviewer's own F1 and F2 probes                          | corrected tree (import paths adjusted)   | F1: versions 2 and 64 `stale_evaluation`, 65 and 66 `invalid_history`, zero decisions written; F2 witness still records (documented limitation)                        | Builder-reported |
| Six excluded historical suites                           | corrected Patch 4                        | 190 passed and the same 6 failed (of 196) as at `aven-011`; identical failure set                                                                                      | Builder-reported |
| Separability                                             | corrected patches, `git apply --index`   | corrected Patch 3 on the owner's Patch 2 tree, then corrected Patch 4 on its result, reproduce both recorded result trees                                              | Builder-reported |
| Independent review                                       | Patches 1 and 2                          | approved (2026-10-16 and 2026-10-17)                                                                                                                                   | Independent      |
| Independent review                                       | original Patches 3 and 4                 | rejected: F1 and F2 (2026-10-17)                                                                                                                                       | Independent      |
| Independent review                                       | corrected Patch 3                        | approved (checks 2026-10-17, finalized 2026-10-18): `check` 2,341 tests in 68 files; 27 probes, version-66 attack refused with zero writes; trusted T12 gate PASS      | Independent      |
| Independent review                                       | corrected Patch 4                        | approved (2026-10-18): `check` 2,374 tests in 69 files; 27 probes; six excluded suites with the same six failures; trusted T12 gate PASS                               | Independent      |
| GitHub CI                                                | owner commits of Patches 1 to 4          | passed: runs `39000599788`, `39049373006`, `39106022147` and `39142134173` (section R)                                                                                 | GitHub CI        |
| Independent review                                       | this status amendment                    | **pending**                                                                                                                                                            | Pending          |
| Real-model or end-to-end experiment                      | out of scope                             | not run; `execution: not_run` unchanged                                                                                                                                | n/a              |

The rows for Patches 1 to 4 above the corrected rows record the original
2026-10-15 preparation; the corrected rows record the 2026-10-17 candidates.

Test counts: the AVEN-011 suite has 2,066 tests in 58 files. Patch 2 adds 169
tests in 7 files, the corrected Patch 3 another 106 in 3 files (90 originally,
plus 16 F1/F2 regressions) and the corrected Patch 4 another 33 in 1 file. The
pre-existing tests are unchanged.

## O. Known limitations and risks

- **No real authentication.** Approval-based `ALLOW` exists only with the
  synthetic test capability. Without it, no approval is ever verified.
- **In-process prototype.** No OS-level or process isolation; any in-process
  code can construct its own policy, capability or gateway, and any code with
  storage access can append events, including forged `policy_decision` events.
  Root never reads them as authority, but a consumer that trusts stored
  decisions would be misled (section J).
- **Time of check and time of use.** The recording window is an entry-time check
  of the evaluation's age, not a bound on the time from precheck to append. A
  revocation committed after the recorder's precheck snapshot and before the
  Ledger's write lock is not seen, and nothing bounds that interval. A recorded
  `ALLOW` is therefore a claim about one evaluation at its evaluation time,
  never current execution authority. The Root clock must not run ahead of the
  Ledger's recording clock.
- **Bounded approval history.** An approval with more than 64 stored versions
  (or more than 64 approval records for one proposal) cannot be evaluated or
  relied on: Root refuses it (`invalid_history`) rather than reading an
  incomplete history.
- **No exactly-once recording.** A direct frozen-Ledger append can re-observe an
  identical decision under a second event identifier (tested).
- **Approvals are not consumed** and decisions are not single-use.
- **Grants are explicit.** No wildcard or prefix grants; a grant names one exact
  resource.
- **Duplicated logic.** The AVEN-011 v1 rules and the inert-copy module exist in
  two places; the golden vectors and a byte comparison of the inert-copy body
  pin them, but a future protocol change must update both.
- **Tripwires, not proofs.** Static boundary tests are pattern checks.
- **Platform and runner.** All builder runs were on Windows; the default
  5-second Vitest timeout is not met by some frozen suites on this machine
  (section N). GitHub CI ran the literal `check` on Linux (`ubuntu-latest`) for
  each owner commit (section R); no other platform was tested.

## P. Nonclaims

This report does not claim real owner authentication (approval authentication is
synthetic and test-only), OS-level or external security isolation, actual tool
execution, production readiness, exactly-once recording, atomic freshness
between Root's precheck and the Ledger write, that a stored `ALLOW` is present
execution authority, end-to-end learned intelligence, any experimental result or
any C-versus-B learning advantage (none has been demonstrated). Package
separation and these tests are not runtime security. Independent approval, owner
commits and passing CI establish that the reviewed bytes were committed and
checked; they do not establish any of the above.

## Q. Remaining steps

1. Complete: independent approval of Patch 1, owner commit `f3ffdf7` (T12) and
   its GitHub CI.
2. Complete: independent approval of Patch 2, owner commit `fd9b873` and its
   GitHub CI.
3. Complete: independent approval of the corrected Patch 3 (T12's gate with
   `--governance-frozen-at T12`), owner commit `fad845c` and its GitHub CI.
4. Complete: independent approval of the corrected Patch 4 on the committed
   Patch 3, owner commit `6b5fd65` and its GitHub CI.
5. Pending: independent review of this status amendment; if approved, its owner
   commit, T12's trusted gate and GitHub CI.
6. Pending: an explicitly authorized final acceptance of AVEN-012, merge into
   `main` and the annotated `aven-012` tag.

Steps 5 and 6 are not claimed as completed. AVEN-013 is not started.

## R. Final implementation identities (2026-10-18)

All four implementation commits are on `aven-012/root-policy-gateway`, each the
sole parent of the next, starting from frozen AVEN-011 `44ba416d…`. GitHub
attributes author and committer of each to the owner's account `varun-raj-77`
(Varun Karthik, account-linked noreply address); the commits are not
cryptographically signed. Each message ends with exactly one
`Co-authored-by: Claude <noreply@anthropic.com>` trailer.

| Patch | Owner commit                               | Tree                                       | Independent verdict                     | GitHub CI run (success)                                                                |
| ----- | ------------------------------------------ | ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | `f3ffdf7e72365b511541af596c82a27975534d59` | `b623b60894804c1bc81447ef48475465481bac5e` | approved 2026-10-16                     | [`39000599788`](https://github.com/varun-raj-77/Project-Aven/actions/runs/39000599788) |
| 2     | `fd9b873b1bfc9fda7e231dff96ff30b86a09e00d` | `364db8d150ef5bd60952e6386a8b10995c461f77` | approved 2026-10-17                     | [`39049373006`](https://github.com/varun-raj-77/Project-Aven/actions/runs/39049373006) |
| 3     | `fad845c69b38025d8a9a2eabad9f9114180eba71` | `cce3de9bfe019765a8731a0fe786f642789ca1a0` | corrected candidate approved 2026-10-18 | [`39106022147`](https://github.com/varun-raj-77/Project-Aven/actions/runs/39106022147) |
| 4     | `6b5fd65baf5417908678b1468e09c13f52c31dac` | `10b7e45a6b4d1c8fd5a3e5fc7754c40adf734878` | corrected candidate approved 2026-10-18 | [`39142134173`](https://github.com/varun-raj-77/Project-Aven/actions/runs/39142134173) |

Each commit's tree equals the tree of the bytes its independent review approved.
Each CI run is the `Owner-first attribution` workflow on a `pull_request` event,
checked out at exactly that commit on `ubuntu-latest` (Node 24, pnpm 11.19.0),
completed with conclusion `success`: the gate's `--self-test` and the gate on
the commit's history; the literal `scripts.check` on the current tree; and the
unchanged AVEN-010 and AVEN-011 checks at their frozen tags. CI runs the
candidate tree's gate; the trusted evaluation with T12's own gate bytes and
`--governance-frozen-at f3ffdf7e72365b511541af596c82a27975534d59` is the
independent reviews' evidence (and the builder's), not CI's.

**Acceptance status.** AVEN-012 is implemented: every patch is approved,
committed and green. It is **not** finally accepted, merged, tagged or frozen:
`main` remains frozen AVEN-011 `44ba416d90624be67fde2fab31c716e8298648bb`, no
`aven-012` tag exists, and the draft pull request from
`aven-012/root-policy-gateway` is open and unmerged.

**Outstanding limitations** (details in sections J, O and P): approval
authentication is synthetic and test-only; a stored `ALLOW` is a claim about one
evaluation, never present execution authority, and a future executor must obtain
a current Root evaluation and recheck the real parameter bytes; the recording
window is an entry-time age check, so atomic freshness between the precheck and
the Ledger write is not guaranteed; approvals with more than 64 versions are
refused; there is no OS-level or process isolation, no actual tool execution, no
exactly-once recording and no approval consumption; and no C-versus-B learning
advantage has been demonstrated.
