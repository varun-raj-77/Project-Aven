# AVEN-005 implementation report

Date: October 4, 2026 (America/New_York). Revised October 5, 2026 after the
first external review (section 18).

AVEN-005 adds Aven's first local interaction boundary: a loopback HTTP API for
owner-scoped sessions, task identities, owner messages recorded through the
AVEN-004 Experience Ledger, and session history read back from the Ledger. **No
model runs, and nothing answers a message.** The work is uncommitted. It passed
a first external review with required fixes; those fixes are implemented
(section 18) and the work is ready for final external verification. AVEN-006 has
not been started.

## Baseline and verification environment

`HEAD`, local `main`, and local `origin/main` resolve to `8479aa1`
(`chore: fix source artifact and pnpm portability`, MAINT-001), whose parent is
`54b0d1a` (tag `aven-004`). Tags `aven-001`…`aven-004` resolve to `9aa52bf`,
`9c05272`, `fd6784d`, `54b0d1a`. No fetch, branch, commit, tag or push was made,
and the remote was not queried.

The implementing agent had file access to the owner's checkout but, for most of
the session, no shell on that machine, and the GitHub remote was not reachable
from its workspace. It mirrored the complete `.git` directory (loose objects
only; `git fsck --full` clean) into an isolated Linux workspace and checked out
`8479aa1`. All 107 tracked files in the owner's working tree matched the
checkout by size (13 are empty `.gitkeep` files), the only untracked items were
ignored (`node_modules/`, `data/aven.sqlite`), and `git status` in the mirror
was clean, so the starting tree is treated as a clean `8479aa1`. A direct
`git status` on the owner's machine was attempted late in the session but the
device was not reachable at that moment.

Toolchain: Node `24.21.0` (the official `node-linux-x64` binary from the npm
registry, because `nodejs.org` was blocked by the workspace proxy), Corepack
`0.36.0`, pnpm `11.19.0`, SQLite `3.53.4`, the frozen lockfile. better-sqlite3
`13.0.3` ships a `linux-x64` prebuilt N-API binary, so nothing was compiled.
pnpm 11 refused to run scripts while better-sqlite3/esbuild build approval was
pending and auto-wrote an `allowBuilds` placeholder into `pnpm-workspace.yaml`;
that edit was reverted every time, and checks were run with the environment-only
setting `pnpm_config_verify_deps_before_run=false`. No repository file encodes
that workaround.

Baseline before any change: `corepack pnpm check` **passed, 305 tests**.

**Re-run on the Windows checkout before committing:**
`corepack pnpm install --frozen-lockfile --ignore-scripts` (the lockfile gains
an `apps/api` importer, so the workspace link must be created) and then
`corepack pnpm check`.

## 1. Exact files created

```text
apps/api/README.md
apps/api/package.json
apps/api/tsconfig.json
apps/api/src/index.ts
apps/api/src/errors.ts
apps/api/src/schemas.ts
apps/api/src/identity-store.ts
apps/api/src/service.ts
apps/api/src/http.ts
apps/api/src/server.ts
apps/api/src/cli.ts
apps/api/test/fixtures.ts
apps/api/test/service.test.ts
apps/api/test/http.test.ts
apps/api/test/server.test.ts
apps/api/test/boundaries.test.ts
docs/AVEN_005_REPORT.md
```

`apps/api/.gitkeep` is **deleted** (review fix 7), as AVEN-004 removed
`packages/ledger/.gitkeep`.

Temporary synthetic databases were created in OS temporary directories and
removed. No owner data, generated database, credential or benchmark output is in
the working tree.

## 2. Exact files modified

| File               | Change                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `package.json`     | Description; `apps/api` added to `typecheck` (and therefore `check`); new `api:start` script.                   |
| `pnpm-lock.yaml`   | `apps/api` importer block only (25 lines), reusing existing exact resolutions.                                  |
| `vitest.config.ts` | Test include gains `apps/*/test/**/*.test.ts`.                                                                  |
| `AGENTS.md`        | Current authorization (AVEN-005 only, baseline `8479aa1`, stop before AVEN-006); `apps/api` boundary sentence.  |
| `README.md`        | Current scope, API entry point, `api:start`, structure line; AVEN-005 scope limits.                             |
| `docs/ROADMAP.md`  | AVEN-004 row "Frozen at `aven-004`", AVEN-005 row "Awaiting review", authorization line. Table width unchanged. |

`git diff 8479aa1` is **empty** for `packages/` (contracts, storage including
the SQL migration, Ledger), `experiments/`, `tooling/`, `docs/sources/`,
principles, project description, threat model, all previous reports,
`.gitattributes`, `.editorconfig`, `.gitignore`, Prettier configuration,
`tsconfig*.json` and `pnpm-workspace.yaml`. Both source artifacts still match
their recorded SHA-256 values (`3D8CAD37…159EC4`, `D76E014F…E446`).

## 3. Package and dependency changes

**No new registry package, resolution or upgrade.** The new private workspace
`@aven/api` declares `@aven/contracts`, `@aven/storage`, `@aven/ledger`
(`workspace:*`), `drizzle-orm` `0.45.3` and `zod` `4.6.5` as dependencies, and
TypeScript `5.9.3` / Vitest `4.0.18` as development dependencies. Every one is
already locked; the `drizzle-orm` resolution string is byte-identical to the
storage package's. `drizzle-orm` is a direct dependency only so the identity
store can use storage's existing typed table mappings (`eq`, `and`, `or`, `gt`,
`asc`) instead of raw SQL.

HTTP uses Node's built-in `node:http`. A framework (Express, Fastify, Hono)
would add packages and middleware conventions without solving anything this
boundary needs: eight routes, strict JSON parsing, and fixed error bodies fit in
one small module. Keeping the dependency set unchanged also keeps the
supply-chain surface and the lockfile diff minimal.

## 4. API architecture

```text
node:http listener (loopback only)          src/server.ts, src/cli.ts
  -> request handler                        src/http.ts
     Host check, canonical path, closed route table, strict query/body schemas,
     JSON content type on every POST, JSON bodies (256 KiB cap), fixed errors
  -> application service                    src/service.ts
     ID syntax, owner/session/task scoping, builds owner_request events
     -> identity store                      src/identity-store.ts
        owners/sessions/tasks via storage's Drizzle mappings, owner-keyed
     -> Experience Ledger                   @aven/ledger (unchanged)
        the only path for historical events
        -> storage                          @aven/storage (unchanged)
```

Route handlers contain no SQL and no domain logic beyond schema validation. The
service is the only place events are built, and it builds only `owner_request`
events. The identity store is the only module that touches the database
directly. It uses Drizzle query builders, never `prepare`/`exec` or SQL strings,
and inserts only into `owners`, `sessions` and `tasks`; a static test enforces
all three properties. The Ledger and storage packages are consumed unchanged.
Everything is synchronous once a request body has been read, so no request work
outlives its request.

## 5. Endpoint and capability inventory

| Capability             | Endpoint                                                                    | Success                                                  |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Static health metadata | `GET /v1/health`                                                            | 200; `modelRuntime: "not_implemented"`                   |
| Create/start session   | `POST /v1/owners/{ownerId}/sessions` (JSON `{}` or empty)                   | 201 `{ session }`                                        |
| List owner sessions    | `GET /v1/owners/{ownerId}/sessions?limit&cursor`                            | 200 `{ sessions, nextCursor }`                           |
| Retrieve session       | `GET /v1/owners/{ownerId}/sessions/{sessionId}`                             | 200 `{ session }`                                        |
| Create task identity   | `POST /v1/owners/{ownerId}/sessions/{sessionId}/tasks` (JSON `{}` or empty) | 201 `{ task }`                                           |
| List session tasks     | `GET /v1/owners/{ownerId}/sessions/{sessionId}/tasks?limit&cursor`          | 200 `{ tasks, nextCursor }`                              |
| Submit owner message   | `POST /v1/owners/{ownerId}/sessions/{sessionId}/tasks/{taskId}/messages`    | 201 receipt (below)                                      |
| Read session history   | `GET /v1/owners/{ownerId}/sessions/{sessionId}/history?limit&cursor&taskId` | 200 `{ ownerId, sessionId, taskId, events, nextCursor }` |
| Close/end session      | **Not implemented** (section 7)                                             | —                                                        |

The message body is exactly `{ "text": string }`. The receipt is
`{ accepted: true, ownerId, sessionId, taskId, eventId, evidenceId, eventType: "owner_request", sequence, occurredAt, recordedAt }`,
where `sequence`, `occurredAt` and `recordedAt` come from the committed Ledger
record. The receipt describes only the durable `owner_request`; the obsolete
response-status flag was removed in review (fix 3) and no response-status field
replaces it. Every POST requires `Content-Type: application/json`, even with an
empty or `{}` body (fix 1). History entries are canonical Ledger
`{ sequence, event, evidence }` records. Page `limit` is an integer 1-200
(default 50 over HTTP), enforced by both the HTTP schema and the exported
service (fix 4). There is no PUT, PATCH or DELETE route, and no chat-completion,
respond or assistant-output route.

**Why tasks exist here.** The frozen AVEN-002 `owner_request` event requires
`payload.task: { sessionId, taskId }`, and no other owner-origin event type can
carry a plain owner message (`owner_correction` and `owner_approval` mean
something else). This is a constraint of the frozen contract, not a gap: no
contract change is needed. Owner messages are therefore task-bound, and the API
provisions bare task identities (ID, session, creation time) because the Ledger
leaves identity provisioning to its caller. There is no task objective, status,
open-loop list or management; `active_task_state` is never written.

**Owner provisioning is not an HTTP capability.** Owners are declared by the
local operator (`pnpm api:start --owner <ownerId>`, or `provisionOwner` in
code), idempotently, before the listener starts. Identity and authentication
belong to Root in the locked architecture, so the API does not let a client mint
owners.

## 6. Identifier conventions

All IDs follow the AVEN-002 syntax (`<prefix>_` plus 1-128 ASCII characters),
which defers suffix allocation. AVEN-005 allocates `session_`, `task_`, `event_`
and `evidence_` IDs server-side from `crypto.randomUUID()`, revalidates each one
against its contract schema, and fails closed (`internal_error`, nothing
written) if a generator ever produces an invalid one. Clients cannot choose IDs.
The generator and clock are injectable for tests only.

## 7. Session lifecycle semantics

A session is an owner-bound identity row `(owner_id, session_id, created_at)`.
It is created explicitly and read by owner-scoped lookup. It has no status and
cannot be closed, ended, renamed or deleted through the API.

Close/end is **deliberately not implemented**: the frozen AVEN-003 schema has no
session lifecycle column or event, and its README states that the identity
tables have "no invented session/task runtime lifecycles". The only lifecycle in
the domain model is `active_task_state` (active/closed), which is learned owner
state with a `learned_` ID, objective, open loops and source evidence. Using it
to close a session would be a derived-state self-write and a semantic stretch.
Adding a lifecycle would need either a new SQL migration (`0002`) or a new
AVEN-002 event type. Both are frozen-schema/contract changes that need explicit
approval, so the milestone marks this optional capability as not implemented
rather than inventing one. Required test 28 is therefore not applicable.

Creating a session records no Experience Ledger event, because the frozen event
union has no session-started type. The identity row's `created_at` is the
record.

## 8. Message-ingestion flow

1. Strict HTTP checks: loopback `Host`, canonical path, no query parameters,
   `Content-Type: application/json` (checked for every POST before the body is
   read), at most 256 KiB, valid UTF-8 JSON.
2. ID syntax for owner, session and task (`invalid_identifier`).
3. Body schema: exactly `{ text }`, 1-65,536 UTF-16 units, at least one
   non-whitespace character, no lone surrogates (they would be silently replaced
   in SQLite's UTF-8 and the stored evidence would differ from what was sent).
   Text is stored verbatim, never trimmed.
4. Owner-scoped pre-check: owner exists, session exists for this owner, task
   exists in exactly this session. This gives clear 404s. It is not the
   authority, because the Ledger re-verifies every binding under its writer
   lock.
5. Build one AVEN-002 `owner_request` event: server-allocated event ID,
   `occurredAt` = server receipt time, envelope **and** payload task binding,
   `metadata.creation = { component: "@aven/api", version: "0.1.0" }`, and
   provenance
   `{ kind: "explicit_owner_statement", ownerId, sourceEventId: <this event> }`.
6. Build one evidence record: `recorded_text` with the same verbatim text and
   the same owner-statement provenance originating at this event.
7. `createLedger(storage, ownerId).appendEvent(event, { evidence })`: a single
   `BEGIN IMMEDIATE` transaction. The receipt is built from the returned,
   committed record. Any failure rolls everything back and no receipt is
   returned.

No model, tool, network, learning, candidate, correction, approval or policy
code runs at any point.

## 9. Ledger interaction

The API calls exactly two Ledger methods, `appendEvent` (messages) and
`listEvents` (history), and inherits their AVEN-004 guarantees unchanged: atomic
append with deferred foreign keys checked at COMMIT, a database-assigned
`sequence`, `recordedAt` stamped inside the transaction, duplicate EventId
rejection, owner-claim and owner-origin evidence checks, and read-only paged
reads with an inclusive `throughSequence` bound captured on the first page.

History is a projection of canonical Ledger records, not a second store. The
history cursor is the Ledger cursor `{ afterSequence, throughSequence }` wrapped
with the owner, session and task it was issued for (base64url JSON) and rejected
if replayed elsewhere. Session filtering uses the Ledger's existing binding
rules, so the API adds no new interpretation of history.

The API never updates or deletes anything, never writes `learned_owner_state`,
`active_task_state`, candidates, no-useful-lessons, corrections, proposals,
policy decisions, approvals, executions, verifications, evaluations or lifecycle
records, and never references their tables.

## 10. Owner-isolation guarantees

- Every identity read and write is keyed by `owner_id`; a session or task ID
  alone never selects a row. AVEN-003 identity is `(owner_id, session_id)`, so
  two owners can hold the same session ID string as two separate sessions. A
  test proves their histories stay separate.
- Another owner's session is indistinguishable from a nonexistent one: the same
  `session_not_found` code, message and HTTP body, byte-for-byte, across get,
  history, task listing, task creation and message submission. Responses never
  echo another owner's IDs or text.
- Ledger reads and appends are bound to the path owner via `createLedger`. A
  foreign owner claim cannot be constructed through the API at all; the
  defensive `owner_mismatch` mapping covers the Ledger's
  `cross_owner_reference`.
- History and listing cursors are bound to the issuing owner and scope. A forged
  cursor naming another scope still runs only the owner-bound query, so it
  yields only that owner's own records.
- **Sequence is database-global.** The Ledger `sequence` (frozen AVEN-003/004)
  is one counter for all owners and appears in receipts, history entries and
  decodable cursors. Gaps between one owner's sequence values can reveal coarse
  activity by other owners (event counts and rough timing). No other-owner
  content, ID or text is exposed by this alone. Sequence behavior is unchanged;
  revisit during authenticated multi-owner / Root work.
- **Limits:** the owner is declared in the path, not authenticated. Any local
  process that can reach the loopback port can act as any declared owner, and
  anyone who can open the SQLite file bypasses the API entirely.
  `owner_not_found` reveals whether an owner ID is declared (owners are
  operator-declared local identities; no session or history detail is revealed).

## 11. Error model

Every failure body is exactly `{ "error": { "code", "message" } }` with a fixed
message per code. Causes (SQLite errors, Zod issues, Ledger errors) are never
serialized; they go to the optional `onError` hook (5xx only), which the CLI
writes to stderr.

| Code                     | HTTP | Raised when                                                                                                          |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`        | 400  | Malformed JSON/UTF-8, schema failure, unknown/repeated field, non-canonical path, foreign/forged cursor.             |
| `invalid_identifier`     | 400  | Path or query ID fails AVEN-002 syntax, or undecodable percent-encoding.                                             |
| `unsupported_media_type` | 415  | Any POST without `Content-Type: application/json`, including empty-body creation requests.                           |
| `payload_too_large`      | 413  | Body above 256 KiB (declared or streamed/chunked).                                                                   |
| `host_not_allowed`       | 403  | `Host` is not `localhost`, `127.0.0.1` or `[::1]` (optionally with a port).                                          |
| `route_not_found`        | 404  | No such route.                                                                                                       |
| `method_not_allowed`     | 405  | Route exists, method does not; `Allow` header lists GET/POST.                                                        |
| `owner_not_found`        | 404  | Owner not declared; Ledger `unknown_owner`.                                                                          |
| `session_not_found`      | 404  | No such session for this owner (foreign = missing); Ledger `unknown_session`.                                        |
| `task_not_found`         | 404  | No such task in this owner's session; Ledger `unknown_task`.                                                         |
| `owner_mismatch`         | 403  | Ledger `cross_owner_reference` (defensive; not reachable through the API).                                           |
| `invalid_reference`      | 422  | Ledger `invalid_reference` (binding mismatch, evidence-ID reuse) or a SQLite FK error.                               |
| `conflict`               | 409  | Session/task ID already exists for the owner; Ledger `duplicate_event`.                                              |
| `storage_failure`        | 503  | Closed/busy/unusable database, writer contention, injected SQL fault; Ledger `storage_failure`/`transaction_active`. |
| `ledger_failure`         | 500  | Ledger `invalid_event`/`integrity_failure`, or any failed rollback.                                                  |
| `internal_error`         | 500  | Unexpected defect, invalid generated ID or clock value.                                                              |

`session unavailable/closed` does not exist because sessions have no lifecycle
(section 7). Every 4xx/5xx on a write path means nothing was acknowledged and,
as the tests show, nothing durable changed.

## 12. Tests added

68 tests in four files under `apps/api/test/` (synthetic owners
`owner_synthetic_a`/`_b`, temporary in-memory or temp-directory databases): 61
original plus 7 added by the review fixes (section 18).

| File                 | Tests | Focus                                                                                                                    |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `service.test.ts`    | 34    | Isolation, provenance, ingestion, ordering, pagination, cursors, atomicity, conflicts, failures, reopen, page limits.    |
| `http.test.ts`       | 25    | Shapes/status codes, strictness, cross-owner bodies, methods, Host, media type, cross-site POSTs, size, aborted bodies.  |
| `server.test.ts`     | 4     | Startup against migrated temp DB, shutdown under load, unmigrated/non-loopback refusal.                                  |
| `boundaries.test.ts` | 5     | Static tripwires (not guarantees): import allowlist, no outbound calls, identity-only writes, `owner_request`, GET/POST. |

Most write-path failure tests compare a full snapshot of all 21 application
tables plus `sqlite_sequence` before and after.

| #     | Required case                      | Evidence                                                                                                                                                                                                                    |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-3   | Create, retrieve, list             | Service create/get/list; HTTP happy path; paginated listing with 7 + 3 sessions across owners.                                                                                                                              |
| 4-5   | Foreign read/append                | Service and HTTP: get/history/tasks/create-task/message by owner B on A's session → 404, no change.                                                                                                                         |
| 6     | Invalid IDs                        | Nine malformed owner IDs, traversal-like session IDs, wrong-prefix task/session IDs, percent-encoded NUL/slash in paths.                                                                                                    |
| 7     | Malformed request                  | Truncated JSON, `null`, arrays, strings, numbers, empty body, invalid UTF-8 body.                                                                                                                                           |
| 8     | Unknown fields                     | 16 authority/provenance-like body fields; raw `"__proto__"` key; queries on write routes; repeated, unknown and prototype-named query keys.                                                                                 |
| 9     | Empty/invalid message              | Empty, whitespace-only, 65,537 chars, non-string, lone/reversed surrogates; inclusive 65,536 bound accepted.                                                                                                                |
| 10-12 | Event, provenance, binding         | Exact stored event/evidence, verbatim text, envelope + payload task, generated columns, per-task history.                                                                                                                   |
| 13-14 | Canonical order vs timestamps      | System clock moved backwards and repeated (fake timers): order follows sequence; timestamps preserved as claims; equal/reversed session times ordered deterministically.                                                    |
| 15    | Repeated reads                     | Reads under `PRAGMA query_only = ON`; identical results; unchanged `total_changes()` and full snapshot.                                                                                                                     |
| 16-17 | Pagination dup/skip                | Interleaved sessions and owners at limits 1, 2, 5, 7, 22, 23, 24, 1000; appends between pages excluded.                                                                                                                     |
| 18    | Cursor leakage                     | Cursor replayed on another owner's same-named session, another session, a task filter; forged and corrupt cursors.                                                                                                          |
| 19-20 | Failed append; typed errors        | Injected mid-append trigger fault (event inserted, evidence fails): no event/evidence/catalog/sequence; contention; closed DB; HTTP bodies contain no driver detail.                                                        |
| 21    | Duplicate IDs                      | Colliding event (`conflict`), evidence (`invalid_reference`), session and owner-wide task IDs: nothing overwritten.                                                                                                         |
| 22-23 | Rewrite/delete                     | PUT/PATCH/DELETE on every resource → 405 with `Allow`; item paths → 404; static GET/POST-only and no-update/delete checks.                                                                                                  |
| 24    | No learned state                   | Messages phrased as preferences/approvals/corrections/permissions create zero derived or authority rows; session creation records no event.                                                                                 |
| 25    | No model/tool/network              | `fetch`/`WebSocket` stubs never called; static import allowlist and call-pattern scan; health metadata.                                                                                                                     |
| 26-27 | Owner-bounded list; non-disclosure | Listing per owner; foreign vs missing session bodies byte-identical over HTTP.                                                                                                                                              |
| 28    | Closed session                     | Not applicable: no session lifecycle in the frozen schema (section 7).                                                                                                                                                      |
| 29-30 | Startup; clean shutdown            | Real listener on a migrated temp file; close (idempotent), listener gone, `integrity_check` ok, FK check empty, Ledger inspection ok; 25 concurrent submissions with close mid-burst: recorded set equals acknowledged set. |

Additional risk-driven tests: equal session IDs across owners stay isolated; a
task from another session of the same owner is refused; owner provisioning is
idempotent; an undeclared owner creates nothing; non-loopback `Host` headers and
non-loopback bind addresses are refused; dot-segment and absolute-form request
targets are refused instead of being reinterpreted; chunked oversize bodies are
bounded; history survives close/reopen with sequence continuation.

**Mutation checks** (temporary edits, then restored): removing the owner filter
from session lookup, the session check from history, owner binding from the
history cursor, body strictness, query strictness, the session filter from task
lookup, the Host check, the content-type check, the surrogate check, the
canonical-path check, the null-prototype query object, and the fatal UTF-8
decoder. Each one made at least one test fail. With the API task pre-check
removed, the Ledger still refused the mis-bound task (defense in depth).

## 13. Test results

| Command                                    | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `corepack pnpm format:check`               | PASS                                                   |
| `corepack pnpm typecheck`                  | PASS; root, contracts, storage, Ledger, `apps/api`     |
| `corepack pnpm experiment:check`           | PASS; valid draft, `execution=not_run`, results absent |
| `corepack pnpm test`                       | PASS; **373 tests in 14 files**                        |
| `corepack pnpm --filter @aven/api test`    | PASS; 68 tests                                         |
| `corepack pnpm --filter @aven/ledger test` | PASS; 60 tests (unchanged)                             |
| `corepack pnpm db:test`                    | PASS; 73 tests (unchanged)                             |
| `corepack pnpm check`                      | PASS; full sequential pipeline                         |
| `git diff --check` (including new files)   | PASS                                                   |

373 = 305 baseline (155 contracts, 73 storage, 60 Ledger, 12 AVEN-001, 5
MAINT-001, all unchanged and passing) + 68 AVEN-005 (61 original + 7 from the
review fixes). Section 13 originally recorded 366 before the review fixes.

**Original smoke test** (CLI, temporary migrated database, port 43180, owners
declared with `--owner`): health returned static metadata; session → task →
three messages returned 201 with sequences 1-3; history paged 2 + 1 via
`nextCursor`; owner B's read and append into A's session returned 404
`session_not_found`; a forged `role` field returned 400; `DELETE` on history
returned 405; a `text/plain` body returned 415; a foreign `Host` returned 403.
`SIGINT` exited 0. Reopening the file afterwards gave `integrity_check` = ok, no
FK violations, and Ledger inspection ok for both owners: 3 events and 3 evidence
rows for A, none for B, zero rows in every derived/authority table, and no
journal sidecar files. The CLI also tolerates a literal leading `--` that pnpm
11 forwards.

## 14. Assumptions

Local single-machine v0.1; one SQLite file opened through `openStorage`; the
schema is migrated before the server starts (the server checks `user_version`
and never migrates); owners are declared by the local operator; the system clock
is the source of `occurredAt` and identity `createdAt`; random UUID suffixes do
not collide in practice (collisions fail closed as `conflict` or
`invalid_reference`); a loopback client is the owner it declares; tests use
synthetic data only.

## 15. Unresolved limitations

- **Declared, unauthenticated owner.** Anyone who can reach the port or open the
  file can act as any declared owner. The `Host` check and the JSON content type
  required on every POST reduce browser cross-site and DNS-rebinding exposure;
  they are not authentication and not production network security.
- **Owner-origin is asserted by the channel, not proven.** Clients cannot choose
  an event type, provenance kind, owner claim or trust label, and only this one
  endpoint can create owner-statement evidence. But any local client that
  reaches it would have its text recorded as `explicit_owner_statement`. Closing
  this requires an authenticated owner channel (Root). The binding forward rule
  is in section 18 (fix 2), `AGENTS.md` and `apps/api/README.md`.
- **No idempotency.** A retried submission after a lost response records a
  second event with a new ID. Server-allocated IDs prevent overwrites but not
  duplicate messages. AVEN-004 deliberately has no idempotency keys either. A
  message can also be durable while its client never receives the 201 (for
  example, the client resets the connection right after sending); clients
  reconcile through history.
- **Sequence is database-global** (section 10): gaps can reveal coarse
  other-owner activity, no other-owner content.
- **No session close/end** (section 7) and no task lifecycle.
- **Text is duplicated** in the `owner_request` payload and its evidence record.
  This is deliberate, so later model inference can cite owner-statement evidence
  through AVEN-002 `EvidenceReference`s; it is the canonical Ledger shape, not a
  second store.
- **`occurredAt` is server receipt time**, not a client claim. A clock that
  moves backwards between sampling and the Ledger's `recordedAt` stamp makes the
  append fail as `ledger_failure` with nothing recorded.
- History responses can be large: up to 200 events, each with its text stored
  twice (payload and evidence), so a worst-case page is on the order of 100+ MB
  of JSON built synchronously; there is no streaming.
- Owner-ID existence is observable via `owner_not_found`.
- The server is single-process and synchronous; SQLite writer contention beyond
  the 5-second busy timeout surfaces as `storage_failure` (503) with no retry.
- Verified on Linux only in this session; the Windows reference run is pending.

## 16. Explicitly not implemented

LLM/model calls; provider adapters; prompt construction; any assistant response
or "chat completion" route; Context Broker; semantic/vector retrieval; Owner
Model learning; preference inference; learning hypotheses; correction handling
beyond existing contracts; Root Policy Gateway; permissions engine; tool
execution; autonomous actions; agent workers; browser/network integrations;
frontend UI; authentication; production deployment; WebSocket/streaming; session
close/end; task management; owner creation over HTTP; idempotency keys; AVEN-006
work. Prediction remains distinct from permission, and API acceptance is not
authorization for any consequential action.

## 17. Architecture-change proposals

**None.** No AVEN-002 contract, AVEN-003 migration, AVEN-004 Ledger source,
architecture doctrine or EXP-001 meaning changed. The API consumes the frozen
packages through their public exports and occupies the already designated
`apps/api` placeholder. The two capabilities that would need frozen-layer
changes are both optional for AVEN-005: a session lifecycle (migration or new
event type) and an explicit session-started event (new event type). They were
left unimplemented rather than proposed as changes.

Decisions that need external-review judgment:

1. **Minimal task identities.** Messages are task-bound by the frozen contract,
   so AVEN-005 exposes create/list task identity routes. Accept this, or require
   another binding strategy (for example one implicit task per session)?
2. **Foreign session → `session_not_found`, not `owner_mismatch`.** Chosen for
   non-disclosure and because AVEN-003 session identity is owner-scoped.
   `owner_mismatch` exists only as a defensive Ledger mapping.
3. **Operator-only owner declaration** (no HTTP owner creation), on the grounds
   that identity belongs to Root.
4. **Owner-statement evidence per message**, duplicating the text (section 15).
5. **The obsolete response-status flag** in the receipt (removed in review,
   fix 3) and `modelRuntime: "not_implemented"` in health (kept).
6. **Status mappings**: `storage_failure` → 503; evidence-ID collision →
   `invalid_reference` (422, the Ledger's code) rather than `conflict`.
7. **Server receipt time as `occurredAt`**, with no client-declared occurrence.
8. **`metadata.creation.component = "@aven/api"`** for API-recorded events.
9. `vitest.config.ts` now includes `apps/*/test`; `apps/api/.gitkeep` was
   deleted in review (fix 7).
10. **Owner-origin channel trust** (section 15): the message endpoint is the
    only source of owner-statement evidence, but declared identity means it
    cannot distinguish an owner from a local relay. Is this acceptable until
    Root authentication exists?

## 18. External review and fixes

### First external review (October 4-5, 2026)

An independent reviewer (Claude) reconstructed `8479aa1` from the owner's `.git`
objects, applied the patch in isolation, re-ran every check (305 baseline, 366
patched), ran a real loopback smoke test, roughly 100 additional adversarial
cases (cursors, text round-trip, raw HTTP framing, Host variants, aborts,
shutdown races) and source mutations. Verdict: **ACCEPT WITH REQUIRED FIXES**.
No CRITICAL or HIGH finding. The full review is kept outside the repository with
the project records.

| ID  | Severity | Finding                                                                                                                                                                      |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | MEDIUM   | An empty POST skipped the JSON content-type check, so a browser "simple" cross-site request or HTML form could create permanent sessions and tasks. Messages were protected. |
| M2  | MEDIUM   | The rule that model output must never enter the owner-message endpoint lived only in this report; the API README even said AVEN-006 would "attach" to this boundary.         |
| L1  | LOW      | Global Ledger `sequence` reveals coarse other-owner activity; undocumented.                                                                                                  |
| L2  | LOW      | Static boundary tests missed history/catalog tables and aliased Drizzle inserts (a direct `experience_events` insert passed them).                                           |
| L3  | LOW      | The exported service did not validate page `limit` (only HTTP did).                                                                                                          |
| L5  | LOW      | No regression test for aborted/truncated bodies (manually verified safe).                                                                                                    |
| E   | decision | The obsolete response-status flag would become meaningless or a semantic break once responses exist as separate `assistant_response` events.                                 |

Decisions A-N were judged. All were accepted (task identity routes; foreign
session = `session_not_found`; operator-only owners; one evidence record per
message; health `modelRuntime`; `storage_failure` → 503; `invalid_reference` →
422; server receipt time as `occurredAt`; `metadata.creation.component`;
owner-origin labelling, conditional on M2; no idempotency; no session close; no
session-start event), except E, which was changed to removal. No frozen
architecture, contract, storage, Ledger or EXP-001 change was required.

### Fixes accepted and implemented

1. **Every POST requires `Content-Type: application/json` (M1).** The check runs
   in `http.ts` for every POST route after routing and before the body is read
   or any handler runs, including empty and `{}` session/task creation. A JSON
   content type is not CORS-safelisted, so browsers must preflight, and the
   preflight is refused (405, no CORS headers). A JSON-typed `{}` or empty body
   still creates a session or task. Tests: simple/cross-site POSTs (no content
   type, `text/plain`, urlencoded, multipart; empty and `{}`) to session, task
   and message routes return 415 with a byte-identical database snapshot; the
   preflight is refused; JSON-typed creation and messages still succeed.
2. **Owner/model provenance boundary (M2).** `AGENTS.md` and
   `apps/api/README.md` now state, as a binding forward rule: the owner-message
   endpoint is exclusively for text entered by the owner (`owner_request` +
   `explicit_owner_statement`); model/runtime output must never be relayed
   through it; future AVEN-006 model output must be recorded through a separate
   in-process Ledger path as `assistant_response` with `model_inference`
   provenance; `metadata.creation.component = "@aven/api"` marks owner input
   received through the declared, unauthenticated AVEN-005 channel; declared
   owner origin is not authenticated owner identity. The README sentence about
   AVEN-006 attaching to this boundary was removed. AVEN-006 is not implemented.
3. **The obsolete response-status flag removed** from `MessageReceipt`, the
   implementation, docs and tests. The receipt describes only the durable
   `owner_request`; the HTTP test asserts its exact key set.
4. **Service-level page validation (L3).** `listSessions`, `listTasks` and
   `readHistory` validate `{ limit, cursor }` with the same bounds as HTTP
   (integer 1-200; cursor a 1-1024 character string) and reject zero, negative,
   fractional, NaN, ±Infinity, above-maximum, non-number and non-object input as
   `invalid_request`. HTTP validation is unchanged. One existing test that paged
   history with `limit: 1000` through the service now uses the maximum, 200.
5. **Aborted/truncated body regression tests (L5).** A fixed-length request
   whose received bytes are already valid JSON but shorter than the declared
   length, then reset by the client, records no event, evidence or other row and
   receives no response; a positive control then records the same text. A
   chunked request without its terminating chunk, then half-closed, is not
   acknowledged and changes nothing.
6. **Static tripwires hardened (L2).** Still explicitly regression tripwires,
   not security guarantees. They now enforce per-module named-import allowlists
   (for example only `createServer` and types from `node:http`; no `sql` from
   `drizzle-orm`; no dynamic import or `require`); allow `schema.<table>` only
   for `owners`, `sessions` and `tasks` in files importing the storage schema
   (catching aliasing such as `const t = schema.experienceEvents`), forbid
   destructuring or renaming `schema`, require every `.insert(...)` to name an
   identity table literally, forbid every protected table identifier and SQL
   table name (history, catalog, owner state, candidates, corrections,
   proposals, policy, approvals, executions, verification, evaluations,
   lifecycle), raw SQL entry points, SQL write statements and pragma writes, and
   require exactly one `appendEvent`, on `createLedger(storage, ownerId)`. Each
   rule is also run against known-bad samples so a weakened rule fails.
   Mutations of the real source (aliased `experience_events` insert,
   destructured `evidence` insert, raw SQL into `evidence`, an outbound
   `node:http` `request` import) each fail the tripwires.
7. **`apps/api/.gitkeep` deleted.**
8. **Global sequence documented (L1)** in section 10, section 15 and
   `apps/api/README.md`; behavior unchanged.

### Deferred findings (documented, not fixed)

Duplicate JSON keys are accepted last-wins; equivalent percent-encoded paths are
accepted and decoded consistently; `GET /v1/health` ignores query parameters; a
refused startup against a nonexistent `--db` path leaves an empty SQLite file;
history pages are not size-optimized or streamed; GET request bodies are ignored
and drained by Node; the default port 4317 is also the OTLP gRPC port;
`transaction_active` maps to 503 although it would indicate a defect; identity
listings have no snapshot bound (rows created mid-traversal with an earlier
clock value are not seen by that traversal); a client disconnect mid-body is
logged through `onError` as `internal_error`. Authentication, idempotency,
session close/end, a session-start event and all AVEN-006 work remain out of
scope.

### Revalidation after the fixes

All commands in section 13 pass on Linux (Node 24.21.0, pnpm 11.19.0): 373 tests
in 14 files, 68 of them AVEN-005. A real loopback smoke test against a temporary
migrated database with synthetic owners confirmed: cross-site/simple empty POSTs
to session and task creation return 415 and create nothing; JSON-typed creation
and messages succeed; owner B cannot read, append to or replay a cursor into
owner A's session; owner messages appear only as Ledger `owner_request` events
with owner-statement evidence; an aborted request with a valid-JSON prefix
records nothing; every derived/authority table stays empty; `integrity_check`,
the FK check and Ledger inspection pass. `packages/`, `tooling/`,
`experiments/`, `evals/`, `decisions/`, `docs/sources/`, the principles, project
description, threat model and earlier reports remain byte-identical to
`8479aa1`. No dependency was added. AVEN-006 has not been started.

## 19. Status

No CRITICAL or HIGH issue is known; both MEDIUM findings and the accepted LOW
items are fixed. Re-run
`corepack pnpm install --frozen-lockfile --ignore-scripts` and
`corepack pnpm check` on the Windows checkout before committing. Do not commit,
tag or push before final external verification. Do not start AVEN-006.

**Status: READY FOR FINAL EXTERNAL VERIFICATION**
