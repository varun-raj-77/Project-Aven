/**
 * @aven/root-policy/ledger: Root over recorded history (AVEN-012 Patch 3).
 *
 * The only subpath that depends on `@aven/storage` and `@aven/ledger`. The
 * gateway evaluates one recorded AVEN-011 proposal, with the approvals bound
 * to it, read-only and at the Root clock's time; the recorder appends one
 * frozen `policy_decision` event for an evaluation the same gateway
 * produced; reconciliation only reads, to settle an uncertain recording.
 * Evaluation, recording and (future, AVEN-013) execution stay separate:
 * nothing here executes a tool, writes owner state or learns.
 */
export {
  createRootGateway,
  evaluateRecordedProposal,
  type RecordedProposalRequest,
  type RootGateway,
  type RootGatewayOptions,
} from './gateway.ts';
export {
  reconcileRootDecisionRecording,
  recordRootDecision,
  type DecisionReconciliation,
  type DecisionRecordingReceipt,
  type DecisionRecordingRequest,
} from './record.ts';
