# @aven/api

AVEN-005 is Aven's first local interaction boundary: an owner-scoped HTTP API
for sessions, task identities, owner messages and session history. **No model
runs behind the HTTP API.** Accepting a message records it in the Experience
Ledger; nothing answers it, learns from it, or authorizes anything because of
it.

AVEN-006 adds a separate **in-process** assistant-response recorder
(`src/assistant-response.ts`) that invokes an injected
[`@aven/runtime`](../../packages/runtime/README.md) model runtime and records
successful output. It has no HTTP route and is not wired into the server.

## Owner input versus model output (binding for AVEN-006 and later)

- The owner-message endpoint (`POST …/tasks/{taskId}/messages`) is **exclusively
  for text entered by the owner**. Each message is recorded as an
  `owner_request` event with `explicit_owner_statement` provenance, as the
  frozen AVEN-002 contract requires.
- **Model or runtime output must never be relayed through this HTTP endpoint**,
  nor recorded as `owner_request` or owner-statement evidence by any path. Doing
  so would launder model text into owner evidence.
- Model output is recorded only through the **separate in-process AVEN-006
  path** (`createAssistantResponseService`) as an `assistant_response` event
  with `model_inference` provenance and creation component
  `@aven/api/assistant-response`. That path never calls the owner-message
  service or HTTP handler, and the HTTP layer never imports it.
- `metadata.creation.component = "@aven/api"` (with `metadata.creation.version`)
  marks owner input received through this declared, unauthenticated AVEN-005
  channel. A later authenticated channel must be distinguishable by a different
  component or version.
- Declared owner origin is **not authenticated owner identity**. The provenance
  label records which channel and declared owner a statement came from; it does
  not prove who typed it. Authentication belongs to future Root work.

## Layers

```text
HTTP (node:http)          src/http.ts      strict routing, JSON bodies, typed errors
  -> service              src/service.ts   validated operations; builds owner_request events
     -> identity store    src/identity-store.ts   owners/sessions/tasks (Drizzle, owner-keyed)
     -> Experience Ledger @aven/ledger     the only path for historical events
        -> storage        @aven/storage    SQLite schema, triggers, migrations

in-process caller (no HTTP route)
  -> assistant-response   src/assistant-response.ts  builds assistant_response events
     -> model runtime     @aven/runtime    injected; generates text, owns no storage
     -> identity store / Experience Ledger (read-only checks, then one append)
```

No new registry dependency. `drizzle-orm` (already locked for storage) provides
typed identity queries. The HTTP layer is Node's built-in `http` module.

## Running locally

```sh
pnpm db:migrate                                  # creates/migrates data/aven.sqlite
pnpm api:start --owner owner_local               # declares the owner, listens on 127.0.0.1:4317
```

Options: `--db <path>`, `--host 127.0.0.1|::1|localhost`, `--port <n>`,
`--owner <ownerId>` (repeatable, idempotent). The server refuses non-loopback
hosts and refuses a database whose schema version does not match the shipped
migrations; it never migrates implicitly. `SIGINT`/`SIGTERM` stop the listener,
wait for in-flight requests, then close storage. There are no credentials,
telemetry or outbound connections.

## Endpoints

All routes are under `/v1`. The owner is a **declared** path value, not an
authenticated principal.

| Method | Path                                                                    | Result                                             |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| GET    | `/v1/health`                                                            | Static metadata (`modelRuntime: not_implemented`). |
| POST   | `/v1/owners/{ownerId}/sessions`                                         | 201 `{ session }`. JSON body `{}` (or empty).      |
| GET    | `/v1/owners/{ownerId}/sessions?limit&cursor`                            | 200 `{ sessions, nextCursor }`.                    |
| GET    | `/v1/owners/{ownerId}/sessions/{sessionId}`                             | 200 `{ session }`.                                 |
| POST   | `/v1/owners/{ownerId}/sessions/{sessionId}/tasks`                       | 201 `{ task }`. JSON body `{}` (or empty).         |
| GET    | `/v1/owners/{ownerId}/sessions/{sessionId}/tasks?limit&cursor`          | 200 `{ tasks, nextCursor }`.                       |
| POST   | `/v1/owners/{ownerId}/sessions/{sessionId}/tasks/{taskId}/messages`     | 201 receipt. Body exactly `{ "text": string }`.    |
| GET    | `/v1/owners/{ownerId}/sessions/{sessionId}/history?limit&cursor&taskId` | 200 `{ events, nextCursor }` in Ledger order.      |

`limit` is an integer 1-200 (default 50 over HTTP); the exported service
enforces the same bounds for direct callers and rejects anything else (zero,
negative, fractional, NaN, Infinity, above 200, non-numbers) as
`invalid_request`. `cursor` is the opaque `nextCursor` from the previous page;
it is bound to the exact owner/session/task listing that issued it and is
rejected elsewhere. A history traversal is bounded at its first page, so later
appends never shift or duplicate entries mid-traversal.

A message receipt is
`{ accepted, ownerId, sessionId, taskId, eventId, evidenceId, eventType: "owner_request", sequence, occurredAt, recordedAt }`
and is returned only after the Ledger transaction commits. It describes only the
durable `owner_request`; it carries no response or response-status field.
History entries are the canonical `{ sequence, event, evidence }` Ledger
records.

`sequence` is the Ledger's **database-global** committed order, shared by all
owners (frozen AVEN-003/004 behavior, unchanged here). Gaps between one owner's
sequence values can therefore reveal coarse activity by other owners in the same
database (how many events, roughly when). No other-owner content, ID or text is
exposed by this alone. Revisit during authenticated multi-owner / Root work.

Owner messages are task-bound because the frozen AVEN-002 `owner_request`
contract requires a `{ sessionId, taskId }` binding. Tasks here are bare
identities (ID, session, creation time); there is no task objective, status or
management. Sessions have no close/end lifecycle because the frozen AVEN-003
schema has none.

Every request object and query string is strict: unknown fields, repeated
parameters, query parameters on write routes, and non-canonical paths (dot
segments, absolute-form targets) are rejected, so a client cannot supply `role`,
`provenance`, `eventType`, `ownerId`, `trusted`, `approved` or similar fields.
**Every POST must carry `Content-Type: application/json`**, including session
and task creation whose body is `{}` or empty; anything else is 415 before the
body is read or any handler runs. This keeps every write out of reach of browser
"simple" cross-site requests and HTML forms (they cannot set that type without a
CORS preflight, and preflight `OPTIONS` is refused). Bodies are at most 256 KiB;
text is 1-65,536 UTF-16 units with at least one non-whitespace character,
well-formed Unicode, stored verbatim. There are no PUT, PATCH or DELETE routes.

## AVEN-006 assistant-response recorder (in-process only)

```ts
const responses = createAssistantResponseService(storage, { runtime });
const receipt = await responses.generateResponse(
  {
    ownerId,
    sessionId,
    taskId,
    request: { messages: [{ role: 'user', content: '…' }] }, // already assembled
    derivedFrom: [{ evidenceId, eventId }], // recorded evidence the input came from
    sourceCoverage: 'complete', // or 'partial' / 'unknown'
  },
  { signal, timeoutMs }, // optional
);
```

`derivedFrom` and `sourceCoverage` are **declared claims**: the recorder checks
that each reference exists for this owner, not that the input was actually
derived from it or that coverage is complete. `timeoutMs` rejects output
produced after the deadline, but cannot preempt a runtime's synchronous work.

The runtime is injected and explicit; there is no router. The call validates
input, checks owner/session/task and that every `derivedFrom` reference resolves
for this owner (read-only), invokes the runtime, accepts only a strictly valid
result, then appends **one** `assistant_response` event plus one evidence record
of the response text, both with `model_inference` provenance carrying the
reported `ModelConfiguration`, `derivedFrom` and `sourceCoverage`.
`metadata.creation.runtime` records the reported runtime identity.
`payload.citedEvidence` is empty: model text is never parsed for citations or
claims. The caller cannot choose the event type, provenance kind, owner origin,
model identity or citations.

The receipt (returned only after COMMIT) carries the event/evidence IDs,
sequence, times, text, runtime and model identity, `finishReason` (or `null`),
`requestedAt`, and frozen AVEN-002 `ModelResponseMetadata` (call ID, status,
provider-reported usage when supplied). Usage, finish reason, call ID and
`requestedAt` are **not persisted**: the frozen `assistant_response` contract
has no field for them.

Failures are `AssistantResponseError { code, stage, recorded: false }`:
`validation` (nothing invoked or written: `invalid_request`,
`binding_not_found`, or `recording_failure` when storage is unavailable),
`invocation` (runtime codes `runtime_unavailable`, `runtime_timeout`,
`runtime_aborted`, `runtime_failure`, `malformed_runtime_result`, or an
implementation-reported `invalid_request`; nothing written), and `recording`
(`recording_failure`: output was generated but **not** durably recorded and is
not returned). Invocation is not transactional with SQLite; there is no retry,
idempotency or exactly-once invocation.

## Errors

Every HTTP failure is `{ "error": { "code", "message" } }` with a fixed message
per code; internal causes go only to the optional `onError` hook.

| Code                     | HTTP | Meaning                                                                 |
| ------------------------ | ---- | ----------------------------------------------------------------------- |
| `invalid_request`        | 400  | Malformed JSON/query, unknown field, bad text, foreign cursor.          |
| `invalid_identifier`     | 400  | A path or query ID fails its AVEN-002 ID syntax.                        |
| `unsupported_media_type` | 415  | A POST without `Content-Type: application/json`.                        |
| `payload_too_large`      | 413  | Body above 256 KiB.                                                     |
| `host_not_allowed`       | 403  | `Host` header is not a loopback name (DNS-rebinding guard).             |
| `route_not_found`        | 404  | No such route.                                                          |
| `method_not_allowed`     | 405  | Route exists; method does not (`Allow` header set).                     |
| `owner_not_found`        | 404  | Owner not declared in this database.                                    |
| `session_not_found`      | 404  | No such session **for this owner** (foreign = missing).                 |
| `task_not_found`         | 404  | No such task in this owner's session.                                   |
| `owner_mismatch`         | 403  | Ledger saw a foreign owner claim (defensive; not reachable by clients). |
| `invalid_reference`      | 422  | Ledger binding/reference failure.                                       |
| `conflict`               | 409  | Identifier already exists; nothing changed.                             |
| `storage_failure`        | 503  | Storage unavailable/busy/closed; nothing acknowledged.                  |
| `ledger_failure`         | 500  | Ledger rejected or could not complete; nothing acknowledged.            |
| `internal_error`         | 500  | Unexpected defect.                                                      |

## Limits

This is a local development boundary, not production network security. Owner
identity is declared, not authenticated; any local process that can reach the
loopback port, or open the database file, can act as any declared owner. The
`Host` check and the JSON content-type requirement on every POST only reduce
browser-based cross-site and DNS-rebinding exposure; they are not
authentication. There is no idempotency key: a retried submission records a
second, distinct event, and a message can be durable even if its client never
receives the 201 (reconcile through history). Sequence values are
database-global (see above). See `docs/AVEN_005_REPORT.md` and
`docs/AVEN_006_REPORT.md`.
