# Project Aven

Aven is a neutral, owner-agnostic, local-first personal AI agent intended to
become more useful to one owner through evidence-backed learning. The immediate
question is whether governed persistent learning can outperform a strong naive
personalization baseline while authority remains externally controlled.

**Current scope: AVEN-003 database schema, on the frozen AVEN-002 contracts
(`9c05272`, tag `aven-002`).** The
[contracts package](packages/contracts/README.md) defines schemas and types; the
[storage package](packages/storage/README.md) provides local SQLite schema,
integrity constraints, and migrations. The
[AVEN-003 report](docs/AVEN_003_REPORT.md) is ready for external review. There
is no running Aven, Ledger service, API, web app, learning engine, or Root
gateway. EXP-001 has not been run.

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

`pnpm format` formats repository text. `pnpm format:check`, `pnpm typecheck`,
`pnpm experiment:check`, and `pnpm test` can run separately. Typechecking covers
repository tooling, contracts, and storage, including compile-time ID checks.
Tests validate contract boundaries, SQLite integrity, experiment metadata, and
freeze gates; passing them is not evidence of learning quality or runtime
security.

Dependencies are pinned and locked. Strict TypeScript, Zod metadata validation,
Prettier, YAML parsing, and Vitest are available at the root. The contracts
workspace declares its pinned Zod dependency. Storage adds stable Drizzle and
better-sqlite3; its README records versions and rationale. `pnpm db:test` runs
database tests. `pnpm db:migrate` creates or migrates the ignored local
`data/aven.sqlite`; it does not record owner experience. There is no app
framework or model SDK. The setup follows the official
[pnpm workspace instructions](https://pnpm.io/workspaces),
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
  evals/         datasets, held-out, scorers, regression (placeholders)
  results/       future frozen run artifacts; no results yet
  apps/          api, web (placeholders)
  packages/      contracts, storage, ledger, owner-model, context-broker, runtime,
                 root, learning, eval, test-utils (placeholders)
  tooling/       scripts and bootstrap tests
```

`packages/contracts` and `packages/storage` are private workspace packages.
Other app/package directories remain placeholders containing `.gitkeep` only.

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

AVEN-003 stops at schema, migrations, and integrity tests. AVEN-004 and every
runtime feature remain deferred. Do not commit this milestone before review. The
AVEN-001 source summaries and experiment documents retain their historical
milestone context; the current authorization is recorded in `AGENTS.md`.
