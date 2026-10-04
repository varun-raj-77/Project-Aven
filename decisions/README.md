# Decisions

Record meaningful architecture decisions with the concrete evidence that caused
them. This directory is ready for future ADRs; no new architecture change has
been approved or implemented in AVEN-001.

The baseline is the locked design in the Master Description. Routine bootstrap
choices are recorded in `docs/REPOSITORY_INSPECTION.md`: nested repository to
preserve research, requested package names, placeholders, local tooling, and
draft experiment freeze gates. These do not decide Root process topology,
storage schema, scope/oracle representation, provider, or framework.

For an architecture change, first present the required ARCHITECTURE CHANGE
PROPOSAL from `AGENTS.md` and wait for approval. Afterwards use a record such as
`0001-descriptive-title.md` containing status/date, current design, observed
problem, proposal, evidence/run references, alternatives, consequences, approval
reference, and supersession/rollback implications. Never label a proposal
"accepted" before approval or invent approval evidence.
