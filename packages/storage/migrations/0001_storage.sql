-- AVEN-003 / contract schema v1. Authoritative, reviewed SQL migration.
-- Requires openStorage(): registered v1 contract functions, FK and recursive triggers ON.
-- Every relationship restricts deletion; deferred references allow cyclic evidence batches.
CREATE TABLE owners (
  owner_id TEXT PRIMARY KEY NOT NULL CHECK (aven_scalar_v1('owner', owner_id) = 1),
  created_at TEXT NOT NULL CHECK (aven_scalar_v1('timestamp', created_at) = 1)
) STRICT;
CREATE TABLE sessions (
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK (aven_scalar_v1('session', session_id) = 1),
  created_at TEXT NOT NULL CHECK (aven_scalar_v1('timestamp', created_at) = 1),
  PRIMARY KEY (owner_id, session_id),
  FOREIGN KEY (owner_id) REFERENCES owners(owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
CREATE TABLE tasks (
  owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK (aven_scalar_v1('task', task_id) = 1),
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (aven_scalar_v1('timestamp', created_at) = 1),
  PRIMARY KEY (owner_id, task_id),
  UNIQUE (owner_id, session_id, task_id),
  FOREIGN KEY (owner_id, session_id) REFERENCES sessions(owner_id, session_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE experience_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0 AND sequence <= 9007199254740991),
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('experience_events', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  event_type TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.eventType')) STORED NOT NULL,
  occurred_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.occurredAt')) STORED NOT NULL,
  recorded_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.recordedAt')) STORED NOT NULL,
  session_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.sessionId')) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.taskId')) STORED,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.trust')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks (owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (owner_id, record_id, event_type)
) STRICT;

CREATE TABLE evidence (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('evidence', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  event_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.eventId')) STORED NOT NULL,
  recorded_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.recordedAt')) STORED NOT NULL,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.trust')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, event_id) REFERENCES experience_events (owner_id, record_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (owner_id, record_id, event_id)
) STRICT;

CREATE TABLE learned_owner_state (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('learned_owner_state', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  category TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.content.category')) STORED NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.status')) STORED NOT NULL,
  scope_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.scope.kind')) STORED NOT NULL,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.trust')) STORED,
  last_validated_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.lastValidatedAt')) STORED,
  candidate_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.candidate.candidateId')) STORED,
  candidate_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.candidate.version')) STORED,
  promotion_event_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.promotionEventId')) STORED,
  lineage_event_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.eventId')) STORED,
  replacement_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.replacement.learnedItemId')) STORED,
  replacement_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.replacement.version')) STORED,
  fallback_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.fallback.learnedItemId')) STORED,
  fallback_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.fallback.version')) STORED,
  support TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.support')) STORED NOT NULL,
  independence_status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.sourceIndependence.status')) STORED NOT NULL,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (owner_id, candidate_id, candidate_version) REFERENCES learning_candidates (owner_id, record_id, record_version) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, replacement_id, replacement_version) REFERENCES learned_owner_state (owner_id, record_id, record_version) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, fallback_id, fallback_version) REFERENCES learned_owner_state (owner_id, record_id, record_version) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE active_task_state (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('active_task_state', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.status')) STORED NOT NULL,
  session_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.sessionId')) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.taskId')) STORED,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.trust')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks (owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE learning_candidates (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('learning_candidates', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  category TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposedContent.category')) STORED NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.status')) STORED NOT NULL,
  scope_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposedScope.kind')) STORED NOT NULL,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.generation.generator.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.generation.generator.trust')) STORED,
  support TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.support')) STORED NOT NULL,
  independence_status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.sourceIndependence.status')) STORED NOT NULL,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE no_useful_lessons (
  storage_id TEXT NOT NULL CHECK (length(trim(storage_id)) > 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('no_useful_lessons', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (storage_id) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.generation.generator.kind')) STORED NOT NULL,
  declared_trust TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.generation.generator.trust')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE corrections (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('corrections', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.evidenceId')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  category TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.category')) STORED NOT NULL,
  source_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.provenance.kind')) STORED NOT NULL,
  event_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.evidence.eventId')) STORED NOT NULL,
  target_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.target.kind')) STORED NOT NULL,
  immediate_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.immediateApplicability.kind')) STORED NOT NULL,
  scope_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.durableScopeHint.kind')) STORED NOT NULL,
  session_id TEXT GENERATED ALWAYS AS (coalesce(json_extract(record_json, '$.immediateApplicability.task.sessionId'), json_extract(record_json, '$.immediateApplicability.sessionId'))) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.immediateApplicability.task.taskId')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks (owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE action_proposals (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('action_proposals', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  session_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.sessionId')) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.task.taskId')) STORED,
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64 AND proposal_digest NOT GLOB '*[^a-f0-9]*'),
  parameters_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.parameters.artifact.digest.value')) STORED NOT NULL,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks (owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (owner_id, record_id, record_version, proposal_digest, parameters_digest),
  UNIQUE (owner_id, record_id, record_version, proposal_digest, parameters_digest, session_id, task_id)
) STRICT;

CREATE TABLE policy_decisions (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('policy_decisions', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  proposal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalId')) STORED,
  proposal_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalVersion')) STORED,
  proposal_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalDigest.value')) STORED,
  parameters_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.parametersDigest.value')) STORED,
  decision TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.decision')) STORED NOT NULL,
  basis_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.basis.kind')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, proposal_id, proposal_version, proposal_digest, parameters_digest) REFERENCES action_proposals (owner_id, record_id, record_version, proposal_digest, parameters_digest) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (owner_id, record_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest)
) STRICT;

CREATE TABLE owner_approvals (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('owner_approvals', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  proposal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalId')) STORED,
  proposal_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalVersion')) STORED,
  proposal_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.proposalDigest.value')) STORED,
  parameters_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.proposal.parametersDigest.value')) STORED,
  session_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.bounds.sessionId')) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.bounds.taskId')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.status')) STORED NOT NULL,
  issued_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.issuedAt')) STORED NOT NULL,
  expires_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.expiresAt')) STORED NOT NULL,
  revoked_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.revokedAt')) STORED,
  revocation_event_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.lifecycle.revocationEventId')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks (owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, proposal_id, proposal_version, proposal_digest, parameters_digest, session_id, task_id) REFERENCES action_proposals (owner_id, record_id, record_version, proposal_digest, parameters_digest, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE tool_executions (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('tool_executions', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  proposal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.policy.proposal.proposalId')) STORED,
  proposal_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.policy.proposal.proposalVersion')) STORED,
  proposal_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.policy.proposal.proposalDigest.value')) STORED,
  parameters_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.policy.proposal.parametersDigest.value')) STORED,
  decision_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.policy.decisionId')) STORED,
  decision TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.policy.decision')) STORED,
  attempted INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.attempted')) STORED NOT NULL,
  outcome TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.outcome.status')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, decision_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) REFERENCES policy_decisions (owner_id, record_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE verification_results (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('verification_results', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  execution_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.executionId')) STORED NOT NULL,
  status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.status')) STORED NOT NULL,
  method_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.method.kind')) STORED NOT NULL,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, execution_id) REFERENCES tool_executions (owner_id, record_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE evaluations (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('evaluations', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.id')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  definition_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.test.id')) STORED NOT NULL,
  definition_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.test.metadata.recordVersion')) STORED NOT NULL,
  subject_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.subject.kind')) STORED NOT NULL,
  oracle_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.test.oracle.kind')) STORED NOT NULL,
  scorer_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.scorer.kind')) STORED NOT NULL,
  verdict TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.verdict')) STORED NOT NULL,
  split TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.test.split')) STORED NOT NULL,
  actual_status TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.actual.status')) STORED NOT NULL,
  scope_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.test.scope.kind')) STORED NOT NULL,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;

CREATE TABLE lifecycle_records (
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND aven_valid_v1('lifecycle_records', record_json) = 1),
  owner_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.ownerId')) STORED NOT NULL,
  record_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.eventId')) STORED NOT NULL,
  record_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.recordVersion')) STORED NOT NULL,
  schema_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.schemaVersion')) STORED NOT NULL,
  created_at TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.metadata.createdAt')) STORED NOT NULL,
  transition_kind TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.kind')) STORED NOT NULL,
  proposal_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.authority.proposal.proposalId')) STORED,
  proposal_version INTEGER GENERATED ALWAYS AS (json_extract(record_json, '$.authority.proposal.proposalVersion')) STORED,
  proposal_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.authority.proposal.proposalDigest.value')) STORED,
  parameters_digest TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.authority.proposal.parametersDigest.value')) STORED,
  decision_id TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.authority.decisionId')) STORED,
  decision TEXT GENERATED ALWAYS AS (json_extract(record_json, '$.authority.decision')) STORED,
  UNIQUE (owner_id, record_id, record_version),
  CHECK (record_version > 0 AND record_version <= 9007199254740991),
  CHECK (schema_version = 1),
  FOREIGN KEY (owner_id) REFERENCES owners (owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  UNIQUE (owner_id, record_id),
  FOREIGN KEY (owner_id, decision_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) REFERENCES policy_decisions (owner_id, record_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE record_keys (
  owner_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, record_kind, record_id),
  FOREIGN KEY (owner_id) REFERENCES owners(owner_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
CREATE TABLE record_versions (
  owner_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_version INTEGER NOT NULL CHECK (record_version > 0 AND record_version <= 9007199254740991),
  PRIMARY KEY (owner_id, record_kind, record_id, record_version),
  FOREIGN KEY (owner_id, record_kind, record_id) REFERENCES record_keys(owner_id, record_kind, record_id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;
CREATE TABLE record_references (
  owner_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  path TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version INTEGER,
  evidence_event_id TEXT,
  session_id TEXT,
  proposal_id TEXT,
  proposal_version INTEGER,
  proposal_digest TEXT,
  parameters_digest TEXT,
  decision TEXT,
  event_type TEXT,
  bound_task_id TEXT,
  event_id TEXT GENERATED ALWAYS AS (CASE WHEN target_kind = 'experience_events' THEN target_id END) STORED,
  decision_id TEXT GENERATED ALWAYS AS (CASE WHEN target_kind = 'policy_decisions' THEN target_id END) STORED,
  record_target_kind TEXT GENERATED ALWAYS AS (CASE WHEN target_kind NOT IN ('tasks', 'sessions') THEN target_kind END) STORED,
  evidence_id TEXT GENERATED ALWAYS AS (CASE WHEN target_kind = 'evidence' THEN target_id END) STORED,
  task_id TEXT GENERATED ALWAYS AS (CASE WHEN target_kind = 'tasks' THEN target_id END) STORED,
  referenced_session_id TEXT GENERATED ALWAYS AS (CASE WHEN target_kind = 'sessions' THEN target_id END) STORED,
  PRIMARY KEY (owner_id, source_kind, source_id, source_version, path, target_kind),
  FOREIGN KEY (owner_id, source_kind, source_id, source_version) REFERENCES record_versions(owner_id, record_kind, record_id, record_version) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, record_target_kind, target_id) REFERENCES record_keys(owner_id, record_kind, record_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, record_target_kind, target_id, target_version) REFERENCES record_versions(owner_id, record_kind, record_id, record_version) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, evidence_id, evidence_event_id) REFERENCES evidence(owner_id, record_id, event_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, task_id) REFERENCES tasks(owner_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, session_id, task_id) REFERENCES tasks(owner_id, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, referenced_session_id) REFERENCES sessions(owner_id, session_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, proposal_id, proposal_version, proposal_digest, parameters_digest) REFERENCES action_proposals(owner_id, record_id, record_version, proposal_digest, parameters_digest) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, decision_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) REFERENCES policy_decisions(owner_id, record_id, decision, proposal_id, proposal_version, proposal_digest, parameters_digest) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, event_id, event_type) REFERENCES experience_events(owner_id, record_id, event_type) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, proposal_id, proposal_version, proposal_digest, parameters_digest, session_id, bound_task_id) REFERENCES action_proposals(owner_id, record_id, record_version, proposal_digest, parameters_digest, session_id, task_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE VIEW record_snapshots AS
SELECT 'experience_events' AS record_kind, owner_id, record_id, record_version, record_json FROM experience_events
UNION ALL
SELECT 'evidence' AS record_kind, owner_id, record_id, record_version, record_json FROM evidence
UNION ALL
SELECT 'learned_owner_state' AS record_kind, owner_id, record_id, record_version, record_json FROM learned_owner_state
UNION ALL
SELECT 'active_task_state' AS record_kind, owner_id, record_id, record_version, record_json FROM active_task_state
UNION ALL
SELECT 'learning_candidates' AS record_kind, owner_id, record_id, record_version, record_json FROM learning_candidates
UNION ALL
SELECT 'no_useful_lessons' AS record_kind, owner_id, record_id, record_version, record_json FROM no_useful_lessons
UNION ALL
SELECT 'corrections' AS record_kind, owner_id, record_id, record_version, record_json FROM corrections
UNION ALL
SELECT 'action_proposals' AS record_kind, owner_id, record_id, record_version, record_json FROM action_proposals
UNION ALL
SELECT 'policy_decisions' AS record_kind, owner_id, record_id, record_version, record_json FROM policy_decisions
UNION ALL
SELECT 'owner_approvals' AS record_kind, owner_id, record_id, record_version, record_json FROM owner_approvals
UNION ALL
SELECT 'tool_executions' AS record_kind, owner_id, record_id, record_version, record_json FROM tool_executions
UNION ALL
SELECT 'verification_results' AS record_kind, owner_id, record_id, record_version, record_json FROM verification_results
UNION ALL
SELECT 'evaluations' AS record_kind, owner_id, record_id, record_version, record_json FROM evaluations
UNION ALL
SELECT 'lifecycle_records' AS record_kind, owner_id, record_id, record_version, record_json FROM lifecycle_records;

CREATE TRIGGER record_keys_require_snapshot BEFORE INSERT ON record_keys
WHEN NOT EXISTS (SELECT 1 FROM record_snapshots s WHERE s.owner_id = NEW.owner_id AND (s.record_kind = NEW.record_kind OR (NEW.record_kind = 'owner_state' AND s.record_kind IN ('learned_owner_state', 'active_task_state'))) AND s.record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Identity index requires an existing typed snapshot'); END;

CREATE TRIGGER record_versions_require_snapshot BEFORE INSERT ON record_versions
WHEN NOT EXISTS (SELECT 1 FROM record_snapshots s WHERE s.owner_id = NEW.owner_id AND (s.record_kind = NEW.record_kind OR (NEW.record_kind = 'owner_state' AND s.record_kind IN ('learned_owner_state', 'active_task_state'))) AND s.record_id = NEW.record_id AND s.record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Identity index requires an existing typed snapshot'); END;

CREATE TRIGGER record_references_require_snapshot BEFORE INSERT ON record_references
WHEN NOT EXISTS (
  SELECT 1 FROM record_snapshots s, json_each(aven_references_v1(s.record_kind, s.record_json)) r
  WHERE s.owner_id = NEW.owner_id AND s.record_kind = NEW.source_kind
    AND s.record_id = NEW.source_id AND s.record_version = NEW.source_version
    AND json_extract(r.value, '$.path') = NEW.path
    AND json_extract(r.value, '$.targetKind') = NEW.target_kind
    AND json_extract(r.value, '$.targetId') = NEW.target_id
    AND json_extract(r.value, '$.targetVersion') IS NEW.target_version
    AND json_extract(r.value, '$.evidenceEventId') IS NEW.evidence_event_id
    AND json_extract(r.value, '$.sessionId') IS NEW.session_id
    AND json_extract(r.value, '$.proposalId') IS NEW.proposal_id
    AND json_extract(r.value, '$.proposalVersion') IS NEW.proposal_version
    AND json_extract(r.value, '$.proposalDigest') IS NEW.proposal_digest
    AND json_extract(r.value, '$.parametersDigest') IS NEW.parameters_digest
    AND json_extract(r.value, '$.decision') IS NEW.decision
    AND json_extract(r.value, '$.eventType') IS NEW.event_type
    AND json_extract(r.value, '$.boundTaskId') IS NEW.bound_task_id
)
BEGIN SELECT RAISE(ABORT, 'Reference must match its typed source snapshot'); END;

CREATE TRIGGER experience_events_index_references AFTER INSERT ON experience_events
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'experience_events', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'experience_events', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'experience_events', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('experience_events', NEW.record_json));
END;

CREATE TRIGGER experience_events_no_replace BEFORE INSERT ON experience_events
WHEN EXISTS (SELECT 1 FROM experience_events WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER evidence_index_references AFTER INSERT ON evidence
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'evidence', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'evidence', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'evidence', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('evidence', NEW.record_json));
END;

CREATE TRIGGER evidence_no_replace BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM evidence WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER learned_owner_state_index_references AFTER INSERT ON learned_owner_state
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'learned_owner_state', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'learned_owner_state', NEW.record_id, NEW.record_version);
  INSERT INTO record_keys VALUES (NEW.owner_id, 'owner_state', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'owner_state', NEW.record_id, NEW.record_version);
  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'learned_owner_state', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('learned_owner_state', NEW.record_json));
END;

CREATE TRIGGER learned_owner_state_no_replace BEFORE INSERT ON learned_owner_state
WHEN EXISTS (SELECT 1 FROM learned_owner_state WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER active_task_state_index_references AFTER INSERT ON active_task_state
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'active_task_state', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'active_task_state', NEW.record_id, NEW.record_version);
  INSERT INTO record_keys VALUES (NEW.owner_id, 'owner_state', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'owner_state', NEW.record_id, NEW.record_version);
  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'active_task_state', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('active_task_state', NEW.record_json));
END;

CREATE TRIGGER active_task_state_no_replace BEFORE INSERT ON active_task_state
WHEN EXISTS (SELECT 1 FROM active_task_state WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER learning_candidates_index_references AFTER INSERT ON learning_candidates
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'learning_candidates', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'learning_candidates', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'learning_candidates', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('learning_candidates', NEW.record_json));
END;

CREATE TRIGGER learning_candidates_no_replace BEFORE INSERT ON learning_candidates
WHEN EXISTS (SELECT 1 FROM learning_candidates WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER no_useful_lessons_index_references AFTER INSERT ON no_useful_lessons
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'no_useful_lessons', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'no_useful_lessons', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'no_useful_lessons', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('no_useful_lessons', NEW.record_json));
END;

CREATE TRIGGER no_useful_lessons_no_replace BEFORE INSERT ON no_useful_lessons
WHEN EXISTS (SELECT 1 FROM no_useful_lessons WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER corrections_index_references AFTER INSERT ON corrections
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'corrections', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'corrections', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'corrections', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('corrections', NEW.record_json));
END;

CREATE TRIGGER corrections_no_replace BEFORE INSERT ON corrections
WHEN EXISTS (SELECT 1 FROM corrections WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER action_proposals_index_references AFTER INSERT ON action_proposals
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'action_proposals', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'action_proposals', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'action_proposals', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('action_proposals', NEW.record_json));
END;

CREATE TRIGGER action_proposals_no_replace BEFORE INSERT ON action_proposals
WHEN EXISTS (SELECT 1 FROM action_proposals WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER policy_decisions_index_references AFTER INSERT ON policy_decisions
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'policy_decisions', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'policy_decisions', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'policy_decisions', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('policy_decisions', NEW.record_json));
END;

CREATE TRIGGER policy_decisions_no_replace BEFORE INSERT ON policy_decisions
WHEN EXISTS (SELECT 1 FROM policy_decisions WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER owner_approvals_index_references AFTER INSERT ON owner_approvals
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'owner_approvals', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'owner_approvals', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'owner_approvals', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('owner_approvals', NEW.record_json));
END;

CREATE TRIGGER owner_approvals_no_replace BEFORE INSERT ON owner_approvals
WHEN EXISTS (SELECT 1 FROM owner_approvals WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER tool_executions_index_references AFTER INSERT ON tool_executions
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'tool_executions', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'tool_executions', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'tool_executions', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('tool_executions', NEW.record_json));
END;

CREATE TRIGGER tool_executions_no_replace BEFORE INSERT ON tool_executions
WHEN EXISTS (SELECT 1 FROM tool_executions WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER verification_results_index_references AFTER INSERT ON verification_results
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'verification_results', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'verification_results', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'verification_results', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('verification_results', NEW.record_json));
END;

CREATE TRIGGER verification_results_no_replace BEFORE INSERT ON verification_results
WHEN EXISTS (SELECT 1 FROM verification_results WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER evaluations_index_references AFTER INSERT ON evaluations
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'evaluations', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'evaluations', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'evaluations', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('evaluations', NEW.record_json));
END;

CREATE TRIGGER evaluations_no_replace BEFORE INSERT ON evaluations
WHEN EXISTS (SELECT 1 FROM evaluations WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id AND record_version = NEW.record_version)
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER lifecycle_records_index_references AFTER INSERT ON lifecycle_records
BEGIN
  INSERT INTO record_keys (owner_id, record_kind, record_id) VALUES (NEW.owner_id, 'lifecycle_records', NEW.record_id) ON CONFLICT DO NOTHING;
  INSERT INTO record_versions VALUES (NEW.owner_id, 'lifecycle_records', NEW.record_id, NEW.record_version);

  INSERT INTO record_references (owner_id, source_kind, source_id, source_version, path, target_kind, target_id, target_version, evidence_event_id, session_id, proposal_id, proposal_version, proposal_digest, parameters_digest, decision, event_type, bound_task_id)
    SELECT NEW.owner_id, 'lifecycle_records', NEW.record_id, NEW.record_version,
      json_extract(value, '$.path'), json_extract(value, '$.targetKind'), json_extract(value, '$.targetId'),
      json_extract(value, '$.targetVersion'), json_extract(value, '$.evidenceEventId'), json_extract(value, '$.sessionId'),
      json_extract(value, '$.proposalId'), json_extract(value, '$.proposalVersion'), json_extract(value, '$.proposalDigest'), json_extract(value, '$.parametersDigest'), json_extract(value, '$.decision'), json_extract(value, '$.eventType'), json_extract(value, '$.boundTaskId')
    FROM json_each(aven_references_v1('lifecycle_records', NEW.record_json));
END;

CREATE TRIGGER lifecycle_records_no_replace BEFORE INSERT ON lifecycle_records
WHEN EXISTS (SELECT 1 FROM lifecycle_records WHERE owner_id = NEW.owner_id AND record_id = NEW.record_id )
BEGIN SELECT RAISE(ABORT, 'Existing snapshot cannot be replaced'); END;

CREATE TRIGGER experience_events_no_update BEFORE UPDATE ON experience_events
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER experience_events_no_delete BEFORE DELETE ON experience_events
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER learned_owner_state_no_update BEFORE UPDATE ON learned_owner_state
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER learned_owner_state_no_delete BEFORE DELETE ON learned_owner_state
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER active_task_state_no_update BEFORE UPDATE ON active_task_state
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER active_task_state_no_delete BEFORE DELETE ON active_task_state
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER learning_candidates_no_update BEFORE UPDATE ON learning_candidates
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER learning_candidates_no_delete BEFORE DELETE ON learning_candidates
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER no_useful_lessons_no_update BEFORE UPDATE ON no_useful_lessons
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER no_useful_lessons_no_delete BEFORE DELETE ON no_useful_lessons
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER corrections_no_update BEFORE UPDATE ON corrections
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER corrections_no_delete BEFORE DELETE ON corrections
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER action_proposals_no_update BEFORE UPDATE ON action_proposals
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER action_proposals_no_delete BEFORE DELETE ON action_proposals
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER policy_decisions_no_update BEFORE UPDATE ON policy_decisions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER policy_decisions_no_delete BEFORE DELETE ON policy_decisions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER owner_approvals_no_update BEFORE UPDATE ON owner_approvals
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER owner_approvals_no_delete BEFORE DELETE ON owner_approvals
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER tool_executions_no_update BEFORE UPDATE ON tool_executions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER tool_executions_no_delete BEFORE DELETE ON tool_executions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER verification_results_no_update BEFORE UPDATE ON verification_results
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER verification_results_no_delete BEFORE DELETE ON verification_results
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER evaluations_no_update BEFORE UPDATE ON evaluations
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER evaluations_no_delete BEFORE DELETE ON evaluations
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER lifecycle_records_no_update BEFORE UPDATE ON lifecycle_records
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER lifecycle_records_no_delete BEFORE DELETE ON lifecycle_records
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_keys_no_update BEFORE UPDATE ON record_keys
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_keys_no_delete BEFORE DELETE ON record_keys
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_versions_no_update BEFORE UPDATE ON record_versions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_versions_no_delete BEFORE DELETE ON record_versions
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_references_no_update BEFORE UPDATE ON record_references
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER record_references_no_delete BEFORE DELETE ON record_references
BEGIN SELECT RAISE(ABORT, 'Immutable snapshot or lineage'); END;

CREATE TRIGGER experience_events_monotonic_sequence BEFORE INSERT ON experience_events
WHEN NEW.sequence != -1 AND NEW.sequence <= max(
  coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'experience_events'), 0),
  coalesce((SELECT max(sequence) FROM experience_events), 0)
)
BEGIN SELECT RAISE(ABORT, 'Event sequence must advance the local high-water mark'); END;
CREATE INDEX events_owner_order ON experience_events(owner_id, sequence);
CREATE INDEX events_owner_type ON experience_events(owner_id, event_type, sequence);
CREATE INDEX evidence_source ON evidence(owner_id, event_id);
CREATE INDEX state_lookup ON learned_owner_state(owner_id, status, category, scope_kind);
CREATE INDEX candidate_lookup ON learning_candidates(owner_id, status, category, scope_kind);
CREATE INDEX references_target ON record_references(owner_id, target_kind, target_id, target_version);
CREATE INDEX evaluation_subject ON evaluations(owner_id, subject_kind, verdict);
CREATE INDEX approval_binding ON owner_approvals(owner_id, proposal_id, proposal_version);

-- Latest declared snapshot, not authenticated Root trusted-version selection.
CREATE VIEW latest_learned_owner_state AS
SELECT current.* FROM learned_owner_state current
WHERE NOT EXISTS (SELECT 1 FROM learned_owner_state newer WHERE newer.owner_id = current.owner_id AND newer.record_id = current.record_id AND newer.record_version > current.record_version);

-- Latest declared snapshot, not authenticated Root trusted-version selection.
CREATE VIEW latest_active_task_state AS
SELECT current.* FROM active_task_state current
WHERE NOT EXISTS (SELECT 1 FROM active_task_state newer WHERE newer.owner_id = current.owner_id AND newer.record_id = current.record_id AND newer.record_version > current.record_version);

-- Latest declared snapshot, not authenticated Root trusted-version selection.
CREATE VIEW latest_learning_candidates AS
SELECT current.* FROM learning_candidates current
WHERE NOT EXISTS (SELECT 1 FROM learning_candidates newer WHERE newer.owner_id = current.owner_id AND newer.record_id = current.record_id AND newer.record_version > current.record_version);

-- Latest declared snapshot, not authenticated Root trusted-version selection.
CREATE VIEW latest_owner_approvals AS
SELECT current.* FROM owner_approvals current
WHERE NOT EXISTS (SELECT 1 FROM owner_approvals newer WHERE newer.owner_id = current.owner_id AND newer.record_id = current.record_id AND newer.record_version > current.record_version);
