# AVEN-003 implementation report

Date: October 4, 2026 (America/New_York).

AVEN-003 implements SQLite schema, owner/version/trust/provenance/lineage
integrity, contract serialization and migrations. It is submitted for external
review, **uncommitted**. AVEN-004 has not been started. No Ledger service,
domain append/write API, retrieval, learning, execution, or runtime was added.

Baseline verified before editing: clean `main`, tracking `origin/main`, at
`9c05272712f4bb072d8d16064a10a2439ad59e54` (`aven-002`). Live `git ls-remote`
confirmed that same remote main/tag; `aven-001` remains
`9aa52bf816f9061ffeead76e30b6271109e10f91`. No branch, commit, tag, or push was
created. The older AVEN-002 authorization in AGENTS was superseded by the
current explicit request.

The requested doctrine, AVEN-002 source/tests, both architecture source
documents, and EXP-001 hypothesis/protocol were read before implementation. The
source PDF was read using the PDF skill's extraction workflow. No source
document was edited.

## 1. Exact files created

Paths are relative to the repository root:

```text
docs/AVEN_003_REPORT.md
packages/storage/package.json
packages/storage/tsconfig.json
packages/storage/README.md
packages/storage/migrations/0001_storage.sql
packages/storage/src/index.ts
packages/storage/src/connection.ts
packages/storage/src/migrate.ts
packages/storage/src/migrate-cli.ts
packages/storage/src/serialization.ts
packages/storage/src/references.ts
packages/storage/src/schema.ts
packages/storage/test/fixtures.ts
packages/storage/test/migrations.test.ts
packages/storage/test/schema.test.ts
```

The migration smoke test also created ignored `data/aven.sqlite`, containing
schema only and no owner records. Temporary synthetic databases were removed
after tests. Ignored authoring scratch files live under `.tooling-cache/aven003`
and are not required by the package or migration workflow.

## 2. Exact files modified

| File               | Change                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `.gitignore`       | Ignore runtime `data/` and SQLite rollback-journal extensions; existing DB/WAL/SHM rules retained.                 |
| `.prettierignore`  | Exclude local runtime `data/`.                                                                                     |
| `AGENTS.md`        | Record explicit AVEN-003 scope, storage boundary, external-review/no-commit requirement, and stop before AVEN-004. |
| `README.md`        | Current milestone, storage documentation, local migration/test commands and limits.                                |
| `docs/ROADMAP.md`  | AVEN-003 status/authorization only; other milestone meaning unchanged. Table spacing was formatted.                |
| `package.json`     | Storage typecheck integration, `db:test`, `db:migrate`, native Vitest config loader, milestone description.        |
| `pnpm-lock.yaml`   | New workspace importer and four new registry package resolutions; existing resolutions unchanged.                  |
| `vitest.config.ts` | Include workspace package tests alongside the existing bootstrap tests.                                            |

No files removed. `packages/ledger`, contracts, and frozen experiment artifacts
are unchanged.

## 3. Dependencies and structural proposal

The small structural proposal was reported before implementation:
`packages/storage` owns shared database structure, while Ledger service behavior
remains in the future `packages/ledger`. This is a package addition, not a new
logical architectural component or a repurposing of Ledger.

The selected versions were verified using official npm metadata before adding
dependencies:

| Dependency              | Version           | Reason                                                                                   |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `drizzle-orm`           | 0.45.3            | Stable typed SQLite query integration and serialization adapters.                        |
| `better-sqlite3`        | 13.0.3            | Local driver supported by stable Drizzle and Node >=22; tested on existing Node 24.19.0. |
| `@types/better-sqlite3` | 9.6.0             | Strict driver typechecking.                                                              |
| `node-addon-api`        | 8.9.2, transitive | Required by the native driver, locked through pnpm.                                      |

The workspace also declares existing `@aven/contracts`, Zod 4.6.5, TypeScript
5.9.3 and Vitest 4.0.18. No versions of existing packages were upgraded. The
driver's packaged native binary works with `--ignore-scripts`; no native build,
new global tool, or external infrastructure was needed. SQLite reports 3.53.4.

Drizzle's current `node:sqlite` integration requires its RC line. Stable
Drizzle/better-sqlite3 therefore integrates more cleanly with the requested
stable stack. Drizzle Kit would add no necessary guarantee to this SQL-first
milestone and was not installed. Metadata and primary documentation links are in
the
[storage README](../packages/storage/README.md#structural-proposal-and-stack).

## 4. Schema/table inventory

There are **21 application tables**, plus SQLite's internal `sqlite_sequence`:

| Family                         | Tables                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Explicit identity              | `owners`, `sessions`, `tasks`                                                                        |
| Canonical history and evidence | `experience_events`, `evidence`                                                                      |
| Separate derived state         | `learned_owner_state`, `active_task_state`                                                           |
| Candidate/outcome              | `learning_candidates`, `no_useful_lessons`                                                           |
| Corrections                    | `corrections`                                                                                        |
| Authority stages               | `action_proposals`, `policy_decisions`, `owner_approvals`, `tool_executions`, `verification_results` |
| Evaluation/lineage             | `evaluations`, `lifecycle_records`                                                                   |
| Referential metadata           | `record_keys`, `record_versions`, `record_references`                                                |
| Migration history              | `schema_migrations`                                                                                  |

Four `latest_*` views expose the latest declared state/task/candidate/approval
snapshot, including inactive statuses. `record_snapshots` is a validation-only
union view. It stores no domain data. The catalogs contain only identity/version
metadata and normalized edges, not one giant JSON/event store.

The
[full inventory and relationship map](../packages/storage/README.md#table-inventory)
document every table, queryable projection, and relationship. State preserves
fact, preference, episode, intent pattern and procedure categories; active task
state is separate. Evaluation definitions/oracles are embedded snapshots as in
AVEN-002 rather than a separately invented global definition registry.

## 5. Relational/integrity design

Each snapshot has immutable `record_json`, with non-null physically stored
generated owner/ID/version/schema fields. Integrity-critical scope, category,
status, source kind, authority digests and bindings have SQL columns. Generated
columns prevent disagreement with JSON, while AVEN-002 Zod validation runs both
at serialization boundaries and in SQLite CHECK constraints. No independent SQL
domain model was introduced.

All nested recognized references are projected into relational edges in the same
statement. Composite FKs bind owners and exact versions, evidence/event pairs,
task/session pairs, proposals/digests, approval bounds, and referenced policy
outcome. This also covers authority bindings nested in raw event payloads. Known
learning-transition event pointers enforce event type.

Catalog entries require actual typed snapshots. An edge must match a reference
in its source snapshot, so independently editing a duplicate projection cannot
invent a relationship. All snapshot/catalog/edge UPDATE and DELETE attempts are
blocked, and duplicate insert guards block replacement/UPSERT overwrite. New
derived/candidate/approval versions remain separate rows. Unversioned
policy/execution/verification references resolve immutable identities.

Candidates do not become trusted state merely by existing. ALLOW does not create
execution, execution success does not create verification, and recording a
transition performs no promotion. Execution after DENY remains auditable.
Relationships are integrity claims, not permission to act.

## 6. Migration design

`0001_storage.sql` is the checked-in authoritative artifact. The migration
runner uses a writer transaction (`BEGIN IMMEDIATE`), contiguous numbered files,
SHA-256 history, `user_version`, and a pre-commit FK check. Unknown or changed
history is rejected; failed migrations roll back. A clean database migrates from
zero, and repeat application is a no-op.

Drizzle maps queries; it does not push DDL. The versioned SQLite Zod/reference
functions are part of the migration compatibility contract. Future changes must
retain v1 semantics and add explicit versioned migrations/validators. SQL
checksums alone do not detect changes to those functions. Generic SQLite tools
can read the database but need the registered functions to write through its
checks. This tradeoff is documented, not hidden.

## 7. Event ordering and append-only decision

Each event receives a database-local AUTOINCREMENT sequence, separate from its
stable ID and timestamps. Replay order is owner-filtered ascending sequence.
Gaps are permitted; failed transaction values may be reused. Explicit values
must exceed both the committed high-water mark and existing rows, including
earlier rows in the same INSERT. No distributed causal order is claimed.

UPDATE/DELETE/replacement prevention belongs in AVEN-003 as **schema integrity**
and is implemented for events/evidence and versioned snapshots. This does not
implement the AVEN-004 Ledger service, append/write API, complete capture,
transaction assembly, replay/rebuild, or tamper-resistant audit infrastructure.

## 8. JSON-column rationale

There is one JSON column per snapshot family, `record_json`, and none in the
identity catalogs or reference table. The
[JSON inventory](../packages/storage/README.md#json-policy-and-validation)
individually documents all fourteen occurrences. The payload retains typed
content, scope qualifiers, recorded text/artifact locators, model/runtime
stamps, assessment details, reasons, oracles, and exact historical
serialization.

Relational columns and edges retain every integrity-critical ID/reference, scope
kind, category, status, binding and key lineage path. Scope is validated using
AVEN-002; unknown/uncertain/bounded/global are explicit and no missing scope
becomes global. Deeper qualifier decomposition is deferred because no semantic
matching/ontology guarantee exists in v0.1.

## 9. Owner isolation

Owners are explicit and not hard-coded. IDs are unique within owner and record
kind; versioned keys also bind record version. Every owner-scoped FK includes
the owner. Nested declared owner IDs must agree, and IDs inside scope/evidence/
authority references are checked against the same owner's records. Negative
tests cover all fourteen snapshot families.

`openStorage` explicitly enables/verifies foreign keys and enables recursive
triggers on each connection. This prevents accidental cross-owner references
with the intact configured schema. It is **not complete multi-tenant security**,
authenticated identity, access control, or protection against an actor able to
change the database schema/functions/file or disable constraints.

## 10. Deletion/erasure posture

Every FK uses RESTRICT for update/delete; none cascades or nulls historical
lineage. Snapshots and edges also reject deletion directly. Unreferenced empty
identity rows are ordinary identity metadata, not historical evidence.

Owner erasure remains unresolved. Audit preservation conflicts with deletion,
including copies/backups. Retention, tombstones, redaction, cryptographic
erasure, export and deletion workflows require later design. AVEN-003 does not
pretend to solve them.

## 11. Tests and command results

Final `pnpm check`: **PASS**, exit 0. Seven test files, **240 tests**: 73
storage tests, 155 unchanged contract tests, and 12 unchanged AVEN-001 tests.

| Command/check                                                                                     | Result                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stable dependency metadata / initial install                                                      | PASS; official npm metadata, normal pnpm lock workflow, scripts disabled.                                                                                                            |
| `pnpm install --offline --store-dir .tooling-cache/pnpm-store --frozen-lockfile --ignore-scripts` | PASS; already up to date, no lockfile changes.                                                                                                                                       |
| `pnpm format:check`                                                                               | PASS, all matched files.                                                                                                                                                             |
| `pnpm typecheck`                                                                                  | PASS; root tooling, contracts including ID type tests, and storage.                                                                                                                  |
| `pnpm experiment:check`                                                                           | PASS; valid draft, execution not run, results absent, freeze prerequisites unset.                                                                                                    |
| Database tests                                                                                    | PASS; 73 tests in the final full check.                                                                                                                                              |
| Contract tests                                                                                    | PASS; all 155 unchanged tests.                                                                                                                                                       |
| AVEN-001 tests                                                                                    | PASS; all 12 unchanged experiment-discipline tests.                                                                                                                                  |
| `pnpm test`                                                                                       | PASS; 240 tests using the native config loader.                                                                                                                                      |
| `pnpm db:migrate`                                                                                 | PASS; created schema-only ignored `data/aven.sqlite`.                                                                                                                                |
| `git check-ignore` DB/WAL/SHM/journal                                                             | PASS; all four paths ignored.                                                                                                                                                        |
| `pnpm check`                                                                                      | PASS; complete sequential formatting/typecheck/experiment/test pipeline.                                                                                                             |
| `git diff --check`                                                                                | PASS; no whitespace errors.                                                                                                                                                          |
| Frozen-content comparison against `aven-002`                                                      | PASS; empty diff for experiments, tooling, contracts, principles, project description, threat model, sources, base TS config, EditorConfig, Prettier config, and Ledger placeholder. |

The final standalone `pnpm db:test` command also passed all 73 storage tests.
Tracked diffs and all new files passed whitespace checks (new files were checked
against an empty file with `git diff --no-index --check`). The default config
loader initially failed before running tests because esbuild inspected parent
directories outside the Windows filesystem sandbox. Vitest's supported native
loader passed within the workspace, so root and storage commands now use it with
existing Node 24 TypeScript support. Contract sources and test definitions are
unchanged. Initial storage typecheck diagnostics about Zod union selection and
driver PRAGMA typing were corrected.

A network-enabled final dependency recheck was not executed: automatic approval
review could not complete because of an account usage limit, not an
unsafe-action determination. The safer offline frozen-lockfile recheck then
succeeded entirely inside the workspace. No final validation remains blocked.

Coverage against the requested minimum:

| Requested check | Concrete test coverage                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2, 20        | Empty DB migration, explicit FK/recursive-trigger PRAGMAs, file close/reopen and continued ordering.                                   |
| 3, 4, 5         | Identity persistence, cross-owner negative matrix for every snapshot family, duplicate identities/versions.                            |
| 6, 7, 8         | Raw SQL invalid lifecycle/version/JSON checks; absent/null scope rejection; all four scope variants.                                   |
| 9, 22           | Candidates, no-lesson and active task state cannot parse/persist as durable state or appear in latest trusted-state queries.           |
| 10              | Correction stores new event/evidence; original event serialization remains equal; no derived state is automatically created.           |
| 11, 12, 13      | All five authority tables round trip separately; exact version/digest/bounds checks; success leaves verification empty.                |
| 14, 15, 16      | Seven origins, declared trust, source-independence metadata, model derivation and root-source edges round trip.                        |
| 17              | Promotion/supersession/revocation/rollback records and version links; latest inactive state does not surface historical trusted state. |
| 18              | Equal/reversed timestamps, committed sequence order, backwards explicit multi-row inserts and failed transaction rollback.             |
| 19              | Referenced identity/history/lineage deletion fails; every FK is inspected for RESTRICT.                                                |
| 21              | AVEN-002 parsing at encode/decode and SQLite CHECK boundaries, typed Drizzle round trips and unchanged contract tests.                 |

Additional tests cover migration idempotence/tampered history/rollback, phantom
catalog entries, fabricated edges, generated-column tampering, direct SQL
mutation/REPLACE/UPSERT, correct transition event type, nested approval bounds,
Drizzle mapping drift, all oracle variants, and audit records after DENY. These
are storage/contract tests, not empirical learning or security results.

## 12. Adversarial review findings

Fixed at the AVEN-003 level:

1. A JSON reference could otherwise be omitted from a hand-maintained join
   table. Automatic projection plus source-match guards removes that gap.
2. Matching proposal ID alone could hide version/digest changes. Composite FKs
   now check both digests and version, including historical nested bindings.
3. Owner-valid task/session IDs could still be the wrong approval bounds. Exact
   proposal-bound checks now cover rows and nested event payloads.
4. An ordinary event could be mislabeled as a learning-transition pointer.
   Applicable lifecycle references now enforce their learning event type.
5. A correction can target active task state. A metadata-only shared owner-state
   alias supports that reference while leaving task state separate from durable
   learning; duplicate learned ID/version tuples across the two tables fail.
6. Snapshot overwrite via REPLACE/UPSERT and direct lineage deletion are
   blocked.
7. Timestamp ordering and a multi-row explicit sequence backstep would be unsafe
   replay assumptions. Ordering uses the DB sequence and checks the live maximum
   as well as its committed high-water mark.
8. Historical trusted versions could be confused with latest inactive snapshots.
   Latest-version views include inactive status and never include candidates.

Reviewed and retained as explicit limits: provenance is not truth; model output
does not become owner-origin evidence; claimed independence is not verified;
trusted-state schema validity is not authenticated authority; policy/approval/
execution/verification remain distinct; no cascade destroys historical meaning;
migrations create structure without rewriting recorded history.

## 13. Unresolved questions

- Authenticated owner/Root identity, OS/process/database protection, secrets and
  protected evaluation-vault access.
- Canonical proposal hashing, immutable artifact resolution, active approval
  revision/expiry/replay checks and grant/basis validation.
- Semantic scope inference/matching, source authenticity/independence, recursive
  trust/taint propagation and indirect graph-cycle detection.
- Complete event capture, reciprocal agreement between separately stored
  snapshots and event payloads, deterministic state rebuild, recovery/export.
- Evaluation-definition governance across embedded snapshots, scorer
  independence, oracle correctness, held-out restrictions and promotion
  thresholds.
- Trusted-version selection and valid lifecycle transitions. Latest declared
  version is not a Root authorization decision.
- Retention and owner erasure across live data, audit records and backups.

These are not masked by passing schema tests. The package README specifies which
reference identities/versions and event-type checks are actually enforced.

## 14. Assumptions

Local single-database v0.1, with multiple explicit synthetic owners supported;
existing Node 24/pnpm/TypeScript architecture; stable SQLite/Drizzle; AVEN-002
schema version 1 unchanged; private ESM TypeScript source exports; owner-scoped
IDs and positive safe-integer versions; no implicit global scope; source trust
and independence as declarations; JSON for contract snapshots with relational
integrity projections; caller-supplied full-proposal digest; no new correction
ID or no-lesson domain event invented; paired optional task/session event
bounds.

No real owner data, model calls, credentials, external services or experiment
results were used. The runtime DB smoke test contains schema only.

## 15. Deliberate deferrals

AVEN-003 does not provide:

- Experience Ledger service, domain append/write APIs, replay/rebuild or
  complete audit capture.
- Authenticated owner identity, Root security or policy enforcement.
- Context Broker retrieval or semantic scope inference.
- Truth validation, learning algorithms or model providers.
- Tool execution or execution verification.
- API routes, frontend, action execution, promotion controller or orchestration.
- Owner erasure implementation or production tamper resistance.

EXP-001 remains a draft, unrun experiment. A/B/C meaning, metrics, fairness,
held-out protection, core architecture and source artifacts remain unchanged.

## 16. Architecture-change proposals

**None.** The announced `packages/storage` structural addition separates shared
persistence from future Ledger behavior and preserves the locked architecture.
No new logical service or experimental redesign was needed. Stop after AVEN-003
and external review. **Do not commit yet; do not start AVEN-004.**
