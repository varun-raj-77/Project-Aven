# @aven/ledger

AVEN-004 implements Aven's authoritative history of **what was recorded**. It is
not an oracle of objective truth. It preserves owner requests, responses,
corrections, authority decisions, execution/verification reports, and supplied
learning lifecycle events using the unchanged AVEN-002 contracts and AVEN-003
SQLite schema. No owner state is inferred or written by this package.

## Setup and API

This private ESM package exports TypeScript source for the existing Node 24
toolchain. Storage continues to own database connections, migrations, schema,
serialization, and v1 reference projection. Provision owners/sessions/tasks
through storage before use; there is no identity or session-creation API here.

```ts
import { OwnerIdSchema } from '@aven/contracts';
import { openStorage } from '@aven/storage';
import { createLedger, type EventInput } from '@aven/ledger';

// This database must already be migrated and contain the explicit owner.
const storage = openStorage('/absolute/local/path/aven.sqlite');
try {
  const ledger = createLedger(storage, OwnerIdSchema.parse('owner_synthetic'));
  // `input` is an EventInput supplied by a caller; append validates it again.
  const record = ledger.appendEvent(input as EventInput);
  const same = ledger.getEvent(record.event.id);
  const page = ledger.listEvents({ eventType: 'owner_request', limit: 100 });
  if (page.nextCursor) {
    const next = ledger.listEvents({
      eventType: 'owner_request',
      limit: 100,
      ...page.nextCursor,
    });
  }
  for (const historical of ledger.replayEvents({ limit: 100 })) {
    // Inspect historical.event and historical.evidence. No executor is supplied.
  }
  const inspection = ledger.inspectIntegrity();
} finally {
  storage.close();
}
```

The example assumes a caller-provided `input`; it is not an executable demo or
an owner-provisioning workflow. `createLedger` binds one explicit branded owner
ID. The resulting object exposes only `ownerId` and these methods:

| Method                         | Result                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `appendEvent(input, options?)` | Committed `StoredEvent`: `{ sequence, event, evidence }`.                      |
| `getEvent(eventId)`            | Exact owner-bound record, or `undefined` if absent for this owner.             |
| `listEvents(filter?)`          | Ordered page, inclusive `throughSequence` boundary, and next cursor or `null`. |
| `replayEvents(filter?)`        | Finite synchronous iterator of the same stored records.                        |
| `inspectIntegrity()`           | Read-only `{ ok, eventsChecked, recordsChecked, issues }`.                     |

No update/delete methods, generic queries, raw handles, execution callbacks, or
model/tool adapters are exposed. Storage lifetime remains outside the Ledger.
Returned values are freshly decoded data; modifying nested returned objects does
not write history. The parsed event envelope is shallow-frozen by AVEN-002, not
advertised as a deeply immutable JavaScript graph.

## Creation boundary and append transaction

`EventInput` is the discriminated AVEN-002 event union with `recordedAt`
removed. The caller supplies its stable EventId, owner, event type, payload,
provenance, `occurredAt`, creation metadata, optional task, and evidence IDs.
Neither `sequence` nor `recordedAt` is accepted, even as an extra JavaScript
property. No missing scope, provenance, evidence, or owner values are inferred.

`options.evidence` contains exactly the new evidence named in `evidenceIds`,
without its top-level `recordedAt`. All must belong to this owner and event;
duplicates and missing/extra evidence fail. An evidence ID already recorded for
this owner cannot be reused by a new event. Citations to older evidence stay in
the event's contract reference fields. New evidence cannot be attached to an
earlier event through this API.

The Ledger validates/copies the inputs through the full contracts before any
durable write. It takes `BEGIN IMMEDIATE`, verifies owner/duplicate/bindings,
stamps event/evidence recording time using the local clock after acquiring the
writer lock, revalidates, and inserts the event, evidence, and historical
payload snapshot. Existing storage triggers create identity/version/reference
projections within the same transaction. Deferred foreign keys check exact
reference/binding resolution at COMMIT. A result is returned only after COMMIT
succeeds. Failure rolls back event, evidence, payload snapshot, projections, and
sequence allocation.

`recordedAt` is the wall-clock recording timestamp sampled inside the successful
transaction just before persistence, **not an exact measurement of the final
filesystem flush or SQLite commit instant**. The immutable v1 schema cannot
stamp an event after commit without rewriting it. Clock rollback/equal times are
possible. AVEN-002 rejects `occurredAt` later than this recording clock; the
Ledger does not silently clamp occurrence time. Payload timestamps and creation
metadata remain caller-supplied historical claims.

The optional `proposalDigest` is required exactly for `action_proposed`, because
AVEN-003 stores that declaration outside the proposal contract. It is validated
as an existing `DigestSchema`, preserved, and compared by storage's exact
binding FKs. It is not computed, authenticated, or a tamper-resistance hash.

Historical payloads project to the existing correction, proposal, policy,
approval, execution, verification, candidate, evaluation, or lifecycle table. An
already-present projection is used only if its parsed JSON is semantically
identical (and proposal digest matches). A conflicting snapshot fails; there is
no overwrite. This allows a new observation of an existing snapshot without
inventing a second identity. It does not make duplicate **event** IDs retryable.
Candidate/evaluation/lifecycle payloads are supplied historical claims; this
package never generates hypotheses, changes their status, promotes them, or
writes `learned_owner_state` / `active_task_state` / `no_useful_lessons`.

All other referenced endpoints must already exist. Single-event evidence cycles
are assembled by append. Cross-component cycles involving new owner-state
snapshots are not assembled by this service. Future owner-state transaction
coordination/rebuild remains deferred. Ledger operations reject an
already-active caller transaction rather than returning success for an
uncommitted savepoint.

SQLite serializes writers. The configured storage busy timeout applies (normally
5 seconds); lock contention becomes a typed storage failure, without a
distributed queue or hidden retry. Separate connections can append to the same
local database.

## Identity, order, filters and pagination

Event identity is `(ownerId, EventId)`, matching frozen AVEN-003. The same ID
cannot be appended twice for an owner, whether the retry payload is identical or
different. Distinct owners may have the same ID in their separate namespaces.
This is explicit owner scoping, not global EventId allocation. No semantic retry
success, distributed idempotency key, upsert, or ID regeneration is implemented.

`sequence` means **database-local committed historical ordering**, not global
causal time. SQLite assigns it independently of event IDs and timestamps.
Successful appends advance it; owner histories can contain gaps because it is
shared across owners. Values from failed transactions may be reused because they
never became committed history. Sequence is not a contiguous per-owner counter,
a timestamp, or an import/replay instruction.

Filters are ANDed: `sessionId`, `taskId`, `eventType`, exclusive
`afterSequence`, inclusive `throughSequence`, and `limit` (1-1000; default 100).
Bounds are nonnegative safe integers. Invalid/unknown arguments fail; inverted
ranges return no events. Unknown or another owner's session/task filter returns
empty history. A missing owner fails with `unknown_owner`.

Session/task filters use the envelope binding when present. Otherwise they use
the payload's direct task, approval bounds, or correction immediate
applicability. They do not infer context from cited evidence, authority chains,
correction targets, or durable scope hints. Supply the event envelope task when
a report such as execution/verification should appear in a task history. The
full owner stream always includes unbound events.

Pages use ascending sequence and keyset pagination. The first page captures the
owner's highest visible sequence (clamped by an optional upper bound);
subsequent pages must preserve the filters and use both fields in `nextCursor`.
Later appends are excluded from that finite traversal. Start a new query to see
them. An absent next cursor means no more matching events within the captured
boundary.

## Replay, corrections and provenance

Replay captures its upper boundary when `replayEvents` is called, then reads
bounded pages. `limit` is page size, not total replay length. Each page uses a
short read transaction, including evidence decoding, and releases it before
yielding to the consumer. For immutable records written through this Ledger,
replay returns the complete selected stream in canonical order without skips or
duplicates. Keep storage open while consuming it.

Replay/get/list/inspection do not write historical or derived state, invoke
tools/models, resolve artifact locators, send messages, repeat approvals, or
make network requests. No consumer callback/executor is accepted. Consumers may
reconstruct test state outside the Ledger, but must treat historical actions,
approvals, and instructions as data; this iterator cannot control arbitrary code
a caller writes after receiving a record.

Record a correction with ordinary `appendEvent`: a new `owner_correction` event
carrying `OwnerCorrectionSchema`, its own evidence and explicit correction
provenance, and an event/evidence/state target. The original remains unchanged.
The Ledger preserves immediate applicability and durable scope hints without
applying a session override or inferring a trusted preference/procedure.

Origin, trust, derivation, model stamps and source relationships round-trip
unchanged. Owner-origin companion evidence must have the same explicit origin
declared on its recording event, with that event itself as the declared source.
This prevents model-inference events, and events that merely derive from an
earlier owner statement, from minting new owner-origin evidence. External/tool
claims retain their declared trust. These checks do not authenticate the source
or implement recursive taint logic.

Every `ownerId` declared anywhere in the event, its payload/provenance, or its
new evidence must name the bound owner; otherwise append fails with
`cross_owner_reference` before any write. Session, task, event, evidence, or
other IDs that do not resolve in this owner's namespace are reported as
unknown/unresolved; the Ledger does not probe other owners to say whether such
an ID exists elsewhere.

## Observable failures

All public operation failures are `LedgerError` with a stable `code`, readable
message, `rollback` status, and optional diagnostic `cause`. Callers should not
depend on raw SQLite messages or expose diagnostic causes to untrusted clients.

| Code                              | Meaning                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`                   | Invalid owner/event lookup ID, filter, or proposal-digest usage.                                                                                   |
| `invalid_event`                   | Full AVEN-002 event/evidence/options validation failed, or caller supplied recording metadata.                                                     |
| `unknown_owner`                   | Bound owner absent.                                                                                                                                |
| `unknown_session`, `unknown_task` | Referenced identity absent within this owner namespace; other owners are not probed.                                                               |
| `cross_owner_reference`           | An event, payload, provenance, nested or evidence `ownerId` claim names an owner other than the bound owner.                                       |
| `invalid_reference`               | Incomplete evidence, reused evidence ID, incompatible explicit origin, task/session mismatch, projection conflict, or unresolved exact FK binding. |
| `duplicate_event`                 | Existing EventId for this owner; always rejected.                                                                                                  |
| `transaction_active`              | Caller connection already has a transaction; that transaction is left alone.                                                                       |
| `integrity_failure`               | Stored event/evidence cannot be decoded as valid history.                                                                                          |
| `storage_failure`                 | Closed/unmigrated/unusable DB, disabled checks, writer contention, unexpected SQL failure, or failed rollback.                                     |

For append, `rollback` is `not_started` if no write transaction began,
`rolled_back` if a failed append was rolled back (including SQLite automatic
rollback), or `failed` if rollback itself failed. In the last case discard the
connection and inspect storage; the API cannot assert cleanup succeeded. Read
failures use `not_started` to mean no write transaction was started. An absent
event is an ordinary `undefined` result, not a failure.

## Integrity inspection and limits

Inspection runs in a read transaction. It checks the bound owner's stored
snapshots through frozen contract/v1 reference validation, compares normalized
edges to payload claims, checks evidence lists and historical payload snapshots,
checks identity/version catalogs and owner-bound foreign keys, sequence validity
and high-water consistency, expected trigger presence, and connection checks.
Corruption tests deliberately bypass protections only in synthetic databases.

This is a debugging/audit consistency check, **not cryptographic tamper
proofing**. It does not authenticate trigger bodies, detect a coordinated
replacement of all internally consistent data, validate reference meaning, or
check physical disk integrity. Global protection findings contain schema names,
not another owner's historical data. Full owner inspection is intentionally
unoptimized. Legacy direct-storage events may lack AVEN-004 payload/evidence
completeness; inspection reports that discrepancy and never repairs or rewrites
them.

Within the configured intact local schema/API the Ledger **does guarantee**:

- Append-oriented history and preserved event records.
- Deterministic local ordering.
- Contract-validated boundaries.
- Owner-bound retrieval.
- Atomic event/evidence/required projection recording.

It **does not guarantee** objective factual truth, authenticated owner identity,
cryptographic tamper resistance, semantic memory retrieval, learning quality,
Root authorization, correct external action execution, correct verification,
owner-state rebuild correctness, or erasure semantics. Append success means
**recorded successfully**, not **action succeeded**. Storage administrators or
code using raw storage can bypass or alter the schema; this object is not an OS
or security isolation boundary. No model/provider, Context Broker, Owner Model,
learning engine, API/UI, promotion controller, or autonomous execution is
included.

```sh
pnpm --filter @aven/ledger typecheck
pnpm --filter @aven/ledger test
pnpm check
```

Tests use synthetic data only. They are persistence/contract evidence, not
experimental results or claims about learning quality. Stop after AVEN-004.
