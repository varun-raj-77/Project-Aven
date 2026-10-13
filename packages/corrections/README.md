# @aven/corrections

AVEN-010: correction events and immediate session overrides (version
`aven-010-corrections-v1`).

This package does five things:

- records an explicit, structured owner correction as append-only evidence;
- reads one owner's recorded corrections back from the frozen Experience Ledger;
- resolves which corrections apply immediately to one task at an explicit as-of
  boundary;
- offers the applicable ones to the frozen Context Broker as current owner
  instructions;
- verifies that they were actually selected.

It learns nothing, writes no owner state, decides no permission, executes no
tool and calls no model. See the
[AVEN-010 report](../../docs/AVEN_010_REPORT.md) for the design decisions
(D1-D12), evidence and limitations. AVEN-010 is an implementation-complete
candidate on an isolated branch; it is not merged, tagged or frozen.

## Entry points

| Import                             | Exports                                                                                                                                                                                          | Depends on                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `@aven/corrections`                | `AVEN_010_CORRECTIONS_VERSION`, `CORRECTIONS_CONFIG`, `CORRECTION_ERROR_CODES`, `CorrectionError`, `IMMEDIATE_RESOLUTION_VERSION`, `resolveImmediateCorrections`, and the view and history types | `@aven/contracts`, `zod` (pure: no storage)   |
| `@aven/corrections/ledger`         | `recordOwnerCorrection` (the only writer), `readCorrectionHistory`, `buildCorrectionEvidenceIndex`, and their types                                                                              | adds `@aven/storage`, `@aven/ledger`          |
| `@aven/corrections/context-source` | `assembleWithCorrections`, `CORRECTION_INSTRUCTION_SOURCE_ID`, and the outcome types                                                                                                             | adds `@aven/context-broker` (no storage read) |

There is no HTTP route; `apps/api` is unchanged.

## Concepts

**Recorder versus reader.**

- `recordOwnerCorrection(storage, submission, options?)` performs exactly one
  frozen Ledger append. It writes one `owner_correction` event plus one
  `recorded_evidence` record holding the exact corrected instruction, with
  `explicit_owner_correction` provenance.
  - Event type, IDs, provenance, metadata and the applicability binding are
    derived, never supplied.
  - Its frozen receipt means that recording succeeded, not that the correction
    was applied.
- `readCorrectionHistory(storage, ownerId)` only replays the Ledger, page by
  page, up to a boundary fixed when it is called. It returns a detached, deeply
  frozen `{ ownerId, entries }` with every stored event and evidence record
  unmodified. Corrupt or inconsistent history fails closed; it is never returned
  partially.

**Evidence index versus resolver.**

- `buildCorrectionEvidenceIndex(history)` answers identity questions only: which
  correction owns an evidence record, whether that record is the correction's
  own instruction evidence or supporting evidence, and each correction's
  sequence.
- `resolveImmediateCorrections(history, binding, options)` decides immediate
  applicability for one exact `{ ownerId, sessionId, taskId }` at an explicit
  `{ referenceTime, throughSequence }`. It is pure: no storage, clock or
  randomness. It returns active corrections, inactive ones with a reason,
  explicit supersession links, unresolved overlaps and exact suppression
  targets.

**Applicability.**

- `current_task` applies to its exact task only.
- `current_session` applies to every task of its session.
- `unspecified` applies to its origin (envelope) task only. With no origin task
  it has no immediate effect.

Order is the owner-local Ledger `sequence` only, never occurrence time. The
durable scope hint is recorded but never read.

**Active correction versus durable learned owner state.** An active correction
is transient context for one task or session, recomputed from recorded history
on every call. It is not a preference, not owner state, not trusted, and not
promoted. Durable learning from corrections belongs to later milestones
(AVEN-014+).

**Suppression versus supersession.**

- **Supersession** deactivates an earlier correction for a binding. It happens
  only when a later applicable correction's target is that correction's event ID
  or its exact own evidence (both IDs). Shared targets never supersede (they are
  reported as overlaps), supporting evidence never does, and a superseded
  correction never comes back.
- **Suppression** lowers a base Context Broker candidate for one assembly.
  - Only a valid same-owner candidate whose reference exactly equals an active
    correction's target is affected: evidence ID **and** event ID, or learned
    item ID **and** version.
  - It receives a copy with `negativeRetrieval` 1, the Broker's frozen
    suppression value.
  - `event` and `unidentified` targets suppress nothing, and text is never
    compared.

Neither is durable revocation or learned negative retrieval.

**Exposed versus not exposed.** `assembleWithCorrections` returns:

- `status: 'exposed'` only when every active correction's instruction is in the
  Broker's **selected** bundle with its exact identity, binding, provenance and
  untruncated text;
- otherwise `status: 'not_exposed'` with a fixed `reason`:
  - `instruction_unrepresentable`
  - `assembly_failed`
  - `instruction_not_selected`
  - `instruction_truncated`
  - `instruction_altered`

A `not_exposed` outcome also carries the missing identities and, where traced,
the Broker's exclusion reason. It never carries a usable bundle. Item limits,
character budget, truncation, duplicates, source failures and timeouts are never
reported as exposed.

**Permission deferral.** A `permission` correction is recorded like any other
category but is always inactive with reason `deferred_to_root`. It never becomes
an instruction, suppresses nothing and supersedes nothing. This package grants
and denies nothing; Root (AVEN-012) does not exist yet.

**Explicit `referenceTime` and `sequence`.**

- The resolver and the assembly read no clock: the as-of boundary is the
  request's `referenceTime` plus an explicit `throughSequence` (or `null` for
  the whole supplied history).
- A correction recorded after that boundary cannot change the result.

**File-backed restart.** Nothing is cached or persisted apart from the
recorder's append. After a restart, re-reading the same database reproduces the
same history, views and outcomes; this is tested on a `query_only` connection
and in a separate Node process. A history read is not a snapshot across pages:
each page is its own read transaction under a boundary fixed at call time.

## Caller responsibilities

- **Owner context.** Owner, session and task identities are declared, not
  authenticated. The caller must supply the history of the same owner as the
  request; a mismatch is refused with `invalid_correction_history`. Sessions and
  tasks must already exist in storage for the recorder (for example, provisioned
  through the AVEN-005 API).
- **Source registration.** `assembleWithCorrections` reads no storage. The
  caller passes:
  - the correction history it loaded;
  - the exact Broker request;
  - at most 15 base sources (`MAX_SOURCES - 1`; one slot is the instruction
    source, `aven-correction-instruction`).

  The Broker alone validates, isolates owners, deduplicates, ranks and budgets.

- **No authority.** An exposed instruction is transient context, not owner
  memory, not a prompt and not Root approval. Nothing here calls a model; the
  bundle is not wired into any API path.

## Errors

Every failure is a `CorrectionError` with:

- one fixed code: `invalid_submission`, `unknown_binding`, `unresolved_target`,
  `identifier_collision`, `storage_failure`, `invalid_correction_history` or
  `internal_error`;
- one fixed owner-local message;
- no `cause`;
- a `toJSON` of exactly `name`, `code` and `message`.

No identifier, text, SQL or path crosses the boundary. A Broker failure inside
assembly is reported as `not_exposed` / `assembly_failed`, with a code taken
only from the Broker's declared vocabulary.

## Example

The identifiers below are synthetic placeholders. The storage must be migrated,
and its owner, session and task must already exist.

```ts
import { openStorage } from '@aven/storage';
import type { ContextSource } from '@aven/context-broker';
import { resolveImmediateCorrections } from '@aven/corrections';
import {
  readCorrectionHistory,
  recordOwnerCorrection,
} from '@aven/corrections/ledger';
import { assembleWithCorrections } from '@aven/corrections/context-source';

const storage = openStorage('data/aven.sqlite');
const owner = {
  ownerId: 'owner_local',
  sessionId: 'session_1',
  taskId: 'task_1',
};

// 1. Record (the only write). The receipt means "recorded", not "applied".
const receipt = recordOwnerCorrection(storage, {
  ...owner,
  category: 'communication',
  target: { kind: 'unidentified', description: 'The previous draft' },
  originalBehavior: 'The draft used long paragraphs.',
  correctedInstruction: 'Keep this draft to three short bullet points.',
  immediateApplicability: 'current_task',
  durableScopeHint: { kind: 'unknown', reason: 'Not evaluated.' },
});

// 2. Read back and resolve at an explicit as-of boundary. The caller chooses
//    the reference time; the package itself reads no clock.
const referenceTime = new Date().toISOString();
const history = readCorrectionHistory(storage, owner.ownerId);
const view = resolveImmediateCorrections(history, owner, {
  referenceTime,
  throughSequence: receipt.sequence,
});

// 3. Assemble through the frozen Broker and verify exposure.
const baseSources: ContextSource[] = []; // the caller's own Broker sources
const outcome = await assembleWithCorrections({
  history,
  request: {
    ownerId: owner.ownerId,
    task: { sessionId: owner.sessionId, taskId: owner.taskId },
    request: 'Draft the summary',
    referenceTime,
    taskDescriptor: {},
  },
  sources: baseSources,
  throughSequence: receipt.sequence,
});
if (outcome.status === 'exposed') {
  // outcome.bundle holds every active instruction exactly as offered.
} else {
  // outcome.reason and outcome.missing say why; there is no bundle.
}
console.log(view.active.length, outcome.status);
storage.close();
```

## Tests and benchmarks

`corepack pnpm --filter @aven/corrections test` runs 444 tests in 8 files on
synthetic data:

| File                     | Tests | Covers                                                                                             |
| ------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `boundaries.test.ts`     | 69    | exports, error contract, import allowlists and static rules per subpath                            |
| `frozen-layers.test.ts`  | 43    | 226 frozen pins, attribution-gate pins, the repository-wide addition guard                         |
| `record.test.ts`         | 82    | the recorder                                                                                       |
| `resolve.test.ts`        | 121   | the resolver                                                                                       |
| `resolve-scale.test.ts`  | 24    | linkage oracle, scale and complexity                                                               |
| `history.test.ts`        | 22    | Ledger replay, the evidence index, restart                                                         |
| `context-source.test.ts` | 51    | Broker integration, suppression, exposure, hostile sources                                         |
| `cross-layer.test.ts`    | 32    | real-SQLite end-to-end pipeline, fresh-process replay (`cross-layer-replay.ts`), adversarial cases |

`bench/` holds diagnostic, synthetic benchmarks outside `pnpm test` and
`pnpm check`:

- `resolve.bench.ts`: the resolver;
- `cross-layer.bench.ts`: per-phase pipeline timing;
- `statement-retention.bench.ts`: native-memory pressure of synchronous
  statement preparation in the frozen storage and Ledger layers.

Run them with `node` (Node 24) from the repository root. Their figures describe
one machine only and are not guarantees; see the report for the resource-risk
disposition.
