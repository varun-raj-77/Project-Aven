# AVEN-011 report: Action Proposal Boundary

Status recorded **2026-10-15 after Patch 6 acceptance and CI**: **all six
AVEN-011 implementation patches were independently reviewed, accepted and
committed by the owner on `aven-011/action-proposals`. The accepted Patch 6
commit is `dd00d430b8ec6595415959fc5bcb0bfefaf3ca97`; GitHub CI passed on
Patches 2-6, including Patch 6 run `38762243518`.** The owner separately
authorized final acceptance, merging and tagging. **This report amendment is a
candidate finalization record**: as of its preparation `main` still points to
`c8b83ec`, the branch tip is `dd00d430`, and no `aven-011` tag exists. The
milestone is not yet merged or frozen; a separately reviewed amendment, actual
fast-forward into `main`, and an immutable annotated `aven-011` tag with
post-operation verification remain necessary. No model was called. Nothing in
this report is an experimental result, and no C-versus-B claim is made.

Baseline: `c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be` (owner-first attribution
policy on `main`), above frozen AVEN-010 (tag `aven-010`, commit
`76535d8647ee36e56bd2efd1a86642d1fc572ee7`). Package:
`packages/action-proposals` (`@aven/action-proposals`, version
`aven-011-action-proposals-v1`). Package documentation:
[`packages/action-proposals/README.md`](../packages/action-proposals/README.md).

**Evidence classes.** This report keeps five kinds of evidence apart:

- **Repository evidence:** committed code and tests that anyone can re-run.
- **Builder-reported:** results of commands the builder (Claude) ran on Linux
  while preparing each patch, recorded in that patch's handoff. Reviewers should
  re-run them.
- **Independent:** review verdicts and Windows validation runs of the
  independent (Codex) audits, as relayed by the owner.
- **GitHub CI:** the repository's actual CI runs on committed patches.
- **Pending:** checks that have not happened yet. They are listed in section M
  and are never reported as passed.

## A. Purpose and milestone scope

AVEN-011 gives Aven a typed, recordable way to **propose** an action without any
path from a proposal to permission. Aven proposes; Root decides (AVEN-012). The
milestone reuses the frozen AVEN-002 contracts (`ActionProposalSchema`,
`ProposalBindingSchema`, `RequestedAuthoritySchema`, `ResourceTargetSchema` and
the `action_proposed` experience event) unchanged and adds one package.

In scope:

- deterministic construction and validation of version-1 proposals, with
  caller-supplied owner, session, task, identifier and creation time;
- a canonical proposal digest (protocol v1) and the exact `ProposalBinding`;
- an authority-neutral inspection view;
- one recorder that appends one `action_proposed` event through the frozen
  Ledger, with explicit outcomes for uncertain results;
- read-only reconciliation of an uncertain recording;
- a read-only historical reader that classifies recorded proposal events.

Out of scope, and absent: Root policy or any ALLOW, DENY or
REQUIRE_OWNER_APPROVAL decision; approval creation or verification; tool
execution or verification; model or provider calls; learning, promotion or any
owner-state write; authentication of declared origins; API wiring; exactly-once
recording.

## B. Baseline, ancestry and governance

| Role                             | Commit                                     | Notes                                               |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Frozen AVEN-010                  | `76535d8647ee36e56bd2efd1a86642d1fc572ee7` | Annotated tag `aven-010` (tag object `4ef575c2…`)   |
| AVEN-011 baseline (`main`)       | `c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be` | Owner-first attribution policy                      |
| Patch 1, trusted evaluator **T** | `3761c775b5650e353816b3395e4d71022398afd1` | Gate blob `8fe769e7…`, `attribution.ts` `aa033604…` |
| Patch 2                          | `8b25e89cbc24a302125b7f2e8bf5ffff5be37705` | Pure boundary                                       |
| Patch 3                          | `2e84dbc982a7444f4d33f2e4b744f2d1a939655f` | Recorder and reconciliation                         |
| Patch 4                          | `9bd2ad744f8c717ddaf37802629ad4bdb0137362` | Read-only historical reader                         |
| Patch 5                          | `f49451160e2d4e0eb4fd4f86c6498403481a9ff4` | Cross-layer campaign (tests only)                   |
| Patch 6                          | `dd00d430b8ec6595415959fc5bcb0bfefaf3ca97` | Final report and status reconciliation, accepted    |

Every AVEN-011 commit has the owner as author and committer and exactly one
final trailer, `Co-authored-by: Claude <noreply@anthropic.com>`. Claude prepares
patch files and commit-message drafts and never commits under the owner's
identity.

The gate of T (`tooling/attribution/check-post-aven010.mjs`, governance version
`aven-011-governance-v1`) enforces:

- the frozen lineage;
- owner-first identity;
- the exact 26-path package inventory plus the shared files;
- the root `package.json` states P0/P1 (one approved script insertion and one
  approved description);
- the lockfile states L0/L1 (one importer block).

Reviewers run T's gate, never the candidate's, with
`--governance-frozen-at 3761c775b5650e353816b3395e4d71022398afd1`. Candidate CI
is advisory.

## C. Architecture and boundaries

| Entry                           | Depends on                                                             | Contents                                                                         |
| ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@aven/action-proposals` (root) | `@aven/contracts`, `zod`, `node:crypto` (SHA-256), `node:util` (Proxy) | Construction, validation, digest v1, binding, inspection, fixed errors (pure)    |
| `@aven/action-proposals/ledger` | adds `@aven/ledger`, `@aven/storage`                                   | `recordActionProposal`, `reconcileActionProposalRecording`, `readProposalEvents` |

- **Pure root entry.** It reads no clock, generates no identifiers, touches no
  storage and runs no caller code: input is copied inertly (no getters, Proxies
  or non-plain prototypes) and limited to depth 16, 2,048 nodes, arrays of 256
  and strings of 20,000.
- **The only write** is the recorder's single frozen `appendEvent`. The Ledger
  owns the transaction, the recording clock, the frozen `action_proposals`
  projection and every reference check at COMMIT.
- **Static tripwires** (`test/boundaries.test.ts`) pin the modules, imports,
  exports and SQL. In the `ledger/` modules they forbid SQL writes, transaction
  control, `Date`, clocks and randomness. They allow exactly one `appendEvent`
  (recorder) and one `listEvents` (reader). They are pattern checks, not
  security.
- **No dependents.** No other workspace package imports
  `@aven/action-proposals`. Package separation is not process isolation.

## D. Patch history

| Patch | Content                                                                | Status                                                 |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| 1     | Successor attribution gate with AVEN-011 file governance               | Accepted and committed as T (independent)              |
| 2     | Package scaffold and pure boundary                                     | Accepted, committed `8b25e89`, CI passed (independent) |
| 3     | Recorder and reconciliation; review finding F1 corrected before commit | Accepted, committed `2e84dbc`, CI passed (independent) |
| 4     | Read-only historical reader                                            | Accepted, committed `9bd2ad7`, CI passed (independent) |
| 5     | Cross-layer adversarial and regression campaign (tests only)           | Accepted, committed `f494511`, CI passed (independent) |
| 6     | This report and status reconciliation (documentation and description)  | Accepted, committed `dd00d43`, CI passed (independent) |

Patches 4, 5 and 6 were prepared together as separate candidates. Each is
reviewed and committed on its own, in order.

**Review finding F1 (Patch 3).** The first Patch 3 candidate compared the
proposal's `createdAt` with the event's `occurredAt` through `Date.parse`, which
loses the sub-millisecond precision the frozen `TimestampSchema` accepts. The
correction orders the two instants exactly (section I). The committed Patch 3
contains the correction.

## E. Construction, validation and digest

- **Construction.** `constructActionProposal(draft)` builds the version-1
  proposal from caller-supplied values only. The creation stamp is exactly
  `{ component: '@aven/action-proposals', version: 'aven-011-action-proposals-v1' }`.
- **Validation.** `validateActionProposal(proposal, context)` applies the v1
  rules, which are stricter than the contract:
  - an explicit binding;
  - the exact stamp and `recordVersion` 1;
  - well-formed Unicode;
  - the resource limits;
  - no learning-lifecycle operation and no non-read operation on
    `learned_state`.

  This is a format restriction of this package, not Root enforcement. The rules
  invent no tool semantics: no identifier syntax, target membership, duplicate
  or risk rule.

- **Digest v1.** SHA-256 over the ASCII tag
  `AVEN-011-ACTION-PROPOSAL-DIGEST-V1`, one NUL byte, and the RFC
  8785-compatible canonical JSON of the full payload. Lone surrogates are
  rejected, and there is no Unicode normalization. Event provenance is not part
  of the payload or the digest.
- **Golden vectors.** Five valid and two rejected vectors were produced by an
  independent Python standard-library procedure, never by the code under test.
- **What the claims cover.** Distinct payloads give distinct hash inputs.
  Distinct digests then follow only with overwhelming probability, under SHA-256
  collision resistance. A matching digest shows integrity consistency only:
  never authorship, parameter content or approval.
- **Inspection.** `inspectActionProposal` revalidates its input and returns
  `confersAuthority: false` and `rootDecision: 'not_evaluated_here'`.

## F. Recording and outcomes

`recordActionProposal(storage, request)` takes
`{ ownerId, sessionId, taskId, proposal, eventId, occurredAt, provenance }`.

1. **Revalidation.** The proposal is revalidated against the request's owner,
   session and task.
2. **Declared origin.** Only `model_inference` or `system_generated` is
   accepted, and the origin is never authenticated.
3. **Expected event.** The recorder builds the exact event: the v1 stamp,
   `createdAt` equal to `occurredAt`, and no evidence.
4. **Prechecks.** They are owner-local and read-only: owner, task in session,
   derivation evidence, prior approvals, and unused event and proposal
   identifiers.
5. **The single append.** One frozen `appendEvent` call, with the protocol-v1
   digest.
6. **After COMMIT.** There is no storage access, and the receipt confers
   nothing.

| Outcome       | Meaning                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_written` | Rejected before the Ledger began its transaction                                                                                                                                          |
| `rolled_back` | The Ledger rolled back for a check it raises inside its open transaction (`identifier_collision`, `ledger_rejected`, `unknown_binding`, integrity `storage_failure`)                      |
| `unknown`     | Everything else, including every storage failure the Ledger reports as rolled back: the frozen Ledger reports `rolled_back` after a failed COMMIT without checking whether it took effect |

Tests cover the exhaustive mapping table, a real deferred foreign-key failure at
COMMIT, a COMMIT that fails, a COMMIT that takes effect and then raises, a
failed rollback, a duplicate found under the write lock, and the measured row
deltas of a fresh recording:

- +1 `experience_events` and +1 `action_proposals`;
- `record_keys` +2 and `record_versions` +2;
- `record_references` +8;
- 0 rows in any other table.

## G. Reconciliation

`reconcileActionProposalRecording(storage, request)` only reads. It compares the
full stored event except `recordedAt` and `sequence`, the stored projection and
the declared digest. Its results are:

- `recorded`, with the sequence, `recordedAt` and binding;
- `not_recorded`;
- `conflict`;
- `unresolved`, with a code, for an open transaction, a missing owner, a storage
  error or history that fails validation.

The protocol after `unknown`:

1. Close the connection; closing rolls back an open transaction.
2. Reopen and reconcile with the identical request.
3. Resubmit only after `not_recorded`.

There is no exactly-once guarantee. A concurrent writer can re-record an
identical payload under a new event identifier, and that is tested.

## H. Historical reader (Patch 4)

`readProposalEvents(storage, ownerId, filter?)`:

- **Paging.** It pages one owner's `action_proposed` events through the frozen
  `listEvents` and maps them one to one in sequence order. `throughSequence` and
  `nextCursor` are therefore the Ledger's own.
- **Projection check.** Each event's frozen projection is read with the pinned
  owner-scoped SELECT and must equal the payload.
- **Records.** Every re-recording is its own record, with its own provenance.
- **Classifications.** Each record is classified independently:
  - `protocol`: `v1` or `unsupported`;
  - `digest`: `agrees`, `disagrees` or `not_evaluated` (outside the digest
    domain; size limits do not affect it);
  - `proposalFormat` reasons: ill-formed Unicode, limits, record version and
    operation format;
  - `eventFormat` reasons: task missing, origin kind, provenance Unicode,
    provenance limits, evidence present, metadata not v1, and an event that
    precedes its proposal.
- **Origins and citations.** Origins are always `declared_unauthenticated`, and
  prior-approval citations are always `cited_unverified`.
- **Fails closed.** The whole call fails with no partial page:
  - `invalid_request`;
  - `unknown_binding`;
  - `invalid_history`: a stored event that fails frozen validation, or a
    projection that is missing, differs or has an unusable digest;
  - `storage_failure`;
  - `internal_error`.
- **Read-only.** It writes and repairs nothing, and works on a `query_only`
  connection.

The frozen layers already exclude some conditions the reader checks, as long as
history was written through intact Ledger appends:

- an envelope task that differs from the payload task;
- an event `schemaVersion` or `recordVersion` other than 1;
- `evidenceIds` that do not name new evidence of the same event.

The reader still checks them. Both evidence guards are kept: `evidenceIds`
non-empty, and evidence rows stored against the event. Corrupted storage can
separate the two. Evidence rows deleted outside the Ledger leave `evidenceIds`
naming evidence that no longer exists, and the reader still reports
`event_evidence_present` from `evidenceIds`. Evidence rows inserted outside the
Ledger are reported from the stored rows.

## I. Timestamp order

The recorder and the reader order `proposal.metadata.createdAt` and the event's
`occurredAt` as exact instants:

- integer (BigInt) arithmetic for the proleptic-Gregorian date, the time and the
  UTC offset;
- a digit-exact comparison of fractions of any length (trailing zeros carry no
  precision);
- no `Date` or floating point.

The parser accepts exactly the structure of the frozen `TimestampSchema`, which
has already validated both strings. Equal instants in different forms are equal.
The strings themselves are stored verbatim, and the digest input is unchanged.

The frozen Ledger's own check of `recordedAt` against `occurredAt` remains
millisecond-based. It is frozen and outside AVEN-011.

## J. Root nonauthority

Repository evidence (Patch 5, `test/cross-layer.test.ts`):

- No exported name of either entry decides, approves, authorizes, executes,
  grants or learns.
- No AVEN-011 output parses as a frozen policy decision, owner approval, ALLOW
  decision reference, execution result or verification result. That covers the
  receipt, binding, inspection, reconciliation, record and page.
- Recording, reconciling and reading change no `policy_decisions`,
  `owner_approvals`, `tool_executions` or `verification_results` row.
- The frozen storage refuses a tool-execution record that cites a recorded
  proposal's binding without a matching recorded ALLOW decision. The same holds
  for a fabricated decision, a cited approval identifier and a recorded DENY.
- A system origin naming `@aven/root` is still `declared_unauthenticated`.

## K. Adversarial and mutation evidence (builder-reported)

| Campaign                                              | Mutants | Killed | Surviving and why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch 2, pure boundary                                | 14      | 14     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Patch 3, recorder and reconciliation (revised, F1)    | 44      | 40     | S2 (owner precheck): equivalent. S1 and S3 (transaction guards): change only which fixed code is reported when an open transaction coincides with another fault. T3 (unparseable timestamp guard): unreachable                                                                                                                                                                                                                                                                                                                                                          |
| Patch 4, reader (reader and boundary tests)           | 30      | 29     | H16 (drops the `evidenceIds` half of the evidence guard): **not universally equivalent**. It is unobservable only for history written through intact Ledger appends, which require `evidenceIds` to name new evidence of the same event. Under simulated corruption that deletes evidence rows, the production reader still reports `event_evidence_present` and the H16 mutant does not (found in Codex's review of the Patch 6 candidate and confirmed by a builder probe). No committed test exercises that corruption, so the mutant survives. Both guards are kept |
| Patch 5, sample run against the cross-layer file only | 24      | 23     | C2 (canonicalizer accepts lone surrogates): masked by validator and reader guards on every public path; killed by the canonical unit suite                                                                                                                                                                                                                                                                                                                                                                                                                              |

Patch 5's multi-fault tests now kill S1 and S3. The precedence they establish
applies **after request validation**. A malformed request fails validation first
(for example `invalid_request`, `binding_mismatch` or `timestamp_order`), with
or without an open transaction: validation runs before any transaction or
storage check in the code, though no test combines the two. For a request that
passes validation, an open transaction outranks only the specific checks those
tests exercise:

- in the recorder: an unknown task, a missing owner, a missing prior approval
  and an already used event identifier;
- in reconciliation and the reader: a missing owner.

No wider precedence is claimed. The Patch 5 sample spans the validator, the
canonicalizer, the outcome mapping, the transaction guards, reconciliation and
the reader.

The cross-layer campaign covers the following:

- deterministic histories, plus a fresh-process replay on a `query_only`
  connection that matches the in-process results and writes nothing;
- hostile inputs: forged authority fields, Proxies, getters (never invoked),
  sparse arrays, symbols, BigInts, NaN, size and depth limits, blank text and
  bad identifiers;
- unsupported origins and stamps;
- learned-state and lifecycle operations;
- owner isolation, with identical codes and messages for missing and foreign
  references;
- the golden vectors, recorded and read unchanged;
- digest mutations, and the absence of normalization;
- COMMIT and rollback failures;
- two-connection races;
- retries, and stale or conflicting requests;
- corrupted projections and frozen-trigger protection;
- pagination over 150 mixed events against `listEvents`;
- exact timestamp order across all three layers.

## L. Reproducibility

Use Node 24 and pnpm 11.19.0. Install with `pnpm install --frozen-lockfile`.

| Command                                                                                                           | Purpose                                           |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm check`                                                                                                      | Prettier, all typechecks, experiment check, tests |
| `pnpm --filter @aven/action-proposals test`                                                                       | Package tests only                                |
| `pnpm attribution:self-test`                                                                                      | Gate self-test (synthetic histories)              |
| `node tooling/attribution/check-post-aven010.mjs --governance-frozen-at 3761c775b5650e353816b3395e4d71022398afd1` | Gate, run with T's evaluator files checked out    |

The trusted procedure has four steps:

1. Make a worktree at the candidate.
2. Check out `tooling/attribution/check-post-aven010.mjs` and
   `tooling/attribution/attribution.ts` from T.
3. Verify their blob IDs: `8fe769e70143b513da83ebccece0da3a9fb22a93` and
   `aa033604688134b1311fd0bb5c9562f39e371c74`.
4. Run the gate.

Running scripts through `pnpm run` may trigger pnpm 11's reinstall and edit
`pnpm-workspace.yaml`. Check `git status`, and stage explicit paths only.

## M. Validation status

| Check                                                       | Scope                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Class                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Check                                                       | Scope                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Class                                               |
| ---                                                         | ---                                                                                              | ---                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ---                                                 |
| Codex review                                                | Patches 1-6                                                                                      | accepted (Patch 3 after the F1 correction)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Independent                                         |
| GitHub CI (`Verify historical and owner-first attribution`) | committed Patches 2-6, including 6 (`dd00d43`)                                                   | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | GitHub CI                                           |
| `pnpm check`, Linux, Node 24.21.0, pnpm 11.19.0             | Patch 4 candidate (byte-identical to the committed `9bd2ad7`)                                    | passed: 2,019 tests in 57 files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Builder-reported                                    |
| `pnpm check`, same environment                              | Patch 5 candidate (byte-identical to the committed `f494511`)                                    | passed: 2,066 tests in 58 files (363 in this package)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Builder-reported                                    |
| `pnpm check`, same environment                              | Patch 6 candidate on `f494511`                                                                   | passed (see the Patch 6 handoff); Patch 6 changes no code or test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Builder-reported                                    |
| T's gate with `--governance-frozen-at T`, trusted procedure | real `f494511` (covers real Patches 4 and 5), and a disposable rehearsal commit of Patch 6 on it | passed (see the Patch 6 handoff)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Builder-reported                                    |
| Windows x64, Node 24.19.0                                   | revised Patch 3 candidate                                                                        | passed: 1,973 tests in 56 files (270 in this package); 37 focused timestamp regressions; 14,108 independent timestamp comparisons; formatting, all 11 TypeScript checks and experiment validation; T's evaluator and self-test. Full suite with `--maxWorkers=2 --testTimeout=30000`, using the pinned installed tool entry points, not a fresh pnpm installation or the literal `pnpm check` command                                                                                                                                                     | Independent                                         |
| Windows, Node 24.19.0                                       | Patches 4-6 candidates combined                                                                  | passed: 2,066 tests in 58 files (363 in this package), including all 47 cross-layer tests; 17 independent classification cases and 288 SQL-backed pagination comparisons; formatting, all 11 TypeScript checks and experiment validation; T's governance rehearsal for all three candidates, including `--governance-frozen-at T`. Two Vitest workers, 30-second timeout, the existing six test exclusions and the already installed pinned dependencies; no fresh pnpm installation. These validate candidates; they are not CI on a real Patch 6 commit | Independent                                         |
| Frozen tripwire suites excluded from `pnpm check`           | accepted base, Patch 5 and Patch 6 candidate                                                     | 190 passed and the same six failed (of 196) at each, in a controlled comparison. The six reflect obsolete frozen expectations, not new source regressions. A seventh failure seen in one run was reproduced as a dependency or worktree-link artifact. No frozen test was edited and no exclusion was added                                                                                                                                                                                                                                               | Independent; matches the builder's Linux comparison |
| Independent review of Patch 6                               | revised candidate `e9fe0519...`                                                                  | **approved**; no actionable findings in 2026-10-15 independent Codex audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Independent                                         |
| GitHub CI on the real Patch 6 commit                        | `dd00d430` (run `38762243518`)                                                                   | **passed**; owner-first attribution, current-tree and frozen AVEN-010 checks all succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                | GitHub CI                                           |
| Original T's gate on real Patch 6                           | `dd00d430` using trusted T `3761c77`, with `--governance-frozen-at T`                            | **passed** in Codex's independent status review; evaluator hashes verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Independent                                         |
| Real-model or end-to-end experiment                         | out of scope                                                                                     | not run; `execution: not_run` stays unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | n/a                                                 |

Test counts: the pre-AVEN-011 suite had 1,703 tests. Patch 2 brought it to
1,856, Patch 3 to 1,973, Patch 4 to 2,019 and Patch 5 to 2,066. Patch 6 adds no
test. The pre-existing tests are unchanged.

## N. Known limitations and risks

- **Unauthenticated origins.** Declared origins are not authenticated. A
  `conforming` record with an `agrees` digest does not show that the recorder
  wrote it: the digest and stamp are public, and the frozen Ledger accepts
  appends from any code with storage access.
- **No exactly-once recording.** The identifier prechecks are best-effort under
  concurrency. An identical payload under a new event identifier is a second
  record.
- **Unverified citations.** Prior-approval citations are never verified.
  Binding, status, expiry and bounds are Root's decision.
- **Single rollback label.** The frozen Ledger reports a single `rolled_back`
  label. AVEN-011 therefore treats every rolled-back storage failure as
  `unknown`.
- **Tripwires, not proofs.** Pattern-based boundary tests are review tripwires,
  not security proofs.
- **Platform and runner qualifications.** The builder's runs were on Linux.
  Codex's independent Windows runs (section M) passed with two Vitest workers
  and a 30-second timeout, using already installed pinned dependencies rather
  than a fresh installation. No Windows run used the literal default
  `pnpm check` runner settings. The frozen AVEN-009 and AVEN-010 paging tests
  run close to the 5 s vitest default under load: one timeout was observed once
  on Linux under a concurrent mutation run, and it passed on rerun.
- **Mutation-test gap.** No committed test simulates corruption that deletes
  evidence rows, so the reader mutant H16 survives (section K). The production
  guard handles that case.
- **Inherited resource risk.** The native-memory risk of large synchronous
  storage batches (AVEN-010 report, section Q) still needs a separate
  resource-readiness gate. The reader pages at most 1,000 events per call.

## O. Relationship to AVEN-012 (Root Policy Gateway)

AVEN-011 hands Root **inputs, not conclusions**. Root must:

- **Revalidate the proposal.** Revalidate every proposal it evaluates, using
  `validateActionProposal` or its own validator, rather than trusting a stored
  record.
- **Recompute the binding.** Recompute the binding and check the declared
  digest; the reader's `agrees` is a convenience, not proof.
- **Authenticate origins.** Authenticate origins if it relies on them. AVEN-011
  only labels them `declared_unauthenticated`.
- **Verify approvals.** Verify any cited approval: binding, status, expiry and
  bounds.
- **Own the decision.** Decide ALLOW, DENY or REQUIRE_OWNER_APPROVAL with its
  own policy, and record the decision itself. The frozen storage requires a
  recorded ALLOW decision before any execution record can cite a proposal.
- **Check parameters at use.** Hash the parameter bytes at use. A proposal
  carries only a declared parameters digest and a locator.

Nothing in AVEN-011 constrains Root's policy model.

## P. Finalization record and remaining freeze steps

1. **Complete.** Patch 6 was independently approved (SHA-256
   `e9fe051994a447b6d35bb7a3294988301c0f9850d39fdb7229eadb94f0f88f71`),
   owner-authored and owner-committed as
   `dd00d430b8ec6595415959fc5bcb0bfefaf3ca97`.
2. **Complete.** Its GitHub Actions run `38762243518` passed. The successful
   workflow included owner-first historical attribution, post-freeze
   current-tree checks and unchanged frozen AVEN-010 checks. This workflow is
   the actual committed-tree CI; synthetic T rehearsals are separately labeled
   above.
3. **Complete.** The owner explicitly authorized milestone acceptance, merging
   and tagging after all six reviewed commits and CI checks passed.
4. **Pending as of this amendment.** Independently review this post-Patch-6
   status-only change and, if approved, commit it linearly under the owner-first
   policy with the required single Claude trailer. Recheck real-commit CI and
   the trusted evaluator T with `--governance-frozen-at T`.
5. **Pending as of this amendment.** Fast-forward `main` without squashing,
   rebasing or rewriting accepted commits; create annotated `aven-011` pointing
   to the final reviewed milestone commit; verify both refs and tag object.

The pending steps above are **not claimed as completed** by this report. This is
an as-of acceptance record, not retroactive evidence that a merge or tag exists.
