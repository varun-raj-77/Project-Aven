# @aven/action-proposals

AVEN-011 Action Proposal Boundary, version `aven-011-action-proposals-v1`.
**Patch 4 (this state): the pure root entry and the `./ledger` subpath with the
recorder, reconciliation and the read-only historical reader.**

Aven proposes; Root decides. This package reuses the frozen AVEN-002 contracts
(`ActionProposalSchema`, `ProposalBindingSchema` and their nested schemas)
unchanged. It makes no policy decision and records no approval. Its only write
is the recorder's single frozen Ledger append. It reads no clock (the Ledger
stamps `recordedAt`), generates no identifiers, calls no model, executes no
tool, learns nothing and is not wired into the API. Package separation is not
process isolation.

## API (root entry)

| Export                                           | Meaning                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `constructActionProposal(draft)`                 | Builds a version-1 proposal from caller-supplied owner, session, task, `proposalId`, `createdAt` and proposal fields; validates it |
| `validateActionProposal(proposal, context)`      | Checks a complete proposal against the v1 rules for an explicit `{ ownerId, sessionId, taskId }`; derives its binding              |
| `computeActionProposalDigest(proposal)`          | The protocol-v1 digest of a proposal carrying the v1 creation stamp                                                                |
| `inspectActionProposal(validated)`               | Revalidates a `{ proposal, binding }` pair and returns an authority-neutral, deeply frozen view                                    |
| `ActionProposalError` and its codes, outcomes    | Fixed codes and messages, no `cause`; the pure functions always report outcome `not_written`                                       |
| `ACTION_PROPOSALS_CONFIG` and identity constants | Version, creation stamp, digest protocol, frozen baseline and resource limits (deeply frozen)                                      |

All functions are deterministic. Caller input is copied without running caller
code (no getters, Proxies or non-plain prototypes), then parsed with the frozen
contract. Results are deeply frozen.

A proposal's origin (provenance) belongs to the event that will record it, not
to the proposal. It is not accepted by the constructor and is not part of the
payload or its digest.

## v1 rules (stricter than the contract)

- Owner, session and task must equal the explicit binding context.
- `metadata.creation` must be exactly
  `{ component: '@aven/action-proposals', version: 'aven-011-action-proposals-v1' }`
  and `recordVersion` must be 1. A revised proposal is a new proposal with a new
  caller-allocated identifier.
- Every string must be well-formed Unicode (no unpaired surrogate).
- The v1 recording format excludes the learning-lifecycle operations
  (`promote_learning`, `revoke_learning`, `rollback_learning`) and every
  non-read operation on `learned_state`; reads of learned state are allowed.
  This is a format restriction of this package, not Root enforcement, and other
  writers can still append such proposals through the frozen Ledger.
- Resource limits: depth 16, 2,048 nodes, arrays of 256, strings of 20,000.

There is deliberately no rule about identifier syntax, target membership in the
requested resources, duplicates, or declared risk: none has established tool
semantics, and Root decides with its own registry.

## Digest protocol v1

The digest covers the full strict-parsed payload as stored, and nothing else (no
provenance, event identifier, timestamp of recording or Root data).

1. Canonical text, RFC 8785-compatible for this value domain (plain objects,
   arrays, well-formed strings, non-negative safe integers): members sorted by
   key as UTF-16 code units; array order kept; no whitespace; strings escaped as
   ECMAScript `JSON.stringify` escapes a well-formed string; integers in
   shortest decimal form; no Unicode normalization.
2. Input bytes: ASCII `AVEN-011-ACTION-PROPOSAL-DIGEST-V1`, one `0x00` byte,
   then the UTF-8 canonical text.
3. Digest: `{ algorithm: 'sha256', value: <lowercase hex> }`.

The frozen `DigestSchema` has no protocol field, so the protocol is selected by
the creation stamp inside the digested payload. `parametersDigest` in the
binding is the declared `parameters.artifact.digest`, copied, never computed.

What a digest does and does not show:

- Distinct v1 payloads have distinct canonical texts and therefore distinct
  digest inputs. Distinct inputs give distinct digests only with overwhelming
  probability, under SHA-256 collision resistance; this is not a mathematical
  guarantee.
- Domain separation keeps the input encodings apart from the untagged hash of
  the same text and from other tagged schemes; it does not make the output sets
  disjoint.
- Changing only the locator changes the proposal digest but not the parameters
  digest. Content changed behind an unchanged locator and unchanged declared
  digest is invisible here; only hashing the bytes at use can detect it.
- A matching digest shows integrity consistency only: not authorship, not the
  parameter content, not any approval or permission.

`test/digest-vectors.json` holds golden vectors produced by an independent
Python standard-library procedure recorded in the file, never by this code.

## Recording (`@aven/action-proposals/ledger`)

The only subpath that depends on `@aven/storage` and `@aven/ledger`.

| Export                                                 | Meaning                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `recordActionProposal(storage, request)`               | Records one validated proposal as one `action_proposed` event; returns a frozen receipt       |
| `reconcileActionProposalRecording(storage, request)`   | Read-only: decides whether exactly this request was recorded                                  |
| `ProposalRecordingRequest`, `ProposalRecordingReceipt` | Request `{ ownerId, sessionId, taskId, proposal, eventId, occurredAt, provenance }`, receipt  |
| `ProposalReconciliation`                               | `recorded` (sequence, `recordedAt`, binding), `not_recorded`, `conflict` or `unresolved` code |

The request carries every identifier and the occurrence time, so a retry of the
identical request is safe to compare. The proposal is revalidated against the
request's owner, session and task. The declared origin must be `model_inference`
or `system_generated` (owner, tool and external origins are
`unsupported_origin`) and is never authenticated. `occurredAt` must not precede
`proposal.metadata.createdAt` (`timestamp_order`). The two are compared as the
instants they denote, exactly: integer arithmetic for date, time and offset, and
every fraction digit the frozen `TimestampSchema` accepts, so equal instants in
different forms (`.5Z` and `.500Z`, `Z` and `+05:30`) compare equal and no
sub-millisecond order is lost. Both strings are stored as given, never
normalized, and the comparison changes neither them nor the digest.

The recorder builds the exact event (the v1 creation stamp, `createdAt` equal to
`occurredAt`, no evidence), runs owner-local read-only prechecks (owner, task in
session, derivation evidence, prior approvals, unused event and proposal
identifiers) and makes exactly one call to the frozen `appendEvent` with the
protocol-v1 digest. The Ledger owns the transaction, the recording clock, the
frozen `action_proposals` projection and every reference check at COMMIT. After
COMMIT there is no storage access: the receipt comes from values computed before
the append and the event the Ledger returned. A receipt means recording
succeeded, nothing more.

Every failure is an `ActionProposalError` with an outcome:

- `not_written`: rejected before the Ledger began its transaction.
- `rolled_back`: the Ledger reported a rollback for a check it raises while its
  transaction is open (`identifier_collision`, `ledger_rejected`,
  `unknown_binding`, and an integrity `storage_failure`).
- `unknown`: anything else, including every storage failure the Ledger reports
  as rolled back. The frozen Ledger reports `rolled_back` after a failed COMMIT
  without checking whether the COMMIT took effect, so this package does not
  trust it.

Protocol after `unknown`: close that connection (closing rolls back an open
transaction), open a fresh one and reconcile with the identical request.
`not_recorded` means the identical request may be resubmitted; `recorded` means
it must not be; `conflict` means the identifiers are taken by different content;
`unresolved` means the lookup itself failed (an open transaction, a missing
owner, a storage error or history that fails validation) and nothing is decided.
Reconciliation compares the full stored event except `recordedAt` and
`sequence`, its stored projection and its declared digest.

The identifier prechecks are best-effort. Under a concurrent writer, a duplicate
event identifier is rolled back by the Ledger, and a different payload under a
taken proposal identifier is rejected; an identical payload under a new event
identifier is recorded as a second event re-observing the existing snapshot.

## Reading history (`readProposalEvents`)

`readProposalEvents(storage, ownerId, filter?)` reads one page of the owner's
`action_proposed` events through the frozen Ledger `listEvents` and returns one
record per event, in sequence order, with nothing dropped, merged or ranked. The
filter is `{ sessionId?, taskId?, afterSequence?, throughSequence?, limit? }`
(limit 1–1000, default 100); the event type is always `action_proposed`.
`throughSequence` and `nextCursor` are the Ledger's own, so the caller pages
with the same filter. Every re-recording of one proposal is its own record with
its own provenance and sequence. The reader writes nothing, repairs nothing and
works on a `query_only` connection.

Each record carries `sequence`, `eventId`, `occurredAt`, `recordedAt`,
`envelopeTask` (or `null`), `evidenceIds`, the verbatim `provenance` with
`origin: 'declared_unauthenticated'`, the verbatim `proposal` (required to equal
its frozen `action_proposals` projection), the `declaredDigest` and four
independent classifications:

| Field                    | Values and meaning                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`               | `v1` only for exactly the v1 creation stamp; otherwise `unsupported`, and everything below is `not_evaluated` (reported, not an error)                                                                                                                                                          |
| `digest`                 | `agrees` / `disagrees` with the declared digest; `not_evaluated` outside the digest domain (ill-formed Unicode). Size limits do not affect it                                                                                                                                                   |
| `proposalFormat`         | `conforming` or `nonconforming` with reasons `proposal_ill_formed_unicode`, `proposal_limits_exceeded`, `proposal_record_version_not_1`, `proposal_operation_not_in_v1_format`                                                                                                                  |
| `eventFormat`            | `conforming` or `nonconforming` with reasons `event_task_missing`, `event_origin_kind_unsupported`, `event_provenance_ill_formed_unicode`, `event_provenance_limits_exceeded`, `event_evidence_present`, `event_metadata_not_v1`, `event_occurs_before_proposal_creation` (exact instant order) |
| `priorApprovalCitations` | Each cited approval as `cited_unverified`; binding, status, expiry and bounds are never evaluated                                                                                                                                                                                               |

None of this is authentication. The digest function and the v1 stamp are public,
and the frozen Ledger accepts appends from any code with storage access, so
`conforming` with `agrees` does not show that the recorder wrote the record. A
record is evidence of recording only: never a permission, approval or Root
decision.

The whole call fails closed with no partial page (outcome `not_written`):
`invalid_request` (owner or filter), `unknown_binding` (owner absent),
`invalid_history` (an event that fails frozen validation, or a projection that
is missing, differs from its payload or has an unusable digest),
`storage_failure` (an open transaction or a failing read) or `internal_error`.

## Checks

```sh
pnpm --filter @aven/action-proposals typecheck
pnpm --filter @aven/action-proposals test
pnpm check
```

Tests use synthetic data only, on in-memory and temporary file-backed SQLite.
Synthetic owner-approval and policy-decision records appear only as test setup
to exercise references; they are not Root and decide nothing. The tests are
boundary and mechanics tests, not security proofs.
