# Repository inspection and AVEN-001 decisions

Inspection date: 2026-10-04 (America/New_York). Working directory: the selected
PROJECT AVEN desktop workspace. Inspection completed before source edits.

## Existing tree

All 61 existing files were inventoried recursively, including hidden files. Text
files were classified from contents/openings and relevant design material was
read. No existing runtime or code package was found. Historical research was not
reopened as a project-selection exercise.

```text
AVEN_PROJECT_DECISION_2026-10-01.md
FINAL_PROJECT_SEARCH_2026-10-02.md
FINAL_SEARCH_PROBLEM_ATLAS_2026-10-02.md
FINAL_SEARCH_SCORECARDS_2026-10-02.md
research-final-search/accessibility-deep.txt
research-final-search/additional-prior-art-0.txt
research-final-search/additional-prior-art-1.txt
research-final-search/agent-security-deep.txt
research-final-search/assurance-precedent.txt
research-final-search/atlas-source-check.txt
research-final-search/c-migration-detail.txt
research-final-search/citation-audit-0.txt
research-final-search/citation-audit-1.txt
research-final-search/citation-audit-2.txt
research-final-search/clinical-workflows.txt
research-final-search/concurrency.txt
research-final-search/db-network.txt
research-final-search/education-energy.txt
research-final-search/evaluation-education.txt
research-final-search/finance.txt
research-final-search/gpu-kill.txt
research-final-search/gpu-verification.txt
research-final-search/health-semantic.txt
research-final-search/human-access.txt
research-final-search/incidents.txt
research-final-search/integrity.txt
research-final-search/internet-identity.txt
research-final-search/kernel-detail.txt
research-final-search/memory-safety.txt
research-final-search/migration-boundaries.txt
research-final-search/migration-prior-art.txt
research-final-search/migration-proof.txt
research-final-search/nontech-domains.txt
research-final-search/numerical-adversarial.txt
research-final-search/numerical-tools.txt
research-final-search/numerics.txt
research-final-search/other-compute.txt
research-final-search/predecessor-status.txt
research-final-search/privacy-collaboration.txt
research-final-search/privacy.txt
research-final-search/public-services.txt
research-final-search/real-migrations.txt
research-final-search/recovery-detail.txt
research-final-search/recovery-gap.txt
research-final-search/recovery-prior-art.txt
research-final-search/recovery-research.txt
research-final-search/remaining-evidence.txt
research-final-search/reproducibility-data.txt
research-final-search/required-candidates.txt
research-final-search/safe-migration-products.txt
research-final-search/semantic-health-products.txt
research-final-search/semantic-runtime-deep.txt
research-final-search/state-data.txt
research-final-search/systems-a.txt
research-final-search/systems-b.txt
research-final-search/top15-completion.txt
research-final-search/verification.txt
tmp/pdfs/blackbook-review.png
tmp/pdfs/blackbook.txt
tmp/pdfs/catalogue-review.png
tmp/pdfs/catalogue.txt
```

Counts: 4 Markdown documents, 53 research text files, 2 PDF-extraction text
files, and 2 rendered PNGs (61 total). Original per-file sizes and SHA-256
hashes are in
[sources/workspace-inventory.json](sources/workspace-inventory.json).

## Package/tooling present before edits

No Git repository, package manifest, lockfile, workspace file, TypeScript
config, AGENTS.md, application source, or tests in the selected workspace. No
inherited AGENTS.md was found in its ancestor directories. Installed tools
observed: Node 24.19.0, pnpm 11.19.0, npm 11.17.0, Git, and bundled
Python/pypdf.

A separate older scaffold exists in OneDrive Documents/aven, and Downloads has
aven-AVEN-001.zip. Those contain TypeScript package shells, principles, boundary
checks and ADRs. They were inspected read-only, not copied into this repository.
The old shells use context/evals/tools names and older milestone assumptions.

## Conflicts and preservation

AVEN_PROJECT_DECISION_2026-10-01.md recommends TenantScope; the final 2026-10-02
search recommends SafeShift. These are superseded historical selection records,
not current instructions. Preserve the entire research corpus and scratch PDFs
in place. No existing application conflicts with Aven because none is present
here. The older external scaffold's useful neutrality, A/B/C, provenance, and
two-speed correction concepts are already supported by the new authoritative
sources. Its implementation shells and speculative Root dependency rule are not
imported.

## Authoritative sources read completely

- Master Project Description: all 15 pages, prepared 2026-10-03. SHA-256:
  D76E014F1A0A10364BBE1BBFDFE74CD4188810B3EB45A66F74AEEB2A932AE446.
- AVEN — IMPLEMENTATION INSTRUCTIONS.txt: complete 28-section text. SHA-256:
  3D8CAD37688476E0F9C0501D9A597A8B2EC038E490F8C9219C5B385BDE159EC4. Its (1)
  duplicate has the same hash.

Both source files are preserved in docs/sources/. Newer-source conflict
resolutions: C must beat B rather than merely A; AVEN-007 is the naive
baseline/dataset rather than a Strands adapter; AVEN-010 is corrections/session
override; later milestone IDs follow Master section 19. No architectural change
was necessary.

## Bootstrap decisions and assumptions

- Create a nested aven/ repository and leave historical research and the
  external scaffold untouched. This interprets the requested aven/ tree
  literally without moving or overwriting existing work. Git has no remote or
  commit yet.
- App/package directories contain .gitkeep only, with the requested names. pnpm
  does not need package manifests in empty directories; only the root is
  installed.
- Strict TypeScript checks repository tooling; Zod validates experimental
  metadata, YAML parses the manifest, Prettier formats text, and Vitest
  exercises discipline gates. These are not business contracts, a runtime, or
  security enforcement.
- Pin tool dependencies and pnpm for reproducibility. Node 24 is the initial
  supported runtime; TypeScript 5.9.3 and Vitest 4.0.18 are verified stable
  versions, avoiding an unnecessary compiler/test-runner major migration in this
  foundation.
- SQLite is the initial future storage preference. No
  database/provider/framework is installed or selected. Local-first storage is
  not an offline-model promise.
- EXP-001 remains draft/not_run with null results and unset freeze artifacts. A
  25-100 base-scenario feasibility target, 50/25/25 split, >=15 point C-vs-B
  materiality gate with paired uncertainty, >=85% completion, and equal-or-lower
  C supervision minutes are proposed operational choices grounded in the Master
  targets. They are not approved frozen metrics or empirical outcomes.
- Baseline tuning/model/tool/policy parity, final held-out protection,
  independent evaluation, group-aware splits, and effort/cost accounting are
  explicit. Freeze validation checks metadata completeness, not truth or actual
  access enforcement.

## Deliberate deferrals

Every milestone AVEN-002 onward: shared contracts, SQLite schema/ledger,
API/web, model adapters, B implementation/dataset, owner state/context
retrieval, correction handling, action proposals/Root policy, tool/verifier,
learning/eval/shadow/promotion, rollback and model swap. Also Root process
topology, real eval-vault protection, scope/oracle representation,
privacy/erasure, model choice, study budgets and scoring implementation. No
voice/telephony, swarms, broad control, affect/consciousness, self-preservation,
production self-modification, integrations, billing or scaling.

## Verification

Dependency installation completed with lifecycle scripts disabled and generated
`pnpm-lock.yaml`. Formatting, strict tooling typecheck, draft manifest
validation, and all 12 Vitest metadata/freeze-discipline tests passed. Vitest
initially could not read ancestor directories through the filesystem sandbox;
the same tests passed with an approved execution outside that sandbox. This was
an environment restriction, not evidence of an Aven control boundary.

All 61 original files matched their pre-edit SHA-256 hashes. Copied
authoritative sources matched the hashes above. Local Markdown links resolved.
Apps/packages contain no TypeScript or package manifests. Git was initialized on
`main`; no remote or commit was created. No experiment has run, and no progress
beyond AVEN-001 is claimed. The final combined `pnpm check` is run after this
report edit.

## Files created and changed

All 50 files below are new in `aven/`; no pre-existing file was changed.
Dependency installations, ignored caches, and Git internals are not source
files.

```text
.editorconfig
.gitignore
.prettierignore
.prettierrc.json
AGENTS.md
README.md
apps/api/.gitkeep
apps/web/.gitkeep
decisions/README.md
docs/AVEN_PRINCIPLES.md
docs/BACKLOG_FUTURE.md
docs/PRODUCT_THESIS.md
docs/PROJECT_DESCRIPTION.md
docs/REPOSITORY_INSPECTION.md
docs/RISK_REGISTER.md
docs/ROADMAP.md
docs/THREAT_MODEL.md
docs/USER_RESEARCH.md
docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt
docs/sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf
docs/sources/README.md
docs/sources/workspace-inventory.json
evals/README.md
evals/datasets/.gitkeep
evals/held-out/.gitkeep
evals/regression/.gitkeep
evals/scorers/.gitkeep
experiments/EXP-001/hypothesis.md
experiments/EXP-001/manifest.yaml
experiments/EXP-001/protocol.md
experiments/README.md
package.json
packages/context-broker/.gitkeep
packages/contracts/.gitkeep
packages/eval/.gitkeep
packages/learning/.gitkeep
packages/ledger/.gitkeep
packages/owner-model/.gitkeep
packages/root/.gitkeep
packages/runtime/.gitkeep
packages/test-utils/.gitkeep
pnpm-lock.yaml
pnpm-workspace.yaml
results/README.md
tooling/scripts/check-experiment.ts
tooling/scripts/experiment-schema.ts
tooling/tests/experiment-manifest.test.ts
tsconfig.base.json
tsconfig.json
vitest.config.ts
```
