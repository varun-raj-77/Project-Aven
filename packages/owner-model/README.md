# @aven/owner-model (AVEN-009)

The Typed Owner Model (version `aven-009-owner-model-v1`). It gives one owner's
recorded owner state a typed, owner-isolated, deterministic and **read-only**
representation, and offers that state to the unchanged AVEN-008 Context Broker
as transient candidates.

**Status:** implemented on an isolated candidate branch (AVEN-009 patches 1-9),
pending final external review, Windows validation and an authorized merge and
tag. It is not frozen. The full record is in
[`docs/AVEN_009_REPORT.md`](../../docs/AVEN_009_REPORT.md).

The package performs no learning, preference inference, correction detection or
interpretation, negative-signal generation, promotion, trust or permission
decision, Root change, tool execution, prompt assembly or model/provider call.
It has **no owner-state writer**. A recorded lifecycle claim is not
authenticated Root authority, and a declared current version is not Root's
trusted-version selection.

## Architecture

```text
           unknown records ──► intakeOwnerState  (patch 2, root export)
                                     │  owner-bound, validated, canonical
                                     ▼
                           buildDurableLineage   (patch 3, internal)
                                     │  exact version graph, no cycles
      recorded transitions ─────────►▼
                          verifyLifecycleClaims  (patch 4, internal)
                                     │  trusted/superseded/revoked claims
                                     │  agree with recorded transitions
          ┌──────────────────────────┴───────────────────────────┐
          ▼                                                      ▼
buildDurableCategoryViews (patch 5, internal)     buildActiveTaskView (patch 6, internal)
  latestDeclared / currentDeclared at              latest active head for one
  an explicit referenceTime                        exact (sessionId, taskId)

@aven/owner-model/persistence     rebuildOwnerModel(storage, ownerId)  (patch 7)
  stored snapshots + owner-bound Ledger replay -> intake -> lineage -> claims

@aven/owner-model/context-source  createOwnerModelContextSources(rebuilt) (patch 8)
  rebuilt model -> views -> four read-only ContextSources for the Broker
```

Every stage accepts only a result produced by the previous stage in the same
module instance (module-private `WeakSet` brands), so caller-supplied values
cross exactly one validating boundary: `intakeOwnerState` (or
`rebuildOwnerModel`, which reads storage and then calls it). Results are deeply
frozen with null prototypes. Brands are per module instance and are not
serializable proofs.

## Public surfaces

| Entry                              | Runtime exports                                                                                                        | Dependencies                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `@aven/owner-model`                | `AVEN_009_OWNER_MODEL_VERSION`, `OWNER_MODEL_CONFIG`, `OWNER_MODEL_ERROR_CODES`, `OwnerModelError`, `intakeOwnerState` | `@aven/contracts`, `zod`                        |
| `@aven/owner-model/persistence`    | `rebuildOwnerModel` (type `RebuiltOwnerModel`)                                                                         | adds `@aven/storage`, `@aven/ledger`            |
| `@aven/owner-model/context-source` | `AVEN_OWNER_MODEL_SOURCE_CONFIG_V1`, `createOwnerModelContextSources`                                                  | adds `@aven/context-broker` (and `node:crypto`) |

The root entry also exports the types `OwnerModelConfiguration`,
`OwnerModelErrorCode`, `SerializedOwnerModelError`, `OwnerStateIntake` and
`OwnerStateIntakeRequest`.

Internal, not exported from any entry: lineage (`lineage.ts`), lifecycle-claim
verification (`claims.ts`), category views (`views.ts`), the active task view
(`active-task.ts`), the ambient-prototype gate (`ambient.ts`), canonical text
(`canonical-text.ts`) and instant comparison (`timestamps.ts`). The views are
used by the context-source adapter; they are not a public query API.

Dependency isolation is by subpath: the root entry and every core module import
only `@aven/contracts` and `zod`; only `persistence/` imports storage and the
Ledger, and only `context-source/` imports the Context Broker. Static boundary
tests pin this. Package and subpath separation is **not** process, storage or
security isolation: everything runs in one trusted Node process.

## Examples (synthetic data)

All IDs and text below are synthetic.

### Typed intake (root)

```ts
import { intakeOwnerState, OwnerModelError } from '@aven/owner-model';

const intake = intakeOwnerState({
  ownerId: 'owner_synthetic_a',
  records: unknownRecords, // durable_owner_state / active_task_state values
});
intake.durable; // frozen, validated, ordered by ID then recordVersion
intake.activeTasks; // frozen active task state snapshots
// Records of another well-formed owner are dropped unread; anything that is
// malformed or of unrecognizable ownership throws OwnerModelError.
```

### Read-only rebuild (persistence)

```ts
import { OwnerIdSchema } from '@aven/contracts';
import { openStorage } from '@aven/storage';
import { rebuildOwnerModel } from '@aven/owner-model/persistence';

const storage = openStorage('/absolute/local/path/aven.sqlite'); // migrated
try {
  const ownerId = OwnerIdSchema.parse('owner_synthetic_a'); // branded OwnerId
  const rebuilt = rebuildOwnerModel(storage, ownerId);
  rebuilt.intake; // stored snapshots, through Patch-2 intake
  rebuilt.verified; // lineage plus lifecycle claims checked against the Ledger
} finally {
  storage.close();
}
```

### Context Broker sources (context-source)

```ts
import { createContextBroker } from '@aven/context-broker';
import { createOwnerModelContextSources } from '@aven/owner-model/context-source';

const sources = createOwnerModelContextSources(rebuilt);
const { bundle, trace } = await createContextBroker({ sources }).assemble({
  ownerId: 'owner_synthetic_a',
  task: { sessionId: 'session_synthetic', taskId: 'task_synthetic' },
  request: 'synthetic sandbox drafts',
  referenceTime: '2026-10-05T00:00:00Z',
  taskDescriptor: { domain: 'synthetic-sandbox', taskType: 'draft' },
});
// `bundle` is transient context data for one task: not a prompt, not owner
// memory, not authority. The Broker alone ranks, selects and budgets.
```

## Typed state

The package reuses the frozen AVEN-002 contracts and defines no second
vocabulary.

- **Durable owner state** (`durable_owner_state`): `fact` (subject, assertion),
  `preference` (subject, desiredBehavior), `episode` (summary, occurredAt,
  originalEvidence), `intent_pattern` (cue, interpretedIntent) and `procedure`
  (objective, ordered steps with optional preconditions). Each snapshot is one
  numeric version of a stable learned-item ID with provenance, scope, evidence
  signals and lifecycle (`observed`, `validated`, `trusted`, `superseded`,
  `revoked`).
- **Active task state** (`active_task_state`): objective, open loops and source
  evidence bound to one `(sessionId, taskId)`, with lifecycle `active` or
  `closed` (completed or cancelled).

Durable and active state never mix: lineage, claims and category views read
durable records only; the active task view reads active task records only.

A fact is a declared, provenance-bearing claim, not objective truth. A
preference is scoped to its declared scope, not a universal trait. A procedure
is data, never an executable tool.

## Deterministic as-of views (internal)

`buildDurableCategoryViews(verified, { referenceTime })` requires an explicit
timestamp; nothing reads a clock. Per stable ID:

- `latestDeclared`: the highest `recordVersion` whose `metadata.createdAt` is at
  or before `referenceTime` (exact instants). Later versions never leak back.
- `currentDeclared`: that same snapshot, only if its lifecycle is observed,
  validated or trusted and its own bounded temporal window (`from` inclusive,
  `until` exclusive), if any, covers `referenceTime`.

A superseded or revoked head has no `currentDeclared`; no older version is used
instead (no fallback, rollback or resurrection of an older trusted version), and
replacement or fallback references are not followed. Unknown, uncertain and
global scopes are kept as declared and never widened. Neither field is Root's
trusted-version selection.

## Active task selection (internal)

`buildActiveTaskView(intake, { sessionId, taskId })` takes, for every stable
active-task ID, its highest version first, and only then requires an exact
session and task match and `active` lifecycle. A closed head hides older active
versions of that ID; different IDs are never compared by version. No match
returns `undefined`; one match returns that frozen snapshot; two or more
distinct IDs fail with `active_task_conflict`. There is no expiry and nothing is
executed.

## Rebuild assumptions

`rebuildOwnerModel(storage, ownerId)`:

- reads only this owner's rows from `learned_owner_state` and
  `active_task_state` (two pinned `SELECT … WHERE owner_id = ?` statements) and
  replays only this owner's Ledger;
- passes every recorded `learning_promoted`, `_rejected`, `_superseded`,
  `_revoked` and `_rolled_back` payload to claim verification; rejection and
  rollback are never applied, and the `lifecycle_records` projection is not
  read;
- requires owner-origin provenance (`explicit_owner_statement`,
  `explicit_owner_correction`, `owner_approval`) to cite an event this owner's
  Ledger records with the matching type, and `confirmed` or `disputed` owner
  confirmations to cite recorded evidence of an owner request or correction;
- **synthesizes no snapshot from Ledger events** and writes nothing;
- runs the snapshot read and the Ledger replay as **separate read
  transactions**, so a consistent result assumes storage that is not being
  written concurrently.

## Context Broker integration

`createOwnerModelContextSources(rebuilt)` accepts only a genuine rebuilt model
and returns four frozen sources:

| Source ID              | Kind              | Offers                                                |
| ---------------------- | ----------------- | ----------------------------------------------------- |
| `aven-owner-state`     | `owner_state`     | `currentDeclared` facts, preferences, intent patterns |
| `aven-procedure`       | `procedure`       | `currentDeclared` procedures                          |
| `aven-episode-history` | `episode_history` | `currentDeclared` episodes                            |
| `aven-active-task`     | `active_task`     | the active task view for the exact `query.task`       |

A query for another owner returns `[]`. Durable candidates are `owner_state`
references carrying the lifecycle status; the active task is an
`active_task_state` reference with scope `{ kind: 'bounded', taskId }`.
Provenance and scope are copied unchanged; text is rendered deterministically
from structured fields; candidate IDs are `om:<token>:<sha256 hex>` over a fixed
identity tuple. Every candidate is preflighted against the Broker's own
`ContextCandidateSchema`; text or metadata beyond the frozen limits, or more
candidates than `query.maxCandidates`, fails the whole collection with
`invalid_owner_model_context`, which the Broker reports as `source_failure`.
Nothing is truncated, ranked, assembled into a prompt or marked as a current
instruction.

Signals come from the frozen `AVEN_OWNER_MODEL_SOURCE_CONFIG_V1`
(`aven-009-owner-model-source-config-v1`): durable confidence is the minimum of
a support table and an inference-certainty table, active-task confidence is 0.5,
salience is 0.5 and negativeRetrieval is always 0. These are provisional ordinal
values specified before any real A/B/C evaluation, not calibrated probabilities.
Do not tune them; a change requires a new version and evidence.

## Errors

`OwnerModelError` carries one fixed `code` and message, never a `cause`, ID,
count, position or owner text:

`invalid_input`, `internal_error`, `conflicting_duplicate`, `identity_conflict`,
`version_order_conflict`, `invalid_lineage_reference`, `lineage_cycle`,
`invalid_lifecycle_claim`, `invalid_owner_state_view`, `active_task_conflict`,
`invalid_persisted_owner_model`, `invalid_owner_model_context`.

An error carries no authority meaning.

## Tests

```sh
pnpm --filter @aven/owner-model test
```

Nine test files (intake, fresh-process ambient checks, lineage, claims, views,
active task, persistence, context source and static boundaries) use synthetic
owners and records only. They are mechanics checks of the representation and
retrieval integration, not experiment results. Static boundary rules and the
frozen-layer tripwire are regression tripwires, not security proofs.

## Explicit exclusions

No owner-state writer, learning, promotion or rollback application, correction
or `current_instruction` handling, negative-retrieval generation, Root
authentication or permission decision, owner authentication, prompt assembly,
model or network call, task execution, caching, or session-wide scope.
