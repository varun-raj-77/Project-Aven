// All identifiers, texts, locators, digests and policies in this file are
// SYNTHETIC test data; none describes a real owner, tool or permission.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import {
  ROOT_POLICY_DEFINITION_FORMAT,
  ROOT_V1_REFERENCE_RISK_TABLE,
  RootPolicyError,
  createRootPolicy,
  revalidateProposal,
  type RootPolicy,
  type RootPolicyErrorCode,
} from '../src/index.ts';
import {
  createSyntheticApprovalChannel,
  type SyntheticApprovalChannel,
} from '../src/testing/index.ts';

export const ownerId = 'owner_synthetic';
export const sessionId = 'session_synthetic';
export const taskId = 'task_synthetic';
export const createdAt = '2026-10-14T09:00:00Z';
export const evaluatedAt = '2026-10-14T09:05:00Z';
export const context = Object.freeze({ ownerId, sessionId, taskId });

/** Fresh deep copy of plain JSON data. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A complete AVEN-011 v1 proposal (low-risk sandbox note), written out. */
export function proposal(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'action_proposal',
    ownerId,
    metadata: {
      schemaVersion: 1,
      recordVersion: 1,
      createdAt,
      creation: {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
      },
    },
    id: 'proposal_synthetic',
    task: { sessionId, taskId },
    toolId: 'synthetic-sandbox-tool',
    action: 'append_note',
    parameters: {
      kind: 'immutable_reference',
      artifact: {
        locator: 'synthetic:parameters',
        digest: { algorithm: 'sha256', value: 'b'.repeat(64) },
      },
    },
    target: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
    consequences: {
      risk: 'low',
      reversibility: 'reversible',
      description: 'Append a synthetic note in the sandbox.',
    },
    requestedAuthority: [
      {
        operation: 'modify',
        resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
      },
    ],
    priorApprovalIds: [],
    ...overrides,
  };
}

/** A proposal for another catalogued action, with matching authority. */
export function proposalFor(
  toolId: string,
  action: string,
  operation: string,
  target: { kind: string; identifier: string },
  consequences: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return proposal({
    toolId,
    action,
    target,
    requestedAuthority: [{ operation, resource: { ...target } }],
    consequences: {
      risk: 'low',
      reversibility: 'reversible',
      description: `Synthetic ${action}.`,
      ...consequences,
    },
    ...overrides,
  });
}

/** Catalogued synthetic proposals by Root risk. */
export const medium = () =>
  proposalFor(
    'synthetic-docs',
    'edit_document',
    'modify',
    { kind: 'document', identifier: 'synthetic-doc' },
    { risk: 'medium', reversibility: 'partially_reversible' },
  );
export const high = () =>
  proposalFor(
    'synthetic-mail',
    'send_message',
    'send',
    { kind: 'message', identifier: 'synthetic-message' },
    { risk: 'high', reversibility: 'irreversible' },
  );

/** The synthetic Root policy definition used by most tests. */
export function definition(overrides: Record<string, unknown> = {}) {
  return {
    format: ROOT_POLICY_DEFINITION_FORMAT,
    policyVersion: 'synthetic-root-policy-v1',
    approvalAuthentication: 'unavailable',
    highRisk: 'require_owner_approval',
    approvalMaxAgeSeconds: 3600,
    riskTable: ROOT_V1_REFERENCE_RISK_TABLE.map((entry) => ({ ...entry })),
    actions: [
      {
        toolId: 'synthetic-sandbox-tool',
        action: 'append_note',
        operation: 'modify',
        resourceKind: 'sandbox_resource',
        reversibility: 'reversible',
      },
      {
        toolId: 'synthetic-sandbox-tool',
        action: 'draft',
        operation: 'draft',
        resourceKind: 'sandbox_resource',
        reversibility: 'reversible',
      },
      {
        toolId: 'synthetic-docs',
        action: 'edit_document',
        operation: 'modify',
        resourceKind: 'document',
        reversibility: 'partially_reversible',
      },
      {
        toolId: 'synthetic-mail',
        action: 'send_message',
        operation: 'send',
        resourceKind: 'message',
        reversibility: 'irreversible',
      },
      {
        toolId: 'synthetic-files',
        action: 'read_file',
        operation: 'read',
        resourceKind: 'file',
        reversibility: 'reversible',
      },
    ],
    grants: [
      {
        grantId: 'grant_sandbox_notes',
        ownerId,
        toolId: 'synthetic-sandbox-tool',
        action: 'append_note',
        resource: { kind: 'sandbox_resource', identifier: 'synthetic-notes' },
        scope: { kind: 'task', sessionId, taskId },
        validFrom: '2026-10-14T00:00:00Z',
        validUntil: '2026-10-15T00:00:00Z',
      },
    ],
    ...overrides,
  };
}

export const policy = (overrides: Record<string, unknown> = {}): RootPolicy =>
  createRootPolicy(definition(overrides));

/** A synthetic-authentication policy and its test channel. */
export function syntheticPolicy(overrides: Record<string, unknown> = {}): {
  readonly policy: RootPolicy;
  readonly channel: SyntheticApprovalChannel;
} {
  const channel = createSyntheticApprovalChannel();
  return {
    channel,
    policy: createRootPolicy(
      definition({
        approvalAuthentication: 'synthetic_test_only',
        ...overrides,
      }),
      channel.authenticator,
    ),
  };
}

/** Root's recomputed binding of a proposal for its own owner and task. */
export function bindingOf(candidate: Record<string, unknown> = proposal()) {
  const task = candidate.task as { sessionId: string; taskId: string };
  return clone(
    revalidateProposal(candidate, {
      ownerId: candidate.ownerId,
      sessionId: task.sessionId,
      taskId: task.taskId,
    }).binding,
  );
}

/** An issued owner approval exactly bound to a proposal (synthetic). */
export function approval(
  candidate: Record<string, unknown> = proposal(),
  overrides: Record<string, unknown> = {},
) {
  const id = (overrides.id as string | undefined) ?? 'approval_synthetic';
  const eventId = `event_${id}`;
  return {
    kind: 'owner_approval',
    ownerId,
    metadata: {
      schemaVersion: 1,
      recordVersion: 1,
      createdAt: '2026-10-14T09:01:00Z',
      creation: { component: 'synthetic-owner-interface', version: 'v1' },
    },
    id,
    proposal: bindingOf(candidate),
    bounds: clone(candidate.task),
    issuedAt: '2026-10-14T09:01:00Z',
    expiresAt: '2026-10-14T10:01:00Z',
    evidence: { evidenceId: `evidence_${id}`, eventId },
    provenance: { kind: 'owner_approval', ownerId, sourceEventId: eventId },
    lifecycle: { status: 'issued' },
    ...overrides,
  };
}

/** A later revoked version of an approval (its own event and evidence). */
export function revoked(
  issued: ReturnType<typeof approval>,
  revokedAt = '2026-10-14T09:02:00Z',
) {
  const eventId = `${issued.evidence.eventId}_revocation`;
  return {
    ...clone(issued),
    metadata: { ...clone(issued.metadata), recordVersion: 2 },
    evidence: { evidenceId: `${issued.evidence.evidenceId}_r`, eventId },
    provenance: { kind: 'owner_approval', ownerId, sourceEventId: eventId },
    lifecycle: {
      status: 'revoked',
      revokedAt,
      revocationEventId: eventId,
      reason: 'Synthetic revocation.',
    },
  };
}

/** A valid evaluation input for the default proposal. */
export function input(overrides: Record<string, unknown> = {}) {
  return {
    ownerId,
    sessionId,
    taskId,
    proposal: proposal(),
    decisionId: 'decision_synthetic',
    evaluatedAt,
    approvals: [],
    ...overrides,
  };
}

export function expectRootError(
  run: () => unknown,
  code: RootPolicyErrorCode,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RootPolicyError);
  expect((thrown as RootPolicyError).code).toBe(code);
  expect((thrown as RootPolicyError).outcome).toBe('not_written');
  expect((thrown as Error).cause).toBeUndefined();
}

export interface DigestVector {
  readonly name: string;
  readonly proposal: Record<string, unknown>;
  readonly canonical: string;
  readonly digest: string;
  readonly plainSha256OfCanonical: string;
}
/**
 * The frozen AVEN-011 golden digest vectors, read as data (never imported
 * as code): Root's independent digest must reproduce every one of them.
 */
export const AVEN_011_VECTORS_URL = new URL(
  '../../action-proposals/test/digest-vectors.json',
  import.meta.url,
);
export const vectorFile = JSON.parse(
  readFileSync(AVEN_011_VECTORS_URL, 'utf8'),
) as {
  readonly protocol: string;
  readonly vectors: readonly DigestVector[];
  readonly rejected: readonly {
    readonly name: string;
    readonly proposal: Record<string, unknown>;
  }[];
};

/** True when every nested object and array is frozen. */
export const deeplyFrozen = (value: unknown): boolean =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
