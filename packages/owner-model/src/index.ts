/**
 * @aven/owner-model: AVEN-009 Typed Owner Model, patch 1 scaffold.
 *
 * Only the package identity, the fixed error surface and their guardrails
 * exist. There is no owner-state intake, view, lineage, persistence or
 * Context Broker adapter yet; those arrive in later reviewed AVEN-009
 * patches. Nothing here reads storage or the Ledger, calls a model, infers or
 * corrects owner state, promotes learning or decides authority.
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
