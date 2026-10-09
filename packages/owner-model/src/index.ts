/**
 * @aven/owner-model: AVEN-009 Typed Owner Model (root entry).
 *
 * The root entry exposes package identity, the fixed error surface and the
 * owner-bound typed owner-state intake (`intakeOwnerState`, patch 2), which
 * filters, validates, deduplicates and canonically orders the requesting
 * owner's records against the frozen AVEN-002 contracts. It stays pure: it
 * depends only on `@aven/contracts` and `zod`.
 *
 * The later stages are internal modules, not root exports: structural
 * lineage (patch 3), lifecycle-claim verification (patch 4), durable category
 * views (patch 5) and the active task view (patch 6). The separate subpath
 * `@aven/owner-model/persistence` (patch 7) returns a read-only rebuild over
 * storage and the owner-bound Ledger whose `intake` and `verified` (lineage
 * plus checked claims) are frozen data; `@aven/owner-model/context-source`
 * (patch 8) uses the views internally to offer AVEN-008 Context Broker
 * candidates. Only those subpaths carry storage, Ledger or Broker
 * dependencies. Nothing here
 * writes, calls a model, infers or corrects owner state, promotes learning or
 * decides authority.
 */
export {
  AVEN_009_OWNER_MODEL_VERSION,
  OWNER_MODEL_CONFIG,
  type OwnerModelConfiguration,
} from './config.ts';
export {
  OWNER_MODEL_ERROR_CODES,
  OwnerModelError,
  type OwnerModelErrorCode,
  type SerializedOwnerModelError,
} from './errors.ts';
export {
  intakeOwnerState,
  type OwnerStateIntake,
  type OwnerStateIntakeRequest,
} from './intake.ts';
