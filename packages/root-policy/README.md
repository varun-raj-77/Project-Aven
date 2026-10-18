# @aven/root-policy

AVEN-012 Root Policy Gateway: the pure Root policy engine (Patch 2) and Root
over recorded history, with audited decision recording (Patch 3), exercised by
an adversarial campaign (Patch 4; see
[the AVEN-012 report](../../docs/AVEN_012_REPORT.md)). Version
`aven-012-root-policy-v1`. Aven proposes; Root decides.

Given a Root-controlled policy and an AVEN-011 action proposal, Root revalidates
the proposal, recomputes its exact binding and returns a frozen AVEN-002
`PolicyDecision`: `ALLOW`, `DENY` or `REQUIRE_OWNER_APPROVAL`. The package
reuses the frozen AVEN-002 contracts (`ActionProposalSchema`,
`ProposalBindingSchema`, `PolicyDecisionSchema`, `OwnerApprovalSchema`)
unchanged; it defines no second action, approval or decision schema.

**What it is not.** The pure entry reads no storage, clock or network. The only
write in the package is one frozen Ledger append of a `policy_decision` event.
Nothing generates identifiers, calls a model, executes a tool, writes owner
state or learns. A decision is not an execution. This is an in-process
prototype: package and module separation is not OS-level security isolation, and
it has no real owner authentication.

## Entries

| Entry                       | Depends on                                                             | Contents                                                                    |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@aven/root-policy`         | `@aven/contracts`, `zod`, `node:crypto` (SHA-256), `node:util` (Proxy) | Policy validation, proposal revalidation, approval verification, evaluation |
| `@aven/root-policy/ledger`  | adds `@aven/ledger`, `@aven/storage`                                   | Root gateway, read-only evaluation of recorded proposals, decision recorder |
| `@aven/root-policy/testing` | the same as the root entry                                             | `createSyntheticApprovalChannel` (synthetic test capability only)           |

Root never depends on `@aven/action-proposals` (a frozen AVEN-011 tripwire
forbids any other package from depending on it, and Root should not depend on
the proposing side). It re-implements the AVEN-011 v1 rules and digest protocol
and is pinned to the same results by the AVEN-011 golden digest vectors, which
its tests read as data.

## Trusted and untrusted inputs

| Input                                                                                  | Trust                                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Policy definition (risk table, catalog, grants, high-risk mode, approval age, version) | Root configuration, registered by identity           |
| Approval authentication capability                                                     | Root-held; only a synthetic test capability exists   |
| Evaluation time                                                                        | Root host: the gateway's Root clock                  |
| Proposal: requested authority, declared risk/reversibility, cited approvals, all texts | Untrusted model output; revalidated, never authority |
| Decision identifier                                                                    | Caller-allocated; no authority                       |
| Approval records                                                                       | Untrusted; each must pass every verification check   |

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

## Recorded proposals and decision recording (`./ledger`)

`createRootGateway({ policy, clock, recordingWindowSeconds? })` is Root host
configuration: a registered policy, the Root clock (the only source of
evaluation time) and the recording window (default 60 seconds, at most 3600).
Gateways, like policies, are recognised by identity.

`evaluateRecordedProposal(gateway, storage, { ownerId, proposalEventId, decisionId })`
is read-only. Inside one deferred SQLite read transaction it reads, owner-scoped
and with pinned statements, the `action_proposed` event, its frozen projection
(which must equal the payload) and its declared digest (which must equal Root's
recomputation), and every stored version of every approval bound to the
proposal's identifier and version, including versions that name another binding
(so a revocation recorded with another binding is still found). Each approval
version must come from its own `owner_approval` event with an identical payload.
More than 64 approval records, or more than 64 versions of one approval, is
refused rather than truncated. Anything inconsistent is `invalid_history`. It
then evaluates with the pure engine at the Root clock's time. The request cannot
supply a proposal, approvals, grants, a policy, a time, a risk or an outcome.
Earlier policy decisions are never read as input: a recorded ALLOW, including
one appended beside Root, grants nothing.

`recordRootDecision(gateway, storage, evaluation, { eventId })` records one
evaluation produced by the same gateway from the same storage connection
(recognised by identity; a decision object, a copy, a pure-engine evaluation or
another gateway's evaluation is `untrusted_evaluation`) as exactly one frozen
`policy_decision` event through one frozen `appendEvent`:

- envelope task: the proposal's task; `occurredAt` and `metadata.createdAt`: the
  evaluation time; creation `@aven/root-policy` / `aven-012-root-policy-v1`;
- provenance `system_generated` by `@aven/root-policy`, derived from the
  evidence of the approvals an approval-based ALLOW relied on;
- on entry, the Root clock is read once and must lie within
  `[evaluatedAt, evaluatedAt + window]`, otherwise `stale_evaluation`. This is
  an entry-time check of the evaluation's age only: it does not bound the time
  the prechecks and the append then take, and the Root clock is not read again;
- read-only prechecks, in one snapshot: owner, task, the exact recorded proposal
  binding, derivation evidence, unused decision and event identifiers, and, for
  an approval-based ALLOW, each relied-on approval's complete current version
  history: more than 64 versions is `invalid_history` (an incomplete history is
  never taken as proof of no revocation), and any version that is not `issued`,
  or any version set other than exactly the one evaluated, is
  `stale_evaluation`.

The Ledger checks the exact proposal binding again at COMMIT. Outcomes follow
AVEN-011: `not_written`, `rolled_back` (for the checks the Ledger raises in its
open transaction) or `unknown` (every storage failure, including a COMMIT that
fails or takes effect and then raises). Measured row deltas of one recording: +1
`experience_events`, +1 `policy_decisions`, +2 `record_keys`, +2
`record_versions`, +4 `record_references`, nothing else.

`reconcileRootDecisionRecording(storage, evaluation, { eventId })` only reads:
it compares the full stored event (except `recordedAt` and `sequence`) with what
the recorder would have written for the evaluation (the original object or plain
data copied from it) and returns `recorded`, `not_recorded`, `conflict` or
`unresolved` with a code. After `unknown`: close the connection, reopen,
reconcile, and only after `not_recorded` evaluate again and record.

Limits: there is no exactly-once guarantee (a direct frozen-Ledger append can
re-observe an identical decision under a second event identifier); a revocation
committed after the recorder's precheck snapshot and before the Ledger's write
lock is not seen, and nothing bounds that interval (the recording window is
checked only on entry); the Root clock must not run ahead of the Ledger's
recording clock; and a recorded decision is a claim about one evaluation at its
evaluation time, never a standing or current execution permission, since any
code with storage access can append a `policy_decision` event.

## Errors

`RootPolicyError` has fixed codes and messages and no `cause`. Every error fails
closed: it is never a decision and never a permission. The pure entry and the
gateway never write, so their errors are always `not_written`; the recorder's
errors carry the storage outcome.

## Tests

`pnpm --filter @aven/root-policy test` runs this package's tests on synthetic
data, including the AVEN-011 golden digest vectors, in-memory and file-backed
SQLite through the frozen storage and Ledger, injected COMMIT and read faults,
the adversarial campaign (forged, replayed, stale, expired and revoked
approvals; approval history at and beyond the 64-version bound; declared-risk
lies; cross-owner and cross-task references; digest mismatches; unknown
operations; policy version changes; hostile text), a fresh-process `query_only`
replay, a seeded invariant sweep with an independent approval oracle, and static
boundary tripwires (pattern checks, not security proofs). Tests that spawn a
process, use file-backed SQLite or sweep thousands of cases carry explicit
timeouts instead of the 5-second default.
