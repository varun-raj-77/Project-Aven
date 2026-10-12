/**
 * @aven/corrections/ledger: the AVEN-010 owner-correction recorder (patch 3)
 * and the read-only correction history and evidence index (patch 5).
 *
 * The only subpath that depends on `@aven/storage` and `@aven/ledger`. The
 * recorder records one explicit owner correction through one frozen Ledger
 * append and returns a receipt meaning that recording succeeded; it applies
 * nothing. The history reader only replays the frozen Ledger, and the index
 * only derives identities from a history; neither writes.
 */
export {
  recordOwnerCorrection,
  type CorrectionIdPrefix,
  type CorrectionReceipt,
  type CorrectionRecordingOptions,
  type CorrectionSubmission,
} from './record.ts';
export {
  buildCorrectionEvidenceIndex,
  readCorrectionHistory,
  type CorrectionEvidenceIndex,
  type IndexedCorrection,
  type IndexedEvidence,
  type PersistedCorrectionHistory,
} from './history.ts';
