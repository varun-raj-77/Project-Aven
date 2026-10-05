# AVEN-006 report: model/runtime abstraction

Status: **implemented; independent external review (Codex) returned ACCEPT WITH
REQUIRED FIXES (0 CRITICAL, 0 HIGH, 3 MEDIUM, 1 LOW, no architecture change).
The accepted fixes are applied (section 21). Awaiting final external
verification. Not committed, tagged, pushed or frozen.** AVEN-007 was not
started.

## 1. Milestone purpose

AVEN-006 asks: can Aven invoke a replaceable model runtime through one stable,
provider-neutral boundary, and record successful model output in the Experience
Ledger with correct model provenance, without confusing that output with owner
input, learned state, authority, or tool execution?

This is a runtime-boundary milestone, not a personalization milestone. It
establishes the replaceable runtime boundary and a correct durable
model-inference recording path. **It does not provide real model-provider
network access.** AVEN-007 builds the strong Naive Personalized baseline and may
add the first justified live-model adapter behind this interface.

Source precedence: the Master Project Description (2026-10-03), sections 2
("Model independence"), 7.1 (model routing, deferred) and 19 (AVEN-006 =
model/runtime abstraction; framework adapters optional), then the older
implementation instructions section 16, then the task's explicit instructions.
No Strands or other framework adapter is added.

## 2. Baseline

`f28994ac6a199d95ce55c2ea8820afeb6e7f4b50` = `main` = `origin/main` = tag
`aven-005` ("feat: add AVEN-005 local chat and session API"), clean working tree
apart from the untracked `Claude outputs/` directory, which was not read,
modified, staged or incorporated. Baseline `pnpm check`: 373 tests passing.

## 3. Architecture added

```text
caller / future orchestration (in-process)
   │  createAssistantResponseService(storage, { runtime })      apps/api
   │  .generateResponse({ ownerId, sessionId, taskId, request,
   │                      derivedFrom, sourceCoverage }, { signal, timeoutMs })
   ▼
validate input → identity/lineage read-only checks (no invocation on failure)
   ▼
invokeModelRuntime(runtime, request, options)                    packages/runtime
   ▼   validates request · AbortSignal/timeout · normalizes errors
ModelRuntime.invoke(request, { signal })   ← replaceable implementation
   ▼   (scripted test runtime today; future provider adapter)
ModelRuntimeResult (strictly validated, frozen)
   ▼
assistant-response recorder  ──createLedger(storage, ownerId).appendEvent──▶ Experience Ledger
   assistant_response + model_inference (+ one model_inference evidence record)
```

The runtime generates; the Ledger records. The runtime package has no storage,
Ledger, SQLite, owner, Root, permission or tool access. The recorder owns
identity/lineage checks and the single append. There is no new HTTP route.

The owner path is unchanged:

```text
POST …/tasks/{taskId}/messages → owner_request + explicit_owner_statement   (AVEN-005, frozen)
ModelRuntime → result → separate in-process recorder → assistant_response + model_inference
```

## 4. Files changed

New:

- `packages/runtime/package.json`, `tsconfig.json`, `README.md`
- `packages/runtime/src/types.ts`: request/output/result schemas and the
  `ModelRuntime` interface
- `packages/runtime/src/errors.ts`: `ModelRuntimeError` and the 6 normalized
  codes
- `packages/runtime/src/invoke.ts`: `invokeModelRuntime`, `InvokeOptionsSchema`
- `packages/runtime/src/scripted.ts`: test-only scripted runtime
  (`@aven/runtime/testing`)
- `packages/runtime/src/index.ts`: production entry point (no scripted runtime)
- `packages/runtime/test/runtime.test.ts`, `boundaries.test.ts`, `fixtures.ts`
- `apps/api/src/assistant-response.ts`: in-process assistant-response recorder
- `apps/api/test/assistant-response.test.ts`
- `tooling/tests/frozen-layers.test.ts`
- `docs/AVEN_006_REPORT.md` (this file)

Modified:

- `apps/api/src/index.ts`: re-exports the recorder (additive)
- `apps/api/package.json`: `@aven/runtime` workspace dependency; description
- `apps/api/test/boundaries.test.ts`: AVEN-005 tripwires made per-path
  (section 15)
- `package.json`: root `typecheck`/`check` include `packages/runtime`;
  description
- `pnpm-lock.yaml`: two workspace importer entries only (`apps/api` →
  `@aven/runtime` link; `packages/runtime` importer). No new registry package.
- `README.md`, `AGENTS.md`, `docs/ROADMAP.md`, `apps/api/README.md`

Deleted: `packages/runtime/.gitkeep` (AVEN-001 placeholder, obsolete now that
the package has real files; external review LOW cleanup, section 21).

Unchanged:
`apps/api/src/{service,http,server,cli,errors,schemas,identity-store}.ts`, every
file in `packages/contracts`, `packages/storage` (including the migration) and
`packages/ledger`, EXP-001, earlier reports, principles, project doctrine and
threat model.

## 5. ModelRuntime interface semantics

```ts
interface ModelRuntime {
  invoke(
    request: ModelRuntimeRequest,
    invocation: { signal: AbortSignal },
  ): Promise<ModelRuntimeOutput>;
}
```

- **Request** `{ messages: { role: 'system'|'user'|'assistant'; content }[] }`,
  1-1000 messages, non-blank content, strict. It carries only already-assembled
  model input: no owner/session/task ID, permission, approval, Root, tool,
  learned state, provider name, model selection or sampling parameter (all
  rejected as unknown keys). `role` is conversation position, not provenance.
  Generation parameters belong to the runtime configuration so that the reported
  `configurationId` remains truthful. No retrieval, ranking, scope inference or
  personalization (Context Broker = AVEN-008).
- **Output** (implementation-returned, strict)
  `{ text, runtime, model, finishReason?, usage? }` reusing frozen AVEN-002
  schemas: `RuntimeStamp` (`runtime`), `ModelConfiguration` (`model`), `Usage`
  (`usage`), and `NonEmptyText` (`text`). No new contract duplicates an existing
  one.
- **Result** frozen `{ status: 'completed', ...output }`.
- `invokeModelRuntime` is the single normalizing entry point (validation,
  cancellation, error normalization, strict output validation). Provider
  request/response shapes stay inside implementations; a test proves a
  hand-written class works identically to the scripted runtime.

## 6. Deterministic runtime semantics

`createScriptedModelRuntime({ model, runtime?, script })` from
`@aven/runtime/testing` (never from the production entry). Steps: `respond`
(exact configured text, optional `finishReason`/`usage`), `fail` (normalized
code), `throw` (raw value, as a buggy adapter might), `malformed` (arbitrary
value), `pending` (settles only on abort). A script may be an array or a
`(request, call) => step` function. It records the frozen requests received. An
exhausted script fails as `runtime_failure`. No clock, randomness, network,
credential or storage. It is test infrastructure, not production model logic.

## 7. Assistant-response recording path

`createAssistantResponseService(storage, { runtime, now?, generateId? })` →
`generateResponse(input, { signal?, timeoutMs? })`:

1. **Validate** input strictly: owner/session/task IDs, model request,
   `derivedFrom: EvidenceReference[]` (≤1000, unique), and `sourceCoverage` (the
   frozen `model_inference` enum). The caller cannot choose event type,
   provenance kind, owner origin, model identity or citations.
2. **Check** that the owner/session/task binding exists (`requireTask`) and that
   every `derivedFrom` reference resolves to an existing evidence record of that
   event for this owner (read-only Ledger `getEvent`). On failure the runtime is
   **not invoked**.
3. **Invoke** the injected runtime via `invokeModelRuntime`.
4. **Accept** only a strictly valid result; re-check the caller's signal.
5. **Record** (synchronously, no `await`): allocate IDs, build one
   `assistant_response` event and one `recorded_text` evidence record, both with
   the same `model_inference` provenance; build and validate the frozen
   `ModelResponseMetadata` **before** appending, so nothing can fail after
   COMMIT; then call `createLedger(storage, ownerId).appendEvent(...)` once.
6. **Return** a frozen receipt only after the append commits.

The recorded event:

| Field                      | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `eventType`                | `assistant_response`                                                       |
| `task`, `payload.task`     | the validated `{ sessionId, taskId }`                                      |
| `payload.response`         | the model text, verbatim                                                   |
| `payload.citedEvidence`    | `[]` (model text is never parsed for citations)                            |
| `provenance`               | `{ kind: 'model_inference', model, derivedFrom, sourceCoverage }`          |
| `evidenceIds`              | one ID: recorded text of the response, same provenance                     |
| `metadata.creation`        | `{ component: '@aven/api/assistant-response', version: '0.1.0', runtime }` |
| `occurredAt` / `createdAt` | the recorder clock when the result was accepted                            |

The direct Ledger API is used; no historical row, projection, evidence or
catalog table is written directly. `assistant_response` has no derived-record
projection in the frozen Ledger, so no owner-state or authority table changes.

## 8. Owner/model provenance separation

- Model output is never relayed through `POST …/messages`; the recorder does not
  import the owner service or HTTP modules, and the HTTP layer does not import
  the recorder (static tripwires plus runtime tests).
- Model output never receives `explicit_owner_statement` provenance. The frozen
  contract already forces `model_inference` for `assistant_response`, and the
  Ledger already refuses owner-origin evidence on a model event (AVEN-004).
  Owner text that informed the invocation appears only as `derivedFrom` lineage.
  A test where the model repeats the owner's text verbatim still records
  `model_inference`, and the earlier `owner_request` is unchanged.
- `metadata.creation.component` is `@aven/api/assistant-response`, distinct from
  `@aven/api`, which continues to mark owner input from the declared AVEN-005
  channel.
- Model output never becomes an owner fact, preference, correction, approval,
  permission, learned state, policy decision, tool result or verification
  result. Tests with approval/permission/Root/action text, owner-preference,
  "remember" and "correction" claims, and a JSON blob imitating an
  `owner_approval` event leave all 12 derived/authority tables empty. The only
  event types present are `owner_request` and `assistant_response`.

## 9. Runtime-result metadata

| Item                                                   | Durable (Ledger)                                    | Returned (receipt)                          |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------- |
| Output text                                            | `payload.response` + evidence text                  | `text`                                      |
| Provider/model/version/config                          | `provenance.model` (frozen `ModelConfiguration`)    | `model`                                     |
| Runtime implementation identity                        | `metadata.creation.runtime` (frozen `RuntimeStamp`) | `runtime`                                   |
| Input lineage                                          | `provenance.derivedFrom`, `sourceCoverage`          | (in the event)                              |
| Resulting historical event                             | event/evidence ID, sequence                         | `eventId`, `evidenceId`, `sequence`         |
| Occurrence/record time                                 | `occurredAt`, `recordedAt`                          | same                                        |
| Request time                                           | not persisted                                       | `requestedAt`                               |
| Call ID, status, usage (tokens, provider elapsed time) | not persisted                                       | `response` (frozen `ModelResponseMetadata`) |
| Finish reason                                          | not persisted                                       | `finishReason` or `null`                    |
| Failure category                                       | nothing is written on failure                       | `AssistantResponseError.code/stage`         |

Nothing is fabricated: `usage` and `finishReason` appear only when the runtime
supplied them; Aven does not measure elapsed time itself. All four
`ModelConfiguration` fields are required by the frozen contract, so a runtime
must declare them; they are recorded as **reported claims of the runtime's
configuration**, not verified facts. No hidden reasoning or chain-of-thought is
accepted (`reasoning`/`thinking` fields make the result malformed) or stored.

## 10. Error and cancellation semantics

Runtime codes (`ModelRuntimeError`, fixed public message per code):
`invalid_request`, `runtime_unavailable`, `runtime_timeout`, `runtime_aborted`,
`runtime_failure`, `malformed_runtime_result`. Foreign throws become
`runtime_failure`. The original error is kept only in `cause`, which is never
written to the Ledger or a public message (tests check that a thrown provider
error containing a credential-like string does not reach `message`,
`String(error)` or `JSON.stringify(error)`).

Recorder errors (`AssistantResponseError { code, stage, recorded: false }`) add
`binding_not_found` and `recording_failure`:

| Stage        | Meaning                                         | Codes                                                                                   |
| ------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `validation` | nothing invoked, nothing written                | `invalid_request`, `binding_not_found`, `recording_failure` (storage/clock unavailable) |
| `invocation` | runtime invoked or attempted; nothing written   | the runtime codes (an implementation may itself report `invalid_request`)               |
| `recording`  | output generated and accepted, **not recorded** | `recording_failure`                                                                     |

Cancellation uses standard `AbortSignal`. An already-aborted signal invokes
nothing. Abort or `timeoutMs` while pending returns promptly even if the
implementation ignores its signal, aborts the signal passed to the
implementation, and discards any late result or rejection. `timeoutMs` is also a
monotonic deadline (`performance.now()`), checked before any outcome is
accepted: **synchronous runtime work cannot be forcibly preempted in-process**,
but any result (or rejection) produced after the deadline is reported as
`runtime_timeout` and never reaches the recorder, so no `assistant_response` is
recorded (section 21, M1). A `ModelRuntimeError` whose `code` is not one of the
six allowed values at runtime is normalized to `runtime_failure` (M2). An abort
that races a successful result before acceptance wins (`runtime_aborted`,
nothing recorded). After acceptance, recording is synchronous, so cancellation
cannot interleave; once appended, a later abort has no effect. No retry,
failover, streaming or provider fallback.

## 11. Failure and persistence atomicity limitations

A model invocation, local or remote, cannot be transactional with SQLite.

- failed / timed-out / aborted / malformed invocation → no event (tested by
  byte-identical database snapshots);
- successful result + successful append → durable response, receipt returned;
- successful result + failed append → `recording_failure` at stage `recording`;
  the Ledger rolls back, no partial event/evidence/projection remains (tested
  with a foreign open transaction, a duplicate event ID, a future occurrence
  time, an invalid ID allocation and a closed connection). The generated text is
  **not** returned, so a caller cannot present unrecorded output as recorded.

So "the model generated output but persistence failed" is a distinct, explicit
outcome. There is no exactly-once invocation, idempotency key or automatic
retry: retrying calls the model again and may record a different response.
Concurrent calls for the same task are independent appends.

## 12. Security and secrets posture

- No API key, credential, account or network access is needed or used. The
  service options are only `runtime`, `now`, `generateId`.
- The runtime package has no environment, network, process, storage or
  provider-SDK access (static tripwires). Its only dependencies are
  `@aven/contracts` and `zod`.
- Results are strict: headers, raw provider responses and credential fields are
  rejected. Identity strings must match a short identifier pattern and must not
  look like credentials (`sk-` prefixes, `api_key`, `secret`, `password`,
  `bearer`, `authorization`, `credential`). This is a tripwire, not a secret
  scanner.
- A test scans the full database after success and two rejected leaky results
  for credential-like strings.
- **Future provider adapters must receive secrets from external
  operator/Root-owned configuration, never from the Ledger, owner memory, model
  input or runtime metadata, and must not persist them.** Root is not
  implemented.

## 13. Explicit non-goals (not implemented)

AVEN-007, naive personalized baseline, eval dataset, Context Broker, Typed Owner
Model, corrections, learning, model routing heuristics, Strands, any live
provider adapter (OpenAI, Anthropic, Gemini, Ollama/local), tool/function
calling, agent loops, WebSocket/token streaming, retry/failover, billing/cost
accounting, Root, authentication changes, permissions, approvals, action
execution, self-improvement, fine-tuning, voice, UI, and a public generation
HTTP route. The health field `modelRuntime: "not_implemented"` is unchanged: the
HTTP server wires no runtime.

## 14. Tests and counts

| File                                       | Tests                       | Covers                                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/test/runtime.test.ts`    | 25                          | A, D, I, cancellation: normalized frozen results, replaceability, strict request/option/output validation, error normalization and non-leakage, abort/timeout/late results, scripted determinism; M1 monotonic deadline (3); M2 code sanitization (2) |
| `packages/runtime/test/boundaries.test.ts` | 5                           | J, I: import allowlist, no storage/network/env/provider capability, no Ledger/provenance/authority knowledge; M3 no direct or transitive test-runtime dependency in any production module; test runtime only via the testing export                   |
| `apps/api/test/assistant-response.test.ts` | 22                          | B, C, D, E, F, G, I: provenance and binding, separation from `/messages`, atomicity on every failure path, no authority/learning, swappability, secrets, concurrency; M1/M2 recorder regressions (2)                                                  |
| `apps/api/test/boundaries.test.ts`         | 7 (was 5)                   | per-path owner/model tripwires (section 15)                                                                                                                                                                                                           |
| `tooling/tests/frozen-layers.test.ts`      | 2                           | H: frozen contracts/storage/migration/Ledger/EXP-001 byte-identity                                                                                                                                                                                    |
| **Total**                                  | **429** (373 baseline + 56) | all other AVEN-001…005 tests unchanged and passing; the reviewed candidate had 421                                                                                                                                                                    |

Mutation checks (each applied to the source, tests run, then reverted): owner
provenance on model output; the `@aven/api` component marker; skipping the
binding pre-check; skipping the lineage pre-check; dropping `derivedFrom`;
non-strict output schema; removing the secret-like identity check; awaiting the
implementation instead of racing the abort; rethrowing raw provider errors;
skipping output validation; reporting a recording failure as success; importing
the runtime into the owner path; importing the recorder into HTTP; passing the
caller's mutable request to the runtime. **All 14 were caught.** The "ignore
abort" mutation initially survived because cooperative runtimes still rejected
on abort; two tests were tightened to require a prompt return when the
implementation ignores its signal.

## 15. Static regression guards (tripwires, not a security boundary)

The AVEN-005 rule "no `assistant_response`/`model_inference` anywhere in
`apps/api/src`" is obsolete for AVEN-006. It was replaced, not deleted, by
precise per-path rules, each with known-bad self-tests:

- `service.ts` (owner input): only `owner_request` and
  `explicit_owner_statement`; no other provenance; no runtime terms
  (`@aven/runtime`, `ModelRuntime`, `generateResponse`, `assistant-response`).
- `assistant-response.ts` (model output): only `assistant_response` and
  `model_inference`; no owner/approval/correction/tool/system/external
  provenance; no owner-message service/HTTP import or call; no test runtime.
- every other API module: no event or provenance construction; only
  `assistant-response.ts` imports `@aven/runtime`; HTTP/server/CLI never
  reference the recorder (only `index.ts` re-exports it).
- exactly two `appendEvent` calls in `apps/api/src`, one per path, each
  `createLedger(storage, ownerId).appendEvent(`.
- unchanged: direct-write, protected-table, raw-SQL, outbound-network and
  provider-name rules; `@aven/runtime` is allowlisted by exact names, while
  `@aven/runtime/testing` is not.

Plus the runtime package tripwires and the frozen-layer hash tripwire. All are
pattern checks over source text and can be bypassed deliberately; behavior is
evidenced by the runtime tests.

## 16. Frozen-layer comparison

`git diff` against `f28994a` is empty for `packages/contracts/**`,
`packages/storage/**` (including `migrations/0001_storage.sql`),
`packages/ledger/**`, `experiments/**`, `docs/AVEN_00{2,3,4,5}_REPORT.md`,
`docs/MAINT_001_REPORT.md`, `docs/AVEN_PRINCIPLES.md`,
`docs/PROJECT_DESCRIPTION.md`, `docs/THREAT_MODEL.md` and `docs/sources/**`. The
AVEN-005 owner-input implementation (`service.ts`, `http.ts`, `server.ts`,
`cli.ts`, `errors.ts`, `schemas.ts`, `identity-store.ts`) and all AVEN-005
service/HTTP/server tests are unchanged and pass.
`tooling/tests/frozen-layers.test.ts` pins SHA-256 for the 37 frozen source,
migration, manifest and EXP-001 files and fails if a file is changed or added in
those directories.

## 17. Known limitations

1. Usage, finish reason, call ID and request time are returned but not
   persisted: the frozen `assistant_response` contract and storage have no place
   for `ModelResponseMetadata`. Durable per-invocation observability is
   therefore limited to model configuration, runtime stamp, lineage and times.
2. Lineage is caller-declared. The recorder verifies that each `derivedFrom`
   reference exists for this owner (and the Ledger re-verifies), but it cannot
   prove the request messages were derived from those records. Lineage is
   owner-scoped, not restricted to the same session/task.
3. Model/runtime identity is self-reported by the implementation and not
   verified against a provider.
4. `citedEvidence` is always empty; no citation extraction.
5. Whitespace-only model output is rejected as malformed (frozen
   `NonEmptyText`), so an empty answer cannot be recorded. Output length is not
   capped.
6. The identifier pattern may reject some legitimate provider model names that
   contain characters outside `[A-Za-z0-9._:/@+-]` or exceed 128 characters.
7. No idempotency or exactly-once invocation; a retry records a new response.
8. The database-global Ledger `sequence` leak documented in AVEN-005 also
   applies to `assistant_response` receipts.
9. Validation in this session ran on a Linux replica (section 19). The external
   reviewer validated the pre-fix candidate (421 tests) on Windows; the fixed
   candidate still needs a Windows `install` + `check`.
10. In-process timeouts cannot preempt synchronous JavaScript. A runtime that
    blocks the event loop delays the caller until it yields; its output is then
    rejected as `runtime_timeout`. Hard preemption would need a worker or
    process boundary, which is out of scope.
11. Aborting immediately after calling `invokeModelRuntime` (before its
    scheduled microtask runs) still invokes the implementation once with an
    already-aborted signal. The call rejects and nothing is recorded; avoiding
    that wasted provider call is a deferred efficiency improvement.
12. Lineage and `sourceCoverage` are declared claims: cross-session, cross-task,
    assistant-response and irrelevant same-owner sources, and empty lineage with
    `sourceCoverage: complete`, are accepted. Consumers must not treat them as
    verified causality or completeness.

## 18. Decisions needing external-review judgment

A. Recorder placement in `apps/api` (beside the identity store it needs) rather
than a new orchestration package. B. One `recorded_text` evidence record per
response with the same `model_inference` provenance (mirrors AVEN-005 decision
D, so a later correction or citation can reference the response). C.
`metadata.creation.component = "@aven/api/assistant-response"` and
`creation.runtime` = reported runtime stamp. D. Returning, but not persisting,
usage/finish reason/call ID (limitation 1), instead of proposing a contract
change now. E. Requiring all four `ModelConfiguration` fields from every runtime
(the contract requires them) and treating them as declared configuration. F.
Request shape: three roles, no per-request generation parameters or output token
limit. G. Identifier pattern and secret-like denylist for runtime/model
identity. H. `recording_failure` at stage `validation` for storage unavailable
before invocation (reusing the code instead of adding a new one). I. Not
returning generated text when recording fails. J. Health
`modelRuntime: "not_implemented"` left unchanged. K. The new frozen-layer hash
tripwire test, which later authorized changes must update deliberately. L.
`packages/runtime/.gitkeep`: resolved by deletion after review.

## 19. Validation environment and commands

This session had no shell on the owner's Windows computer. All 123 tracked files
were copied from the owner's checkout into a Linux workspace, their git blob
SHA-1 values were verified against the owner's `.git/index` (0 mismatches), and
a local git baseline was created from them. Commands then ran there with Node
24.21.0 and pnpm 11.19.0 (Corepack). Results are recorded in the handoff. The
owner-machine commands to re-run are:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm experiment:check
corepack pnpm --filter @aven/runtime test
corepack pnpm --filter @aven/api test
corepack pnpm --filter @aven/ledger test
corepack pnpm db:test
corepack pnpm test
corepack pnpm check
git diff --check
git status --short
git diff --stat
```

## 20. Architecture-change proposals

None. The frozen contracts express every required AVEN-006 semantic
(`assistant_response`, `model_inference`, `ModelConfiguration`, `RuntimeStamp`,
`Usage`, `ModelResponseMetadata`, `EvidenceReference`). The only gap, durable
per-invocation usage/status metadata, is documented as a limitation (decision
D), not a correctness blocker.

## 21. External review and fixes

### Independent review (Codex, October 5, 2026)

Codex reviewed the candidate patch (SHA-256
`0d928adb0a0d336efeb10f9fc967e261306277523839454527edf8af9149e06c`) in an
independent Windows clone at `f28994a` (Node 24.19.0, pnpm 11.19.0). All
requested commands passed with 421 tests. It ran 22 adversarial scenario groups
and 16 source mutations. Verdict: **ACCEPT WITH REQUIRED FIXES**. There were 0
CRITICAL and 0 HIGH findings, no architecture change was required, and frozen
layers were confirmed byte-identical (65 files). The frozen-layer hash tripwire
was judged useful and retained. Lineage and reported model identity were
accepted as declared claims, as documented.

| ID  | Severity | Finding                                                                                                                                                                                                                     |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | MEDIUM   | The timeout was only a timer callback. A runtime blocking ~40 ms synchronously with `timeoutMs: 5` resolved before the timer ran, and the response was accepted and durably recorded.                                       |
| M2  | MEDIUM   | `ModelRuntimeError.code` was trusted after `instanceof`. A JavaScript adapter throwing `new ModelRuntimeError('<arbitrary string>')` produced a recorder error carrying that enumerable code (visible in `JSON.stringify`). |
| M3  | MEDIUM   | The test-runtime guard checked only `index.ts`. Importing `createScriptedModelRuntime` from `./scripted.ts` into production `invoke.ts` passed all 421 tests and the full `check`.                                          |
| L   | LOW      | `packages/runtime/.gitkeep` remained although the package has real files.                                                                                                                                                   |

Deferred by the reviewer and not implemented here: avoiding invocation after an
immediately scheduled cancellation, stronger semantic lineage verification,
provider identity authentication, durable usage/finish reason/call ID/request
time, and exactly-once invocation (see limitations 1-3, 7, 11, 12).

### Fixes applied

1. **M1: monotonic deadline (`packages/runtime/src/invoke.ts`).** The timer is
   kept, so pending asynchronous work is still interrupted and the
   implementation's signal still aborts. A `performance.now()` deadline is now
   checked at three points: when the implementation rejects or throws, when its
   result arrives, and after output validation, before the result is returned.
   An expired deadline yields `runtime_timeout` and aborts the implementation's
   signal, and the output never reaches the recorder. This does **not** preempt
   synchronous JavaScript (limitation 10). Regressions:
   - runtime: Codex's exact case (40 ms block, `timeoutMs: 5`) →
     `runtime_timeout`;
   - runtime: non-async implementations that block, then resolve, return
     malformed output, or throw → `runtime_timeout`;
   - runtime: blocking work within the deadline is still accepted;
   - recorder: the same blocking runtime → `runtime_timeout` at stage
     `invocation`, with a byte-identical database snapshot (all tables including
     events, evidence and catalog, plus `sqlite_sequence`, so no sequence
     movement).
2. **M2: runtime code validation (`errors.ts`, `invoke.ts`,
   `apps/api/src/assistant-response.ts`).** Three layers now apply
   `isModelRuntimeErrorCode`, the existing source of truth for the six codes:
   - the `ModelRuntimeError` constructor maps any invalid runtime value to
     `runtime_failure`;
   - `invokeModelRuntime` revalidates the code of any caught
     `ModelRuntimeError`, which covers mutation after construction and forged
     prototype objects;
   - the recorder revalidates before building its own error.

   The original exception stays only in the non-enumerable `cause`. Regressions:
   - an invalid constructor code, a valid error with a mutated code, and a
     forged prototype object all surface only `runtime_failure` with the fixed
     message;
   - the arbitrary value is absent from `JSON.stringify`, enumerable values and
     `String(error)`, and enumerable keys are exactly `name` and `code`;
   - recorder-level: invalid and mutated codes → `runtime_failure` with no
     Ledger change.

3. **M3: production test-runtime guard
   (`packages/runtime/test/boundaries.test.ts`).** Every module in `src/` other
   than `scripted.ts` is treated as production. For each one, the guard rejects:
   - any static import, re-export (`export … from`), type import or dynamic
     import of `./scripted[.ts|.js]` or `@aven/runtime/testing`;
   - any `scripted`/`fake`/`mock`/`stub` reference;
   - test-only code reachable through a chain of local imports/re-exports (a
     small reachability walk, not a static-analysis framework).

   The guard also pins the production module set. Codex's exact surviving
   mutation and a transitive three-module re-export chain are permanent
   known-bad fixtures. The testing export (`@aven/runtime/testing` →
   `scripted.ts`) is unchanged. These remain regression tripwires, not security
   guarantees.

4. **LOW:** `packages/runtime/.gitkeep` deleted.

### Defect reproduction against the fixes

Each fix was reverted in the source, the runtime and API suites were run, and
the source was restored:

- All three M1 deadline checks removed (the reviewed candidate's behavior): 3
  tests fail, including the recorder test that would otherwise durably record
  the late response.
- Only the rejection-path check removed: 1 test fails.
- Only the result-arrival check removed: 1 test fails.
- Only the post-validation check removed: no test fails. It is defense in depth
  for validation itself exceeding the deadline, which cannot be reproduced
  cheaply and deterministically.
- M2 constructor and wrapper validation both reverted: 2 tests fail.
- Only constructor validation reverted: 1 test fails.
- Only wrapper validation reverted: no test fails, because the constructor
  independently sanitizes the rethrown error (defense in depth).
- M3: Codex's exact mutation (production `invoke.ts` imports and uses
  `createScriptedModelRuntime` from `./scripted.ts`) now fails the guard, as
  does a re-export from `errors.ts`.

### Post-fix validation

429 tests (373 baseline + 56). The full command list in section 19 passed on the
Linux replica. Owner path, recorder event/provenance kinds, absence of
authority/learning state, absence of any provider/network adapter, frozen layers
and AVEN-007 non-start were re-verified. **Windows validation of the fixed
candidate has not been run in this session.**
