# AVEN-009 report: Typed Owner Model

Status: **implementation complete on the isolated candidate branch
`claude/jolly-ptolemy-hzm28w` (patches 1-9); pending final external review,
Windows validation and an explicitly authorized merge and tag. Not merged, not
tagged, not frozen.** Validation ran in a Linux cloud container on Node 24.21.0
(section 20). Windows validation has not been run. No model was called. Nothing
in this report is an experimental result, and no C-versus-B claim is made.

Baseline: frozen AVEN-008, tag `aven-008`, commit
`4174080998d383fe78e8e4799e13103d42635151`. Package: `packages/owner-model`
(`@aven/owner-model`, version `aven-009-owner-model-v1`). Package documentation:
[`packages/owner-model/README.md`](../packages/owner-model/README.md).

## 1. Purpose and scope

AVEN-009 implements the Typed Owner Model of the Master Description (section 1,
"Owner model": "Keep typed structures for facts, preferences, episodes, intent
patterns, procedures, and active task state"). It is a **representation and
retrieval-integration layer**: typed, owner-isolated, deterministic, read-only
structures and views over the frozen AVEN-002 contracts, AVEN-003 storage and
AVEN-004 Ledger, plus a source adapter that offers that state to the unchanged
AVEN-008 Context Broker.

AVEN-009 performs no learning, preference inference, correction detection or
interpretation, negative-signal generation, promotion, trust or permission
decision, Root change, tool execution, prompt assembly, or model/provider call.
It contains no owner-state writer.

## 2. Sources and precedence

The Master Project Description (2026-10-03) takes precedence over the older
implementation instructions; the explicit instructions of each patch took
precedence over both. In the Master Description's order AVEN-007 is the naive
personalization baseline and dataset, AVEN-008 the Context Broker, AVEN-009 the
Typed Owner Model and AVEN-010 corrections. Evidence in this report comes from
the committed code and tests on the candidate branch and from the builder's
recorded patch handoffs; where a figure is builder-reported rather than
re-derivable from the repository, it says so.

## 3. Owner Model doctrine

- **The Experience Ledger is canonical recorded history, not an oracle of
  objective truth.** An appended event records that a claim was made, by whom
  and with what provenance. AVEN-009 checks owner-state snapshots against that
  history; agreement shows consistency with what was recorded, never that the
  recorded content is true.
- **Durable owner state is a set of typed, scoped, versioned, provenance-bearing
  claims.** Each snapshot is one immutable version of a stable learned-item ID,
  carrying provenance, scope, evidence signals, counterexamples, timestamps,
  model/version metadata and a lifecycle.
- **Context Broker candidates are transient retrieval data, not owner memory.**
  The adapter derives them per query and never stores them; the Broker's bundle
  is not a prompt and not a state change.
- **Model-generated interpretation is not owner evidence.** A `model_inference`
  record keeps that provenance end to end. Only owner-origin provenance kinds
  (`explicit_owner_statement`, `explicit_owner_correction`, `owner_approval`)
  are checked against owner-recorded Ledger events, and nothing upgrades
  provenance from text.
- **A recorded lifecycle claim is not authenticated Root authority.** Patch 4
  checks that a trusted, superseded or revoked claim agrees with a recorded
  transition; the transition's `authority` field remains recorded data.
- **`currentDeclared` is not a Root-selected trusted version.** It is the latest
  declared version that is still declared active at a reference time.
  Trusted-version selection belongs to Root (AVEN-017), which does not exist
  yet.
- **Prediction is not permission.** Nothing in AVEN-009 allows, denies or
  approves anything, and errors carry no authority meaning.
- **AVEN-009 performs no learning.** It reads and verifies what is recorded; it
  creates, promotes, rewrites or retires nothing.

## 4. Typed state

AVEN-009 reuses the frozen AVEN-002 schemas (`owner-state.ts`, `provenance.ts`,
`scope.ts`, `transitions.ts`) and defines no second vocabulary.

| Kind                  | Category / content                                                         |
| --------------------- | -------------------------------------------------------------------------- |
| `durable_owner_state` | `fact`: subject, assertion                                                 |
| `durable_owner_state` | `preference`: subject, desiredBehavior                                     |
| `durable_owner_state` | `episode`: summary, occurredAt, originalEvidence (at least one)            |
| `durable_owner_state` | `intent_pattern`: cue, interpretedIntent                                   |
| `durable_owner_state` | `procedure`: objective, ordered steps (instruction, optional precondition) |
| `active_task_state`   | task binding, objective, openLoops, sourceEvidence; `active` or `closed`   |

**Durable/active separation.** One stable ID is one record kind across all
versions (`identity_conflict` otherwise). Lineage, claims and category views
read durable records only; the active task view reads active task records only;
no reference resolves across the two.

**Scope semantics are preserved, never widened.** Bounded scopes (domain, task
type, task ID, qualifiers, optional temporal window), `unknown`, `uncertain`
(several bounded possibilities) and `global` (explicit declaration) are carried
exactly as recorded. Views interpret only a bounded scope's own temporal window;
the adapter copies scope unchanged; the Broker alone applies scope to a task.
Session-wide scope is not representable in the frozen contracts and stays
deferred.

**Facts are not objective truth.** A fact is a declared, provenance-bearing
claim with recorded support and certainty signals. **Preferences are not
universal traits.** A preference applies within its declared scope only, and
nothing generalizes it. **Procedures are not executable tools.** A procedure is
text data: the adapter renders its steps; nothing executes, plans or schedules
them.

## 5. Patch-by-patch implementation

### 5.1 Patch 1: scaffold, fixed errors, frozen-layer guards

- **Commits:** `3e9646d` (scaffold), `0156bc8` (error-code canonicalization
  fix).
- **Purpose:** package identity, a fixed error surface and regression guards
  before any domain logic.
- **Implementation:** `src/config.ts` (`AVEN_009_OWNER_MODEL_VERSION`, deeply
  frozen `OWNER_MODEL_CONFIG` holding only version, frozen baseline and contract
  schema version 1), `src/errors.ts` (`OwnerModelError`: code-only constructor,
  one fixed message per code, no `cause`, frozen instance, null-prototype
  `toJSON`; an unknown code becomes `internal_error` by strict equality only),
  `src/index.ts`, `test/boundaries.test.ts` and
  `tooling/tests/aven-009-frozen-layers.test.ts` (SHA-256 of all 195 files
  tracked at `aven-008` outside the authorized update set, plus a no-addition
  walk of 22 frozen trees).
- **Contracts reused:** none yet; `@aven/contracts` and `zod` declared.
- **Key invariants:** no caller text, value or cause crosses the error boundary;
  frozen layers stay byte-identical.
- **Evidence:** 712 tests in 39 files at `3e9646d`; 731 in 39 at `0156bc8`
  (builder-reported).
- **Limitations:** static rules are pattern tripwires and can be bypassed by
  deliberately obfuscated code.

### 5.2 Patch 2: owner-bound typed intake and identity

- **Commits:** `202d589` (intake), `74c782b`, `14e506a`, `ea79e1a` (review
  hardening against inherited prototype behavior and hostile intake).
- **Purpose:** the single validating boundary for caller-supplied owner state.
- **Implementation:** `src/intake.ts` (`intakeOwnerState`), `src/ambient.ts`
  (ambient-prototype gate), `src/canonical-text.ts` (own-data canonical text,
  the only module allowed to call `JSON.stringify`), `test/intake.test.ts`,
  `test/fixtures.ts`, `test/fresh-process.test.ts`.
- **Contracts reused:** `OwnerStateSchema`, `DurableOwnerStateSchema`,
  `ActiveTaskStateSchema`, `OwnerIdSchema` and the provenance/scope schemas they
  embed.
- **Key invariants:**
  - A request is a plain object with exactly `ownerId` and `records`.
  - Ownership is read from one own data property per element: another
    well-formed owner's records are dropped unread; unrecognizable ownership
    fails closed with `invalid_input`.
  - Each requesting-owner record is copied into inert own data and validated
    strictly by the frozen schema; nothing is coerced or repaired.
  - Identity: one ID is one record kind (`identity_conflict`); equal ID and
    version must be canonically identical (`conflicting_duplicate`); one durable
    ID keeps one category (`identity_conflict`); `metadata.createdAt` never
    decreases as `recordVersion` increases (`version_order_conflict`, equal
    accepted).
  - `Object.prototype` and `Array.prototype` must match a pinned standard
    baseline, re-checked after every caller-controlled reflective read.
  - Output: frozen, null-prototype, canonically ordered (ID, then version);
    independent of input order and of foreign records.
- **Evidence:** 844 / 880 / 885 / 913 tests (40, 40, 40, 41 files) across the
  four commits (builder-reported); fresh-process tests install pollution before
  import.
- **Limitations:** the trusted runtime (`Reflect`, `Object` statics, global
  bindings) is assumed untampered; tampering with intrinsics needs realm
  isolation, not an in-realm check. Raw bounds: 100,000 records, depth 32.

### 5.3 Patch 3: structural lineage and version graph

- **Commit:** `db2d571`.
- **Purpose:** an exact, deterministic version graph of durable state.
- **Implementation:** `src/lineage.ts` (`buildDurableLineage`, internal),
  `test/lineage.test.ts`.
- **Contracts reused:** `LearnedLifecycleSchema` (superseded `replacement`,
  revoked `fallback`), `LearnedItemReferenceSchema`.
- **Key invariants:** histories per stable ID with every version in numeric
  order; edges only from a superseded snapshot's `replacement` and a revoked
  snapshot's optional `fallback`; a reference resolves only to that exact (ID,
  version) in the same owner's durable set and the same category
  (`invalid_lineage_reference`); any directed cycle fails (`lineage_cycle`);
  cycle detection is iterative and linear. No notion of "current" or "in force".
- **Evidence:** 1,008 tests in 42 files; a 10,000-node chain succeeds; 19
  mutants caught (builder-reported).
- **Limitations:** structure only; claims are verified in Patch 4.

### 5.4 Patch 4: lifecycle claim and transition agreement

- **Commits:** `1fb65ce`, `f9e9982` (review fix: removed an unsupported
  timestamp-equality rule; transitions validated only as inert copies).
- **Purpose:** check that trusted, superseded and revoked claims agree with
  recorded learning transitions.
- **Implementation:** `src/claims.ts` (`verifyLifecycleClaims`, internal),
  `test/claims.test.ts`.
- **Contracts reused:** `LearningTransitionSchema` and its promotion,
  supersession and revocation payloads.
- **Key invariants:** resolution by exact `eventId`; trusted needs a matching
  `learning_promotion` (exact trusted state, candidate and ordered evaluations);
  superseded needs a matching `learning_supersession` (exact previous and
  replacement edge); revoked needs a matching `learning_revocation` (exact
  revoked, fallback presence and target, reason). Timestamps are not compared. A
  repeated `eventId` fails closed. Foreign transitions are dropped unread. Every
  disagreement is the one fixed `invalid_lifecycle_claim`. Nothing is applied.
- **Evidence:** 1,104 tests in 43 files at `1fb65ce`, 1,127 in 43 at `f9e9982`;
  26 and 21 mutants caught (builder-reported).
- **Limitations:** `observed` and `validated` claims need no backing, and
  validation `evaluations` references are not resolved; agreement is not Root
  authentication.

### 5.5 Patch 5: durable category views

- **Commit:** `39dbdfb`.
- **Purpose:** what durable state is declared, per category, at an explicit
  reference time.
- **Implementation:** `src/views.ts` (`buildDurableCategoryViews`, internal),
  `src/timestamps.ts` (`compareInstants`, extracted unchanged from intake),
  `test/views.test.ts`.
- **Contracts reused:** `TemporalQualifierSchema`, the lifecycle schemas and
  `TimestampSchema`.
- **Key invariants:** see section 7. Episodes whose `occurredAt` is after their
  `createdAt` fail with `invalid_owner_state_view`.
- **Evidence:** 1,194 tests in 44 files; 27 non-equivalent mutants caught; one
  equivalent mutant (removing a redundant sort) documented as not catchable
  (builder-reported).
- **Limitations:** not authoritative; no domain, task or context matching (the
  Broker's job).

### 5.6 Patch 6: active task state view

- **Commit:** `8626f40`.
- **Purpose:** the latest declared active task state for one exact task binding.
- **Implementation:** `src/active-task.ts` (`buildActiveTaskView`, internal),
  `test/active-task.test.ts`.
- **Contracts reused:** `ActiveTaskStateSchema`, `SessionIdSchema`,
  `TaskIdSchema`.
- **Key invariants:** see section 8.
- **Evidence:** 1,247 tests in 45 files; 25 mutants caught (builder-reported).
- **Limitations:** no expiry, freshness or execution.

### 5.7 Patch 7: read-only persisted rebuild with Ledger history

- **Commit:** `8d8944f`.
- **Purpose:** rebuild the verified model of one owner from persisted state.
- **Implementation:** `src/persistence/rebuild.ts` and `index.ts`
  (`@aven/owner-model/persistence`, `rebuildOwnerModel`), `test/persisted.ts`,
  `test/persistence.test.ts`; adds `@aven/storage` and `@aven/ledger` to the
  subpath only.
- **Contracts reused:** `OwnerIdSchema`, frozen storage `deserializeContract`,
  `createLedger(storage, ownerId).replayEvents()`, stored `ExperienceEvent`s and
  their transition payloads.
- **Key invariants:** see section 9.
- **Evidence:** 1,334 tests in 46 files; 31 mutant runs caught
  (builder-reported); zero-change and byte-identical file tests.
- **Limitations:** separate read transactions; narrow evidence checks; cost
  (section 15).

### 5.8 Patch 8: Context Broker source adapter

- **Commit:** `3651415`.
- **Purpose:** offer the rebuilt model to the unchanged AVEN-008 Broker.
- **Implementation:** `src/context-source/sources.ts` and `index.ts`
  (`@aven/owner-model/context-source`), `test/context-source.test.ts`; adds
  `@aven/context-broker` to the subpath only; new error code
  `invalid_owner_model_context`.
- **Contracts reused:** the Broker's public `ContextCandidateSchema` and
  `ContextSource` types (which reuse AVEN-002 `ContextSource`, `Provenance` and
  `Scope`).
- **Key invariants:** see sections 10 and 11.
- **Evidence:** 1,386 tests in 47 files; 699 owner-model tests in 9 files; 40 of
  40 mutants caught (builder-reported).
- **Limitations:** no caching; provisional signals; not wired into any API or
  prompt path.

### 5.9 Patch 9: documentation and milestone reconciliation

- **Commit:** the documentation commit on top of `3651415` (this report).
- **Purpose:** record the milestone and reconcile mutable status documents.
- **Implementation:** this report, `packages/owner-model/README.md`, updates to
  `README.md`, `docs/ROADMAP.md`, `AGENTS.md`, the root `package.json`
  description and the header comment of `packages/owner-model/src/index.ts`.
- **Key invariants:** no runtime behavior, export, test or frozen file changes.
  The historical AVEN-008 report is not rewritten; its status header records
  that milestone's own state before its freeze.
- **Evidence:** section 20.
- **Limitations:** documentation only.

## 6. Lifecycle and versions

| Status       | Recorded fields (frozen)                                                | AVEN-009 behavior                                                        |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `observed`   | none                                                                    | no backing required; can be `currentDeclared`                            |
| `validated`  | evaluations, lastValidatedAt                                            | no backing required (evaluations not resolved); can be `currentDeclared` |
| `trusted`    | evaluations, lastValidatedAt, candidate, promotionEventId               | must match a recorded promotion; can be `currentDeclared`                |
| `superseded` | supersededAt, replacement, eventId, optional lastValidatedAt            | must match a recorded supersession; never `currentDeclared`              |
| `revoked`    | revokedAt, reason, eventId, optional fallback, optional lastValidatedAt | must match a recorded revocation; never `currentDeclared`                |

- **Numeric record versions:** positive integers per stable ID, compared
  numerically; gaps are allowed and no first version is required.
- **Identity and category consistency:** one record kind per ID and one category
  per durable ID.
- **Nondecreasing creation times:** `createdAt` never moves backwards as the
  version increases (exact instants, full fractional precision).
- **Exact lineage references:** replacement and fallback resolve only to the
  exact (ID, version), same owner, same category.
- **Cycle detection:** any directed cycle over replacement and fallback edges
  fails.
- **Matching recorded transitions:** section 5.4.
- **History preservation:** every version stays in its history; nothing is
  deleted, merged or rewritten.
- **No rollback application:** recorded rollbacks and rejections are inert.
- **No automatic fallback:** a revoked head's `fallback` is not followed.
- **No trusted-version selection:** no stage chooses among versions by trust.

## 7. Category views

`buildDurableCategoryViews(verified, { referenceTime })` requires an explicit
AVEN-002 timestamp and reads no clock. For each stable ID, by category (`facts`,
`preferences`, `episodes`, `intentPatterns`, `procedures`, each ordered by ID):

- `latestDeclared`: the highest-version snapshot whose `createdAt` is at or
  before `referenceTime`. This is historical as-of selection: **future versions
  are excluded**, and an ID with no snapshot by then is absent.
- `currentDeclared`: that same snapshot, present only when its lifecycle is
  observed, validated or trusted and its own **bounded temporal window** covers
  `referenceTime` (`from` inclusive, `until` exclusive).

Both fields are **non-authoritative**: they describe what is declared, not what
Root selected, what is true, or what is permitted. **A superseded or revoked
latest head is inactive** and has no `currentDeclared`; **older trusted versions
are not resurrected**, and a trusted older version never outranks a newer
observed one. **Unknown and uncertain scopes are not silently widened**: they
are carried as recorded and only a bounded scope's own temporal window is
evaluated.

## 8. Active task views

`buildActiveTaskView(intake, { sessionId, taskId })`:

1. takes **the latest version per stable active-task ID first**;
2. then requires **exact `(sessionId, taskId)` matching** and lifecycle
   `active`.

So **closed heads are excluded** (completed or cancelled alike) and **older
active states are not resurrected**. **Different IDs are never compared by
version number.** No match returns `undefined`; one match returns that frozen
snapshot; **two or more distinct active IDs fail closed** with
`active_task_conflict`. There is **no expiry** (an old active head stays active)
and **no task execution**.

## 9. Persisted rebuild

Definition used throughout AVEN-009:

```text
stored immutable snapshots (learned_owner_state, active_task_state, this owner)
+ owner-bound Ledger history (createLedger(storage, ownerId).replayEvents())
+ accepted Owner Model validators (intake -> lineage -> claim verification)
= read-only rebuilt representation { ownerId, intake, verified }
```

- **No snapshots are synthesized from Ledger events.** A promotion event with no
  stored snapshot produces no state; tests confirm it.
- **No owner-state writer was built.** Snapshot rows are produced only by test
  fixtures in this milestone.
- **Owner-origin verification:** a snapshot with `explicit_owner_statement`,
  `explicit_owner_correction` or `owner_approval` provenance must cite a
  `sourceEventId` this owner's Ledger records as `owner_request`,
  `owner_correction` or `owner_approval` respectively; a `confirmed` or
  `disputed` owner confirmation must cite an owner request or correction event
  of this owner whose recorded evidence contains that evidence ID.
- **Transitions:** every recorded `learning_promoted`, `_rejected`,
  `_superseded`, `_revoked` and `_rolled_back` payload goes to claim
  verification; the `lifecycle_records` projection is never read.
- **Errors:** a malformed owner ID is `invalid_input`; storage, Ledger,
  deserialization, unknown-owner and owner-origin failures are
  `invalid_persisted_owner_model`; fixed intake, lineage and claim codes pass
  through.
- **Read-only tests:** two pinned owner-scoped `SELECT` statements, each checked
  read-only by SQLite; `total_changes()` unchanged across rebuilds; a
  file-backed database stays byte-identical; a static guard forbids writes.
- **Owner-isolation tests:** owner A rebuilds identically whatever owner B
  holds; a failing owner B does not affect owner A; another owner's identical
  event ID never backs a claim; an unknown owner fails without reading others.
- **Acknowledged limitation:** the snapshot read and the Ledger replay are
  **separate read transactions** (the Ledger refuses to run inside another), so
  a consistent rebuild assumes storage that is not being written concurrently.

The Master Description requires derived owner state to be rebuildable from the
Ledger. AVEN-009 verifies stored snapshots against recorded history; it does not
derive snapshots from events, because no event-to-state writer exists yet.
Section 18 lists this for review.

## 10. Context Broker adapter

`createOwnerModelContextSources(rebuilt)` accepts only a genuine Patch-7 result
(`invalid_input` otherwise) and returns four frozen sources:

| Source ID              | Kind              | Category routing                 | Reference kind      |
| ---------------------- | ----------------- | -------------------------------- | ------------------- |
| `aven-owner-state`     | `owner_state`     | fact, preference, intent_pattern | `owner_state`       |
| `aven-procedure`       | `procedure`       | procedure                        | `owner_state`       |
| `aven-episode-history` | `episode_history` | episode                          | `owner_state`       |
| `aven-active-task`     | `active_task`     | active task state                | `active_task_state` |

- **Verified `currentDeclared` only:** durable candidates come from the Patch-5
  views of the verified model at `query.referenceTime` (historical as-of), so
  superseded, revoked, future and out-of-window versions are never offered. The
  reference carries the lifecycle status, which the Broker uses for trust.
- **Exact active task binding:** the Patch-6 view for `query.task`; scope
  `{ kind: 'bounded', taskId }`.
- **Owner:** a query for another owner returns a frozen `[]` before anything is
  built.
- **Structured provenance and scope:** copied unchanged; text can change no
  structured field. Through the Broker, external content stays `label_untrusted`
  and tool results `label_potentially_untrusted`.
- **Deterministic rendering** (`aven-009-owner-model-render-v1`): fact
  `subject\nassertion`; preference `subject\ndesiredBehavior`; intent pattern
  `cue\ninterpretedIntent`; episode `summary`; procedure objective then
  `\n<n>. instruction` with ` [precondition: …]` when present; active task
  objective, plus `\nOpen loops:` and `\n- loop` lines when loops exist.
- **Timestamps:** `recordedAt` = `metadata.createdAt`; `lastValidatedAt` only
  when the lifecycle records it.
- **Compact SHA-256 candidate IDs** (`aven-009-owner-model-candidate-id-v1`):
  `om:<state|procedure|episode|task>:<hex>` over the UTF-8 JSON array
  `[idVersion, configVersion, sourceKind, ownerId, learnedItemId, recordVersion]`;
  at most 77 characters, content-free. Candidates are sorted by ID code units.
- **Fail-closed capacity and metadata:** every candidate is preflighted against
  the Broker's `ContextCandidateSchema`; oversized text or metadata, or more
  candidates than `query.maxCandidates`, fails the whole collection with
  `invalid_owner_model_context` (the Broker reports `source_failure`). Nothing
  is truncated, dropped or ranked.
- **No Broker modification, no prompt assembly, no model call, no
  `current_instruction`.** The Context Broker's files are byte-identical to
  `aven-008`.

End-to-end tests with the unchanged Broker show: a trusted record ranks above an
otherwise identical observed record; a narrow non-matching scope is excluded as
`scope_mismatch`; assembly follows the request `referenceTime`; the active task
appears only for the exact binding; oversize or over-quota sources fail the
assembly. These are synthetic mechanics checks.

## 11. Configuration freeze: `aven-009-owner-model-source-config-v1`

`AVEN_OWNER_MODEL_SOURCE_CONFIG_V1` is deeply frozen and pinned by a test.

| Support        | Factor |     | Inference certainty | Factor |
| -------------- | -----: | --- | ------------------- | -----: |
| `unassessed`   |   0.25 |     | `not_applicable`    |      1 |
| `limited`      |    0.5 |     | `unassessed`        |    0.5 |
| `corroborated` |      1 |     | `tentative`         |    0.5 |
| `contested`    |   0.25 |     | `supported`         |      1 |
|                |        |     | `disputed`          |   0.25 |

- `calibration`: `provisional_ordinal_not_probability`
- `confidenceCombiner`: `minimum` (durable confidence = min of the two factors;
  lifecycle, provenance and category do not enter it)
- `activeTaskConfidence`: 0.5
- `salience`: 0.5 for every candidate
- `negativeRetrieval`: 0 for every candidate (AVEN-009 generates no negative
  signals)
- `rendering.version`: `aven-009-owner-model-render-v1`
- `candidateId.version`: `aven-009-owner-model-candidate-id-v1`

These values are **provisional ordinal values, not calibrated probabilities**.
They were specified before any real A/B/C evaluation. **Do not tune them**; a
change requires a new configuration version and evidence. Trust is not a source
signal: the Broker derives it from provenance and lifecycle with its own frozen
weights.

## 12. Package API

| Entry                              | Runtime exports                                                                                                        | Adds dependencies               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@aven/owner-model`                | `AVEN_009_OWNER_MODEL_VERSION`, `OWNER_MODEL_CONFIG`, `OWNER_MODEL_ERROR_CODES`, `OwnerModelError`, `intakeOwnerState` | `@aven/contracts`, `zod`        |
| `@aven/owner-model/persistence`    | `rebuildOwnerModel`                                                                                                    | `@aven/storage`, `@aven/ledger` |
| `@aven/owner-model/context-source` | `AVEN_OWNER_MODEL_SOURCE_CONFIG_V1`, `createOwnerModelContextSources`                                                  | `@aven/context-broker`          |

The five root runtime exports are pinned by tests. Internal helpers, exported by
no entry: `buildDurableLineage`, `verifyLifecycleClaims`,
`buildDurableCategoryViews`, `buildActiveTaskView`, the `is*` brand checks, the
ambient gate, canonical text and `compareInstants`. Core modules import only
`@aven/contracts` and `zod`; only `persistence/` imports storage and the Ledger;
only `context-source/` imports the Broker (and `node:crypto`). Static tests pin
these import allowlists. **Package boundaries are not enforced process or
security isolation.**

## 13. Error surface

`OwnerModelError` codes, each with one fixed message and no cause:
`invalid_input`, `internal_error`, `conflicting_duplicate`, `identity_conflict`,
`version_order_conflict`, `invalid_lineage_reference`, `lineage_cycle`,
`invalid_lifecycle_claim`, `invalid_owner_state_view`, `active_task_conflict`,
`invalid_persisted_owner_model`, `invalid_owner_model_context`. No error carries
an ID, version, count, position, owner, event, table, SQL or text.

## 14. Test evidence

Evidence classes, kept distinct:

- **Builder-reported test executions:** the counts below come from the builder's
  own validation runs recorded in each patch handoff.
- **Independently inspected code:** patches 1-8 were each reviewed externally
  and accepted before the next began; patch 9 awaits final review. Acceptance is
  a review outcome, not a re-measurement recorded in this report.
- **Synthetic mechanics tests:** every owner, ID and text is synthetic; tests
  check representation, verification and retrieval mechanics.
- **Real-model experiments:** none.

Full repository after each commit (builder-reported):

| Commit     | Tests | Files |
| ---------- | ----: | ----: |
| `aven-008` |   681 |    37 |
| `3e9646d`  |   712 |    39 |
| `0156bc8`  |   731 |    39 |
| `202d589`  |   844 |    40 |
| `74c782b`  |   880 |    40 |
| `14e506a`  |   885 |    40 |
| `ea79e1a`  |   913 |    41 |
| `db2d571`  | 1,008 |    42 |
| `1fb65ce`  | 1,104 |    43 |
| `f9e9982`  | 1,127 |    43 |
| `39dbdfb`  | 1,194 |    44 |
| `8626f40`  | 1,247 |    45 |
| `8d8944f`  | 1,334 |    46 |
| `3651415`  | 1,386 |    47 |

Accepted Patch-8 evidence: **1,386 tests in 47 files; 699 owner-model tests in 9
files** (intake 173, lineage 93, claims 116, views 66, active task 52,
persistence 75, context source 39, boundaries 79, fresh process 6); **40 of 40
Patch-8 mutants detected**. Patch 9 adds no tests (section 20).

Mutation campaigns (builder-reported, per campaign; **no cumulative total is
claimed**, because the patch 1 scaffold was checked by deliberate guard breakage
rather than a numbered campaign and campaigns overlap across fix commits):

| Campaign  | Result                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `0156bc8` | 6 of 6 caught (acceptance review)                                        |
| `202d589` | 10 of 10 caught                                                          |
| `74c782b` | 15 of 15 caught                                                          |
| `14e506a` | 10 of 10 caught                                                          |
| `ea79e1a` | 15 of 16 caught; 1 equivalent by construction                            |
| `db2d571` | 19 of 19 caught                                                          |
| `1fb65ce` | 26 of 26 caught                                                          |
| `f9e9982` | 21 of 21 caught                                                          |
| `39dbdfb` | 27 of 27 non-equivalent caught; 1 equivalent (redundant sort) not caught |
| `8626f40` | 25 of 25 caught                                                          |
| `8d8944f` | 31 of 31 runs caught                                                     |
| `3651415` | 40 of 40 caught                                                          |

Mutants detected **only by static guards** (runtime-equivalent or
runtime-inert): Patch 3 #17 (type-only Ledger import); Patch 4 #23 (all
transitions scanned per claim); Patch 7 #01, #02, #03 and #27a (owner predicate
or `ORDER BY` removed; caught by the pinned SQL) and #18 (inert append call);
Patch 8 #34 (prompt assembly, static boundary rule) and #37 (Broker edited,
frozen-layer tripwire). Static checks are **regression tripwires, not general
security proofs**; they can be bypassed by deliberately obfuscated code.

## 15. Performance

Builder measurements in the Linux container, Node 24.21.0; not production-scale
claims.

Patch-7 full rebuild (median of 5, after setup, 6 Ledger events unless noted):

| Snapshots | Storage read | Ledger replay + index | Owner-model pipeline | Full rebuild |
| --------: | -----------: | --------------------: | -------------------: | -----------: |
|       100 |       1.5 ms |                1.1 ms |               164 ms |  **~168 ms** |
|     1,000 |        11 ms |                1.1 ms |               1.61 s |  **~1.72 s** |
|     5,000 |        56 ms |                1.4 ms |               8.40 s |  **~8.29 s** |

With 2,006 paged Ledger events and 1,000 snapshots the rebuild took ~1.72 s.
Cost is linear and **dominated by Patch-2 intake** (about 1.6 ms per record:
ambient-gate re-checks, inert snapshots and strict frozen-schema validation).
The columns were timed separately, so the 5,000-row medians do not sum exactly.

Patch-8 collect only (excluding rebuild and Broker ranking; 30 timed runs after
5 warm-up runs, 4 vCPU):

| Case                                      | Candidates |   Median |      p95 |
| ----------------------------------------- | ---------: | -------: | -------: |
| 100 durable, mixed, three durable sources |        103 |  4.59 ms |  6.36 ms |
| 500 durable, mixed, three durable sources |        503 | 19.70 ms | 28.98 ms |
| Maximum per source (`owner_state`, 500)   |        500 | 15.43 ms | 20.15 ms |
| Active task lookup, maximum-size model    |          1 |  0.13 ms |  0.23 ms |

Every `collect` call rebuilds the Patch-5 views; nothing is cached. The rebuild
cost above is not hidden by these figures: a Broker assembly over persisted
state pays the full rebuild first.

## 16. Research status

- **No real foundation-model A/B/C experiment was run.**
- **There is no evidence yet that governed Aven (C) beats naive personalization
  (B).** AVEN-009 makes no C-versus-B claim.
- The AVEN-007 dataset still records **`execution: not_run`**; EXP-001 has not
  been run.
- No claim of AGI, consciousness, alignment, general safety or autonomous
  learning success is made.
- AVEN-009 delivers **a tested representation and retrieval-integration layer**,
  not a validated longitudinal learning result.

## 17. Known limitations

These bound what AVEN-009 shows; none is treated as automatically fatal to the
milestone.

- No owner-state writer; snapshots exist only as stored rows (tests use
  fixtures).
- No correction interpretation and no `current_instruction` (AVEN-010).
- No negative-retrieval generation (`negativeRetrieval` is always 0).
- No learning, hypothesis generation, evaluation or promotion controller.
- No Root authenticity verification: transition `authority` is recorded data.
- No authenticated owner identity (owner IDs are declared, as in AVEN-005).
- No model-integrated chat path; the Broker bundle is not wired into the API.
- No real-model A/B/C result.
- No production UI or voice.
- No concurrent-consistent persisted rebuild guarantee (separate read
  transactions).
- No caching of category views during collection.
- No session-wide scope representation (frozen contracts).
- No general evidence graph or taint propagation: only owner-origin provenance
  and owner confirmations are checked against history; supporting evidence,
  counterexamples and derivations are not.
- Identity branding is per module instance and not serializable.
- Same-process trusted runtime assumption: intrinsics and dependency code are
  trusted; no realm or process isolation.
- Full-rebuild performance cost (section 15).
- Provisional, uncalibrated source confidence values (section 11).

## 18. Decisions for external review

1. **Rebuild definition.** Stored immutable snapshots verified against
   owner-bound Ledger history, not snapshots derived from events. Deriving owner
   state from events needs an event-to-state writer, which belongs to a later,
   authorized milestone.
2. **Declared, not selected.** `latestDeclared` and `currentDeclared` remain
   non-authoritative until Root-controlled selection exists.
3. **Source configuration v1.** Provisional ordinal signals, minimum combiner,
   negativeRetrieval 0; frozen until evidence justifies a new version.
4. **Fail closed on capacity.** The adapter never truncates or trims; an
   oversized owner model makes the source fail rather than silently drop state.

## 19. Frozen-layer preservation

All AVEN-009 commits change only `packages/owner-model`, the new
`tooling/tests/aven-009-frozen-layers.test.ts`, `pnpm-lock.yaml` (owner-model
importer), and the authorized mutable documents (`AGENTS.md`, `README.md`,
`docs/ROADMAP.md`, root `package.json`) plus this new report. Contracts,
storage, migrations, Ledger, runtime, baseline, Context Broker, API,
experiments, evaluation data, source documents and earlier reports are
byte-identical to `aven-008`; the AVEN-009 tripwire pins 195 files by SHA-256.
The historical AVEN-008 report is deliberately not rewritten.

## 20. Validation (patch 9)

Environment: Linux cloud container, Node 24.21.0, pnpm 11.19.0 via Corepack.
Windows: **not run**. All commands passed (exit 0). Patch 9 changes only
documentation, one source comment and the root package description, so the
counts equal the accepted Patch-8 baseline, which `pnpm check` reproduced before
any edit.

| Command                                                    | Result                |
| ---------------------------------------------------------- | --------------------- |
| `corepack pnpm install --frozen-lockfile --ignore-scripts` | exit 0                |
| `corepack pnpm format:check`                               | exit 0                |
| `corepack pnpm typecheck`                                  | exit 0                |
| `corepack pnpm experiment:check`                           | exit 0                |
| `corepack pnpm dataset:check`                              | exit 0                |
| `corepack pnpm --filter @aven/owner-model test`            | 699 tests, 9 files    |
| `corepack pnpm --filter @aven/context-broker test`         | 133 tests, 10 files   |
| `corepack pnpm --filter @aven/baseline test`               | 82 tests, 6 files     |
| `corepack pnpm --filter @aven/runtime test`                | 30 tests, 2 files     |
| `corepack pnpm --filter @aven/api test`                    | 92 tests, 5 files     |
| `corepack pnpm --filter @aven/ledger test`                 | 60 tests, 2 files     |
| `corepack pnpm db:test`                                    | 73 tests, 2 files     |
| `corepack pnpm test`                                       | 1,386 tests, 47 files |
| `corepack pnpm check`                                      | 1,386 tests, 47 files |
| `git diff --check`                                         | clean                 |

## 21. Branch and remaining steps before freeze

The candidate branch is `claude/jolly-ptolemy-hzm28w`; `main` remains at
`aven-008` (`4174080`) and no `aven-009` tag exists. AVEN-009 is **not frozen**.
Before it can be:

1. final external review of patches 1-9, including this report;
2. Windows validation of the full command set (section 20);
3. an explicitly authorized merge to `main` and creation of the `aven-009` tag;
4. a later milestone's own frozen-layer pins, if it is authorized to build on
   AVEN-009.

AVEN-010 is not started and not authorized.
