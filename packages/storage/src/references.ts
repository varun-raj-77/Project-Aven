// Frozen v1 structural reference projection. Only parsed AVEN-002 contracts
// enter this function. Prose and artifact locators are never interpreted as IDs.
// Paths preserve the distinction between roots, derivations, supporting evidence,
// counterexamples, oracle evidence and evaluator-independence assessments.
export interface StorageReference {
  path: string;
  targetKind: string;
  targetId: string;
  targetVersion: number | null;
  evidenceEventId: string | null;
  sessionId: string | null;
  proposalId: string | null;
  proposalVersion: number | null;
  proposalDigest: string | null;
  parametersDigest: string | null;
  decision: string | null;
  eventType: string | null;
  boundTaskId: string | null;
}

function object(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function referencesV1(value: unknown): StorageReference[] {
  const result: StorageReference[] = [];
  const root = object(value) ? value : {};
  const ownerId = root.ownerId;
  const transitionEvents: { [kind: string]: string | undefined } = {
    learning_promotion: 'learning_promoted',
    learning_rejection: 'learning_rejected',
    learning_supersession: 'learning_superseded',
    learning_revocation: 'learning_revoked',
    learning_rollback: 'learning_rolled_back',
  };
  function add(
    path: string,
    targetKind: string,
    id: unknown,
    options: {
      version?: unknown;
      eventId?: unknown;
      sessionId?: unknown;
      binding?: unknown;
      decision?: unknown;
      eventType?: string | null;
      boundTaskId?: unknown;
    } = {},
  ) {
    const {
      version,
      eventId,
      sessionId,
      binding,
      decision,
      eventType = null,
      boundTaskId,
    } = options;
    if (typeof id !== 'string') throw new Error(`Missing reference at ${path}`);
    const bound = object(binding) ? binding : {};
    const proposalDigest = object(bound.proposalDigest)
      ? bound.proposalDigest.value
      : null;
    const parametersDigest = object(bound.parametersDigest)
      ? bound.parametersDigest.value
      : null;
    result.push({
      path,
      targetKind,
      targetId: id,
      targetVersion: typeof version === 'number' ? version : null,
      evidenceEventId: typeof eventId === 'string' ? eventId : null,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      proposalId:
        typeof bound.proposalId === 'string' ? bound.proposalId : null,
      proposalVersion:
        typeof bound.proposalVersion === 'number'
          ? bound.proposalVersion
          : null,
      proposalDigest:
        typeof proposalDigest === 'string' ? proposalDigest : null,
      parametersDigest:
        typeof parametersDigest === 'string' ? parametersDigest : null,
      decision: typeof decision === 'string' ? decision : null,
      eventType,
      boundTaskId: typeof boundTaskId === 'string' ? boundTaskId : null,
    });
  }
  function walk(
    current: unknown,
    path: string,
    learnedTarget = 'learned_owner_state',
    approvalBounds?: unknown,
  ) {
    if (Array.isArray(current)) {
      current.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!object(current)) return;
    if ('ownerId' in current && current.ownerId !== ownerId)
      throw new Error('Nested owner reference differs from record owner');
    if ('evidenceId' in current)
      add(path, 'evidence', current.evidenceId, {
        version: 1,
        eventId: current.eventId,
      });
    if ('learnedItemId' in current)
      add(path, learnedTarget, current.learnedItemId, {
        version: current.version,
      });
    if ('candidateId' in current)
      add(path, 'learning_candidates', current.candidateId, {
        version: current.version,
      });
    if ('evaluationId' in current)
      add(path, 'evaluations', current.evaluationId, {
        version: current.version,
      });
    if ('proposalId' in current) {
      const bounds = object(approvalBounds) ? approvalBounds : {};
      add(path, 'action_proposals', current.proposalId, {
        version: current.proposalVersion,
        binding: current,
        sessionId: bounds.sessionId,
        boundTaskId: bounds.taskId,
      });
    }
    const eventKeys = [
      'eventId',
      'sourceEventId',
      'promotionEventId',
      'rejectionEventId',
      'revocationEventId',
    ];
    for (const key of eventKeys) {
      if (!(key in current)) continue;
      const transitionType =
        typeof current.kind === 'string'
          ? transitionEvents[current.kind]
          : undefined;
      const eventType =
        key === 'eventId' && transitionType
          ? transitionType
          : key === 'promotionEventId'
            ? 'learning_promoted'
            : key === 'rejectionEventId'
              ? 'learning_rejected'
              : key === 'revocationEventId' &&
                  current.kind === 'learning_rollback'
                ? 'learning_revoked'
                : key === 'eventId' && current.status === 'superseded'
                  ? 'learning_superseded'
                  : key === 'eventId' && current.status === 'revoked'
                    ? 'learning_revoked'
                    : null;
      add(`${path}.${key}`, 'experience_events', current[key], {
        version: 1,
        eventType,
      });
    }
    if ('taskId' in current)
      add(`${path}.taskId`, 'tasks', current.taskId, {
        sessionId: current.sessionId,
      });
    if ('sessionId' in current)
      add(`${path}.sessionId`, 'sessions', current.sessionId);
    if ('decisionId' in current)
      add(`${path}.decisionId`, 'policy_decisions', current.decisionId, {
        binding: current.proposal,
        decision: current.decision,
      });
    if ('executionId' in current)
      add(`${path}.executionId`, 'tool_executions', current.executionId);
    for (const key of ['approvalIds', 'priorApprovalIds']) {
      const ids = current[key];
      if (Array.isArray(ids))
        ids.forEach((id, i) =>
          add(`${path}.${key}[${i}]`, 'owner_approvals', id),
        );
    }
    if (Array.isArray(current.evidenceIds))
      current.evidenceIds.forEach((id, i) =>
        add(`${path}.evidenceIds[${i}]`, 'evidence', id, {
          version: 1,
          eventId: current.id,
        }),
      );
    for (const [key, entry] of Object.entries(current))
      walk(
        entry,
        `${path}.${key}`,
        current.kind === 'owner_state' && key === 'reference'
          ? 'owner_state'
          : 'learned_owner_state',
        current.kind === 'owner_approval' && key === 'proposal'
          ? current.bounds
          : undefined,
      );
  }
  walk(value, '$');
  return result;
}
