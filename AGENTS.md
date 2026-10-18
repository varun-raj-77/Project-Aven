# Working on Aven

## Current post-freeze attribution policy (owner-authorized maintenance)

**AVEN-010 was independently approved and frozen on 2026-10-13.** The immutable
`aven-010` annotated tag and `main` milestone commit are
`76535d8647ee36e56bd2efd1a86642d1fc572ee7`. The older AVEN-010 instructions and
D11 decision **below are historical and apply only to the already-frozen
AVEN-010 commits**, not to new commits. Do not rewrite or retag them. The
owner-first attribution policy was merged to `main` at
`c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be`, the AVEN-011 baseline. Wherever an
older section below names the AVEN-010 branch, AVEN-010-only authorization or
Claude as commit author, it is historical; current authorization is in the
AVEN-012 section.

For every subsequent Claude-assisted commit, author AND committer must be the
owner, `Varun Karthik` (or `varun-raj-77`), using either verified
`varunraj2117@gmail.com` or the account-linked GitHub
`71327884+varun-raj-77@users.noreply.github.com`. Give Claude transparent credit
using exactly one parsed final trailer:
`Co-authored-by: Claude <noreply@anthropic.com>`. A GitHub connector may choose
the authenticated owner's GitHub noreply email by default; verify that the
GitHub API resolves both fields to `varun-raj-77`.

Before pushing new commits run `pnpm attribution:self-test`,
`pnpm attribution:check`, `pnpm check`, and inspect
`git show -s --format=fuller HEAD`. **Never waive a failed attribution gate.**
The combined gate audits the old frozen 16 commits with the original evaluator
and enforces owner-first identity for all commits after AVEN-010; it also
enforces the exact versioned file governance: `aven-011-governance-v1` for the
history and AVEN-011 eras (closed at the `aven-011` tag) and
`aven-012-governance-v1` for AVEN-012. For details see
`docs/POST_AVEN010_COMMIT_ATTRIBUTION.md`.

## AVEN-012 authorization and working plan

**AVEN-011 was accepted and frozen**: annotated tag `aven-011` (tag object
`56a0e883b17b03be080af50ce5f60c692d409b83`) and `main` at
`44ba416d90624be67fde2fab31c716e8298648bb`. The owner authorized **AVEN-012, the
Root Policy Gateway**, as one development batch of **four separately reviewable
patches**, each independently reviewed and separately committed by the owner, in
order, on the isolated branch `aven-012/root-policy-gateway` (created from
`44ba416`). That authorization accepted, committed and froze nothing. Claude
prepares each patch and commit-message draft outside the tracked tree and never
commits, pushes, merges or tags; the owner applies, reviews, commits as author
and committer, and pushes. Never merge the branch into `main` during the
milestone, tag it, squash, rebase, rewrite accepted commits or force-push. If
`main` moves during AVEN-012, stop and ask. Do not begin AVEN-013.

Aven proposes; Root decides. AVEN-012 adds one package, `packages/root-policy`
(`@aven/root-policy`), that reuses the frozen AVEN-002 action, approval and
policy-decision contracts unchanged and returns `ALLOW`, `DENY` or
`REQUIRE_OWNER_APPROVAL`. It grants no tool execution capability, adds no real
authentication, writes no owner state and learns nothing. Patches (the gate
enforces the exact file inventory):

1. Governance: the successor gate (`aven-012-governance-v1`), its policy
   document, the CI workflow (which also runs the unchanged AVEN-011 checks at
   the `aven-011` tag) and this file. **Independently approved; owner commit
   `f3ffdf7e72365b511541af596c82a27975534d59` (T12); GitHub CI passed.**
2. Pure Root policy engine: Root-controlled policy definitions, independent
   AVEN-011 v1 revalidation, approval verification and deterministic evaluation.
   **Independently approved; owner commit
   `fd9b873b1bfc9fda7e231dff96ff30b86a09e00d`.**
3. Approval checks and audited recording: read-only evaluation of recorded
   proposals at the Root clock, one frozen Ledger `policy_decision` append and
   read-only reconciliation. **Original rejected (finding F1: a revocation
   beyond the recorder's 65-row history read); corrected candidate pending
   independent review.**
4. Adversarial campaign and the AVEN-012 report, with status reconciliation.
   **Original rejected (finding F2: the recording window was overstated, and it
   carried the F1 recorder); corrected candidate, built on the corrected Patch
   3, pending independent review.**

Trusted evaluator: T's gate (`3761c77`) with `--governance-frozen-at T`
deliberately rejects Patch 1, which changes the governance files; that refusal
is the guard working and is never bypassed or presented as approval. Patch 1 is
judged as an independently reviewed governance transition (procedure in
`docs/POST_AVEN010_COMMIT_ATTRIBUTION.md`). The owner-created Patch 1 commit
`f3ffdf7e72365b511541af596c82a27975534d59`, independently accepted, is the
AVEN-012 trusted reference `T12`; reviewers run `T12`'s gate, not the
candidate's, against Patches 2 to 4 with `--governance-frozen-at T12`. Candidate
CI is advisory.

Design boundaries of the AVEN-012 candidates:

- Root depends on `@aven/contracts`, `zod` and, in its `./ledger` subpath, the
  frozen Ledger and storage; never on `@aven/action-proposals` (a frozen
  AVEN-011 tripwire forbids any other package from depending on it). Root
  re-implements the AVEN-011 v1 rules and digest, pinned by its golden vectors.
- Policy rules, risk classification, the action catalog, grants, issuer
  identity, policy version and evaluation time are Root-controlled; nothing in a
  proposal, including requested authority, declared risk, origin and cited
  approvals, is authority. Unknown, conflicting, unclassified or forbidden
  requests are `DENY`; low risk is `ALLOW` only on a matching Root grant;
  approval-based `ALLOW` requires a verified approval vouched for by a Root-held
  authentication capability, and the only one in AVEN-012 is a synthetic test
  capability, so no production approval trust is claimed.
- Evaluation, decision recording and (future, AVEN-013) execution stay separate.
  A recorded decision is never a standing permission; a future executor must
  recheck the real parameter bytes and Root's decision at use.
- An in-process prototype is not OS-level security isolation.

## AVEN-011 authorization and working plan (historical)

Historical record: AVEN-011 is accepted and frozen at `aven-011` (`44ba416`).

AVEN-011 is the **Action Proposal Boundary**. The accepted design reuses the
frozen AVEN-002 contracts (`ActionProposalSchema`, `ProposalBindingSchema`,
`RequestedAuthoritySchema`, `ResourceTargetSchema` and the `action_proposed`
event) unchanged and adds one package, `packages/action-proposals`
(`@aven/action-proposals`). Aven proposes; Root decides. AVEN-011 makes no
policy decision, records no approval, executes no tool, calls no model, writes
no owner state, learns nothing and is not wired into the API; Root is AVEN-012.

Patches 1-3 were prepared one at a time, independently accepted and committed by
the owner. The owner then authorized preparing **Patches 4, 5 and 6 together as
separate implementation candidates**, each with its own independent review and
its own owner commit, in order; that authorization accepted, committed and froze
nothing. Patches 4 and 5 were then accepted and committed with GitHub CI
passing; Patch 6 remains a candidate. Work only on the isolated milestone branch
`aven-011/action-proposals`, created from `c8b83ec`: never merge it into `main`
during the milestone, tag it, squash, rebase, rewrite accepted commits or
force-push. Claude prepares each patch file and commit-message draft outside the
tracked tree and never commits under the owner's identity; the owner applies,
reviews, commits as author and committer, and pushes. If `main` moves during
AVEN-011, stop and ask.

Patches, each one reviewed commit (corrective commits after review findings are
separate commits). The gate enforces the exact file inventory:

1. Governance: the successor attribution gate, this file and
   `docs/POST_AVEN010_COMMIT_ATTRIBUTION.md`. Accepted; committed as
   `3761c775b5650e353816b3395e4d71022398afd1` (`T`).
2. Package scaffold and pure boundary: construction, validation, canonical
   proposal digest v1 and inspection. Accepted; committed as `8b25e89`.
3. Recorder and reconciliation: one frozen Ledger append per recording, outcomes
   `not_written`, `rolled_back` or `unknown`, reconciliation by comparison of
   the full expected event, and exact timestamp order (review finding F1).
   Accepted; committed as `2e84dbc`.
4. Read-only historical reader: one record per event, with digest agreement,
   proposal format and event format classified separately. Accepted; committed
   as `9bd2ad7`.
5. Cross-layer adversarial and regression campaign (tests only). Accepted;
   committed as `f494511`.
6. Report and status reconciliation (`docs/AVEN_011_REPORT.md`, `README.md`,
   `docs/ROADMAP.md`, this file, the root `package.json` description and the
   package README). **Candidate pending independent review.**

Trusted evaluator: Patch 1 was verified with the gate from `c8b83ec`. The
accepted Patch 1 commit `3761c775b5650e353816b3395e4d71022398afd1` is the
trusted reference `T` (gate blob `8fe769e70143b513da83ebccece0da3a9fb22a93`,
`attribution.ts` blob `aa033604688134b1311fd0bb5c9562f39e371c74`); reviewers run
`T`'s gate, not the candidate's, against Patches 2 to 6 with
`--governance-frozen-at T`. Candidate CI is advisory. AVEN-011 is not accepted
as a milestone, not merged and not tagged; recording the acceptance of Patch 6
or a freeze requires a later reviewed change made after those events.

Accepted v1 boundaries:

- A proposal's origin is declared on its event (`model_inference` or
  `system_generated`), is never part of the payload or its digest, and is never
  authenticated.
- The v1 recording format excludes learning-lifecycle operations and non-read
  operations on learned state; reads of learned state are allowed. This is a
  format restriction of the recorder, not Root enforcement.
- The proposal digest is SHA-256 over `AVEN-011-ACTION-PROPOSAL-DIGEST-V1`, a
  NUL byte and the canonical JSON of the full payload; ill-formed Unicode is
  rejected. A matching digest shows integrity consistency only, never authorship
  or authorization.
- Prior approval citations stay unverified; their validity is Root's decision.
- There is no exactly-once guarantee; caller-allocated identifiers and
  reconciliation make a retry safe.

## Authority and scope

Historical record of the AVEN-010 authorization; current authorization is in the
AVEN-011 section above.

Build Aven v0.1. Project selection is closed unless implementation evidence
reveals a concrete fatal problem. Current authorized work is **AVEN-010 only**:
Correction Events and Immediate Session Overrides, implemented patch by patch on
the isolated branch `claude/adoring-pasteur-hcc5oe`. Each patch stops for
independent review and explicit authorization before the next begins; the
current patch is recorded in the working plan below. AVEN-001 through AVEN-009
and MAINT-001 are frozen. The current baseline is AVEN-009, tag `aven-009`,
commit `80057a217adb90132c5b6bc1c6a5c0f798db08c5` (Windows validation passed
with the test-runner options `--maxWorkers=2 --testTimeout=30000`, a runner
adjustment, not a code change). The corrected AVEN-008 anchor is tag `aven-008`,
commit `4ea1bc537a55604cf2414fbe3886323934207382`. Commit SHAs cited inside
frozen reports, code and earlier tripwire comments (for example AVEN-008
`4174080`, its configuration v1 `630369a` and the AVEN-009 candidate commits)
refer to the pre-attribution history, which is archived separately and is never
used as a baseline, merged or rebased against. Do not semantically modify a
frozen layer, and do not begin AVEN-011 or any later milestone. AVEN-010 records
explicit, structured owner corrections, preserves the original behavior and
evidence, applies an immediate current-task or current-session override and
exposes inspectable correction evidence for later learning. It performs no
learning, preference inference, promotion or trust decision, durable owner-state
write, correction-derived negative-retrieval learning, authority or permission
decision, Root change, tool execution, or model/provider call. AVEN-010 commits
belong only on the isolated branch for external review: never push to `main`,
merge, or create the `aven-010` tag. Existing research outside this repository
is historical.

Read these sources completely before changing the design:

1. `docs/sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf`
2. `docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt`

The newer Master Description takes precedence when they disagree. In particular,
AVEN-007 is the naive personalization baseline and prebuilt dataset, AVEN-008
the Context Broker, AVEN-009 the Typed Owner Model and AVEN-010 corrections;
success requires C to materially beat B, not only A. The current task's explicit
instructions take precedence over both documents. `docs/AVEN_PRINCIPLES.md`
records the invariants.

## AVEN-010 working plan

Historical: AVEN-010 is frozen at `76535d8`; this plan is kept as its record.

Accepted design (independent review): one new package, `packages/corrections`
(`@aven/corrections`); every frozen layer stays byte-identical. Patches, each a
single reviewed commit; corrective commits after review or audit findings are
separate commits, recorded in `docs/AVEN_010_REPORT.md` (section D):

1. Reconciliation of `AGENTS.md`, `docs/ROADMAP.md` and `README.md`, and the
   commit attribution gate (`tooling/attribution/`, `pnpm attribution:check`).
   Accepted (`19bc92b`).
2. Package scaffold, fixed errors, and the AVEN-010 frozen-layer tripwire inside
   the package (the AVEN-009 tripwire forbids additions to `tooling/tests`).
   Accepted (`9da05c7`).
3. Correction recorder: the only AVEN-010 write, one atomic Ledger
   `owner_correction` append through the frozen Ledger and storage. Accepted
   (`c9f4d41`).
4. Pure immediate-override resolver. Accepted (`9c284c0`, review correction
   `8de38fd`; audit remediations R1-R4 `2a06705`, `2e91eeb`, `7c92380`,
   `64c90ce` and follow-up `1a5f8e4`).
5. Read-only Ledger correction history and correction-evidence index. Accepted
   (`63fae84`).
6. Context Broker integration: current-instruction source, exact-target
   suppression wrapper and exposure verification. Accepted at `0593d44`
   (candidate `9ccfdf3`, audit remediation `0d8753b` for F1-F4, follow-up
   `0593d44` for N1 and N2).
7. Cross-layer adversarial, restart, mutation and performance campaign. Accepted
   with non-blocking notes (`69c5c0a`).
8. AVEN-010 report and documentation. **Current patch: the
   implementation-complete candidate, pending independent final review.**
   AVEN-010 is not merged and not tagged, `main` remains at AVEN-009, and
   freezing it requires separate explicit authorization after that review.

Accepted decisions:

- **D1** Branch `claude/adoring-pasteur-hcc5oe`, from `aven-009`.
- **D2** An in-process recorder in `@aven/corrections`; no HTTP route, and
  `apps/api` stays unchanged. Owner origin remains declared, not authenticated.
- **D3** `unspecified` applicability applies only to the origin task (the
  correction event's envelope binding), labelled as such; without an origin task
  it is recorded with no immediate effect.
- **D4 (modified)** Only explicit correction-to-correction linkage (an `event`
  target naming an earlier correction's event, or an `evidence` target naming
  its evidence) supersedes an earlier correction, and only within the later
  correction's own immediate scope. Sharing a target and category never
  supersedes: both corrections stay active and the overlap is exposed as
  unresolved, without interpreting text.
- **D5** `permission` corrections are recorded only and deferred to Root
  (AVEN-012). They are never emitted as context and never grant anything.
- **D6** Immediate suppression sets the Broker's frozen suppression value
  (`negativeRetrieval` 1) only on candidates whose reference exactly equals an
  active correction target, only within that correction's immediate scope, by
  wrapping the base sources. The AVEN-009 source configuration and the Broker
  stay unchanged. This is distinct from future graded, correction-derived
  negative retrieval (AVEN-014+) and from durable supersession or revocation
  (AVEN-017/018).
- **D7** A current-session correction is projected as a `current_instruction`
  bound to the requesting task of that same session; the origin binding stays in
  the Ledger.
- **D8** Instruction candidates use confidence 1, salience 1 and
  `negativeRetrieval` 0, and render only the corrected instruction, never
  `originalBehavior`.
- **D9 (modified)** Presence in the override view is not proof that the Context
  Broker selected an instruction. The integration patch provides an explicit
  exposure-verification boundary: a required immediate owner instruction missing
  from the selected `ContextBundle` yields a fixed, fail-closed not-exposed
  result, never a reported success. The frozen Broker is not modified.
- **D10** The AVEN-010 frozen-layer tripwire lives in `packages/corrections`;
  the attribution gate lives in `tooling/attribution` and runs as
  `pnpm attribution:check`, outside the pinned `pnpm check`.
- **D11** Claude remains the primary author; tooling-required Claude metadata
  may remain; the owner's exact co-author trailer is mandatory.
- **D12** The owner-local Ledger `sequence` is the only ordering key.

Commit attribution (non-negotiable): every Claude-authored AVEN-010 commit has
author and committer `Claude <noreply@anthropic.com>` and exactly one trailer
`Co-authored-by: Varun Karthik <varunraj2117@gmail.com>` that Git parses in the
final trailer block; owner-authored commits use the verified owner email; no
merge commits; one reviewed patch is one commit and is never squashed. Before
any push run `git show -s --format=fuller HEAD`, `git log -1 --format=%B HEAD`
and `pnpm attribution:check`, which checks every commit after `aven-009`, not
only `HEAD`. On any failure, stop, repair the unpushed commit and verify again.
The gate fails closed on prose lines that combine co-author wording with the
owner's name, so keep such wording out of commit bodies. It reads recorded
commit metadata only; it is tooling discipline, not authentication.

## Architecture

One persistent owner-facing Aven; separate fast execution and slow learning
loops; append-only Experience Ledger; rebuildable typed/scoped owner state;
task-specific Context Broker; typed action proposals; external Root authority;
verification; independent evaluation, shadowing, controlled promotion,
monitoring, and rollback.

Prediction never grants permission. Aven may not directly alter Root, self-grant
permissions, or promote its own learning. Current session corrections may apply
immediately; durable learning follows the slow loop. No specialist agents in
v0.1 without evidence. No production self-modification.

Do not silently redesign Aven. If an architectural change is necessary, stop and
present the following, then wait for approval before making the change:

```text
ARCHITECTURE CHANGE PROPOSAL
Current design:
Observed implementation problem:
Proposed change:
Evidence:
Alternatives:
Consequences:
```

## Engineering and experiment discipline

- Prefer strict TypeScript, pnpm, Zod at boundaries, Vitest, deterministic code,
  explicit state machines where useful, and small local modules. SQLite is the
  initial storage preference; no database implementation in AVEN-001.
- Keep models/frameworks replaceable. No speculative framework adapter,
  microservices, swarms, voice, telephony, broad browser/computer control,
  affect/consciousness work, self-preservation objectives, billing, marketing
  site, or cloud scaling.
- Keep new owners neutral. Never embed this developer's preferences or infer
  owner facts from examples. Synthetic test cases must be labeled as such.
- Preserve evidence; link corrections and supersession. Infer the narrowest
  scope. "No useful lesson" is valid. Current explicit instructions override
  stale learning within Root policy; instructions cannot override denied
  authority.
- Preserve A/B/C, a strong editable/scoped profile plus searchable history for
  B, identical foundation model configurations per comparison, fixed Root
  policy, held-out protection, independent scoring, and supervision/cost
  accounting.
- Pre-specify metrics before results; separate development, promotion
  evaluation, and final held-out cases. Do not invent results, implementation
  status, safety, alignment, novelty, consciousness, or superiority claims.
- Never treat directory/package separation or these checks as enforced runtime
  isolation. Root process isolation, storage protection, and eval-vault controls
  remain implementation decisions.
- Run `pnpm check` after relevant changes. Tests cover bootstrap experiment
  discipline, shared contracts, SQLite integrity, Ledger behavior, the local API
  boundary, the model-runtime boundary and model-output recording path, the
  AVEN-007 A/B baselines and dataset integrity, the AVEN-008 Context Broker's
  selection mechanics, the AVEN-009 owner-model intake, lineage,
  lifecycle-claim, view, rebuild and context-source mechanics, the AVEN-010
  commit attribution rules on synthetic Git repositories, and the AVEN-010
  correction recorder, history reader, evidence index, resolver and Broker
  integration (including a cross-layer campaign on file-backed SQLite), and the
  AVEN-011 proposal construction, digest golden vectors, recorder,
  reconciliation, historical reader and a cross-layer campaign (including a
  fresh-process `query_only` replay and Root-nonauthority checks), and the
  AVEN-012 Root policy definitions, independent proposal revalidation (AVEN-011
  golden vectors), approval verification, evaluation rules, gateway, decision
  recorder, reconciliation and an adversarial campaign (including a
  fresh-process `query_only` replay and a seeded invariant sweep), all on
  synthetic data, not a complete Aven runtime. Run `pnpm attribution:check`
  before every push. Report limitations honestly.
- Keep raw owner data, credentials, private eval cases, and local databases out
  of Git. Commit sanitized reproducibility artifacts only after checking their
  contents.

`packages/contracts` remains the AVEN-002 domain boundary. `packages/storage`
owns AVEN-003 SQLite connections, contract serialization, SQL migrations and
integrity constraints. SQL migrations are authoritative; do not use schema push.
Keep the v1 validation/reference projection semantics available for stored v1
data. `packages/ledger` owns owner-bound historical append/read/replay behavior
over that storage. Replay is observational only. Append success records a claim;
it does not establish truth, authorize execution, or create derived owner state.
`apps/api` owns the AVEN-005 loopback HTTP boundary: declared (unauthenticated)
owner-scoped session and task identity provisioning, owner messages recorded
only as Ledger `owner_request` events, and side-effect-free session history read
from the Ledger. Accepting a message is not authorization and invokes no model.
The owner-message endpoint is exclusively for text entered by the owner
(`owner_request` with `explicit_owner_statement` provenance). Model/runtime
output must never be relayed through that HTTP endpoint or recorded as owner
input; AVEN-006 model output uses only the separate in-process path
`apps/api/src/assistant-response.ts`, recorded as `assistant_response` with
`model_inference` provenance and creation component
`@aven/api/assistant-response`. `metadata.creation.component = "@aven/api"`
marks owner input received through the declared, unauthenticated AVEN-005
channel; declared owner origin is not authenticated owner identity.
`packages/runtime` owns the provider-neutral `ModelRuntime` interface,
normalized runtime errors, cancellation/timeout, strict result validation, and a
test-only scripted runtime (`@aven/runtime/testing`). A runtime generates; it
never owns storage, the Ledger, owner state, Root, permissions or tools, and its
output is data, never authority or learned state. Runtime selection is explicit
injection; there is no router. `packages/baseline` owns the AVEN-007 baselines:
A `fresh` and B `naive_personalized` share one injected runtime, one versioned
base prompt (`BASELINE_SYSTEM_PROMPT_V1`), one call path and one timeout; they
differ only in the personalization payload (an explicit, manually edited
free-text profile plus `NaiveHistorySearch`, a deterministic owner-filtered BM25
over normalized history input, configuration `aven-007-baseline-config-v2` with
tokenizer v2). The harness controls only the injected runtime object, call path,
request shape and timeout; real-model paired runs must compare reported runtime
and model stamps. It owns no storage or Ledger persistence, never auto-edits the
profile, learns nothing, and is not the Context Broker or Owner Model.
`evals/aven-007/` holds the synthetic dataset v2: model-visible `cases.jsonl`;
scorer-only `oracle.jsonl` (behavior is primary, context IDs are diagnostic
only), B-mechanics exposure controls, construction intent and lexical
diagnostics (never read by production code); and a hash-checked `manifest.json`.
`reviewed-v1/` preserves the superseded reviewed v1 candidate byte-for-byte and
is never used. `loadBaselineCases` returns development cases unless held-out
access is explicit; `parseAllBaselineCasesForValidation` is for validation only.
The held-out split is frozen but not secret, and it is not EXP-001
promotion-eval or final held-out data; EXP-001 is unchanged and needs its own
allocation at its later freeze. Changing the B configuration, prompt, dataset or
split requires a new version and a documented experiment change. No real-model
experiment has been run (`execution: not_run`); scripted-runtime tests are
mechanics checks, not results. `packages/context-broker` owns the AVEN-008
Context Broker, configuration `aven-008-context-broker-config-v2` (v1, commit
`630369a`, was the reviewed pre-freeze candidate, superseded after independent
review). Given an owner-scoped request (explicit `referenceTime`, task binding,
declared task labels) and transient `ContextCandidate`s from injected
`ContextSource`s, it bounds collection with a deadline and a raw resource limit,
drops recognizable foreign-owner records before owner quotas, validation,
deduplication and any statistic, deduplicates by structured identity (failing
closed on conflicts), applies eligibility (superseded, revoked, future-dated,
task-binding, explicit scope mismatch, unresolved declared restriction, maximal
negative signal, relevance floor), ranks with the unchanged pre-specified
weights over relevance (AVEN-008-owned lexical coverage, not the AVEN-007 BM25),
scope, provenance, confidence, freshness, salience and trust, applies the
negative-retrieval penalty, and returns a budgeted `ContextBundle` plus a
non-chain-of-thought trace that carries no foreign-owner information and no
request-derived strings. Source-data faults become fixed, typed errors with no
cause. Candidates reuse the frozen AVEN-002 `ContextSource`, `Provenance` and
`Scope` schemas; they are a retrieval view, not owner state. Session-wide scope
is not representable and stays deferred. The broker is read/compute-only: no
storage, Ledger, runtime, baseline, network, persistence, learning, correction
inference or authority. Its bundle is not a prompt and is not wired into the API
paths. Provider credentials, when a later milestone adds a live adapter, come
from external operator/Root configuration and are never stored in the Ledger,
owner memory, model input or runtime metadata. `packages/owner-model`
(`@aven/owner-model`, version `aven-009-owner-model-v1`) is the AVEN-009 Typed
Owner Model. It reuses the frozen AVEN-002 owner-state, provenance, scope and
lifecycle contracts rather than defining a second vocabulary and keeps the
`.gitkeep` that the AVEN-008 tripwire pins. Its root entry (five runtime
exports: version, config, error codes, `OwnerModelError`, `intakeOwnerState`)
depends only on `@aven/contracts` and `zod`. Internal modules, not exported, add
structural lineage, agreement of trusted/superseded/revoked lifecycle claims
with recorded transitions (agreement is not authenticated Root authority),
durable category views at an explicit `referenceTime` (`latestDeclared` and
`currentDeclared` are declared state, never Root's trusted-version selection),
and the active task view for one exact `(sessionId, taskId)`. The
`@aven/owner-model/persistence` subpath (`rebuildOwnerModel`, adding
`@aven/storage` and `@aven/ledger`) is a read-only rebuild: stored immutable
snapshots plus owner-bound Ledger replay through those validators, with
owner-origin provenance and owner confirmations checked against recorded events;
it synthesizes no snapshot from events and writes nothing, and its snapshot read
and Ledger replay are separate read transactions. The
`@aven/owner-model/context-source` subpath (`createOwnerModelContextSources`,
adding `@aven/context-broker`) adapts a genuine rebuilt model into four
read-only sources for the unchanged Broker under the frozen, provisional,
ordinal configuration `aven-009-owner-model-source-config-v1` (negativeRetrieval
always 0); changing it requires a new version and evidence. Package and subpath
separation is not process or security isolation. `tooling/attribution` holds the
AVEN-010 commit attribution gate (`pnpm attribution:check`); it reads commit
metadata and is not security. `packages/corrections` (`@aven/corrections`,
version `aven-010-corrections-v1`; see its README and `docs/AVEN_010_REPORT.md`)
holds AVEN-010. Its pure root entry exports the fixed `CorrectionError` and
`resolveImmediateCorrections` (immediate applicability, explicit supersession,
overlaps and exact suppression targets at an explicit `referenceTime` and
sequence boundary). The `./ledger` subpath holds `recordOwnerCorrection`, the
only AVEN-010 write (one frozen Ledger append), and the read-only
`readCorrectionHistory` and `buildCorrectionEvidenceIndex`. The
`./context-source` subpath holds `assembleWithCorrections`, which offers active
corrections to the unchanged Broker as `current_instruction` candidates,
suppresses only exact targets and returns `not_exposed` unless every instruction
is in the selected bundle. Permission corrections are deferred to Root. An
immediate override is transient task context, not owner memory, a trusted
preference or Root approval; the package learns nothing, writes no owner state
and is not wired into the API. Its synthetic benchmarks
(`packages/corrections/bench`) are diagnostic only. The inherited native-memory
risk of large synchronous storage batches needs a separate resource-readiness
gate before bulk ingestion or long-lived deployment; no maintenance of frozen
layers is authorized. `packages/action-proposals` (`@aven/action-proposals`,
version `aven-011-action-proposals-v1`; see its README and
`docs/AVEN_011_REPORT.md`) holds AVEN-011. Its pure root entry constructs,
validates, digests (protocol v1), binds and inspects frozen AVEN-002 action
proposals. The `./ledger` subpath holds `recordActionProposal`, the only
AVEN-011 write (one frozen Ledger append), the read-only
`reconcileActionProposalRecording` and the read-only `readProposalEvents`, which
classifies recorded proposal events with declared, unauthenticated origins and
unverified approval citations. A recorded proposal is never a permission,
approval or Root decision; the package decides, executes and learns nothing and
is not wired into the API. `packages/root-policy` (`@aven/root-policy`, version
`aven-012-root-policy-v1`; see its README and `docs/AVEN_012_REPORT.md`) holds
the AVEN-012 candidate. Its pure root entry validates and registers
Root-controlled policy definitions (digest protocol
`AVEN-012-ROOT-POLICY-DIGEST-V1`), revalidates AVEN-011 v1 proposals
independently, verifies approval records and evaluates to frozen AVEN-002
`PolicyDecision`s. The `./ledger` subpath holds the Root gateway (Root clock,
read-only evaluation of recorded proposals in one read snapshot),
`recordRootDecision`, the only AVEN-012 write (one frozen Ledger append of a
`policy_decision` event for a gateway-produced evaluation), and the read-only
`reconcileRootDecisionRecording`. The `./testing` subpath holds the synthetic
approval authentication capability, which authenticates nobody. A recorded
decision is never a standing permission; the package executes and learns nothing
and is not wired into the API. Other app/package directories remain
placeholders. Tooling schemas still describe experimental metadata only. No live
provider adapter or network model call, Strands or other framework adapter,
public generation route, durable owner-state writer, learning algorithms,
correction interpretation from free text, learned negative-signal generation,
routing, streaming, tool calling, real owner authentication, OS-level Root
isolation, UI, execution, scorer, promotion controller, or agent orchestration
in this milestone. Stop after each patch and report files, checks, attribution
status, assumptions, and deliberate deferrals for external review. Commit only
to the isolated milestone branch named in the current authorization section (for
AVEN-012, `aven-012/root-policy-gateway`); do not merge or tag.
