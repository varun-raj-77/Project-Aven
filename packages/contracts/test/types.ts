// Compiled by package typecheck. No runtime calls or test-only casts establish these guarantees.
import { expectTypeOf } from 'vitest';
import type * as c from '../src/index.ts';

type Ids = {
  OwnerId: c.OwnerId;
  SessionId: c.SessionId;
  TaskId: c.TaskId;
  EventId: c.EventId;
  EvidenceId: c.EvidenceId;
  LearnedItemId: c.LearnedItemId;
  CandidateId: c.CandidateId;
  ActionProposalId: c.ActionProposalId;
  PolicyDecisionId: c.PolicyDecisionId;
  ApprovalId: c.ApprovalId;
  ExecutionId: c.ExecutionId;
  VerificationId: c.VerificationId;
  EvaluationId: c.EvaluationId;
  EvaluationTestId: c.EvaluationTestId;
  ContextId: c.ContextId;
  ModelCallId: c.ModelCallId;
};
type InterchangeablePairs = {
  [K in keyof Ids]: {
    [L in keyof Ids]: L extends K
      ? never
      : Ids[K] extends Ids[L]
        ? `${K}->${L}`
        : never;
  }[keyof Ids];
}[keyof Ids];
type UnbrandedIds = {
  [K in keyof Ids]: string extends Ids[K] ? K : never;
}[keyof Ids];
expectTypeOf<InterchangeablePairs>().toEqualTypeOf<never>();
expectTypeOf<UnbrandedIds>().toEqualTypeOf<never>();
expectTypeOf<c.LearningCandidate>().not.toExtend<c.TrustedOwnerState>();
expectTypeOf<c.PolicyDecision>().not.toExtend<c.ActionProposal>();
expectTypeOf<c.ExecutionResult>().not.toExtend<c.VerificationResult>();

export function compileTimeNegativeExamples(
  owner: c.OwnerId,
  event: c.ExperienceEvent,
): void {
  // @ts-expect-error Owner IDs cannot be assigned as task IDs.
  const task: c.TaskId = owner;
  // @ts-expect-error Plain strings must cross an ID parser before domain use.
  const evidence: c.EvidenceId = 'evidence_unparsed';
  // @ts-expect-error Historical event envelopes expose no mutable owner field.
  event.ownerId = owner;
  void task;
  void evidence;
}
