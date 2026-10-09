# Working on Aven

## Authority and scope

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

Accepted design (independent review): one new package, `packages/corrections`
(`@aven/corrections`); every frozen layer stays byte-identical. Patches, each a
single reviewed commit:

1. Reconciliation of `AGENTS.md`, `docs/ROADMAP.md` and `README.md`, and the
   commit attribution gate (`tooling/attribution/`, `pnpm attribution:check`).
   **Current patch.**
2. Package scaffold, fixed errors, and the AVEN-010 frozen-layer tripwire inside
   the package (the AVEN-009 tripwire forbids additions to `tooling/tests`).
3. Correction recorder: the only AVEN-010 write, one atomic Ledger
   `owner_correction` append through the frozen Ledger and storage.
4. Pure immediate-override resolver.
5. Read-only Ledger correction history and correction-evidence index.
6. Context Broker integration: current-instruction source, exact-target
   suppression wrapper and exposure verification.
7. Cross-layer adversarial, restart, mutation and performance campaign.
8. AVEN-010 report and documentation.

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
  lifecycle-claim, view, rebuild and context-source mechanics, and the AVEN-010
  commit attribution rules on synthetic Git repositories, all on synthetic data,
  not a complete Aven runtime. Run `pnpm attribution:check` before every push.
  Report limitations honestly.
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
metadata and is not security. Other app/package directories remain placeholders.
Tooling schemas still describe experimental metadata only. No correction
recording, override resolution or correction context source exists yet; they
arrive only in later authorized AVEN-010 patches. No live provider adapter or
network model call, Strands or other framework adapter, public generation route,
durable owner-state writer, learning algorithms, correction interpretation from
free text, learned negative-signal generation, routing, streaming, tool calling,
Root enforcement, authentication, UI, execution, scorer, promotion controller,
or agent orchestration in this milestone. Stop after each patch and report
files, checks, attribution status, assumptions, and deliberate deferrals for
external review. Commit only to the isolated AVEN-010 branch; do not merge or
tag.
