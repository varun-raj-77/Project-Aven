/**
 * @aven/corrections: AVEN-010 correction events and immediate session
 * overrides (root entry, patch 2 scaffold).
 *
 * The root entry exposes package identity and the fixed error surface only.
 * It stays pure: it may depend only on `@aven/contracts` and `zod`. Later
 * reviewed patches add the correction recorder (patch 3, subpath
 * `./ledger`), the pure immediate-override resolver (patch 4), the read-only
 * correction history (patch 5) and the Context Broker integration (patch 6,
 * subpath `./context-source`). Nothing here records, reads or changes state,
 * calls a model, learns, promotes or decides authority.
 */
export {
  AVEN_010_CORRECTIONS_VERSION,
  CORRECTIONS_CONFIG,
  type CorrectionsConfiguration,
} from './config.ts';
export {
  CORRECTION_ERROR_CODES,
  CorrectionError,
  type CorrectionErrorCode,
  type SerializedCorrectionError,
} from './errors.ts';
