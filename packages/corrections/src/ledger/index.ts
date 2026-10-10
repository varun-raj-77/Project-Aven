/**
 * @aven/corrections/ledger: the AVEN-010 owner-correction recorder (patch 3).
 *
 * The only subpath that depends on `@aven/storage` and `@aven/ledger`. It
 * records one explicit owner correction through one frozen Ledger append and
 * returns a receipt meaning that recording succeeded; it applies nothing.
 */
export {
  recordOwnerCorrection,
  type CorrectionIdPrefix,
  type CorrectionReceipt,
  type CorrectionRecordingOptions,
  type CorrectionSubmission,
} from './record.ts';
