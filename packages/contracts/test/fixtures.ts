// All names, preferences, artifacts, digests, and identities in this file are synthetic.
import * as c from '../src/index.ts';

export const time = '2026-10-04T12:00:00Z';
export const later = '2026-10-04T13:00:00Z';
export const metadata = c.RecordMetadataSchema.parse({
  schemaVersion: 1,
  recordVersion: 1,
  createdAt: time,
  creation: { component: 'synthetic-fixture', version: '1' },
});
export const owner = c.OwnerIdSchema.parse('owner_synthetic');
export const base = { ownerId: owner, metadata };
export const task = c.TaskBindingSchema.parse({
  sessionId: 'session_synthetic',
  taskId: 'task_synthetic',
});
export const evidence = c.EvidenceReferenceSchema.parse({
  evidenceId: 'evidence_source',
  eventId: 'event_source',
});
export const model = c.ModelConfigurationSchema.parse({
  providerId: 'synthetic-provider',
  modelId: 'synthetic-model',
  modelVersion: '1',
  configurationId: 'synthetic-config',
});
export const ownerProvenance = c.OwnerStatementProvenanceSchema.parse({
  kind: 'explicit_owner_statement',
  ownerId: owner,
  sourceEventId: evidence.eventId,
});
export const inference = c.ModelInferenceProvenanceSchema.parse({
  kind: 'model_inference',
  model,
  derivedFrom: [evidence],
  sourceCoverage: 'complete',
});
export const system = c.SystemGeneratedProvenanceSchema.parse({
  kind: 'system_generated',
  component: 'synthetic-recorder',
  version: '1',
  derivedFrom: [evidence],
});
export const tool = c.ToolResultProvenanceSchema.parse({
  kind: 'tool_result',
  toolId: 'synthetic-tool',
  sourceEventId: evidence.eventId,
  trust: 'potentially_untrusted',
});
export const external = c.ExternalContentProvenanceSchema.parse({
  kind: 'external_content',
  source: 'synthetic-external-document',
  capturedAt: time,
  trust: 'untrusted',
});
export const digest = c.DigestSchema.parse({
  algorithm: 'sha256',
  value: 'a'.repeat(64),
});
export const artifact = c.ImmutableArtifactReferenceSchema.parse({
  locator: 'synthetic:artifact-1',
  digest,
});
export const scope = c.ScopeSchema.parse({
  kind: 'bounded',
  domain: 'synthetic-sandbox',
  taskType: 'draft',
  qualifiers: { recipient: 'synthetic-reviewer' },
});
export const signals = c.EvidenceSignalsSchema.parse({
  support: 'limited',
  supportingEvidence: [evidence],
  counterexamples: [],
  sourceIndependence: { status: 'unassessed' },
  inferenceCertainty: 'tentative',
  ownerConfirmation: { status: 'not_requested' },
});
export const recordedEvidence = c.EvidenceRecordSchema.parse({
  kind: 'recorded_evidence',
  ...base,
  id: evidence.evidenceId,
  eventId: evidence.eventId,
  recordedAt: time,
  provenance: ownerProvenance,
  content: {
    kind: 'recorded_text',
    text: 'Synthetic owner asked for numbered sandbox drafts.',
  },
});
export const content = c.LearnedContentSchema.parse({
  category: 'preference',
  subject: 'synthetic sandbox drafts',
  desiredBehavior: 'Use numbered steps.',
});
export const learnedRef = c.LearnedItemReferenceSchema.parse({
  learnedItemId: 'learned_synthetic',
  version: 1,
});
export const replacement = c.LearnedItemReferenceSchema.parse({
  learnedItemId: 'learned_synthetic',
  version: 2,
});
export const candidateRef = c.CandidateReferenceSchema.parse({
  candidateId: 'candidate_synthetic',
  version: 1,
});
export const evalRef = c.EvaluationReferenceSchema.parse({
  evaluationId: 'evaluation_synthetic',
  version: 1,
});
export const generation = c.LearningGenerationSchema.parse({
  generatedAt: time,
  generator: inference,
});
export const candidate = c.LearningCandidateSchema.parse({
  kind: 'learning_candidate',
  ...base,
  id: candidateRef.candidateId,
  proposedContent: content,
  proposedScope: scope,
  evidence: signals,
  generation,
  lifecycle: { status: 'candidate' },
});
export const trusted = c.TrustedOwnerStateSchema.parse({
  kind: 'durable_owner_state',
  ...base,
  id: learnedRef.learnedItemId,
  content,
  scope,
  provenance: inference,
  evidence: signals,
  lifecycle: {
    status: 'trusted',
    evaluations: [evalRef],
    lastValidatedAt: time,
    candidate: candidateRef,
    promotionEventId: 'event_promotion',
  },
});
export const activeTask = c.ActiveTaskStateSchema.parse({
  kind: 'active_task_state',
  ...base,
  id: 'learned_task',
  task,
  objective: 'Prepare a synthetic draft',
  openLoops: ['Review draft'],
  sourceEvidence: [evidence],
  provenance: ownerProvenance,
  lifecycle: { status: 'active' },
});
export const correction = c.OwnerCorrectionSchema.parse({
  kind: 'owner_correction',
  ...base,
  evidence,
  provenance: {
    kind: 'explicit_owner_correction',
    ownerId: owner,
    sourceEventId: evidence.eventId,
  },
  category: 'preference',
  target: { kind: 'owner_state', reference: learnedRef },
  originalBehavior: 'Synthetic draft used prose.',
  correctedInstruction: 'Use numbered steps for this draft.',
  immediateApplicability: { kind: 'current_task', task },
  durableScopeHint: {
    kind: 'unknown',
    reason: 'Durable scope has not been evaluated.',
  },
});
export const context = c.TaskContextSchema.parse({
  kind: 'task_context',
  ...base,
  id: 'context_synthetic',
  task,
  assembledAt: time,
  selections: [
    {
      source: {
        kind: 'owner_state',
        reference: learnedRef,
        lifecycle: 'trusted',
      },
      relevance: 'direct',
      scopeCompatibility: 'matches',
      freshness: {
        status: 'current',
        assessedAt: time,
        basis: 'Synthetic evaluation',
      },
      provenance: inference,
      use: 'learned_guidance',
      inclusionReason: 'Matching sandbox draft scope',
    },
  ],
});
export const proposal = c.ActionProposalSchema.parse({
  kind: 'action_proposal',
  ...base,
  id: 'proposal_synthetic',
  task,
  toolId: 'synthetic-tool',
  action: 'draft',
  parameters: { kind: 'immutable_reference', artifact },
  target: { kind: 'sandbox_resource', identifier: 'synthetic-draft' },
  consequences: {
    risk: 'low',
    reversibility: 'reversible',
    description: 'Prepare a fake draft.',
  },
  requestedAuthority: [
    {
      operation: 'draft',
      resource: { kind: 'sandbox_resource', identifier: 'synthetic-draft' },
    },
  ],
  priorApprovalIds: [],
});
export const binding = c.ProposalBindingSchema.parse({
  proposalId: proposal.id,
  proposalVersion: 1,
  proposalDigest: digest,
  parametersDigest: digest,
});
export const policy = c.PolicyDecisionSchema.parse({
  kind: 'policy_decision',
  ...base,
  id: 'decision_synthetic',
  proposal: binding,
  evaluatedAt: time,
  issuer: {
    kind: 'root',
    policyVersion: 'synthetic-policy-1',
    policyDigest: digest,
  },
  reasonCodes: ['SYNTHETIC_GRANT'],
  decision: 'ALLOW',
  basis: { kind: 'existing_grant', grantReference: 'synthetic-grant' },
});
export const policyRef = c.AllowDecisionReferenceSchema.parse({
  decisionId: policy.id,
  proposal: binding,
  decision: 'ALLOW',
});
export const approval = c.OwnerApprovalSchema.parse({
  kind: 'owner_approval',
  ...base,
  id: 'approval_synthetic',
  proposal: binding,
  bounds: task,
  issuedAt: time,
  expiresAt: later,
  evidence,
  provenance: {
    kind: 'owner_approval',
    ownerId: owner,
    sourceEventId: evidence.eventId,
  },
  lifecycle: { status: 'issued' },
});
export const execution = c.ExecutionResultSchema.parse({
  kind: 'execution_result',
  ...base,
  id: 'execution_synthetic',
  policy: policyRef,
  toolId: 'synthetic-tool',
  attempted: true,
  startedAt: time,
  endedAt: later,
  outcome: { status: 'succeeded', returned: artifact },
});
export const verificationEvidence =
  c.ObservableVerificationEvidenceSchema.parse({
    kind: 'deterministic_check',
    reference: evidence,
    provenance: system,
    checkId: 'synthetic-draft-exists',
    checkVersion: '1',
  });
export const verification = c.VerificationResultSchema.parse({
  kind: 'verification_result',
  ...base,
  id: 'verification_synthetic',
  executionId: execution.id,
  verifiedAt: later,
  status: 'VERIFIED',
  method: {
    kind: 'deterministic_assertion',
    identifier: 'synthetic-draft-check',
    version: '1',
  },
  evidence: [verificationEvidence],
});
export const testDefinition = c.EvaluationTestDefinitionSchema.parse({
  kind: 'evaluation_test',
  ...base,
  id: 'evaltest_synthetic',
  testType: 'scope_application',
  split: 'promotion_eval',
  scenarioGroup: 'synthetic-group',
  input: artifact,
  scope,
  oracle: {
    kind: 'owner_supplied',
    expected: { kind: 'scope_application', applied: true },
    provenance: ownerProvenance,
    evidence,
  },
});
export const evaluation = c.EvaluationResultSchema.parse({
  kind: 'evaluation_result',
  ...base,
  id: evalRef.evaluationId,
  test: testDefinition,
  subject: { kind: 'candidate', reference: candidateRef },
  subjectModel: model,
  actual: {
    status: 'observed',
    outcome: { kind: 'scope_application', applied: true },
    evidence: [evidence],
  },
  scorer: {
    kind: 'deterministic',
    identifier: 'synthetic-scorer',
    version: '1',
    specification: artifact,
  },
  independence: { status: 'assessed', relationship: 'independent', evidence },
  verdict: 'PASS',
  conclusionBasis: 'relative_to_declared_oracle',
  scoredAt: later,
});
export const promotion = c.LearningPromotionSchema.parse({
  kind: 'learning_promotion',
  ...base,
  eventId: 'event_promotion',
  occurredAt: later,
  candidate: candidateRef,
  evaluations: [evalRef],
  trustedState: learnedRef,
  authority: policyRef,
});
export const rejection = c.LearningRejectionSchema.parse({
  kind: 'learning_rejection',
  ...base,
  eventId: 'event_rejection',
  occurredAt: later,
  candidate: candidateRef,
  evaluations: [],
  reason: 'Synthetic counterexample',
  evidence: [evidence],
});
export const supersession = c.LearningSupersessionSchema.parse({
  kind: 'learning_supersession',
  ...base,
  eventId: 'event_supersession',
  occurredAt: later,
  previous: learnedRef,
  replacement,
  promotionEventId: promotion.eventId,
  authority: policyRef,
  reason: 'Synthetic replacement',
});
export const revocation = c.LearningRevocationSchema.parse({
  kind: 'learning_revocation',
  ...base,
  eventId: 'event_revocation',
  occurredAt: later,
  revoked: replacement,
  fallback: learnedRef,
  authority: policyRef,
  reason: 'Synthetic regression',
  evidence: [evidence],
});
export const rollback = c.LearningRollbackSchema.parse({
  kind: 'learning_rollback',
  ...base,
  eventId: 'event_rollback',
  occurredAt: later,
  from: replacement,
  restore: learnedRef,
  revocationEventId: revocation.eventId,
  authority: policyRef,
  reason: 'Synthetic rollback',
});
export const noLesson = c.LearningResultSchema.parse({
  kind: 'no_useful_lesson',
  ...base,
  consideredEvidence: [evidence],
  generation,
  reason: 'Insufficient evidence for a reusable lesson.',
});
export const requestMetadata = c.ModelRequestMetadataSchema.parse({
  kind: 'model_request_metadata',
  ...base,
  callId: 'modelcall_synthetic',
  task,
  model,
  purpose: 'candidate_generation',
  requestedAt: time,
});
export const responseMetadata = c.ModelResponseMetadataSchema.parse({
  kind: 'model_response_metadata',
  ...base,
  callId: requestMetadata.callId,
  model,
  completedAt: later,
  status: 'completed',
  usage: { inputTokens: 10, outputTokens: 5, elapsedMilliseconds: 100 },
});

export function omit<T extends object, K extends keyof T>(value: T, key: K) {
  const { [key]: removed, ...rest } = value;
  void removed;
  return rest;
}
