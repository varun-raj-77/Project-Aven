# AVEN-004 implementation report

Date: October 4, 2026 (America/New_York).

AVEN-004 adds the append-only Experience Ledger service over frozen AVEN-003.
External review **accepted** the work, the four review fixes, and the two review
decisions recorded in section 14. It is **uncommitted and ready to freeze**.
AVEN-005 has not been started. No complete Aven runtime or experiment was run.

The milestone was implemented by one coding agent and interrupted by a usage
limit near completion. A second agent then took over, inspected the uncommitted
work without discarding or resetting any of it, verified it against the AVEN-004
requirements, performed an independent adversarial review, made the targeted
changes listed in section 18, re-ran every check, and finalized this report.
Statements below describe the code as it now exists, not claims inherited
without verification.

## Baseline and verification environment

`HEAD`, local `origin/main`, and the `aven-003` tag all resolve to
`fd6784db7f28879c7ec5f71a001c65c97a218e09`; `aven-002` is `9c05272` and
`aven-001` is `9aa52bf`. The first agent reported that a read-only
`git ls-remote` matched the remote; the second agent verified local refs only
and did not query the remote. No fetch, branch, commit, tag, or push was made.

The second agent had file access to the repository but no shell on the owner's
Windows machine. It mirrored the working tree and the complete `.git` directory
(loose objects; `git fsck` clean) into an isolated Linux workspace and ran every
check there with Node `24.21.0`, pnpm `11.19.0`, SQLite `3.53.4`, and the frozen
lockfile. The better-sqlite3 native module was compiled from its locked source
against Node 24.21.0 headers because that workspace could not download a
prebuilt binary; no dependency or lockfile changed. The first agent's runs used
Windows with Node `24.19.0`. **Re-run `pnpm check` on the Windows checkout
before committing** to confirm the same result on the reference machine.

Read before changing anything: `AGENTS.md`, `README.md`, principles, project
description, threat model, roadmap, AVEN-002/003 reports, contracts and storage
READMEs/sources/tests, every Ledger file, the existing draft of this report,
EXP-001 hypothesis/protocol, and the Ledger-relevant sections of the
implementation-instructions source. The source PDF had been read by the first
agent using the PDF skill.

## 1. Exact files created

Paths are relative to the repository root:

```text
docs/AVEN_004_REPORT.md
packages/ledger/README.md
packages/ledger/package.json
packages/ledger/tsconfig.json
packages/ledger/src/index.ts
packages/ledger/src/errors.ts
packages/ledger/src/records.ts
packages/ledger/src/ledger.ts
packages/ledger/src/integrity.ts
packages/ledger/test/fixtures.ts
packages/ledger/test/ledger.test.ts
packages/ledger/test/integrity.test.ts
packages/ledger/test/types.ts
```

Removed: `packages/ledger/.gitkeep`, replaced by the implementation.

Temporary synthetic test databases were created in OS temporary directories and
removed. No owner data, generated database, benchmark output, or credential is
in the working tree. A scratch adversarial-probe test used during review was
removed; it is not part of the deliverable.

## 2. Exact files modified

| File              | Change                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`       | Current AVEN-004 authorization, Ledger boundary, external review, and stop before AVEN-005; architecture/experiment doctrine retained. |
| `README.md`       | Current milestone, Ledger entry points/checks, and scope limits.                                                                       |
| `docs/ROADMAP.md` | Status/authorization only: AVEN-003 frozen, AVEN-004 accepted, rebuild tests in AVEN-009, authorization stops after AVEN-004.          |
| `package.json`    | Milestone description and Ledger package in the root typecheck pipeline.                                                               |
| `pnpm-lock.yaml`  | Ledger workspace importer only, using existing exact resolutions.                                                                      |

No storage files, SQL migrations, shared contracts, previous reports,
principles, project description, threat model, experiment artifacts, tooling, or
existing AVEN-001–003 tests were modified.

Pre-existing observation, not an AVEN-004 change: on a checkout where Git
re-hashes files (here, Linux), `git status` reports
`docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt` as modified. Its bytes
still match the SHA-256 recorded in `docs/REPOSITORY_INSPECTION.md`
(`3D8CAD37…159EC4`, CRLF) and its file time predates the repository. The blob
committed at `aven-001` was LF-normalized; AVEN-002 later added
`docs/sources/** -text`, and the Windows index stat cache hides the difference.
The content differs only in line endings. AVEN-004 did not touch it. Per the
external-review decision it must not be modified or normalized in AVEN-004; it
is a separate maintenance ticket after the freeze. Commit AVEN-004 by explicit
path so this file is not swept into the commit.

## 3. Dependencies added

The Ledger workspace declares `@aven/contracts` and `@aven/storage` as
`workspace:*`, existing Zod `4.6.5`, and existing development TypeScript `5.9.3`
and Vitest `4.0.18`. **No new registry package, resolution, or upgrade.** The
lockfile diff against `aven-003` is only the `packages/ledger` importer block.
No database driver, framework, provider SDK, queue, or lock service was added.

## 4. Ledger API

`createLedger(storage, ownerId)` returns a frozen object bound to one owner:

| Member                         | Behavior                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `ownerId`                      | The bound branded owner ID.                                                              |
| `appendEvent(input, options?)` | Atomically records one event plus its new evidence; returns committed `StoredEvent`.     |
| `getEvent(eventId)`            | Exact owner-bound lookup, or `undefined`.                                                |
| `listEvents(filter?)`          | Owner/session/task history, event-type and sequence-range filters, deterministic paging. |
| `replayEvents(filter?)`        | Finite synchronous iterator over the same records, bounded at call time.                 |
| `inspectIntegrity()`           | Read-only structured consistency report.                                                 |

`StoredEvent` is `{ sequence, event, evidence }`. A correction is recorded with
`appendEvent` (no separate mutation-shaped API). There is no update, delete,
generic query, raw handle, executor, or callback. Storage lifecycle, migrations
and owner/session/task provisioning remain outside the Ledger. Inputs are
validated at runtime regardless of TypeScript types. Compile-time negative tests
(`test/types.ts`) confirm no `sequence`/`recordedAt` input, no update/delete
members, no `sqlite` handle, and no `ownerId` filter.

## 5. Transaction semantics

1. Reject an already-active caller transaction (`transaction_active`).
2. Reject any `ownerId` claim, at any depth of the event or new evidence, that
   is not the bound owner (`cross_owner_reference`).
3. Validate event, evidence and options through the full AVEN-002 contracts with
   a provisional recording time; enforce the evidence-set and owner-origin
   rules. Nothing durable has happened yet.
4. Require foreign keys, recursive triggers and CHECK constraints to be active.
5. `BEGIN IMMEDIATE`; verify the owner exists, the EventId is new, and new
   evidence IDs are new, all under the writer lock.
6. Stamp `recordedAt` from the local clock, revalidate the copied input, resolve
   session/task bindings in this owner's namespace, then insert the event, its
   evidence, and its historical payload snapshot. Frozen AVEN-003 triggers
   populate identity/version catalogs and normalized references in the same
   transaction.
7. `COMMIT`. Deferred foreign keys resolve exact owner/version/evidence/event/
   proposal/digest/policy/bounds relationships here. Only a successful COMMIT
   returns a result.

Any failure after step 5 rolls back the event, evidence, payload snapshot,
catalogs, references, and the AUTOINCREMENT high-water mark. Tests compare all
of these (including `sqlite_sequence`) before and after injected deferred-FK,
mid-append trigger, duplicate, evidence-reuse and contention failures, then show
the connection remains usable.

An existing **identical** payload snapshot (same parsed JSON, and same proposal
digest for proposals) may be referenced by a new event; a conflicting snapshot
fails. No owner state is written, no candidate is generated, and no status is
inferred.

## 6. Ordering semantics

SQLite assigns the AVEN-003 AUTOINCREMENT `sequence`. It means **database-local
committed historical ordering**, not global causal time. Callers cannot supply
it (runtime and compile-time). Event IDs are stable and independent of it. All
reads sort exclusively by sequence; owner histories may have gaps because the
sequence is shared across owners, and values from failed transactions may be
reused because they never became history. Writers are serialized by
`BEGIN IMMEDIATE`, so commit order equals sequence order on one database.

`occurredAt`, creation metadata and payload timestamps are caller-declared
history. `recordedAt` is sampled inside the successful transaction, not the
exact commit/flush instant (the immutable v1 schema allows no post-commit
stamp). Equal and reversed `occurredAt`, and equal and reversed `recordedAt`
(fake clock moved backwards), do not affect order.

## 7. Duplicate behavior

Identity is `(ownerId, EventId)`, as frozen in AVEN-003. A duplicate EventId is
rejected with `duplicate_event`, whether the retry payload is identical or
different; no bytes change. The check runs under the writer lock. Equal IDs in
different owners' namespaces are separate. A new event reusing an evidence ID
already recorded for the owner is rejected with `invalid_reference` (previously
surfaced as an untyped `storage_failure`; see section 18). No upsert, merge,
implicit retry success, ID regeneration, or distributed idempotency exists.

## 8. Replay semantics

`replayEvents` validates the filter, reads the first page immediately (capturing
`throughSequence` = the owner's highest committed sequence, optionally lower),
and then yields pages through short read transactions using exclusive
`afterSequence` / inclusive `throughSequence` keyset cursors (default 100,
maximum 1000 per page). Later appends, including appends made by the consumer
between pages, are excluded; nothing is skipped or duplicated.

Replay, get, list and inspection never execute tools, call models or the
network, resolve artifact locators, resend messages, recreate approvals, append
events, or write derived state. They accept no callbacks. Tests run replay and
inspection with `PRAGMA query_only = ON`, a throwing `fetch` stub, and compare
`total_changes()` and every historical table before/after. Consumers remain
responsible for treating replayed actions/approvals as data.

Session/task filters use the event envelope binding when present; otherwise the
payload's direct task, approval bounds, or correction immediate applicability.
They never infer bindings from citations, authority chains, targets or scope
hints. All unbound events remain in owner history.

## 9. Correction behavior

A correction is an ordinary append of a new `owner_correction` event carrying
`OwnerCorrectionSchema`, its own evidence, and explicit correction provenance.
Tests show the original event's stored JSON is byte-identical afterwards, the
history contains both events, the correction provenance is preserved exactly,
and `learned_owner_state`, `active_task_state` and `learning_candidates` remain
empty. The `corrections` table receives only the historical payload snapshot
required by AVEN-003 references. No session override, lesson inference,
preference/procedure creation or promotion is implemented.

## 10. Failure model

All failures are `LedgerError` with `code`, message, `rollback` (`not_started` |
`rolled_back` | `failed`) and optional diagnostic `cause`.

| Code                              | Meaning                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`                   | Invalid lookup ID, filter, or proposal-digest usage.                                                                         |
| `invalid_event`                   | AVEN-002 contract validation failed, or caller supplied `sequence`/`recordedAt`.                                             |
| `unknown_owner`                   | Bound owner absent.                                                                                                          |
| `unknown_session`, `unknown_task` | Referenced identity absent in this owner's namespace.                                                                        |
| `cross_owner_reference`           | An `ownerId` claim anywhere in the event or new evidence names a different owner.                                            |
| `invalid_reference`               | Evidence-set mismatch, reused evidence ID, owner-origin mismatch, task/session mismatch, projection conflict, unresolved FK. |
| `duplicate_event`                 | EventId already recorded for this owner.                                                                                     |
| `transaction_active`              | Caller already has an open transaction; it is left untouched.                                                                |
| `integrity_failure`               | Stored history fails decoding/validation on read.                                                                            |
| `storage_failure`                 | Closed/unusable DB, disabled checks, writer contention, unexpected SQL failure, or failed rollback.                          |

Owner-claim mismatches are rejected before any transaction begins. A foreign
session/task ID is rejected inside the append transaction before any insert. A
foreign event/evidence/record ID fails its owner-bound foreign key and the whole
append is rolled back. IDs that do not resolve in the bound owner's namespace
are reported as unknown or unresolved; the Ledger deliberately does not probe
other owners to say that an ID exists elsewhere. `rollback: 'failed'` means
discard the connection and inspect storage. Raw SQLite errors appear only as
`cause`.

## 11. Integrity inspection

`inspectIntegrity()` runs inside a read transaction and never repairs. For the
bound owner it:

- decodes every stored snapshot through its frozen contract;
- recomputes v1 reference claims and compares them to every normalized reference
  field (detects deleted, altered, or extra edges even when foreign keys still
  pass);
- checks event evidence lists against stored evidence, and payload snapshots
  against event payloads;
- checks identity/version catalogs, owner-bound foreign keys, strictly
  increasing positive sequences, and the AUTOINCREMENT high-water mark;
- checks the expected no-update/no-delete/no-replace/reference triggers exist
  and that connection integrity pragmas are on.

Issue details are restricted to the bound owner's records. This is ordinary
consistency validation, **not cryptographic tamper resistance**: trigger bodies,
coordinated replacement of internally consistent data, disk integrity, and
source truth are not verified, and no audit hash exists.

## 12. Tests and results

Final `pnpm check`: **PASS**, exit 0. **300 tests in nine files**: 60 Ledger (53
in `ledger.test.ts`, 7 in `integrity.test.ts`), 73 unchanged storage, 155
unchanged contracts, 12 unchanged AVEN-001.

| Command/check                                                           | Result                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm format:check`                                                     | PASS.                                                                           |
| `pnpm typecheck`                                                        | PASS; root, contracts, storage, Ledger, compile-time negative API checks.       |
| `pnpm --filter @aven/ledger test`                                       | PASS; 60 tests.                                                                 |
| `pnpm db:test`                                                          | PASS; 73 tests.                                                                 |
| `pnpm --filter @aven/contracts test --configLoader native`              | PASS; 155 tests.                                                                |
| `node node_modules/vitest/vitest.mjs run --configLoader native tooling` | PASS; 12 AVEN-001 tests.                                                        |
| `pnpm experiment:check`                                                 | PASS; valid draft, execution not run, results absent.                           |
| `pnpm check`                                                            | PASS; full sequential pipeline.                                                 |
| `git diff --check` and new-file whitespace check                        | PASS for all AVEN-004 files; only the pre-existing source CRLF file is flagged. |
| Comparison against `aven-003`                                           | See below.                                                                      |

`git diff aven-003` is empty for `packages/contracts`, `packages/storage`
(including the SQL migration), `experiments`, `tooling`, principles, project
description, threat model, previous reports, repository inspection, risk
register, backlog, thesis, user research,
TypeScript/Vitest/Prettier/EditorConfig and Git configuration. All four
`docs/sources` files match their recorded hashes (the instructions file differs
from its committed blob only in line endings, as explained in section 2). Frozen
contracts, architecture doctrine and EXP-001 meaning are unchanged.

Coverage against the requested minimum:

| #      | Evidence                                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-2    | Valid append with evidence, assigned recording time, sequence 1; exact `getEvent` equality.                                                                                                           |
| 3-5    | Ordered owner/session/task history with envelope and payload-only bindings (task, approval bounds, correction applicability).                                                                         |
| 6-7    | Event-type filter; exclusive/inclusive sequence bounds combined with type filters.                                                                                                                    |
| 8      | Identical and changed duplicate EventIds rejected with unchanged bytes.                                                                                                                               |
| 9-10   | Runtime key set/frozen object; compile-time absence of update/delete/handle/owner filter.                                                                                                             |
| 11     | Direct SQL UPDATE/DELETE/REPLACE/UPSERT still rejected by storage.                                                                                                                                    |
| 12, 18 | Correction is a second event; original JSON unchanged; explicit correction provenance preserved; no owner state.                                                                                      |
| 13, 29 | Deferred-COMMIT FK failure, mid-append trigger failure, evidence reuse and contention leave no event/evidence/catalog/edge/sequence.                                                                  |
| 14     | Foreign envelope/payload/provenance/evidence owner claims → `cross_owner_reference`; foreign session/task/event IDs unresolved.                                                                       |
| 15     | Eight invalid event shapes and malformed evidence fail with `not_started` and no change.                                                                                                              |
| 16-17  | Model inference, derivation, source coverage, external untrusted evidence and owner-statement derivation round-trip unchanged; owner-origin evidence cannot be minted on inference or derived events. |
| 19     | Equal/reversed `occurredAt`; reversed and equal `recordedAt` under a fake clock.                                                                                                                      |
| 20     | File close/reopen preserves events, evidence, order, sequence continuation and integrity.                                                                                                             |
| 21-22  | Replay under `query_only`, throwing `fetch` stub, unchanged `total_changes()` and tables; no executor/callback API exists.                                                                            |
| 23     | Paged traversal across cross-owner sequence gaps with a mid-traversal append: no skip, duplicate or inclusion.                                                                                        |
| 24-25  | Proposal/approval/policy/execution references preserved; verification remains a separate event; failed execution recorded.                                                                            |
| 26-27  | Empty/populated history passes; missing/changed edges, invalid contract data, missing catalogs, regressed high-water mark and conflicting payload snapshot detected; no other-owner details leak.     |
| 28     | Two connections interleave appends with unique ascending sequences; held writer lock yields typed failure and no artifacts.                                                                           |
| 30     | All 240 pre-existing tests unchanged and passing.                                                                                                                                                     |

## 13. Adversarial review findings

Attempts to falsify the implementation (second agent), with outcome:

| Probe                                              | Outcome                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden update/delete/replace in Ledger source      | None. Only INSERTs inside the append transaction; table names interpolated only from fixed sets.                                                                                                                                                                                                                                                                                   |
| Duplicate EventId behaving as update               | Rejected under writer lock; bytes unchanged.                                                                                                                                                                                                                                                                                                                                       |
| Duplicate **evidence** ID on a new event           | **Found:** rejected by storage but surfaced as generic `storage_failure`. **Fixed:** typed `invalid_reference` pre-check under lock; test added.                                                                                                                                                                                                                                   |
| Provenance laundering via derived event            | **Found:** an `action_proposed` (or candidate/evaluation/rejection) event declaring derivation from an _earlier_ owner statement could attach new `explicit_owner_statement` evidence sourced at itself, so generated content would read as an owner statement. **Fixed:** owner-origin evidence now also requires the event's declared owner origin to be that event; test added. |
| Model-inference event with owner-origin evidence   | Rejected (pre-existing check, retained).                                                                                                                                                                                                                                                                                                                                           |
| Cross-owner reference distinguishability           | **Found:** owner mismatches shared `invalid_reference` with seven unrelated causes. **Fixed:** `cross_owner_reference`; tests added/updated.                                                                                                                                                                                                                                       |
| Payload-only session/task JSON paths               | Approval-bounds and correction-applicability paths were untested (a typo would silently drop events). Test added; paths verified correct.                                                                                                                                                                                                                                          |
| Replay side effects / writes / model or tool calls | None; no imports beyond Zod, node:util, contracts, storage.                                                                                                                                                                                                                                                                                                                        |
| Timestamp ordering / caller-controlled sequence    | Not possible; ordering is sequence-only.                                                                                                                                                                                                                                                                                                                                           |
| Partial append after failure                       | None observed in any injected failure.                                                                                                                                                                                                                                                                                                                                             |
| Raw DB handle escape                               | None; frozen object, decoded data only; SQLite errors only as `cause`.                                                                                                                                                                                                                                                                                                             |
| Cross-owner history leakage                        | Every query binds the owner; inspection details owner-restricted.                                                                                                                                                                                                                                                                                                                  |
| Read paths that write                              | None; verified under `query_only`.                                                                                                                                                                                                                                                                                                                                                 |
| Derived owner state during append                  | None; only historical payload snapshots required by AVEN-003 references.                                                                                                                                                                                                                                                                                                           |
| Pagination skip/duplicate                          | None, including consumer appends mid-iteration.                                                                                                                                                                                                                                                                                                                                    |
| Report claims vs code                              | Prior claims held, except: the frozen-source comparison is clean only modulo the pre-existing CRLF artifact; ROADMAP was stale (now updated).                                                                                                                                                                                                                                      |

Retained limits (not solved, not hidden): owner/Root labels and digests are
declarations; schema/file administrators can bypass everything; deterministic
replay cannot make a future consumer rebuild correct state.

## 14. Unresolved questions

Resolved by external review:

- Owner Model rebuild tests belong to **AVEN-009**. AVEN-004 provides complete,
  deterministic, side-effect-free historical replay/access for later rebuild
  consumers. `docs/ROADMAP.md` records this on the AVEN-004 and AVEN-009 rows.
- The instructions-source line-ending inconsistency (section 2) is a separate
  post-freeze maintenance ticket; the file is not modified in AVEN-004.

Still open (not AVEN-004 scope):

- Authenticated owner/Root identity and isolation; canonical proposal hashing
  and artifact verification; source authenticity, independence and recursive
  taint; recording completeness across components; coordinated cycles with
  future owner-state writes; Owner Model rebuild correctness; approval
  freshness/replay/grant validation; trusted-state selection; export/recovery,
  retention/erasure and backups.

## 15. Assumptions

Local single-database v0.1; intact configured AVEN-003 schema and registered
functions; preprovisioned explicit identities; owner-scoped historical IDs;
synchronous in-process service; existing toolchain versions; caller-owned
storage lifetime; referenced endpoints outside an append already exist; local
clock for recording timestamps; supplied provenance/digests are declarations.
Tests use synthetic data only.

## 16. Deliberate deferrals

No Context Broker, Owner Model retrieval/rebuild, learning hypothesis
generation, model-provider adapter, Root policy engine, API/UI, chat/session
API, promotion controller, execution, or AVEN-005+ work. No distributed
idempotency, semantic or vector retrieval, cryptographic audit, authenticated
identity, or erasure design. EXP-001 remains a draft and unrun; A/B/C, the
C-versus-B requirement, metrics, held-out discipline and experiment meaning are
unchanged.

The first agent recorded one informational single-run timing on Windows (100
sequential appends: median ~17.9 ms; replay of 100 events ~19.9 ms). It was not
reproduced and carries no performance claim or gate.

## 17. Architecture-change proposals

**None.** The Ledger adds historical behavior to the already designated
`packages/ledger` and consumes frozen storage abstractions. No contract,
migration, architecture doctrine or experiment meaning was changed.

## 18. Changes made to the interrupted implementation, and why

All other interrupted work was verified and left as written.

| Change                                                                                                                                             | Reason                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `errors.ts`: added `cross_owner_reference`.                                                                                                        | Requirement: distinguish cross-owner references from other invalid references.                 |
| `records.ts`: `assertOwnerClaims` scans event/evidence `ownerId` claims before validation; called first in `appendEvent`.                          | Same rule as v1 reference projection, now typed and applied before any write.                  |
| `records.ts`: owner-origin evidence also requires the event's declared owner origin to be that same event.                                         | Closes a provenance-laundering path (model/derived content as owner-statement evidence).       |
| `ledger.ts`: envelope owner mismatch reports `cross_owner_reference`; evidence-ID reuse checked under the writer lock.                             | Typed failure instead of `invalid_reference` / generic `storage_failure`.                      |
| `ledger.test.ts`: one expectation updated; four tests added (payload-only bindings, derived-event laundering, cross-owner claims, evidence reuse). | Cover the fixes and previously untested filter paths.                                          |
| `packages/ledger/README.md`: evidence reuse, provenance rule, owner-claim rule, failure table.                                                     | Keep documentation accurate.                                                                   |
| `docs/ROADMAP.md`: AVEN-003/004/009 status and authorization lines only.                                                                           | Stale AVEN-004 status/authorization; record rebuild tests in AVEN-009.                         |
| This report: rewritten from the verified state.                                                                                                    | Correct test counts, record takeover verification, findings, and the source line-ending issue. |

## Final reconciliation after external review

The accepted state was re-inspected without stylistic rewrites. The device
working tree was confirmed identical to the verified copy; `HEAD`, `main`,
`origin/main` and all tags are unchanged. The four approved fixes are present
and covered by tests. Additional scratch probes (not kept) confirmed: an extra
normalized edge is reported by inspection; a getter that changes `ownerId`
between reads cannot record a foreign owner (rejected, no artifacts); a foreign
envelope task is rejected with no artifacts; closing storage mid-replay yields a
typed `storage_failure` with no writes; another owner's Ledger sees no history,
replay, lookup, or inspection detail. No CRITICAL/HIGH issue was found and no
code changed during reconciliation. The only edits were the ROADMAP AVEN-004 and
AVEN-009 rows and this report's status, decision and reconciliation text. All
checks in section 12 were re-run with the same results.

Do not start AVEN-005. Do not include
`docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt` in the AVEN-004 commit.

**Verdict: READY TO FREEZE AVEN-004**
