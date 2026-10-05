import { z } from 'zod';
import * as c from '@aven/contracts';

// These names are persisted in migration 0001. Keep v1 available for old data.
// This registry reuses the domain contracts; it is not a second domain model.
export const contracts = {
  experience_events: c.ExperienceEventSchema,
  evidence: c.EvidenceRecordSchema,
  learned_owner_state: c.DurableOwnerStateSchema,
  active_task_state: c.ActiveTaskStateSchema,
  learning_candidates: c.LearningCandidateSchema,
  no_useful_lessons: c.LearningResultSchema.options[1],
  corrections: c.OwnerCorrectionSchema,
  action_proposals: c.ActionProposalSchema,
  policy_decisions: c.PolicyDecisionSchema,
  owner_approvals: c.OwnerApprovalSchema,
  tool_executions: c.ExecutionResultSchema,
  verification_results: c.VerificationResultSchema,
  evaluations: c.EvaluationResultSchema,
  lifecycle_records: c.LearningTransitionSchema,
} as const;
export type ContractName = keyof typeof contracts;
export type Contract<N extends ContractName> = z.output<(typeof contracts)[N]>;

export function isContractName(value: string): value is ContractName {
  return Object.hasOwn(contracts, value);
}

export function serializeContract<N extends ContractName>(
  name: N,
  input: unknown,
): string {
  return JSON.stringify(contracts[name].parse(input));
}

export function deserializeContract<N extends ContractName>(
  name: N,
  serialized: string,
): Contract<N> {
  const input: unknown = JSON.parse(serialized);
  // The registry entry is selected by N; Zod's union call loses that correlation.
  return contracts[name].parse(input) as Contract<N>;
}
