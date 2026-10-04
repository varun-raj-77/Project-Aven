# @aven/contracts

AVEN-002 defines shared TypeScript types and strict Zod serialization
boundaries. It implements no Aven runtime. The AVEN-001 architecture and EXP-001
protocol remain unchanged. No AVEN-003 work is included.

This private ESM workspace exports TypeScript source from `src/index.ts` for the
repository's Node.js 24 / TypeScript toolchain. Zod is its only runtime
dependency. There is no emitted distribution, database type, provider SDK, or
framework adapter.

```ts
import { ActionProposalSchema, type ActionProposal } from '@aven/contracts';

// `input` is untrusted boundary data supplied by the caller.
const proposal: ActionProposal = ActionProposalSchema.parse(input);
// Parsing represents a proposal. It does not grant authority to execute it.
```

## Module inventory and guarantees

| Module            | Contracts and protected distinction                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`          | Sixteen branded, domain-prefixed ID schemas/types, including the thirteen requested IDs plus context, model call, and evaluation test IDs.                      |
| `common.ts`       | Schema/record versions, creation and runtime stamps, ISO timestamps, owner/task bounds, immutable artifact digests, versioned references.                       |
| `provenance.ts`   | Seven distinct origins, recorded evidence, support assessments, source lineage, inference certainty, owner confirmation. Origin is not truth or authentication. |
| `scope.ts`        | Unknown, uncertain, bounded, and intentionally global scope; structured domain/task boundaries and optional qualifiers.                                         |
| `owner-state.ts`  | Separate fact, preference, episode, intent-pattern, and procedure content; durable lifecycle; separate task-bound active state.                                 |
| `corrections.ts`  | Seven correction categories; original behavior, target, new instruction, source evidence, immediate applicability, and durable scope hint.                      |
| `context.ts`      | Task-specific selected references with observable inclusion metadata; current instructions and trusted learned guidance remain distinct.                        |
| `runtime.ts`      | Provider/model/version/configuration identifiers, request purpose, response status, optional usage; no adapter or model-owned identity.                         |
| `actions.ts`      | Proposal, requested authority, resource, consequence assessment, prior approval references, and immutable parameter reference.                                  |
| `policy.ts`       | Exactly ALLOW, DENY, REQUIRE_OWNER_APPROVAL; Root issuer metadata, reason codes, proposal binding, and explicit ALLOW basis.                                    |
| `approvals.ts`    | Owner-origin approval with exact proposal/version/digest, task/session, issuance, expiry, and explicit revocation.                                              |
| `execution.ts`    | Not attempted versus attempted; reported success, failure, or unknown result; exact policy/proposal reference.                                                  |
| `verification.ts` | Separate VERIFIED, FAILED, INCONCLUSIVE outcomes with methods and observable evidence. Model assessment can only be inconclusive.                               |
| `evaluation.ts`   | Test definition, split, declared oracle/provenance, actual observation, subject model, scorer, independence assessment, and relative verdict.                   |
| `learning.ts`     | Candidate hypothesis, evidence/counterexamples, proposed scope, generation metadata, evaluation references, lifecycle, or no useful lesson.                     |
| `transitions.ts`  | Promotion, rejection, supersession, revocation, rollback; affected state versions, evidence/evaluations, and Root ALLOW references where required.              |
| `experience.ts`   | Fifteen discriminated historical event variants, including explicit rollback; typed payloads and provenance.                                                    |
| `index.ts`        | Public package exports.                                                                                                                                         |

All domain objects reject unknown keys. None use `any`, generic memory blobs,
untyped parameter maps, or implicit defaults. Types are inferred from schemas.
IDs are strings on the wire with domain prefixes, such as `owner_example` and
`task_example`; their opaque TypeScript brands cannot be interchanged. Prefixes
and a 1-128 character ASCII suffix validate domain syntax, not uniqueness or
identity. Suffix generation is deferred.

Schema version is currently the literal `1`. Mutable derived records carry a
positive safe-integer `metadata.recordVersion`; references bind this version.
Events and raw evidence have record version `1`: a correction creates a new
historical ID. Their schema version is separate from record version. Dates must
be ISO timestamps with UTC or an explicit offset. Creation metadata identifies
the recording component/version, not the truth of recorded material.

## Evidence, learning, and lifecycle semantics

Recorded text and referenced artifacts are evidence of what was recorded. A
`fact` is a scoped assertion believed about a subject, not an objective truth.
Episodes retain original evidence references rather than only a summary.
Procedures contain declarative instructions; parsing never executes them.

Model inferences retain direct `derivedFrom` evidence/event links and explicit
source-coverage uncertainty. External content remains `untrusted`; tool output
remains `potentially_untrusted`. System-generated does not mean trusted. Later
consumers must traverse source lineage, retain taint, resolve conflicts, and
verify owner/source authenticity. The schema rejects direct evidence
self-derivation but does not walk a stored graph or detect indirect cycles.

Evidence signals have these declared meanings:

- Support: `unassessed` means not evaluated; `limited` means cited support
  without an independence claim; `corroborated` requires an explicit assessment
  citing at least two distinct underlying source IDs; `contested` requires
  counterevidence. These labels describe an assessment, not verified strength.
- Source independence: an assessed claim cites underlying root sources and the
  assessment evidence. Repeated summaries do not create root sources. This
  package does not determine whether alleged root sources are actually
  independent.
- Inference certainty: `unassessed`, `tentative`, `supported`, and `disputed`
  describe the interpreter's qualitative assessment; `not_applicable` means
  there is no inference certainty to assess. None is a calibrated probability.
- Owner confirmation: not requested, pending, confirmed, or disputed. Confirmed
  and disputed require owner-origin evidence. Confirmation of a belief or
  preference is separate from action approval.

No confidence score, probability, automatic evidence count, or promotion
threshold is defined. Numeric fields are versions, provider-reported token
counts, or elapsed milliseconds with explicit units; they are not quality
scores.

Durable state can be observed, validated, trusted, superseded, or revoked.
`candidate` lives in `LearningCandidate`, never implicitly in trusted owner
state. A candidate can be under evaluation, evaluated, in shadow, rejected, or
historically promoted; it remains a candidate record. Validated/trusted states
require evaluation references and validation time. Trusted state additionally
requires candidate and promotion-event references. Those references are audit
claims to verify later, not proof that promotion was authorized.

Active task state instead has active/closed lifecycle and exact task/session
bounds. It is not a durable lesson, even if a later ledger stores a snapshot.
Superseded and revoked state carries explicit event/time/relationship metadata.
Rollback points to a different state version and a revocation event. There is no
state machine, automatic status transition, or controller here.

Corrections can apply to the current task/session and propose an unknown or
bounded durable scope independently. A permission correction is evidence, not an
approval. Context holds references, not the whole owner model. Learned guidance
must identify matching trusted state; superseded/revoked items can be selected
as counterevidence without becoming active guidance. Inclusion reasons are
observable descriptions, never hidden chain-of-thought.

## What this schema can represent

Scope represents a domain, task type or exact task ID, with optional recipient,
entity, and context qualifiers. Optional temporal bounds have an inclusive
`from` and exclusive `until`. A bounded scope requires at least a domain or task
boundary. Qualifier strings are descriptive labels, not an ontology or identity
resolution mechanism. Unknown scope is explicit; uncertain scope carries one or
more possible bounded scopes. Global scope requires `kind: 'global'` and an
explicit declaration. Every required scope must be supplied; none defaults
global.

## What this schema cannot infer

AVEN-002 does not solve scope inference, qualifier identity, semantic matching,
composition of scopes, decay, scope certainty, or correct non-application. An
explicit global declaration describes proposed applicability; it grants no
permission and establishes no evidence that global applicability is appropriate.
Unknown/uncertain scope cannot become learned guidance merely by parsing it.

## Authority and observable outcomes

Action parameters use only an immutable artifact reference in this milestone.
This is the specified alternative to tool-specific inline parameters, avoiding a
generic JSON escape hatch or a premature tool catalog. A digest is a lowercase
SHA-256 value; a locator is an opaque lookup reference and grants no access.

Policy and approval bindings include proposal ID, exact record version,
parameter digest, and full-proposal digest. The intended full-proposal digest
covers all authority-relevant fields, including owner, task/session,
tool/action, target, parameters, and requested authority. AVEN-002 does not
select a canonical serialization, calculate hashes, fetch artifacts, verify
immutability, compare bindings against stored proposals, or prevent replay.
Those operations remain mandatory responsibilities of later Root/execution
implementations.

ALLOW requires a recorded grant or owner-approval reference. An approval has a
bounded task/session and expiry; `issued` does not mean currently usable. Later
Root must authenticate its origin, check current time, revocation, bounds,
parameter/proposal digests, grant validity, and exact policy version. No parser
returns an executable capability. TypeScript brands and a `root` issuer label
are forgeable data, not an enforcement boundary.

Execution is a historical report, including the possibility of an attempt after
DENY or REQUIRE_OWNER_APPROVAL. Keeping that case representable is necessary to
audit unauthorized attempts/executions in EXP-001. Such a report does not grant
permission. Only completed attempt reports are in this initial contract;
in-progress orchestration is deferred. Tool-reported success remains separate
from observed verification.

VERIFIED requires nonempty observable evidence compatible with its method: state
observation, deterministic check, or owner confirmation. A model-only assessment
can represent INCONCLUSIVE, never VERIFIED. This validates evidence shape; it
cannot prove the observation, verifier, or owner is authentic/correct.

## Evaluation and promotion limits

Test definitions support historical replay, counterexample, held-out, scope
application/non-application, permission, and regression. Test definitions and
their declared oracle are preserved in evaluation snapshots, separately from
actual outcome, scorer, model/configuration, independence, and verdict. Split
labels distinguish development, promotion evaluation, and final held-out cases;
the schemas do not provide vault access control or leak prevention.

An oracle can be owner supplied, deterministic, externally verified,
evaluator/model judgment, or unresolved. An evaluator/model judgment is always
marked advisory. A PASS means only a result relative to the declared oracle. It
never asserts authoritative ground truth or grants promotion. Unresolved oracles
and missing observations require INDETERMINATE. Scorer/generator independence
remains an explicit claim requiring evidence, not an automatic consequence of
using a second model.

Promotion records must cite a candidate, evaluations, affected trusted state,
and Root ALLOW decision with a proposal binding. Later Root must resolve these
references, reject final-held-out evidence used for promotion, enforce evaluator
independence, check the proposed transition, and select trusted versions.
Supersession/revocation/rollback remain explicit audit records. Candidate
generation types carry no promotion authority. Runtime enforcement remains
Root's responsibility.

## Unresolved questions and deliberate deferrals

Unresolved: scope inference/matching, evidence independence and taint
propagation, oracle selection and disagreement, evaluation/promotion thresholds,
model-swap compatibility, owner authentication, canonical proposal/parameter
hashing, approval replay/expiry enforcement, Root process isolation, reference
resolution and owner isolation, immutable artifact storage, retention/erasure,
and protected evaluation access. Their representation here does not decide their
implementation.

No SQLite/database, Ledger persistence, retrieval/ranking, learning algorithm,
provider adapter, Root enforcement, API, UI, action execution, promotion
controller, or runtime orchestration is implemented. No experiment was run. The
event envelope is readonly and shallow-frozen on parsing; nested values and
storage are not made immutable. Append-only storage, referential integrity,
authorization, and replay protection require later implementation.

The contracts **DO NOT prove** factual truth, correct scope inference,
calibrated confidence, retrieval quality, learning quality, policy security,
execution correctness, verification correctness, or AI safety.

## Checks

From the repository root:

```sh
pnpm --filter @aven/contracts typecheck
pnpm --filter @aven/contracts test
pnpm check
```

Tests use explicitly synthetic fixtures. They exercise all requested boundary
distinctions, round trips, lifecycle/source consistency, and rejection of forged
authority shapes. `test/types.ts` checks all ID pairs and ordinary strings at
compile time; it is included in the package typecheck. The root test command
also retains all AVEN-001 experiment discipline tests. These are contract tests,
not runtime security or learning-performance evidence.
