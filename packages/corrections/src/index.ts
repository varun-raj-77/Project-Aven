/**
 * @aven/corrections: AVEN-010 correction events and immediate session
 * overrides (root entry, patch 2 scaffold).
 *
 * The root entry exposes package identity, the fixed error surface and the
 * pure immediate-override resolver (patch 4, `resolveImmediateCorrections`).
 * It stays pure: it depends only on `@aven/contracts`, `zod` and the
 * side-effect-free Proxy check of `node:util`. The correction recorder
 * (patch 3) lives in the `./ledger` subpath; the read-only correction history
 * (patch 5) and the Context Broker integration (patch 6) come later. Nothing
 * here records, reads or changes state, calls a model, learns, promotes or
 * decides authority.
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
export {
  IMMEDIATE_RESOLUTION_VERSION,
  resolveImmediateCorrections,
  type ActiveCorrection,
  type CorrectionCategory,
  type CorrectionHistory,
  type CorrectionHistoryEntry,
  type CorrectionQueryBinding,
  type CorrectionResolutionOptions,
  type ImmediateApplicabilityLabel,
  type ImmediateCorrectionView,
  type InactiveCorrection,
  type ResolvedCorrection,
  type StructuredTarget,
  type SuppressionTarget,
} from './resolve.ts';
