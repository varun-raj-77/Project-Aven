# Project Aven

Aven is a neutral, owner-agnostic, local-first personal AI agent intended to
become more useful to one owner through evidence-backed learning. The immediate
question is whether governed persistent learning can outperform a strong naive
personalization baseline while authority remains externally controlled.

**Current scope: AVEN-009 Typed Owner Model, in progress on frozen AVEN-008
(`4174080`, tag `aven-008`).** The
[contracts package](packages/contracts/README.md) defines schemas and types; the
[storage package](packages/storage/README.md) provides local SQLite schema,
integrity constraints, and migrations. The
[Ledger package](packages/ledger/README.md) adds atomic historical recording,
owner-bound reads, observational replay, and integrity inspection. The
[API app](apps/api/README.md) adds a loopback HTTP boundary for owner-scoped
sessions, task identities, owner messages recorded through the Ledger, and
session history. The [runtime package](packages/runtime/README.md) adds a
provider-neutral, replaceable `ModelRuntime` boundary with a deterministic
test-only runtime, and the API app adds a separate in-process recorder that
stores successful model output as `assistant_response` with `model_inference`
provenance. The [baseline package](packages/baseline/README.md) adds the A
(Fresh) and B (Naive Personalized: editable profile plus deterministic lexical
history search) conditions over that runtime, and
[`evals/aven-007/`](evals/aven-007/README.md) holds a 64-case synthetic dataset
(version 2, after independent review; the reviewed v1 is archived unchanged)
with a scorer-only oracle. The
[Context Broker package](packages/context-broker/README.md) adds deterministic,
owner-scoped, budgeted task-context assembly over injected transient candidate
sources, with an observable trace; it is read/compute-only and not a prompt,
owner memory or authority. **There is no real provider adapter, no network model
call, no HTTP route that generates a response, and no experimental result: the
dataset's execution status is `not_run`.** The
[AVEN-008 report](docs/AVEN_008_REPORT.md) (configuration v2, after independent
review) is frozen at tag `aven-008`. The
[owner-model package](packages/owner-model) currently contains only the AVEN-009
scaffold (version, error and boundary guardrails); it has no owner-state
behavior yet. There is no web app, correction engine, learning engine, scorer,
authentication, or Root gateway. EXP-001 has not been run.

## Start here

- [Project description and source precedence](docs/PROJECT_DESCRIPTION.md)
- [Principles](docs/AVEN_PRINCIPLES.md)
- [Repository inspection](docs/REPOSITORY_INSPECTION.md)
- [Threat model](docs/THREAT_MODEL.md)
- [EXP-001 hypothesis](experiments/EXP-001/hypothesis.md),
  [manifest](experiments/EXP-001/manifest.yaml), and
  [protocol](experiments/EXP-001/protocol.md)
- [Roadmap](docs/ROADMAP.md) and [future backlog](docs/BACKLOG_FUTURE.md)

The Master Project Description dated 2026-10-03 overrides conflicting older
implementation instructions. Both are preserved in `docs/sources/`. Earlier
project-selection research remains untouched in the parent workspace and is not
the current build directive.

## Setup and checks

Use Node.js 24 and pnpm 11.19.0 (pinned in `package.json`). A local pnpm
installation or Corepack can select that version. No model account or
credentials are needed.

```sh
cd aven
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

If `pnpm` is not on `PATH`, prefix each command with `corepack` (for example
`corepack pnpm check`). Root scripts call the pinned tools directly and never
invoke a nested `pnpm`.

`pnpm format` formats repository text. `pnpm format:check`, `pnpm typecheck`,
`pnpm experiment:check`, and `pnpm test` can run separately. Typechecking covers
repository tooling, contracts, storage, Ledger, runtime, baseline, Context
Broker, owner model, and the API app, including compile-time API checks. Tests
validate contract boundaries, SQLite and Ledger integrity, experiment metadata,
and freeze gates; passing them is not evidence of learning quality or runtime
security.

Dependencies are pinned and locked. Strict TypeScript, Zod metadata validation,
Prettier, YAML parsing, and Vitest are available at the root. The contracts
workspace declares its pinned Zod dependency. Storage adds stable Drizzle and
better-sqlite3; its README records versions and rationale. `pnpm db:test` runs
database tests; `pnpm --filter @aven/ledger test` runs Ledger tests;
`pnpm --filter @aven/runtime test` runs runtime-boundary tests;
`pnpm --filter @aven/baseline test` runs baseline tests;
`pnpm --filter @aven/context-broker test` runs Context Broker tests;
`pnpm dataset:check` validates the frozen AVEN-007 dataset against its manifest.
`pnpm db:migrate` creates or migrates the ignored local `data/aven.sqlite`; it
does not record owner experience. `pnpm api:start --owner owner_local` declares
a local owner and serves the AVEN-005 API on `127.0.0.1:4317` (loopback only);
`pnpm --filter @aven/api test` runs its tests. The API uses Node's built-in
`http` module. There is no app framework or model/provider SDK. The setup
follows the official [pnpm workspace instructions](https://pnpm.io/workspaces),
[TypeScript strict configuration](https://www.typescriptlang.org/tsconfig/strict.html),
[Vitest guide](https://vitest.dev/guide/), and
[Zod documentation](https://zod.dev/).

## Intended structure

```text
aven/
  AGENTS.md, README.md, package.json, pnpm-workspace.yaml, tsconfig.base.json
  docs/          principles, project, threat/product/research/risk/roadmap/backlog
  decisions/     evidence-backed architecture decision records
  experiments/   hypotheses and pre-specified protocols
  evals/         aven-007 (synthetic A/B dataset v2 + archived reviewed v1); datasets, held-out,
                 scorers, regression (placeholders)
  results/       future frozen run artifacts; no results yet
  apps/          api (AVEN-005 local session API + AVEN-006 response recorder),
                 web (placeholder)
  packages/      contracts, storage, ledger, runtime (AVEN-006), baseline
                 (AVEN-007), context-broker (AVEN-008), owner-model
                 (AVEN-009, scaffold); root, learning, eval, test-utils
                 (placeholders)
  tooling/       scripts and bootstrap tests
```

`packages/contracts`, `packages/storage`, `packages/ledger`, `packages/runtime`,
`packages/baseline`, `packages/context-broker`, `packages/owner-model`, and
`apps/api` are private workspace packages. Other app/package directories remain
placeholders containing `.gitkeep` only.

## Experiment and authority

Fast loop: intent -> context -> plan -> policy -> execution -> verification ->
response. Experience is recorded for the separate slow loop: observation ->
hypothesis -> evidence/counterexamples -> replay -> held-out evaluation ->
promotion/shadow/rejection -> monitoring/rollback. Aven proposes actions; Root
decides.

EXP-001 preserves A (Fresh), B (Naive Personalized: editable scoped profile and
searchable history), and C (Governed Learned Aven). C must justify its
complexity against B. Proposed thresholds are draft working targets, not
measured outcomes or universal safety standards. Freezing the protocol requires
later dataset, model, evaluator, policy, and split hashes.

Local-first is a storage/ownership preference, not a claim of offline model
execution. Provider choice and any future remote transfer of owner context
require an explicit privacy decision. Do not put private data or credentials in
this repo.

AVEN-005 stops at the local session/message/history boundary. Owner identity is
declared, not authenticated, and accepting a message authorizes nothing.
AVEN-006 adds only the replaceable runtime boundary and the model-output
recording path; model output is data, never owner input, permission, or learned
state. AVEN-007 adds only the A/B baselines and the frozen dataset; the held-out
split is frozen but not secret. AVEN-008 adds only the Context Broker: transient
task context selected from injected candidate sources, with no persistence,
learning, correction handling or permission decision. AVEN-008 is frozen at tag
`aven-008`. AVEN-009 (Typed Owner Model) is being implemented patch by patch on
an isolated candidate branch, unmerged and untagged, pending external review;
AVEN-010 and later work remain deferred. The AVEN-001 source summaries and
experiment documents retain their historical milestone context; the current
authorization is recorded in `AGENTS.md`.
