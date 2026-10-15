/**
 * @aven/action-proposals/ledger: the AVEN-011 proposal recorder and
 * reconciliation (Patch 3) and the read-only historical reader (Patch 4).
 *
 * The only subpath that depends on `@aven/storage` and `@aven/ledger`. The
 * recorder records one validated proposal as one frozen `action_proposed`
 * event through one frozen Ledger append and returns a receipt meaning that
 * recording succeeded; nothing is allowed, approved, executed or decided.
 * Reconciliation only reads, to settle an uncertain recording outcome. The
 * reader only reads and classifies recorded proposal events; it repairs,
 * writes and authorizes nothing.
 */
export {
  reconcileActionProposalRecording,
  recordActionProposal,
  type ProposalReconciliation,
  type ProposalRecordingReceipt,
  type ProposalRecordingRequest,
} from './record.ts';
export {
  readProposalEvents,
  type EventFormatReason,
  type FormatClassification,
  type ProposalEventPage,
  type ProposalEventRecord,
  type ProposalFormatReason,
  type ProposalHistoryFilter,
} from './history.ts';
