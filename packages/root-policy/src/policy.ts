import { z } from 'zod';
import {
  NonEmptyTextSchema,
  OwnerIdSchema,
  RequestedAuthoritySchema,
  ResourceTargetSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
} from '@aven/contracts';
import {
  isApprovalAuthenticator,
  type ApprovalAuthenticator,
} from './authentication.ts';
import {
  canonicalText,
  taggedSha256,
  wellFormedThroughout,
} from './canonical.ts';
import {
  ROOT_POLICY_CONFIG,
  ROOT_POLICY_DEFINITION_FORMAT,
  ROOT_POLICY_DIGEST_PROTOCOL,
  deepFreeze,
} from './config.ts';
import { fail, rethrow } from './errors.ts';
import { inertCopy } from './inert.ts';
import { changesLearnedState } from './proposal.ts';
import { compareTimestamps } from './timestamps.ts';

/**
 * Root policy definitions (AVEN-012): Root-controlled configuration.
 *
 * A definition says what Root knows and permits, independently of any
 * proposal: the risk Root itself assigns to every (operation, resource kind)
 * pair, the catalog of tool actions it recognises and the single effect each
 * one really has, how high-risk operations are treated, how old an approval
 * may be, which approval authentication is available, and the
 * least-privilege grants that may allow low-risk actions. Nothing in it can
 * come from a proposal. `createRootPolicy` validates a definition against the
 * Root invariants, deep-freezes it, computes its policy digest and registers
 * the result by identity; only registered policies are evaluated.
 *
 * Root invariants (a violation is `invalid_policy`, so nothing is evaluated):
 *  - each (operation, resource kind) is classified at most once, and any
 *    operation that would change learned owner state is `forbidden`;
 *  - each (tool, action) is catalogued once, with a classified effect that
 *    does not change learned owner state, and an irreversible action is
 *    never classified low risk;
 *  - each grant names a catalogued action of low risk, exactly one resource
 *    of that action's kind, one owner, an owner/session/task scope and a
 *    non-empty validity window; grant identifiers are unique;
 *  - `synthetic_test_only` approval authentication requires the synthetic
 *    test capability, and `unavailable` forbids passing one.
 */

const PolicyNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/, 'Lowercase policy version token');
const CatalogTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 'Tool or action token');
const GrantIdSchema = z
  .string()
  .regex(/^grant_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'Grant identifier');
const OperationSchema = RequestedAuthoritySchema.shape.operation;
const ResourceKindSchema = ResourceTargetSchema.shape.kind;
export const RootRiskSchema = z.enum(['low', 'medium', 'high', 'forbidden']);
const ReversibilitySchema = z.enum([
  'reversible',
  'partially_reversible',
  'irreversible',
]);

const RiskEntrySchema = z.strictObject({
  operation: OperationSchema,
  resourceKind: ResourceKindSchema,
  risk: RootRiskSchema,
});
const ActionEntrySchema = z.strictObject({
  toolId: CatalogTokenSchema,
  action: CatalogTokenSchema,
  operation: OperationSchema,
  resourceKind: ResourceKindSchema,
  reversibility: ReversibilitySchema,
});
const GrantScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner') }),
  z.strictObject({ kind: z.literal('session'), sessionId: SessionIdSchema }),
  z.strictObject({
    kind: z.literal('task'),
    sessionId: SessionIdSchema,
    taskId: TaskIdSchema,
  }),
]);
const GrantSchema = z.strictObject({
  grantId: GrantIdSchema,
  ownerId: OwnerIdSchema,
  toolId: CatalogTokenSchema,
  action: CatalogTokenSchema,
  resource: z.strictObject({
    kind: ResourceKindSchema,
    identifier: NonEmptyTextSchema,
  }),
  scope: GrantScopeSchema,
  validFrom: TimestampSchema,
  validUntil: TimestampSchema,
});
const DefinitionSchema = z.strictObject({
  format: z.literal(ROOT_POLICY_DEFINITION_FORMAT),
  policyVersion: PolicyNameSchema,
  approvalAuthentication: z.enum(['unavailable', 'synthetic_test_only']),
  highRisk: z.enum(['require_owner_approval', 'deny']),
  approvalMaxAgeSeconds: z
    .number()
    .int()
    .min(1)
    .max(ROOT_POLICY_CONFIG.limits.maxApprovalAgeSeconds),
  riskTable: z.array(RiskEntrySchema).max(64),
  actions: z.array(ActionEntrySchema).max(256),
  grants: z.array(GrantSchema).max(256),
});

export type RootRisk = z.infer<typeof RootRiskSchema>;
export type RootPolicyDefinition = z.infer<typeof DefinitionSchema>;
export type RootPolicyGrant = z.infer<typeof GrantSchema>;
export type RootPolicyAction = z.infer<typeof ActionEntrySchema>;

/** The public, deep-frozen view of a registered Root policy. */
export interface RootPolicy {
  readonly kind: 'root_policy';
  readonly policyVersion: string;
  readonly policyDigest: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly approvalAuthentication: 'unavailable' | 'synthetic_test_only';
  readonly definition: Readonly<RootPolicyDefinition>;
}

/** What evaluation needs; never exported from the package entry. */
export interface PolicyInternals {
  readonly policy: RootPolicy;
  readonly definition: Readonly<RootPolicyDefinition>;
  readonly risk: ReadonlyMap<string, RootRisk>;
  readonly actions: ReadonlyMap<string, Readonly<RootPolicyAction>>;
  readonly grants: readonly Readonly<RootPolicyGrant>[];
  readonly authenticator: ApprovalAuthenticator | null;
}

const REGISTRY = new WeakMap<object, PolicyInternals>();

/** Joins two tokens with a separator no token can contain. */
export const pairKey = (a: string, b: string): string => a + '\u0000' + b;

function invariant(condition: boolean): void {
  if (!condition) fail('invalid_policy');
}

/**
 * Validates a definition against the Root invariants and registers the
 * resulting policy. `approvalAuthenticator` must be the authenticator of a
 * synthetic channel when, and only when, the definition declares
 * `synthetic_test_only` approval authentication; it is recognised by
 * identity only (no property of it is read).
 */
export function createRootPolicy(
  definition: unknown,
  approvalAuthenticator?: unknown,
): RootPolicy {
  try {
    const authenticator = approvalAuthenticator;
    if (authenticator !== undefined && !isApprovalAuthenticator(authenticator))
      fail('untrusted_capability');

    const inert = inertCopy(definition, ROOT_POLICY_CONFIG.limits.policy);
    if (inert === undefined || !wellFormedThroughout(inert.copy))
      return fail('invalid_policy');
    const parsed = DefinitionSchema.safeParse(inert.copy);
    if (!parsed.success) return fail('invalid_policy');
    const d = parsed.data;

    invariant(
      (d.approvalAuthentication === 'synthetic_test_only') ===
        (authenticator !== undefined),
    );

    const risk = new Map<string, RootRisk>();
    for (const entry of d.riskTable) {
      const key = pairKey(entry.operation, entry.resourceKind);
      invariant(!risk.has(key));
      invariant(
        !changesLearnedState(entry.operation, entry.resourceKind) ||
          entry.risk === 'forbidden',
      );
      risk.set(key, entry.risk);
    }
    const actions = new Map<string, RootPolicyAction>();
    for (const entry of d.actions) {
      const key = pairKey(entry.toolId, entry.action);
      invariant(!actions.has(key));
      invariant(!changesLearnedState(entry.operation, entry.resourceKind));
      const classified = risk.get(pairKey(entry.operation, entry.resourceKind));
      invariant(classified !== undefined);
      invariant(
        !(classified === 'low' && entry.reversibility === 'irreversible'),
      );
      actions.set(key, entry);
    }
    const grantIds = new Set<string>();
    for (const grant of d.grants) {
      invariant(!grantIds.has(grant.grantId));
      grantIds.add(grant.grantId);
      invariant(compareTimestamps(grant.validFrom, grant.validUntil) === -1);
      const action = actions.get(pairKey(grant.toolId, grant.action));
      invariant(action !== undefined);
      invariant(action!.resourceKind === grant.resource.kind);
      invariant(
        risk.get(pairKey(action!.operation, action!.resourceKind)) === 'low',
      );
    }

    const text = canonicalText(d);
    if (text === undefined) return fail('invalid_policy');
    const frozen = deepFreeze(d);
    const policy: RootPolicy = deepFreeze({
      kind: 'root_policy' as const,
      policyVersion: frozen.policyVersion,
      policyDigest: {
        algorithm: 'sha256' as const,
        value: taggedSha256(ROOT_POLICY_DIGEST_PROTOCOL, text),
      },
      approvalAuthentication: frozen.approvalAuthentication,
      definition: frozen,
    });
    REGISTRY.set(policy, {
      policy,
      definition: frozen,
      risk,
      actions,
      grants: frozen.grants,
      authenticator:
        frozen.approvalAuthentication === 'synthetic_test_only'
          ? (authenticator as ApprovalAuthenticator)
          : null,
    });
    return policy;
  } catch (error) {
    return rethrow(error);
  }
}

/** The internals of a registered policy, or `untrusted_policy`. */
export function policyInternals(policy: unknown): PolicyInternals {
  const internals =
    typeof policy === 'object' && policy !== null
      ? REGISTRY.get(policy)
      : undefined;
  return internals ?? fail('untrusted_policy');
}

const OPERATIONS = OperationSchema.options;
const KINDS = ResourceKindSchema.options;

/**
 * Root's v1 reference classification of every (operation, resource kind)
 * pair: reads and drafts are low; creating or modifying owner documents,
 * files and messages is medium; deleting, sending and publishing them is
 * high; inside a sandbox, creating and modifying are low and deleting is
 * medium; reading learned state is medium (it exposes owner state); every
 * learned-state change and learning-lifecycle operation is forbidden. It is
 * a reference table for definitions to adopt, not a grant of anything.
 */
export const ROOT_V1_REFERENCE_RISK_TABLE: readonly Readonly<
  z.infer<typeof RiskEntrySchema>
>[] = deepFreeze(
  OPERATIONS.flatMap((operation) =>
    KINDS.map((resourceKind) => {
      let level: RootRisk;
      if (changesLearnedState(operation, resourceKind)) level = 'forbidden';
      else if (resourceKind === 'learned_state') level = 'medium';
      else if (operation === 'read' || operation === 'draft') level = 'low';
      else if (resourceKind === 'sandbox_resource')
        level =
          operation === 'create' || operation === 'modify'
            ? 'low'
            : operation === 'delete'
              ? 'medium'
              : 'high';
      else
        level =
          operation === 'create' || operation === 'modify' ? 'medium' : 'high';
      return { operation, resourceKind, risk: level };
    }),
  ),
);

/**
 * The denial fallback: Root's reference classification with an empty catalog
 * and no grants, so every proposal is DENY (`action_not_in_policy`). A host
 * without a valid, reviewed policy uses this.
 */
export const ROOT_DENY_ALL_POLICY_DEFINITION: Readonly<RootPolicyDefinition> =
  deepFreeze({
    format: ROOT_POLICY_DEFINITION_FORMAT,
    policyVersion: 'aven-012-deny-all-v1',
    approvalAuthentication: 'unavailable' as const,
    highRisk: 'deny' as const,
    approvalMaxAgeSeconds: 3600,
    riskTable: ROOT_V1_REFERENCE_RISK_TABLE.map((entry) => ({ ...entry })),
    actions: [],
    grants: [],
  });
