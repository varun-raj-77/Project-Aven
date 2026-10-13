# AVEN-010 report: Correction Events and Immediate Session Overrides

Status: **implementation-complete candidate on the isolated branch
`claude/adoring-pasteur-hcc5oe`. Patches 1-7 (with their remediation commits)
were independently reviewed and accepted; Patch 8 (this report and the status
reconciliation) is pending independent final review. Not merged, not tagged, not
frozen.** `main` remains at frozen AVEN-009 (`80057a2`), and no `aven-010` tag
exists. Freezing requires a separate, explicit owner authorization after the
final review. No model was called. Nothing in this report is an experimental
result, and no C-versus-B claim is made.

Baseline: frozen AVEN-009, tag `aven-009`, commit
`80057a217adb90132c5b6bc1c6a5c0f798db08c5`. Package: `packages/corrections`
(`@aven/corrections`, version `aven-010-corrections-v1`). Package documentation:
[`packages/corrections/README.md`](../packages/corrections/README.md).

**Evidence classes.** This report keeps four kinds of evidence apart and labels
them:

- **Repository evidence:** committed code and tests that anyone can re-run.
- **Builder-reported:** figures from the builder's commit messages and patch
  handoffs, which were not necessarily re-run by the reviewer.
- **Independent:** findings and verdicts of the independent (Codex) audits, as
  relayed in the owner's patch authorizations.
- **Patch 8 validation:** the commands run for this patch (section W).

Collected test counts per historical commit (section D) were re-derived during
Patch 8 with `vitest list` on each commit's own tree. They count collected
tests; they are not pass results.

## A. Purpose and milestone scope

AVEN-010 implements "Correction events + immediate session override" from the
Master Description (2026-10-03, milestone list and sections 3.1, 4 and 4.2). Its
scope:

- record an explicit, structured owner correction as append-only evidence, while
  preserving the original behavior;
- apply it immediately to the current task or current session;
- expose it to the frozen Context Broker as a current owner instruction, with
  verification that it was actually selected;
- keep inspectable correction evidence for later learning.

Of the seven steps in Master Description section 4.2, AVEN-010 covers:

- **Step 1**, preserve the original evidence (the Ledger is append-only and
  `originalBehavior` is stored).
- **Step 2**, record the correction and its context.
- **An immediate, exact-identity, current-scope subset of step 4**, reduce
  retrieval weight for what was corrected.

It does **not** cover:

- step 3 (create or update a candidate preference or procedure);
- step 5 (counterexample search);
- step 6 (scope narrowing);
- step 7 (evaluation before promotion);
- durable, graded negative retrieval.

These belong to AVEN-014 and later.

AVEN-010 performs none of the following:

- learning or preference inference;
- promotion or trust decisions;
- durable owner-state writes;
- correction-derived negative-retrieval learning;
- authority or permission decisions, or Root changes;
- tool execution;
- model or provider calls;
- interpretation of free text.

## B. Frozen baseline and branch ancestry

- Baseline: `aven-009` = `80057a217adb90132c5b6bc1c6a5c0f798db08c5`, the
  AVEN-009 freeze after Windows validation. The corrected AVEN-008 anchor is
  `aven-008` = `4ea1bc537a55604cf2414fbe3886323934207382`. SHAs cited inside
  frozen documents (for example `4174080`) refer to the archived pre-attribution
  history and are never used as a baseline.
- Branch: `claude/adoring-pasteur-hcc5oe`, created from `aven-009` (D1). History
  is linear, with no merge commits; one reviewed patch or remediation is one
  commit and was never squashed or rewritten.
- Before Patch 8 there were 15 commits after `aven-009`, ending at Patch 7
  `69c5c0a0c9464df68d7a7ec94b4e9c8357e97a25`. Patch 8 adds one documentation
  commit whose sole parent is `69c5c0a`.

## C. Accepted decisions D1-D12

These were accepted by independent review before implementation and are recorded
in `AGENTS.md`.

- **D1.** Branch `claude/adoring-pasteur-hcc5oe`, from `aven-009`.
- **D2.** An in-process recorder in `@aven/corrections`; no HTTP route, and
  `apps/api` stays unchanged. Owner origin remains declared, not authenticated.
- **D3.** `unspecified` applicability applies only to the origin task (the
  correction event's envelope binding), labelled as such. Without an origin task
  it is recorded with no immediate effect.
- **D4 (modified).** Only explicit correction-to-correction linkage supersedes
  an earlier correction: an `event` target naming its event, or an `evidence`
  target naming its own evidence. It does so only within the later correction's
  own immediate scope. Sharing a target and category never supersedes: both stay
  active, and the overlap is exposed as unresolved. No text is interpreted.
- **D5.** `permission` corrections are recorded only and deferred to Root
  (AVEN-012). They are never emitted as context and never grant anything.
- **D6.** Immediate suppression sets the Broker's frozen suppression value
  (`negativeRetrieval` 1). It applies only to candidates whose reference exactly
  equals an active correction target, only within that correction's immediate
  scope, by wrapping the base sources. The AVEN-009 source configuration and the
  Broker are unchanged. This is distinct from future graded, learned negative
  retrieval (AVEN-014+) and from durable supersession or revocation
  (AVEN-017/018).
- **D7.** A current-session correction is projected as a `current_instruction`
  bound to the requesting task of that same session; the origin binding stays in
  the Ledger.
- **D8.** Instruction candidates use confidence 1, salience 1 and
  `negativeRetrieval` 0, and render only the corrected instruction, never
  `originalBehavior`.
- **D9 (modified).** Presence in the override view is not proof of selection. A
  required instruction missing from the selected `ContextBundle` yields a fixed,
  fail-closed `not_exposed` result, never a reported success. The frozen Broker
  is not modified.
- **D10.** The AVEN-010 frozen-layer tripwire lives in `packages/corrections`.
  The attribution gate lives in `tooling/attribution` and runs as
  `pnpm attribution:check`, outside the pinned `pnpm check`.
- **D11.** Claude remains the primary author; tooling-required Claude metadata
  may remain; the owner's exact co-author trailer is mandatory.
- **D12.** The owner-local Ledger `sequence` is the only ordering key.

## D. Patch-by-patch development history

"Builder-reported" counts come from commit messages or handoffs. "Collected"
counts are the Patch 8 `vitest list` re-derivation (whole repository / the
corrections package). The original candidates that needed changes are shown with
their corrective commits; none was accepted unchanged after a confirmed finding.

| #   | Commit    | Kind               | Change                                                                                                                                     | Tests                                                       |
| --- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| P1  | `19bc92b` | patch              | Status reconciliation; commit attribution gate (`tooling/attribution/`)                                                                    | builder: 1,431 / 48 files                                   |
| P2  | `9da05c7` | patch              | Package scaffold, `CorrectionError`, boundary and frozen-layer tests                                                                       | builder: 1,468 / 50                                         |
| P3  | `c9f4d41` | patch              | `recordOwnerCorrection`, the only AVEN-010 write                                                                                           | builder: 1,564 / 51                                         |
| P4  | `9c284c0` | patch              | Pure `resolveImmediateCorrections`                                                                                                         | builder: 1,646 / 52; collected 1,646 / 52 (corrections 215) |
| P4c | `8de38fd` | review correction  | Own evidence must hold the exact instruction text and recording time                                                                       | builder: 1,664 / 52; collected 1,664 (233)                  |
| R1  | `2a06705` | audit remediation  | Audit finding F1 (P2): evidence targets validated against each event's complete evidence                                                   | builder: 1,686 / 52; collected 1,686 (255)                  |
| R2  | `2e91eeb` | audit remediation  | Audit finding F2: quadratic supersession linkage replaced by an indexed linear pass                                                        | collected 1,710 / 53 (279)                                  |
| R3  | `7c92380` | audit remediation  | Audit finding F3: a Claude-authored commit must have a Claude committer                                                                    | collected 1,738 / 53 (283)                                  |
| R4  | `64c90ce` | audit remediation  | Audit finding F4: repository-wide addition guard                                                                                           | collected 1,758 / 53 (303)                                  |
| R4f | `1a5f8e4` | re-audit follow-up | R4-N1 (indexed files must exist) and R4-N2 (linked ancestors refused)                                                                      | collected 1,769 / 53 (314)                                  |
| P5  | `63fae84` | patch              | `readCorrectionHistory`, `buildCorrectionEvidenceIndex`                                                                                    | collected 1,802 / 54 (347)                                  |
| P6  | `9ccfdf3` | patch (candidate)  | `assembleWithCorrections`: instructions, suppression wrapper, exposure verification                                                        | collected 1,838 / 55 (383)                                  |
| P6r | `0d8753b` | audit remediation  | Patch 6 audit F1-F4 (wrapper trust boundary)                                                                                               | collected 1,862 / 55 (407)                                  |
| P6n | `0593d44` | re-audit follow-up | Patch 6 re-audit N1 and N2; **Patch 6 accepted at this commit**                                                                            | builder and collected: 1,867 / 55 (412)                     |
| P7  | `69c5c0a` | validation         | Cross-layer validation and adversarial campaign (tests and diagnostic benchmarks only); **independently accepted with non-blocking notes** | independent: 1,899 / 56; collected 1,899 / 56 (444)         |
| P8  | this      | documentation      | This report, the package README, status reconciliation                                                                                     | section W                                                   |

Review history in order:

1. **Patch 4 review correction (`8de38fd`).** Review found that the resolver
   located a correction's own evidence but did not check its content or time.
2. **First independent audit (after Patch 4): F1-F4.**
   - F1, P2 severity: contradictory evidence targets → R1.
   - F2: O(n²) linkage, about 69 s at 40,000 corrections in the Codex Windows
     run → R2.
   - F3: the author and the committer were allowlisted independently → R3.
   - F4: additions outside the selected trees were unguarded → R4.
3. **Re-audit of R4: R4-N1 and R4-N2** → `1a5f8e4`.
4. **Patch 6 audit: four confirmed wrapper trust-boundary findings** →
   `0d8753b`.
   - F1, foreign-owner isolation: the wrapper read or cloned foreign records
     that the Broker would have dropped unread.
   - F2, repaired scoring metadata: invalid scoring metadata on a targeted
     candidate could be overwritten into a valid suppression value instead of
     being rejected.
   - F3, error-code leakage: arbitrary error codes could leak through the
     wrapper.
   - F4, resource preprocessing bypass: the wrapper read elements before the
     Broker's raw-size and owner-quota limits were applied.
5. **Patch 6 re-audit: N1 and N2** → `0593d44`.
   - N1, source-count preflight bypass: base-source registration fields were
     read before the source-count limit.
   - N2, huge logical arrays: a huge logical array length produced
     `source_failure` instead of `source_resource_limit_exceeded`.
6. **Closure.** All six Patch 6 findings were independently closed, and Patch 6
   was accepted at `0593d4414d76e8791e7c6a96bfbfcd1f122092be`.
7. **Patch 7.** Independently accepted at
   `69c5c0a0c9464df68d7a7ec94b4e9c8357e97a25` with non-blocking notes (section
   V).

Note: "F1-F4" names two different audits. The post-Patch-4 audit findings are
remediated by R1-R4; the Patch 6 audit findings are remediated by `0d8753b`.

## E. Correction recording

**API:** `recordOwnerCorrection(storage, submission, options?)` in
`packages/corrections/src/ledger/record.ts`, exported from
`@aven/corrections/ledger`. It is the only AVEN-010 write (tests:
`test/record.test.ts`, 82 tests; boundary rules in `test/boundaries.test.ts`).

**Submission.** The submission is a strict object with these fields:

- `ownerId`, `sessionId`, `taskId`;
- `category`, one of the frozen seven: `fact`, `scope`, `preference`, `intent`,
  `procedure`, `communication`, `permission`;
- `target`, one of four frozen kinds: `event`, `evidence`, `owner_state`,
  `unidentified`;
- `originalBehavior`, `correctedInstruction`;
- `immediateApplicability`: `current_task`, `current_session` or `unspecified`;
- `durableScopeHint`, the frozen `Scope`.

**Validation.**

- The raw value is first copied into inert data without running caller code
  (`src/inert.ts`). Proxies, accessors, symbol keys, non-plain prototypes,
  inherited fields, sparse arrays and non-JSON values are refused.
- Bounds: `SUBMISSION_LIMITS` = depth 16, 2048 nodes, arrays of 256, strings of
  20,000 characters.
- The copy is then parsed with the frozen AVEN-002 schemas. There is no coercion
  or trimming.
- `options.now` and `options.generateId` are trusted configuration, read without
  running getters, and their outputs are revalidated.

**Derived, never supplied:**

- the event type (`owner_correction`);
- the event and evidence IDs;
- provenance: `explicit_owner_correction` naming the owner and the new event;
- metadata (creation component `@aven/corrections`, version
  `aven-010-corrections-v1`);
- the applicability binding:
  - `current_task` binds the submitted session and task;
  - `current_session` binds the submitted session;
  - `unspecified` records `{ kind: 'unspecified' }` with the submitted binding
    as the event's envelope task.

**Prechecks.** Six pinned, owner-scoped, read-only SELECTs (`PRECHECK_SQL`) give
each failure a fixed, owner-local code before any write:

- `unknown_binding`: a missing or foreign owner, session or task, or a wrong
  pairing;
- `unresolved_target`: a missing or foreign target;
- `identifier_collision`: an existing or self-targeting generated ID.

**Atomic append.** One `createLedger(storage, ownerId).appendEvent(...)` call
writes one `owner_correction` event and one `recorded_evidence` record whose
`recorded_text` is exactly the corrected instruction. The frozen Ledger owns:

- the transaction and the recording clock (`recordedAt`);
- the frozen `corrections` and reference projections;
- every key check at COMMIT, which stays authoritative over the prechecks.

The recorder issues no SQL write and starts no transaction of its own.

**Failure mapping after the prechecks:**

- Ledger `duplicate_event` → `identifier_collision`;
- unknown owner, session or task → `unknown_binding`;
- `invalid_reference`, transaction, storage or integrity failure →
  `storage_failure`;
- clock or generator faults, and a recording clock that precedes the injected
  occurrence time → `internal_error`.

Nothing is recorded on any failure.

## F. Original behavior, evidence, provenance and receipt

- **Original behavior** is stored verbatim in the event payload
  (`originalBehavior`) as part of the append-only record (Master Description
  4.2, step 1). It is never rendered into context (D8): the Patch 7 end-to-end
  test checks that no original-behavior text reaches any bundle or trace.
- **Own evidence.** Each correction names exactly one own evidence record
  (`payload.evidence`), recorded in the same append, with
  `explicit_owner_correction` provenance originating at the correction event.
  The resolver requires it to be `recorded_text` equal to `correctedInstruction`
  exactly (no trimming, case folding or Unicode normalization) and recorded at
  the same instant as the event (`8de38fd`). Supporting evidence is allowed; its
  content is not constrained, and it can never stand in for own evidence.
- **Provenance is declared owner origin, not authenticated identity (D2).**
  Owner-origin evidence must originate at its own correction event; nothing
  upgrades provenance from text.
- **Receipt.** A deeply frozen `CorrectionReceipt` holds `ownerId`, `eventId`,
  `evidenceId`, `sequence`, `occurredAt`, `recordedAt` and
  `immediateApplicability`, all read from the committed event. It means
  recording succeeded, not that the correction was applied, selected or trusted.
- **`durableScopeHint`** is recorded and never read by any AVEN-010 logic. Scope
  narrowing belongs to later learning milestones.

## G. Owner-local Ledger replay and evidence index

`readCorrectionHistory(storage, ownerId)` (`src/ledger/history.ts`; tests:
`test/history.test.ts`, 22 tests):

- **Replay.** One owner-bound frozen
  `replayEvents({ eventType: 'owner_correction' })`. This fixes a finite
  sequence boundary when it is called and pages (100 events per page) until that
  boundary is exhausted.
- **Entries.** Each entry keeps its real owner-local sequence, the complete
  stored event and all of the evidence the Ledger holds for it. Nothing is
  filtered by task or session, normalized, inferred or fabricated.
- **Consistency checks.** The whole history must pass the resolver's own
  consistency checks (`validateCorrectionHistory`, not a package export) before
  it is returned.
- **Result.** A detached, deeply frozen `{ ownerId, entries }`.

**Error mapping** (fixed `CorrectionError`, no cause):

- invalid owner → `invalid_correction_history`;
- unknown owner → `unknown_binding`;
- Ledger integrity failure, including undeserializable rows on any page →
  `invalid_correction_history`;
- active transaction, storage failure or any non-Ledger error →
  `storage_failure`.

A failure is never an empty or partial history. Patch 7 shows that corruption on
the second replay page fails after the first page was read and returns nothing.

**Replay boundary limitation.** Each page is a separate read transaction. The
boundary is captured at call time, so a correction appended mid-read is excluded
from that read and seen by the next one (Patch 5 test). This is **not** an
all-pages snapshot transaction.

`buildCorrectionEvidenceIndex(history)` derives an ephemeral identity index for
a validated history:

- `corrections`, in sequence order;
- `correction(eventId)`;
- `evidence(evidenceId)`, giving the owning event, sequence and role (`own` or
  `supporting`).

Lookups accept only strings; the records are frozen; no Map or Set is exposed.
Ordinary Ledger evidence is not correction evidence (it is not indexed). The
reader and the index write nothing, issue only SELECTs through the Ledger, and
read no clock or randomness.

## H. Pure immediate resolver and applicability

`resolveImmediateCorrections(history, binding, options)` (`src/resolve.ts`, root
entry; version `aven-010-immediate-resolution-v1`; tests:
`test/resolve.test.ts`, 121 tests; `test/resolve-scale.test.ts`, 24 tests) is
pure. It reads no storage, clock or randomness, and writes nothing.

**Validation.** Inputs are copied inertly. History is bounded by
`HISTORY_LIMITS`: depth 24, 4,000,000 nodes, arrays of 100,000, strings of
1,000,000. History beyond these bounds fails closed and is not truncated. The
history is then validated with the frozen schemas. Any of the following fails
with `invalid_correction_history`:

- owner disagreement;
- duplicate sequences, events or evidence;
- evidence that does not belong to its event;
- inconsistent own evidence;
- a forward or self reference to a known correction;
- an evidence target whose evidence and event disagree (R1);
- a malformed binding or options.

**Order and as-of.**

- **Order** is the Ledger sequence only (D12), never occurrence time or input
  order.
- **As-of** is the longest sequence-ordered prefix within `throughSequence` (or
  the whole history when it is `null`) that was recorded at or before
  `referenceTime` (exact instant comparison). It is applied before any linkage,
  so a later correction can never change an earlier result.

**Applicability.**

| Declared          | Applies to                                                       | Label                     |
| ----------------- | ---------------------------------------------------------------- | ------------------------- |
| `current_task`    | its exact declared session and task only                         | `current_task`            |
| `current_session` | every task of its declared session, including later ones         | `current_session`         |
| `unspecified`     | only its origin (envelope) task (D3); no envelope task → nothing | `unspecified_origin_task` |

A correction whose declared binding disagrees with its envelope has no immediate
effect anywhere.

**View.** The deeply frozen `ImmediateCorrectionView` contains:

- owner, binding and as-of boundary (with `lastIncludedSequence`);
- `active` corrections, carrying the exact `correctedInstruction` and never the
  original behavior;
- `inactive` corrections, with `superseded_by_correction` or `deferred_to_root`
  and their explicit `supersededBy` links;
- `supersessions`, `overlaps` and `suppressionTargets`.

## I. Explicit supersession, overlaps and no resurrection

- **Supersession (D4).** A later, applicable, non-permission correction
  supersedes an earlier applicable correction for the queried binding only when
  its `target` is that correction's event ID, or that correction's exact own
  evidence reference (both evidence ID and event ID).
- **Shared targets do not supersede.** A shared target or category never
  supersedes, and neither does a reference to a correction's **supporting**
  evidence.
- **Scope.** Linkage applies only within the later correction's own scope. In
  Patch 7, `c5` (`current_task` of one task) targets `c3` (`unspecified`, origin
  a sibling task) and supersedes nothing anywhere.
- **No resurrection.** A superseded correction stays inactive even when its
  superseder is itself superseded. Branching links accumulate in sequence order
  (Patch 7 case H/I: `h1` superseded by `[h2, h4]`).
- **Overlaps.** Active corrections with an identical structured target all stay
  active and are reported as unresolved `overlaps`. Nothing chooses between them
  (Patch 7 case J).
- **Algorithm.** `linkSupersessions` (R2) makes one ascending pass over two
  exact-identity indexes, so linkage is linear in the applicable corrections.
  The whole resolver is not claimed to be linear. An independent pairwise oracle
  compares results byte for byte (`test/resolve-scale.test.ts`).
- **Text.** No text is ever interpreted.

## J. Current-instruction Broker integration

`assembleWithCorrections({ history, request, sources, throughSequence })`
(`src/context-source/integration.ts`, exported from
`@aven/corrections/context-source`; tests: `test/context-source.test.ts`, 51
tests).

**One view per call.** The request is parsed once with the Broker's own
`ContextRequestSchema` from a structured clone. One immediate view is computed
for the request's owner, session, task and `referenceTime`, using the explicit
`throughSequence`. That one view drives instructions, suppression and
verification.

**Instruction candidates (D7, D8).** Each active correction becomes one
candidate from the source `aven-correction-instruction`, of kind `active_task`.
A permission correction is never active, and one reaching this step is an
internal error.

| Field         | Value                                                                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidateId` | `correction:` + SHA-256 of the JSON tuple `aven-010-correction-instruction-id-v1`, owner, requesting session, requesting task, correction event ID, own evidence ID. It is an identity tuple only, with no text, so the same correction gets a different candidate per requesting task. |
| `reference`   | `current_instruction` citing the correction's own evidence and bound to the requesting task (not the origin task; the origin stays in the Ledger)                                                                                                                                       |
| `provenance`  | `explicit_owner_correction`, naming the owner and the correction event                                                                                                                                                                                                                  |
| `scope`       | `{ kind: 'bounded', taskId }` of the requesting task                                                                                                                                                                                                                                    |
| text          | exactly `correctedInstruction`                                                                                                                                                                                                                                                          |
| timestamp     | `recordedAt` of the stored event                                                                                                                                                                                                                                                        |
| signals       | confidence 1, salience 1, `negativeRetrieval` 0                                                                                                                                                                                                                                         |

**Preflight and source budget.**

- Every candidate is preflighted against the Broker's public
  `ContextCandidateSchema`. An unrepresentable one fails closed before assembly.
- At most `MAX_SOURCES - 1` = 15 base sources are accepted. One slot is reserved
  for the instruction source, and the limit is checked before any source element
  or property is read (Patch 6 N1).

**Frozen Broker.** The Broker's weights, limits, scope rules, deduplication and
budget are unchanged. The bundle is transient context for one task, not owner
memory, not a prompt and not authority, and it is not wired into the API.

## K. Exact-target suppression and negative controls

**Exact matches (D6).** Each base source is wrapped. A same-owner candidate is
suppressed (a copy with `negativeRetrieval` 1; nothing is mutated in place) only
when it is a **valid** candidate whose structured reference exactly equals an
active correction target:

- `evidence`: both evidence ID **and** event ID;
- `owner_state`: both learned item ID **and** version.

**Never suppressed.**

- `event` targets suppress nothing, because no candidate reference carries only
  an event ID.
- `unidentified` targets have no suppression identity.
- `active_task_state` and `current_instruction` references are never compared
  with targets.

**Validation before suppression.** Malformed candidates and invalid signals
reach the Broker unrepaired and fail with its own codes (Patch 6 F2). With no
active exact target, the wrapper is a pure pass-through that reads nothing.

**Patch 6 remediation coordination** (`0d8753b`, `0593d44`):

- Foreign records are decided on the Broker's single `ownerId` read and handed
  over as inert `{ ownerId }` placeholders that the Broker drops.
- Wrapped sources wait at two barriers. No element is read until every raw
  length is within the Broker's public per-source and aggregate raw limits, and
  nothing is cloned until owner counts are within its quotas. Otherwise the
  Broker receives inert stand-ins and reports its own limit error.
- A failed or aborted source releases every barrier.

**Negative controls** (Patch 7, `test/cross-layer.test.ts`, exact-target
suppression section). Each case is assembled alone on a real recorded history;
none of the following is suppressed:

- same evidence ID with another event;
- same event with another evidence ID;
- same learned item with another version, or another item with the same version;
- unrelated evidence;
- the target of a superseded correction;
- the target of a permission correction;
- an evidence candidate sharing only an `event` target's event ID;
- supporting evidence that nobody targets;
- candidates whose text equals an `unidentified` description or an active
  instruction.

Non-targeted candidates trace exactly as in a plain Broker run, apart from rank.

**What suppression is not.** Suppression is not supersession. Supersession
deactivates an earlier **correction** for a binding; suppression lowers a **base
candidate** for one assembly within the active correction's scope. Both are
immediate and transient. Neither is durable revocation (AVEN-017/018) or graded
learned negative retrieval (AVEN-014+).

## L. Exposure verification and failure outcomes

**What "exposed" requires (D9).** After the frozen Broker assembles,
`verifyExposure` (internal) requires every required instruction to appear in the
**selected** bundle with exactly the offered identity. It checks:

- source and candidate ID;
- source kind `active_task`;
- text and reference;
- provenance and scope;
- recording time;
- no truncation (`truncated`, `includedChars`, text length).

It also requires the bundle to be for exactly the requesting owner and task, and
the bundle to contain no unexpected item from the instruction source.

The outcome is a deeply frozen union:

- `{ status: 'exposed', bundle, trace, exposed }`, where `exposed` lists
  `{ correctionEventId, evidenceId, candidateId }`;
- `{ status: 'not_exposed', reason, missing, trace | null, brokerErrorCode }`.

A `not_exposed` outcome never carries a bundle.

| Situation                                             | Outcome                                                       | Evidence (tests)                       |
| ----------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Displaced by higher-ranked context (character budget) | `instruction_not_selected`, exclusion `context_budget`        | context-source K; cross-layer exposure |
| 11th active instruction (`MAX_SELECTED_ITEMS` 10)     | `instruction_not_selected`, exclusion `item_limit`            | context-source; cross-layer            |
| Over 1600 code points                                 | `instruction_truncated` (1600 astral code points fit exactly) | cross-layer                            |
| Over the Broker's 20,000-character candidate text     | `instruction_unrepresentable`, no trace                       | context-source C/L; cross-layer        |
| Consistent duplicate kept from another source         | `instruction_not_selected`, exclusion `duplicate_identity`    | context-source E; cross-layer          |
| Conflicting duplicate                                 | `assembly_failed`, `conflicting_duplicate`                    | context-source E; cross-layer          |
| Source rejection / malformed result / timeout         | `assembly_failed`, `source_failure` / `source_timeout`        | context-source; cross-layer            |
| Invalid base-source configuration                     | `assembly_failed`, `invalid_configuration`                    | context-source F3/N1; cross-layer      |
| Altered item or wrong bundle binding                  | `instruction_altered`                                         | context-source (`verifyExposure` unit) |

When several instructions fail, the reported reason follows a fixed order:
unrepresentable, altered, truncated, not selected. A Broker error code is
reported only from the Broker's declared vocabulary, read as an own data
property (`brokerCode`, Patch 6 F3).

**Known interaction.** A base candidate citing a correction's own evidence ID
collides with that correction's instruction under the Broker's evidence-ID
deduplication, so the whole assembly fails closed with `conflicting_duplicate`
(Patch 7). This is safe but unavailable. No current source emits such
candidates; a future episode-history source would need to account for it.

## M. Permission deferral to Root

Permission corrections are recorded like any other category (D2, D5). In the
resolver they are always inactive with reason `deferred_to_root`, an empty
`supersededBy`, no suppression target, no supersession of anything, and no
susceptibility to being superseded. A permission correction can therefore never
become an instruction candidate.

Patch 7 case M records three permission corrections:

- one targets base evidence;
- one targets an active correction's event;
- one is session-wide and targets owner state.

Across both tasks, none is active, exposed, suppressing or superseding, and no
permission event ID or text appears in any bundle or trace. No approval, policy,
lifecycle or owner-state row is created, and the database rows and the change
counter are identical before and after assembly.

Nothing in AVEN-010 allows, denies or approves anything. Root (AVEN-012) does
not exist yet.

## N. Error contracts and owner isolation

**`CorrectionError`** (`src/errors.ts`):

- codes: `invalid_submission`, `unknown_binding`, `unresolved_target`,
  `identifier_collision`, `storage_failure`, `invalid_correction_history`,
  `internal_error`;
- a code-only constructor and one fixed owner-local message per code;
- unknown codes become `internal_error` by strict equality;
- no `cause`, a frozen instance, and a frozen null-prototype `toJSON` with keys
  `name`, `code`, `message`;
- carries no authority meaning.

Patch 7 checks every error it provokes: the exact code, the fixed message, no
cause, and no identifier, text, SQL, path or "sqlite" in the message or JSON.
The cases include:

- an unknown or invalid owner;
- a failing driver whose error contains SQL;
- closed storage;
- tampered or missing own evidence;
- eight inconsistent histories built from real Ledger data.

**Owner isolation.**

- Every recorder precheck and Ledger read is bound to the requesting owner.
- Owner A and owner B share every session, task, event and evidence identifier
  text in the Patch 7 scenario. Each history, index and bundle holds only its
  own owner's records.
- A history paired with another owner's request is refused with
  `invalid_correction_history`.
- Foreign candidates are dropped by the Broker without being read beyond
  `ownerId`.
- Owner-local messages do not distinguish a missing identifier from another
  owner's.

## O. Read-only restart and fresh-process persistence

From `test/cross-layer.test.ts` (restart and fresh-process section) and
`test/history.test.ts`:

- **Same-process restart.** A file-backed database is recorded, closed and
  reopened with `PRAGMA query_only = ON`. History replay, the index, resolution
  and assembly are byte-identical for two owners and three bindings.
  - Unchanged before and after: every row of every table, `sqlite_master` and
    `total_changes()`.
  - Only SELECT statements are issued.
  - A real write attempt on that connection fails as `storage_failure` and
    changes nothing.
- **Fresh process.** `test/cross-layer-replay.ts` runs as a separate Node
  process (a different pid) on a `query_only` connection. It reproduces all six
  results byte for byte, with its own row state and change counter unchanged.
- **Persistence model.** The Ledger is authoritative: nothing in AVEN-010 is
  cached between calls or persisted besides the recorder's one append, and every
  result is recomputed from recorded history.
- **Independent verification.** The Patch 7 audit independently confirmed the
  fresh Node-process, file-backed SQLite, `query_only` read-only replay,
  owner-isolation, exact-selection and restart checks.

## P. Adversarial and mutation evidence

**Builder-reported mutation checks per patch** (commit messages, on isolated
rewrites with restored files):

- P2: 38 mutants, all caught (one by typecheck).
- P3: 35, of which 34 caught and 1 equivalent.
- P4: 40, all caught after four initial survivors were closed with new tests.
- P4c: 12, of which 11 caught and 1 runtime-equivalent caught by typecheck.
- R1: 13, all caught.
- P1 attribution gate: 22 of 22 caught.

Later patches reported campaigns in their handoffs.

**Patch 7 builder campaign.** 21 behavioral mutants were run on an isolated copy
of the repository against `test/cross-layer.test.ts` only, with sources verified
byte-identical afterwards. The builder reports all 21 caught, with no load
errors, after one initial survivor was closed. That survivor was M13c, a
weakened owner quota: `structuredClone` refuses a Proxy without running a trap,
so the probe was changed to accessor-based objects. The mutants were:

- a dropped replay page in the frozen Ledger;
- ordering by `occurredAt`;
- lost or unindexed supporting evidence;
- widened origin scope;
- bypassed supersession;
- an active permission correction;
- broadened evidence or state suppression identity;
- repaired invalid signals;
- a foreign candidate kept by the Broker or by the wrapper;
- skipped verification;
- an accepted truncated instruction;
- a weakened source count;
- weakened raw or aggregate limits or owner quota;
- a read-path write;
- sessions crossed;
- `referenceTime` ignored.

**Independent sampling.** The independent Patch 7 audit detected **6 of 6
sampled** behavioral mutants. It did **not** independently re-run all 21 of the
builder's runs; the 21/21 figure remains builder-reported.

**Hostile-source regressions** (Patch 7, executable): Patch 6 F1-F4, N1 and N2,
plus barrier release with rejected, malformed, delayed, hung and aborted sibling
sources. Each completes within the Broker deadline plus margin.

## Q. Performance and resource observations

These are measurements of one environment, not guarantees. No SLA is implied.
All figures in this section are builder-reported.

**R2 resolver benchmark** (`bench/resolve.bench.ts`). Environment: Linux 6.18.44
x64, 4× Xeon 2.10 GHz, Node 24.21.0. Median of 5 samples after 1 warm-up:

- Whole resolver: 64 ms at 1,000 corrections and about 2.3 s at 40,000, in both
  distribution A (no links) and distribution B (long chains).
- Linkage step alone: 0.6-68 ms.

The pre-R2 Codex Windows measurement was about 69 s at 40,000 (independent).

**Patch 7 cross-layer benchmark** (`bench/cross-layer.bench.ts`). Same
environment, `--expose-gc`, median of 5 repeats after 1 warm-up, one file-backed
database per size. Times are milliseconds.

| Distribution, corrections             | replay (pages) | index | resolve | Broker        | verify | full assembly | fixture (once) |
| ------------------------------------- | -------------- | ----- | ------- | ------------- | ------ | ------------- | -------------- |
| chained, 0                            | 0.22 (1)       | 0.01  | 0.05    | 0.99          | 0.00   | 0.73          | 0.01           |
| chained, 100                          | 14.9 (1)       | 5.2   | 5.7     | 0.72          | 0.01   | 8.0           | 1,291          |
| chained, 1,000                        | 317 (10)       | 56    | 60      | 0.49          | 0.01   | 57            | 19,279         |
| chained, 1,205                        | 450 (13)       | 71    | 68      | 0.59          | 0.01   | 73            | 24,434         |
| flat, 1,205 (all active for one task) | 506 (13)       | 68    | 71      | 9.5 (refused) | n/a    | 100           | 23,163         |

In the flat distribution every correction is active for one task. At 100 it
reports `instruction_not_selected` (90 missing); at 1,000 and 1,205 it fails
closed with `candidate_limit_exceeded`. The JS heap stayed between 19 and 31
MiB. RSS grew to about 1.1 GiB across the run, almost entirely during fixture
recording.

**Native-memory resource risk.** This was inherited, not introduced by AVEN-010.

- **Builder observation (Patch 7, Linux, Node 24.21.0).**
  `bench/statement-retention.bench.ts` shows RSS rising with each preparation of
  the trigger-guarded evidence INSERT, about 136 KiB per prepare, in a tight
  synchronous loop. A reused prepared statement does not grow; frozen Ledger
  appends grow about 0.32 MiB each in a synchronous batch, with the JS heap
  flat. The builder's GC calls were synchronous and never yielded to the event
  loop.
- **Independent reproduction (Windows controls).** The audit reproduced the
  pressure against the frozen AVEN-009 path. It showed:
  - large native-memory involvement;
  - reclamation **while the connection remained open**;
  - statement finalization following event-loop and GC opportunities;
  - substantially lower growth when synchronous batches yielded;
  - lower preparation pressure with statement reuse.
- **Disposition.** A **P2 resource risk for large synchronous prepare/append
  batches**, not an established permanent or connection-lifetime leak. The
  builder's Patch 7 wording, that memory stays until the connection closes, is
  superseded by these controls. **Non-blocking for AVEN-010.** A separate
  **resource-readiness gate** is required before unrestricted bulk ingestion or
  a long-lived v0.1 deployment.
- **Possible later mitigations** (not implemented, and not authorized here):
  - bound synchronous batch work and allow event-loop yielding;
  - characterize the intended workloads;
  - evaluate safe prepared-statement reuse that preserves trigger, transaction,
    owner and rollback invariants;
  - validate the actually supported environments.

  Forced GC is not a production policy. No frozen storage or Ledger code was
  changed.

## R. Frozen layers, attribution and repository integrity

- **Frozen hashes.** `test/frozen-layers.test.ts` (43 tests) pins SHA-256 and
  regular mode for all 226 files tracked at `aven-009` outside the five
  authorized updates (`AGENTS.md`, `README.md`, `docs/ROADMAP.md`,
  `package.json`, `pnpm-lock.yaml`). It also holds a table digest and pins the
  three accepted attribution-gate files (R3 re-pin of two, recorded with their
  Patch 1 digests).
- **R4 repository-wide guard.**
  - Every indexed and every untracked non-ignored path must be pinned, an
    authorized update, or an authorized addition (`packages/corrections/`,
    `tooling/attribution/`, `docs/AVEN_010_REPORT.md`).
  - Every tracked entry must be a regular `100644` file present in the work
    tree, with no symbolic links, gitlinks, linked ancestors or unsafe paths.
- **Attribution gate.** `pnpm attribution:check` (`tooling/attribution/`, 69
  tests) checks every commit after `aven-009`:
  - linear history and the tag anchor;
  - allowlisted authors and committers, and the author/committer relationship
    (R3);
  - exactly one Git-parsed owner trailer for Claude-authored commits.

  It reads recorded commit metadata and is tooling discipline, not
  authentication.

- **Independent result.** All 226 frozen pins passed, and all 15 pre-Patch-8
  commits passed attribution.
- **Scope of changes.** No AVEN-010 commit changes a frozen file. The only
  shared files changed are the authorized updates (status documents, root
  `package.json` description and script, and the `pnpm-lock.yaml` importer).

## S. Known limitations, risks and deferred responsibilities

- Owner identity and origin are declared, not authenticated (as in AVEN-005).
  There is no Root gateway.
- No learning:
  - no candidate preference or procedure;
  - no scope narrowing;
  - no counterexample search;
  - no evaluation or promotion;
  - no durable owner-state write;
  - no learned or graded negative retrieval.
- Immediate effects are transient per assembly. Supersession and suppression are
  not durable revocation or trusted-version selection.
- The immediate scope is exactly `current_task`, `current_session` or the origin
  task. Session-wide scope is not representable in Broker candidates; it is
  projected per requesting task (D7).
- Overlapping active corrections are exposed, not resolved. Choosing between
  them needs owner clarification or later policy.
- `event` and `unidentified` targets suppress nothing. Suppression needs exact
  evidence or state identity.
- At most 10 instructions can be selected (Broker item limit), and over 500
  active instructions for one source fail closed. The fail-closed outcome is
  intended, but heavy correction use for one task is not exposable until a later
  milestone condenses or supersedes corrections.
- A base candidate citing a correction's own evidence makes the assembly fail
  closed (section L).
- Replay is not an all-pages snapshot transaction (section G).
- Same-process trusted runtime: intrinsics and dependency code are trusted; no
  realm or process isolation. Package separation is not security isolation.
- The bundle is not wired into any API or model path. No live provider exists.
- Native-memory resource risk for large synchronous batches (section Q): a
  separate resource-readiness gate is required.
- Validation ran on Linux (builder) and Windows (independent audits). Other
  environments are not validated.

## T. Acceptance gates and later v0.1 dependencies

AVEN-010 acceptance gates, with their current state:

1. Correction recorded atomically with original behavior, evidence and
   provenance. **Met** (P3, P4c; independently accepted).
2. Immediate current-task and current-session application, with correct
   non-application to other tasks, sessions and owners. **Met** (P4, P7 A-E).
3. Explicit supersession only, with overlaps exposed and no resurrection.
   **Met** (P4, R1, R2, P7 F-K).
4. Exact-target suppression with negative controls. **Met** (P6, P6r, P7).
5. Exposure verified against the selected bundle, failing closed. **Met** (P6,
   P6r, P6n, P7).
6. Permission deferred to Root. **Met** (P4, P7 M).
7. Read-only restart, fresh-process and owner isolation. **Met** (P5, P7;
   independently confirmed).
8. Frozen layers byte-identical and attribution passing. **Met through Patch 7;
   Patch 8 pending.**
9. Accurate final documentation. **This patch, pending independent final
   review.**
10. Freeze (merge, `aven-010` tag). **Not done; requires separate explicit
    authorization.**

**Later v0.1 dependencies.**

- AVEN-011 (action proposals) and AVEN-012 (Root Policy Gateway) are needed
  before permission corrections can mean anything.
- AVEN-014 (learning hypotheses) consumes the inspectable correction evidence
  (index and history), together with AVEN-015 (replay, counterexample and
  held-out evaluation), AVEN-016 (shadow), AVEN-017 (promotion) and AVEN-018
  (rollback and supersession).
- AVEN-019 covers model swap and the "why" trace.
- AVEN-020 is the first frozen A/B/C experiment.
- The resource-readiness gate (section Q) precedes bulk ingestion or a
  long-lived deployment.

## U. Research status

- No real foundation-model A/B/C experiment has been run. The AVEN-007 dataset
  (64 synthetic cases: 48 development, 16 held-out) still records **execution
  `not_run`**, and EXP-001 has not been run.
- **There is no evidence yet that governed Aven (C) beats naive personalization
  (B)**; AVEN-010 makes no C-versus-B claim.
- AVEN-010 delivers a tested correction-recording, immediate-override and
  context-exposure layer, not a learning result.

## V. Independent Patch 7 verdict

**APPROVE WITH NON-BLOCKING NOTES**, at
`69c5c0a0c9464df68d7a7ec94b4e9c8357e97a25`, after an independent Windows audit.
Independently verified:

- 1,899 tests in 56 files (full suite);
- 710 focused tests in 22 files;
- the 32 new cross-layer tests;
- 6 of 6 sampled behavioral mutants;
- fresh process, file-backed SQLite, `query_only` replay, owner isolation, exact
  selection and restart;
- all 226 frozen pins;
- all 15 pre-Patch-8 commits passing attribution.

The non-blocking notes concern:

- the native-memory resource risk (section Q);
- the builder-only status of the full 21-mutant campaign.

## W. Validation (Patch 8)

Patch 8 changes documentation only: this report,
`packages/corrections/README.md`, `README.md`, `docs/ROADMAP.md` and
`AGENTS.md`. Environment: Linux 6.18.44 x64, Node 24.21.0, pnpm 11.19.0 via
Corepack. Windows was not run for Patch 8. The corrections package alone
(`corepack pnpm --filter @aven/corrections test`) ran 444 tests in 8 files. The
counts equal the independently verified Patch 7 baseline because Patch 8 adds no
test. The attribution check was run again on the Patch 8 commit before pushing.

| Command                                                    | Result                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `corepack pnpm install --frozen-lockfile --ignore-scripts` | exit 0                                     |
| `corepack pnpm format:check`                               | exit 0                                     |
| `corepack pnpm typecheck`                                  | exit 0                                     |
| `corepack pnpm experiment:check`                           | exit 0                                     |
| `corepack pnpm dataset:check`                              | exit 0                                     |
| `corepack pnpm test`                                       | 1,899 tests, 56 files, all passed          |
| `corepack pnpm check`                                      | 1,899 tests, 56 files, all passed          |
| `corepack pnpm attribution:check`                          | PASS, 15 commits before the Patch 8 commit |
| `git diff --check`                                         | clean                                      |

## X. Branch and remaining steps before freeze

The candidate branch is `claude/adoring-pasteur-hcc5oe`. `main` remains at
`aven-009` (`80057a2`), and no `aven-010` tag exists. AVEN-010 is **not
frozen**. Before it can be:

1. independent final review of the Patch 8 commit, including this report;
2. any validation the owner requires for the final candidate, such as Windows;
3. an explicitly authorized merge to `main` and creation of the `aven-010` tag.

AVEN-011 is not started and not authorized. No maintenance change to the frozen
storage or Ledger layers has been made or authorized.
