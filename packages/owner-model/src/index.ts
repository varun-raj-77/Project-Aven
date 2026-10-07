/**
 * @aven/owner-model: AVEN-009 Typed Owner Model (patches 1-2).
 *
 * Patch 1: package identity, the fixed error surface and guardrails.
 * Patch 2: owner-bound typed owner-state intake (`intakeOwnerState`), which
 * filters, validates, deduplicates and canonically orders the requesting
 * owner's records against the frozen AVEN-002 contracts. There is no view,
 * lineage, lifecycle verification, persistence or Context Broker adapter yet;
 * those arrive in later reviewed AVEN-009 patches. Nothing here reads storage
 * or the Ledger, calls a model, infers or corrects owner state, promotes
 * learning or decides authority.
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
