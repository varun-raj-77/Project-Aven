/**
 * @aven/action-proposals/ledger: the AVEN-011 proposal recorder and
 * reconciliation (Patch 3).
 *
 * The only subpath that depends on `@aven/storage` and `@aven/ledger`. The
 * recorder records one validated proposal as one frozen `action_proposed`
 * event through one frozen Ledger append and returns a receipt meaning that
 * recording succeeded; nothing is allowed, approved, executed or decided.
 * Reconciliation only reads, to settle an uncertain recording outcome.
 */
export {
  reconcileActionProposalRecording,
  recordActionProposal,
  type ProposalReconciliation,
  type ProposalRecordingReceipt,
  type ProposalRecordingRequest,
} from './record.ts';
