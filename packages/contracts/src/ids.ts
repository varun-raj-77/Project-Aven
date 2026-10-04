import { z } from 'zod';

// Prefixes also distinguish domains after serialization; suffix allocation is deferred.
const id = <T extends string>(prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`))
    .brand<T>();

export const OwnerIdSchema = id<'OwnerId'>('owner');
export const SessionIdSchema = id<'SessionId'>('session');
export const TaskIdSchema = id<'TaskId'>('task');
export const EventIdSchema = id<'EventId'>('event');
export const EvidenceIdSchema = id<'EvidenceId'>('evidence');
export const LearnedItemIdSchema = id<'LearnedItemId'>('learned');
export const CandidateIdSchema = id<'CandidateId'>('candidate');
export const ActionProposalIdSchema = id<'ActionProposalId'>('proposal');
export const PolicyDecisionIdSchema = id<'PolicyDecisionId'>('decision');
export const ApprovalIdSchema = id<'ApprovalId'>('approval');
export const ExecutionIdSchema = id<'ExecutionId'>('execution');
export const VerificationIdSchema = id<'VerificationId'>('verification');
export const EvaluationIdSchema = id<'EvaluationId'>('evaluation');
export const EvaluationTestIdSchema = id<'EvaluationTestId'>('evaltest');
export const ContextIdSchema = id<'ContextId'>('context');
export const ModelCallIdSchema = id<'ModelCallId'>('modelcall');

export type OwnerId = z.infer<typeof OwnerIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type LearnedItemId = z.infer<typeof LearnedItemIdSchema>;
export type CandidateId = z.infer<typeof CandidateIdSchema>;
export type ActionProposalId = z.infer<typeof ActionProposalIdSchema>;
export type PolicyDecisionId = z.infer<typeof PolicyDecisionIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type ExecutionId = z.infer<typeof ExecutionIdSchema>;
export type VerificationId = z.infer<typeof VerificationIdSchema>;
export type EvaluationId = z.infer<typeof EvaluationIdSchema>;
export type EvaluationTestId = z.infer<typeof EvaluationTestIdSchema>;
export type ContextId = z.infer<typeof ContextIdSchema>;
export type ModelCallId = z.infer<typeof ModelCallIdSchema>;
