# AVEN-002 implementation report

Date: October 4, 2026 (America/New_York).

Baseline: commit `9aa52bf`, tag `aven-001`; initial working tree was clean.
Scope: shared typed contracts only. No AVEN-003 work, commit, or tag was
created. The architecture, research hypothesis, experimental protocol, metrics,
and baseline comparison are unchanged. EXP-001 remains draft and has not been
run.

## Exact file inventory

Created (paths relative to the repository root):

```text
.gitattributes
docs/AVEN_002_REPORT.md
packages/contracts/package.json
packages/contracts/tsconfig.json
packages/contracts/README.md
packages/contracts/src/index.ts
packages/contracts/src/ids.ts
packages/contracts/src/common.ts
packages/contracts/src/provenance.ts
packages/contracts/src/scope.ts
packages/contracts/src/experience.ts
packages/contracts/src/owner-state.ts
packages/contracts/src/corrections.ts
packages/contracts/src/context.ts
packages/contracts/src/runtime.ts
packages/contracts/src/actions.ts
packages/contracts/src/policy.ts
packages/contracts/src/approvals.ts
packages/contracts/src/execution.ts
packages/contracts/src/verification.ts
packages/contracts/src/learning.ts
packages/contracts/src/evaluation.ts
packages/contracts/src/transitions.ts
packages/contracts/test/fixtures.ts
packages/contracts/test/types.ts
packages/contracts/test/boundaries.test.ts
packages/contracts/test/authority.test.ts
packages/contracts/test/learning.test.ts
packages/contracts/test/events.test.ts
```

Modified:

| Exact path         | Change                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`        | Reflect explicit AVEN-002 authorization and stop before AVEN-003; retain architecture/experiment rules. |
| `README.md`        | Current milestone, package entry point, and expanded check coverage.                                    |
| `docs/ROADMAP.md`  | AVEN-002 status and authorization boundary only.                                                        |
| `package.json`     | Description and contract-package typecheck integration.                                                 |
| `pnpm-lock.yaml`   | New workspace importer using existing pinned resolutions; no dependency upgrades.                       |
| `vitest.config.ts` | Include contract test files alongside original experiment tests.                                        |

Removed: `packages/contracts/.gitkeep`, replaced by the real workspace package.

The new `.gitattributes` uses automatic text detection and LF text endings,
marks PDFs binary, and exempts `docs/sources/**` from text conversion to
preserve source artifacts. Existing `.editorconfig` already specifies LF;
existing Prettier configuration was inspected and retained. No repository-wide
normalization was performed. Only edited/new files were formatted.

## Contract/module inventory

The [package README](../packages/contracts/README.md) documents every module and
its semantics. The public entry point exports seventeen domain/support modules:

- Identifiers; common metadata/references; provenance and evidence; scope.
- Historical experience; typed owner state; corrections; task context.
- Provider-independent model/runtime metadata.
- Action proposals; Root policy decisions; owner approvals; execution reports;
  verification results.
- Learning candidates/results; evaluation definitions/oracles/results;
  promotion/rejection/supersession/revocation/rollback records.

The three additional modules beyond the suggested layout (`approvals.ts`,
`execution.ts`, `transitions.ts`) keep distinct authority and lifecycle concerns
cohesive. No provider, storage, tool execution, or controller implementation is
included.

## Important invariants encoded

1. Domain-prefixed IDs reject wrong domains at runtime; opaque brands
   distinguish all sixteen ID types at compile time. Ordinary strings are not
   branded IDs.
2. Strict objects reject unknown fields; required metadata/scope is never
   supplied through defaults. Events/raw evidence use immutable-history record
   version 1; corrections get new historical IDs.
3. Recorded evidence is distinct from derived assertions. Seven provenance
   origins remain visible; external/tool material retains explicit trust labels.
   Direct self-derivation and embedded owner/source mismatches are rejected.
4. Corroboration requires a cited source-independence assessment and distinct
   underlying source IDs. Repeated summaries provide no automatic support score.
   Support, inference certainty, and owner confirmation remain separate.
5. Scope can be unknown, uncertain, bounded, or intentionally global. Missing
   scope cannot become global. No scope inference or matching is implemented.
6. Facts, preferences, episodes, intent patterns, and procedures have distinct
   shapes. Active task state uses task/session bounds and its own lifecycle.
7. Corrections preserve category, target, original behavior, corrected
   instruction, provenance, immediate applicability, and a separate durable
   hint.
8. Context selects references and observable inclusion metadata. Model/external
   content cannot parse as an explicit current owner instruction; inactive state
   cannot parse as active trusted guidance.
9. Proposal, policy, approval, execution, and verification remain separate
   discriminated objects. ALLOW records a grant or owner approval basis.
10. Approval/policy references carry exact proposal/version, proposal digest,
    and parameter digest. Approvals additionally require task/session bounds,
    issuance/expiry, and explicit revocation metadata when revoked.
11. Tool success does not become verification. VERIFIED requires observable
    evidence matching its declared method; model-only assessment cannot verify.
12. Candidates never implicitly become trusted state. No useful lesson is valid.
    Trusted state requires validation/candidate/promotion references; inactive
    state has explicit lineage. Self-supersession/fallback/rollback is rejected.
13. Evaluation separates oracle, provenance, actual result, scorer,
    model/config, independence assessment, and verdict. Model oracle judgments
    remain advisory; unresolved oracle/missing observation requires
    INDETERMINATE.
14. Promotion references candidate, evaluation evidence, affected trusted state,
    and an exact Root ALLOW decision. Transitions represent auditable claims;
    they do not perform promotion or authenticate Root.

## Tests added

| File                      | Coverage                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/boundaries.test.ts` | Valid parsing/round trips, strict unknown-field rejection, ID/metadata failures, provenance, repeated-source evidence, explicit scope.                                                 |
| `test/authority.test.ts`  | Proposal/policy/execution/verification separation, approval binding/expiry/revocation, explicit grant references, no predicted-intent authority, observable verification.              |
| `test/learning.test.ts`   | Typed categories/lifecycles, current corrections/context, ownership consistency, candidate/trusted separation, no lesson, all evaluation types/oracles, promotion/rollback references. |
| `test/events.test.ts`     | All fifteen historical event variants, envelope/payload/source consistency, serialization, shallow readonly envelope, no event-version updates.                                        |
| `test/types.ts`           | All 240 ordered pairs of distinct branded IDs, ordinary string rejection, domain-type separation, negative assignment and readonly checks.                                             |
| `test/fixtures.ts`        | Explicitly labeled synthetic examples; no real owner data or preferences.                                                                                                              |

All twenty requested minimum test topics are covered. Type checks run through
TypeScript; runtime tests run through Vitest. Test results are boundary
evidence, not runtime-security or learning-quality evidence.

## Command results

Final `pnpm check`: **PASS**, exit 0. This includes all applicable checks:

| Command/check                                                                                                                                                                | Final result                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                                                                                          | PASS; all matched files follow Prettier style.                                                        |
| `pnpm typecheck`                                                                                                                                                             | PASS; root tooling plus contracts and compile-time ID tests.                                          |
| `pnpm experiment:check`                                                                                                                                                      | PASS; EXP-001 is valid draft metadata, execution not run, results absent, freeze prerequisites unset. |
| `pnpm test`                                                                                                                                                                  | PASS; five test files, 167 tests total.                                                               |
| Contract runtime tests                                                                                                                                                       | PASS; 155 tests: boundaries 67, authority 19, learning 51, events 18.                                 |
| Original AVEN-001 tests                                                                                                                                                      | PASS; all twelve unchanged experiment-discipline tests.                                               |
| `pnpm check`                                                                                                                                                                 | PASS; complete sequential formatting/typecheck/experiment/test pipeline.                              |
| `git diff --check`                                                                                                                                                           | PASS; no whitespace errors.                                                                           |
| Diff against `aven-001` for experiments, tooling, principles, project description, threat model, source documents, base TypeScript config, EditorConfig, and Prettier config | Empty diff; unchanged.                                                                                |
| Domain-source scan for `any`, broad records, unknown/any schemas, and defaults                                                                                               | No matches.                                                                                           |

The standalone package test command also passed (150 tests before the final
review additions). The complete final check includes all 155 final contract
tests. An earlier complete check passed 166 tests before the last ownership
regression case was added. All checks used the existing pinned Node/pnpm/tooling
versions; no experiment, performance evaluation, or runtime-security test ran.

Recovered setup/check failures:

- A store flag used with the typecheck script was rejected as an unsupported
  pnpm run option; after installation, the normal `pnpm typecheck` command
  passed.

- Default/offline pnpm installation initially encountered the existing local
  store configuration and unavailable offline peer metadata. The new lockfile
  importer reuses exact existing resolutions. Installation succeeded with
  `pnpm install --store-dir .tooling-cache/pnpm-store --frozen-lockfile --ignore-scripts`.
  Registry metadata verification required an approved network-capable run; pnpm
  verified all 97 lockfile entries against supply-chain policies.
- A package test script initially resolved the root configuration incorrectly;
  its root-relative config path was corrected. Vitest/esbuild also needed an
  approved run outside the filesystem sandbox to load repository configuration.
- The first format check found unformatted new files. The pinned local Prettier
  CLI formatted only the changed files. `pnpm exec prettier` was unavailable in
  this shell, so `node node_modules/prettier/bin/prettier.cjs --write ...` was
  used.
- Direct strict TypeScript checks passed throughout. No runtime test assertion
  failed in the completed test runs.
- The initial PDF text extraction hit Windows console encoding; UTF-8 extraction
  succeeded. All fifteen pages and the requested repository sources were read.

## Adversarial self-review

Reviewed every requested distinction against schemas, documentation, and
negative tests. The review added source/owner consistency checks, self-lineage
rejections, verification-method/evidence agreement, and an explicit distinction
between auditing a denied execution and authorizing it. It also removed an
unused evaluation-test reference abstraction.

No `any`, `Record<string, unknown>`, generic core blobs, schema defaults,
provider SDK, database types, or execution/promotion functions occur in domain
schemas. Runtime metadata uses provider/model names as identifiers only.
Immutable parameter references avoid inventing a generic tool schema catalog.

Remaining practical limits are explicit: a schema can validate a claimed Root
issuer, trusted lifecycle, owner provenance, digest, oracle, or verification
result without proving it genuine. Reference resolution and stored-state checks
must later authenticate owners/Root, compare exact bindings, verify artifacts,
resolve lineage/taint, enforce evaluator independence and protected splits,
reject stale approvals, and protect writes. No parse result is an executable
capability. Shallow event freezing is not append-only storage.

The contracts do not prove factual truth, correct scope inference, calibrated
confidence, retrieval quality, learning quality, policy security, execution
correctness, verification correctness, or AI safety.

## Unresolved questions, assumptions, and deferrals

Unresolved: semantic scope inference/matching; trust and source-independence
assessment; oracle choice/disagreement; evaluation/promotion thresholds; owner
authentication; canonical hashing; immutable parameter storage; grant, expiry
and replay enforcement; Root topology/isolation; reference integrity; protected
evaluation access; retention/erasure; model-swap compatibility.

Implementation assumptions are representational choices: private ESM TypeScript
source exports under the existing Node.js 24 toolchain; branded prefixed string
IDs; schema version 1; per-record positive integer versions; ISO offset-aware
timestamps; opaque artifact locators plus SHA-256 digests; categorical evidence
signals; task-bound active state; immutable parameter references; completed
execution reports; evaluation snapshots preserving their declared oracle.

Deliberately deferred: SQLite/database schema, Experience Ledger persistence,
Context Broker retrieval, learning algorithms, model adapters, Root enforcement,
API routes, frontend UI, actual tool execution, promotion controller, runtime
orchestration, and every AVEN-003-or-later milestone.

Architecture change proposals: **none**. No frozen architectural or experimental
meaning needed to change to complete AVEN-002. The unresolved architectural
decisions remain unresolved rather than being silently chosen.
