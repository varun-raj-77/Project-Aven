# @aven/root-policy

AVEN-012 Root Policy Gateway, Patch 2: the pure Root policy engine. Version
`aven-012-root-policy-v1`. Aven proposes; Root decides.

Given a Root-controlled policy and an AVEN-011 action proposal, Root revalidates
the proposal, recomputes its exact binding and returns a frozen AVEN-002
`PolicyDecision`: `ALLOW`, `DENY` or `REQUIRE_OWNER_APPROVAL`. The package
reuses the frozen AVEN-002 contracts (`ActionProposalSchema`,
`ProposalBindingSchema`, `PolicyDecisionSchema`, `OwnerApprovalSchema`)
unchanged; it defines no second action, approval or decision schema.

**What it is not.** It records nothing (decision recording is the next patch),
reads no storage, clock or network, generates no identifiers, calls no model,
executes no tool, writes no owner state and learns nothing. A decision is not an
execution. This is an in-process prototype: package and module separation is not
OS-level security isolation, and it has no real owner authentication.

## Entries

| Entry                       | Depends on                                                             | Contents                                                                    |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@aven/root-policy`         | `@aven/contracts`, `zod`, `node:crypto` (SHA-256), `node:util` (Proxy) | Policy validation, proposal revalidation, approval verification, evaluation |
| `@aven/root-policy/testing` | the same                                                               | `createSyntheticApprovalChannel` (synthetic test capability only)           |

Root never depends on `@aven/action-proposals` (a frozen AVEN-011 tripwire
forbids any other package from depending on it, and Root should not depend on
the proposing side). It re-implements the AVEN-011 v1 rules and digest protocol
and is pinned to the same results by the AVEN-011 golden digest vectors, which
its tests read as data.

## Trusted and untrusted inputs

| Input                                                                                  | Trust                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Policy definition (risk table, catalog, grants, high-risk mode, approval age, version) | Root configuration, registered by identity             |
| Approval authentication capability                                                     | Root-held; only a synthetic test capability exists     |
| Evaluation time                                                                        | Root host (the gateway's Root clock in the next patch) |
| Proposal: requested authority, declared risk/reversibility, cited approvals, all texts | Untrusted model output; revalidated, never authority   |
| Decision identifier                                                                    | Caller-allocated; no authority                         |
| Approval records                                                                       | Untrusted; each must pass every verification check     |

`createRootPolicy(definition, approvalAuthenticator?)` validates a definition
against the Root invariants, deep-freezes it, computes its policy digest
(SHA-256 over `AVEN-012-ROOT-POLICY-DIGEST-V1`, a NUL byte and the canonical
JSON of the definition) and registers the result. `evaluateActionProposal`
accepts only registered policies: a copy or look-alike is `untrusted_policy`.
The decision's `issuer` (`kind: 'root'`, `policyVersion`, `policyDigest`) comes
only from the registered policy.

Root invariants (otherwise `invalid_policy`): each (operation, resource kind)
classified once and every learned-state change `forbidden`; each (tool, action)
catalogued once with one classified, non-learning effect, never an irreversible
low-risk action; each grant for one catalogued **low-risk** action, one exact
resource, one owner, an owner, session or task scope and a non-empty validity
window; `synthetic_test_only` authentication exactly when the synthetic
capability is supplied.

`ROOT_V1_REFERENCE_RISK_TABLE` is Root's reference classification (reads and
drafts low; creating or modifying documents, files and messages medium;
deleting, sending and publishing them high; sandbox create and modify low,
sandbox delete medium; reading learned state medium; learned-state changes and
learning operations forbidden). `ROOT_DENY_ALL_POLICY_DEFINITION` is the denial
fallback: an empty catalog, so every proposal is `DENY`.

## Evaluation rules

In order; the first that applies decides:

1. Proposal created after Root's evaluation time: `DENY`.
2. (tool, action) not in Root's catalog: `DENY`.
3. Target of another kind than the catalogued effect, or requested authority not
   exactly that one effect on that target: `DENY`.
4. An effect that would change learned owner state: `DENY`.
5. Effect unclassified or `forbidden`: `DENY`.
6. Effective risk: Root's classification, raised (never lowered) by the declared
   risk (`unknown` counts as high) and by a declared reversibility worse than
   the catalog's (at least medium).
7. High risk under `highRisk: 'deny'`: `DENY`.
8. Low risk and a matching, current, in-scope Root grant: `ALLOW` with basis
   `existing_grant` (`<policyVersion>#<grantId>`).
9. Any verified owner approval: `ALLOW` with basis `owner_approval`.
10. Otherwise: `REQUIRE_OWNER_APPROVAL`, with a requirement naming the exact
    binding and task.

A proposal that is not a valid AVEN-011 v1 proposal, or belongs to another
owner, session or task, is not evaluated at all (`invalid_proposal`,
`binding_mismatch`). Cited `priorApprovalIds` are never authority (reason
`cited_approvals_not_authority`).

## Approvals and authentication

An approval is verified only when every version names this owner, exactly this
binding (proposal identifier, version, proposal digest and parameters digest)
and exactly this task; its versions agree and none is revoked; it was issued no
earlier than the proposal's creation and not after Root's evaluation time, is
unexpired and is no older than the policy's maximum approval age; and a
Root-held authentication capability vouches for it.

AVEN-012 has no real owner authentication. With
`approvalAuthentication: 'unavailable'` no approval is ever verified, so
approval-based `ALLOW` is impossible. The only capability is the synthetic test
channel from `@aven/root-policy/testing`: its `attest` hook stands in for a
future authenticated owner interface in tests. A policy using it declares
`approvalAuthentication: 'synthetic_test_only'` in its digested definition and
every decision relying on it carries
`approval_authenticated_by_synthetic_test_capability`. It authenticates nobody.

## Parameters and execution

Root binds the declared parameters digest into every decision but never sees the
parameter bytes (`parameters.content: 'not_inspected'`). Every evaluation says
`executes: false` and
`executionRequirement: 'recheck_parameter_bytes_and_root_decision_at_execution'`:
a future executor (AVEN-013) must hash the real parameter bytes at use and must
not treat an earlier decision as a standing permission.

## Errors

`RootPolicyError` has fixed codes and messages and no `cause`. Every error fails
closed: it is never a decision and never a permission. The pure entry's errors
are always `not_written`.

## Tests

`pnpm --filter @aven/root-policy test` runs this package's tests on synthetic
data, including the AVEN-011 golden digest vectors and static boundary tripwires
(pattern checks, not security proofs).
