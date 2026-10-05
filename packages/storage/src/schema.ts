import { sql } from 'drizzle-orm';
import {
  customType,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import {
  deserializeContract,
  serializeContract,
  type Contract,
  type ContractName,
} from './serialization.ts';

// SQL migrations own constraints, indexes, triggers and views. These are query mappings.
function payload<N extends ContractName>(name: N) {
  return customType<{ data: Contract<N>; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value) => serializeContract(name, value),
    fromDriver: (value) => deserializeContract(name, value),
  })('record_json').notNull();
}
export const experienceEvents = sqliteTable('experience_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  recordJson: payload('experience_events'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  eventType: text('event_type')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.eventType')`)
    .notNull(),
  occurredAt: text('occurred_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.occurredAt')`)
    .notNull(),
  recordedAt: text('recorded_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.recordedAt')`)
    .notNull(),
  sessionId: text('session_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.sessionId')`,
  ),
  taskId: text('task_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.taskId')`,
  ),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.provenance.kind')`)
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.provenance.trust')`,
  ),
});

export const evidence = sqliteTable('evidence', {
  recordJson: payload('evidence'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  eventId: text('event_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.eventId')`)
    .notNull(),
  recordedAt: text('recorded_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.recordedAt')`)
    .notNull(),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.provenance.kind')`)
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.provenance.trust')`,
  ),
});

export const learnedOwnerState = sqliteTable('learned_owner_state', {
  recordJson: payload('learned_owner_state'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  category: text('category')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.content.category')`)
    .notNull(),
  status: text('status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.lifecycle.status')`)
    .notNull(),
  scopeKind: text('scope_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.scope.kind')`)
    .notNull(),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.provenance.kind')`)
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.provenance.trust')`,
  ),
  lastValidatedAt: text('last_validated_at').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.lastValidatedAt')`,
  ),
  candidateId: text('candidate_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.candidate.candidateId')`,
  ),
  candidateVersion: integer('candidate_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.candidate.version')`,
  ),
  promotionEventId: text('promotion_event_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.promotionEventId')`,
  ),
  lineageEventId: text('lineage_event_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.eventId')`,
  ),
  replacementId: text('replacement_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.replacement.learnedItemId')`,
  ),
  replacementVersion: integer('replacement_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.replacement.version')`,
  ),
  fallbackId: text('fallback_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.fallback.learnedItemId')`,
  ),
  fallbackVersion: integer('fallback_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.fallback.version')`,
  ),
  support: text('support')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.evidence.support')`)
    .notNull(),
  independenceStatus: text('independence_status')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.evidence.sourceIndependence.status')`,
    )
    .notNull(),
});

export const activeTaskState = sqliteTable('active_task_state', {
  recordJson: payload('active_task_state'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  status: text('status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.lifecycle.status')`)
    .notNull(),
  sessionId: text('session_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.sessionId')`,
  ),
  taskId: text('task_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.taskId')`,
  ),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.provenance.kind')`)
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.provenance.trust')`,
  ),
});

export const learningCandidates = sqliteTable('learning_candidates', {
  recordJson: payload('learning_candidates'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  category: text('category')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.proposedContent.category')`,
    )
    .notNull(),
  status: text('status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.lifecycle.status')`)
    .notNull(),
  scopeKind: text('scope_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.proposedScope.kind')`)
    .notNull(),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.generation.generator.kind')`,
    )
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.generation.generator.trust')`,
  ),
  support: text('support')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.evidence.support')`)
    .notNull(),
  independenceStatus: text('independence_status')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.evidence.sourceIndependence.status')`,
    )
    .notNull(),
});

export const noUsefulLessons = sqliteTable('no_useful_lessons', {
  storageId: text('storage_id').notNull(),
  recordJson: payload('no_useful_lessons'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`storage_id`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.generation.generator.kind')`,
    )
    .notNull(),
  declaredTrust: text('declared_trust').generatedAlwaysAs(
    sql`json_extract(record_json, '$.generation.generator.trust')`,
  ),
});

export const corrections = sqliteTable('corrections', {
  recordJson: payload('corrections'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.evidence.evidenceId')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  category: text('category')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.category')`)
    .notNull(),
  sourceKind: text('source_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.provenance.kind')`)
    .notNull(),
  eventId: text('event_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.evidence.eventId')`)
    .notNull(),
  targetKind: text('target_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.target.kind')`)
    .notNull(),
  immediateKind: text('immediate_kind')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.immediateApplicability.kind')`,
    )
    .notNull(),
  scopeKind: text('scope_kind')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.durableScopeHint.kind')`,
    )
    .notNull(),
  sessionId: text('session_id').generatedAlwaysAs(
    sql`coalesce(json_extract(record_json, '$.immediateApplicability.task.sessionId'), json_extract(record_json, '$.immediateApplicability.sessionId'))`,
  ),
  taskId: text('task_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.immediateApplicability.task.taskId')`,
  ),
});

export const actionProposals = sqliteTable('action_proposals', {
  recordJson: payload('action_proposals'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  sessionId: text('session_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.sessionId')`,
  ),
  taskId: text('task_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.task.taskId')`,
  ),
  proposalDigest: text('proposal_digest').notNull(),
  parametersDigest: text('parameters_digest')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.parameters.artifact.digest.value')`,
    )
    .notNull(),
});

export const policyDecisions = sqliteTable('policy_decisions', {
  recordJson: payload('policy_decisions'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  proposalId: text('proposal_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalId')`,
  ),
  proposalVersion: integer('proposal_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalVersion')`,
  ),
  proposalDigest: text('proposal_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalDigest.value')`,
  ),
  parametersDigest: text('parameters_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.parametersDigest.value')`,
  ),
  decision: text('decision')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.decision')`)
    .notNull(),
  basisKind: text('basis_kind').generatedAlwaysAs(
    sql`json_extract(record_json, '$.basis.kind')`,
  ),
});

export const ownerApprovals = sqliteTable('owner_approvals', {
  recordJson: payload('owner_approvals'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  proposalId: text('proposal_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalId')`,
  ),
  proposalVersion: integer('proposal_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalVersion')`,
  ),
  proposalDigest: text('proposal_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.proposalDigest.value')`,
  ),
  parametersDigest: text('parameters_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.proposal.parametersDigest.value')`,
  ),
  sessionId: text('session_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.bounds.sessionId')`,
  ),
  taskId: text('task_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.bounds.taskId')`,
  ),
  status: text('status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.lifecycle.status')`)
    .notNull(),
  issuedAt: text('issued_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.issuedAt')`)
    .notNull(),
  expiresAt: text('expires_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.expiresAt')`)
    .notNull(),
  revokedAt: text('revoked_at').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.revokedAt')`,
  ),
  revocationEventId: text('revocation_event_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.lifecycle.revocationEventId')`,
  ),
});

export const toolExecutions = sqliteTable('tool_executions', {
  recordJson: payload('tool_executions'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  proposalId: text('proposal_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.proposal.proposalId')`,
  ),
  proposalVersion: integer('proposal_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.proposal.proposalVersion')`,
  ),
  proposalDigest: text('proposal_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.proposal.proposalDigest.value')`,
  ),
  parametersDigest: text('parameters_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.proposal.parametersDigest.value')`,
  ),
  decisionId: text('decision_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.decisionId')`,
  ),
  decision: text('decision').generatedAlwaysAs(
    sql`json_extract(record_json, '$.policy.decision')`,
  ),
  attempted: integer('attempted')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.attempted')`)
    .notNull(),
  outcome: text('outcome').generatedAlwaysAs(
    sql`json_extract(record_json, '$.outcome.status')`,
  ),
});

export const verificationResults = sqliteTable('verification_results', {
  recordJson: payload('verification_results'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  executionId: text('execution_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.executionId')`)
    .notNull(),
  status: text('status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.status')`)
    .notNull(),
  methodKind: text('method_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.method.kind')`)
    .notNull(),
});

export const evaluations = sqliteTable('evaluations', {
  recordJson: payload('evaluations'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.id')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  definitionId: text('definition_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.test.id')`)
    .notNull(),
  definitionVersion: integer('definition_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.test.metadata.recordVersion')`,
    )
    .notNull(),
  subjectKind: text('subject_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.subject.kind')`)
    .notNull(),
  oracleKind: text('oracle_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.test.oracle.kind')`)
    .notNull(),
  scorerKind: text('scorer_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.scorer.kind')`)
    .notNull(),
  verdict: text('verdict')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.verdict')`)
    .notNull(),
  split: text('split')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.test.split')`)
    .notNull(),
  actualStatus: text('actual_status')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.actual.status')`)
    .notNull(),
  scopeKind: text('scope_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.test.scope.kind')`)
    .notNull(),
});

export const lifecycleRecords = sqliteTable('lifecycle_records', {
  recordJson: payload('lifecycle_records'),
  ownerId: text('owner_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.ownerId')`)
    .notNull(),
  recordId: text('record_id')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.eventId')`)
    .notNull(),
  recordVersion: integer('record_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.recordVersion')`,
    )
    .notNull(),
  schemaVersion: integer('schema_version')
    .generatedAlwaysAs(
      sql`json_extract(record_json, '$.metadata.schemaVersion')`,
    )
    .notNull(),
  createdAt: text('created_at')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.metadata.createdAt')`)
    .notNull(),
  transitionKind: text('transition_kind')
    .generatedAlwaysAs(sql`json_extract(record_json, '$.kind')`)
    .notNull(),
  proposalId: text('proposal_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.proposal.proposalId')`,
  ),
  proposalVersion: integer('proposal_version').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.proposal.proposalVersion')`,
  ),
  proposalDigest: text('proposal_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.proposal.proposalDigest.value')`,
  ),
  parametersDigest: text('parameters_digest').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.proposal.parametersDigest.value')`,
  ),
  decisionId: text('decision_id').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.decisionId')`,
  ),
  decision: text('decision').generatedAlwaysAs(
    sql`json_extract(record_json, '$.authority.decision')`,
  ),
});

export const owners = sqliteTable('owners', {
  ownerId: text('owner_id').primaryKey(),
  createdAt: text('created_at').notNull(),
});
export const sessions = sqliteTable('sessions', {
  ownerId: text('owner_id').notNull(),
  sessionId: text('session_id').notNull(),
  createdAt: text('created_at').notNull(),
});
export const tasks = sqliteTable('tasks', {
  ownerId: text('owner_id').notNull(),
  taskId: text('task_id').notNull(),
  sessionId: text('session_id').notNull(),
  createdAt: text('created_at').notNull(),
});
export const recordReferences = sqliteTable('record_references', {
  ownerId: text('owner_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  sourceVersion: integer('source_version').notNull(),
  path: text('path').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id').notNull(),
  targetVersion: integer('target_version'),
  evidenceEventId: text('evidence_event_id'),
  sessionId: text('session_id'),
  proposalId: text('proposal_id'),
  proposalVersion: integer('proposal_version'),
  proposalDigest: text('proposal_digest'),
  parametersDigest: text('parameters_digest'),
  decision: text('decision'),
  eventType: text('event_type'),
  boundTaskId: text('bound_task_id'),
});
