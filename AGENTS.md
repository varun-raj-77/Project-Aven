# Working on Aven

## Authority and scope

Build Aven v0.1. Project selection is closed unless implementation evidence
reveals a concrete fatal problem. Current authorized work is **AVEN-006 only**:
the provider-neutral model/runtime abstraction and the separate in-process
model-output recording path. AVEN-001 through AVEN-005 and MAINT-001 are frozen;
the current baseline is `f28994a` (tag `aven-005`). Do not begin AVEN-007 or
commit AVEN-006 before external review. Existing research outside this
repository is historical.

Read these sources completely before changing the design:

1. `docs/sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf`
2. `docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt`

The newer Master Description takes precedence when they disagree. In particular,
AVEN-007 is the naive personalization baseline and prebuilt dataset; success
requires C to materially beat B, not only A. The current task's explicit
instructions take precedence over both documents. `docs/AVEN_PRINCIPLES.md`
records the invariants.

## Architecture

One persistent owner-facing Aven; separate fast execution and slow learning
loops; append-only Experience Ledger; rebuildable typed/scoped owner state;
task-specific Context Broker; typed action proposals; external Root authority;
verification; independent evaluation, shadowing, controlled promotion,
monitoring, and rollback.

Prediction never grants permission. Aven may not directly alter Root, self-grant
permissions, or promote its own learning. Current session corrections may apply
immediately; durable learning follows the slow loop. No specialist agents in
v0.1 without evidence. No production self-modification.

Do not silently redesign Aven. If an architectural change is necessary, stop and
present the following, then wait for approval before making the change:

```text
ARCHITECTURE CHANGE PROPOSAL
Current design:
Observed implementation problem:
Proposed change:
Evidence:
Alternatives:
Consequences:
```

## Engineering and experiment discipline

- Prefer strict TypeScript, pnpm, Zod at boundaries, Vitest, deterministic code,
  explicit state machines where useful, and small local modules. SQLite is the
  initial storage preference; no database implementation in AVEN-001.
- Keep models/frameworks replaceable. No speculative framework adapter,
  microservices, swarms, voice, telephony, broad browser/computer control,
  affect/consciousness work, self-preservation objectives, billing, marketing
  site, or cloud scaling.
- Keep new owners neutral. Never embed this developer's preferences or infer
  owner facts from examples. Synthetic test cases must be labeled as such.
- Preserve evidence; link corrections and supersession. Infer the narrowest
  scope. "No useful lesson" is valid. Current explicit instructions override
  stale learning within Root policy; instructions cannot override denied
  authority.
- Preserve A/B/C, a strong editable/scoped profile plus searchable history for
  B, identical foundation model configurations per comparison, fixed Root
  policy, held-out protection, independent scoring, and supervision/cost
  accounting.
- Pre-specify metrics before results; separate development, promotion
  evaluation, and final held-out cases. Do not invent results, implementation
  status, safety, alignment, novelty, consciousness, or superiority claims.
- Never treat directory/package separation or these checks as enforced runtime
  isolation. Root process isolation, storage protection, and eval-vault controls
  remain implementation decisions.
- Run `pnpm check` after relevant changes. Tests cover bootstrap experiment
  discipline, shared contracts, SQLite integrity, Ledger behavior, the local API
  boundary, and the model-runtime boundary and model-output recording path, not
  a complete Aven runtime. Report limitations honestly.
- Keep raw owner data, credentials, private eval cases, and local databases out
  of Git. Commit sanitized reproducibility artifacts only after checking their
  contents.

`packages/contracts` remains the AVEN-002 domain boundary. `packages/storage`
owns AVEN-003 SQLite connections, contract serialization, SQL migrations and
integrity constraints. SQL migrations are authoritative; do not use schema push.
Keep the v1 validation/reference projection semantics available for stored v1
data. `packages/ledger` owns owner-bound historical append/read/replay behavior
over that storage. Replay is observational only. Append success records a claim;
it does not establish truth, authorize execution, or create derived owner state.
`apps/api` owns the AVEN-005 loopback HTTP boundary: declared (unauthenticated)
owner-scoped session and task identity provisioning, owner messages recorded
only as Ledger `owner_request` events, and side-effect-free session history read
from the Ledger. Accepting a message is not authorization and invokes no model.
The owner-message endpoint is exclusively for text entered by the owner
(`owner_request` with `explicit_owner_statement` provenance). Model/runtime
output must never be relayed through that HTTP endpoint or recorded as owner
input; AVEN-006 model output uses only the separate in-process path
`apps/api/src/assistant-response.ts`, recorded as `assistant_response` with
`model_inference` provenance and creation component
`@aven/api/assistant-response`. `metadata.creation.component = "@aven/api"`
marks owner input received through the declared, unauthenticated AVEN-005
channel; declared owner origin is not authenticated owner identity.
`packages/runtime` owns the provider-neutral `ModelRuntime` interface,
normalized runtime errors, cancellation/timeout, strict result validation, and a
test-only scripted runtime (`@aven/runtime/testing`). A runtime generates; it
never owns storage, the Ledger, owner state, Root, permissions or tools, and its
output is data, never authority or learned state. Runtime selection is explicit
injection; there is no router. Provider credentials, when a later milestone adds
a live adapter, come from external operator/Root configuration and are never
stored in the Ledger, owner memory, model input or runtime metadata. Other
app/package directories remain placeholders. Tooling schemas still describe
experimental metadata only. No live provider adapter or network model call,
public generation route, prompt personalization, Context Broker, Owner Model
retrieval or rebuild, learning algorithms, routing, streaming, tool calling,
Root enforcement, authentication, UI, execution, promotion controller, or agent
orchestration in this milestone. Stop after reporting files, checks,
assumptions, and deliberate deferrals for external review. Do not commit yet.
