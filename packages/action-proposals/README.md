# @aven/action-proposals

AVEN-011 Action Proposal Boundary, version `aven-011-action-proposals-v1`.
**Patch 2 (this state): the pure root entry only.** The Ledger recorder and
reconciliation (Patch 3) and the read-only history reader (Patch 4) are not
implemented yet.

Aven proposes; Root decides. This package reuses the frozen AVEN-002 contracts
(`ActionProposalSchema`, `ProposalBindingSchema` and their nested schemas)
unchanged. It makes no policy decision, records no approval, writes nothing,
reads no clock, generates no identifiers, calls no model, executes no tool,
learns nothing and is not wired into the API. Package separation is not process
isolation.

## API (root entry)

| Export                                           | Meaning                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `constructActionProposal(draft)`                 | Builds a version-1 proposal from caller-supplied owner, session, task, `proposalId`, `createdAt` and proposal fields; validates it |
| `validateActionProposal(proposal, context)`      | Checks a complete proposal against the v1 rules for an explicit `{ ownerId, sessionId, taskId }`; derives its binding              |
| `computeActionProposalDigest(proposal)`          | The protocol-v1 digest of a proposal carrying the v1 creation stamp                                                                |
| `inspectActionProposal(validated)`               | Revalidates a `{ proposal, binding }` pair and returns an authority-neutral, deeply frozen view                                    |
| `ActionProposalError` and its codes, outcomes    | Fixed codes and messages, no `cause`; the pure functions always report outcome `not_written`                                       |
| `ACTION_PROPOSALS_CONFIG` and identity constants | Version, creation stamp, digest protocol, frozen baseline and resource limits (deeply frozen)                                      |

All functions are deterministic. Caller input is copied without running caller
code (no getters, Proxies or non-plain prototypes), then parsed with the frozen
contract. Results are deeply frozen.

A proposal's origin (provenance) belongs to the event that will record it, not
to the proposal. It is not accepted by the constructor and is not part of the
payload or its digest.

## v1 rules (stricter than the contract)

- Owner, session and task must equal the explicit binding context.
- `metadata.creation` must be exactly
  `{ component: '@aven/action-proposals', version: 'aven-011-action-proposals-v1' }`
  and `recordVersion` must be 1. A revised proposal is a new proposal with a new
  caller-allocated identifier.
- Every string must be well-formed Unicode (no unpaired surrogate).
- The v1 recording format excludes the learning-lifecycle operations
  (`promote_learning`, `revoke_learning`, `rollback_learning`) and every
  non-read operation on `learned_state`; reads of learned state are allowed.
  This is a format restriction of this package, not Root enforcement, and other
  writers can still append such proposals through the frozen Ledger.
- Resource limits: depth 16, 2,048 nodes, arrays of 256, strings of 20,000.

There is deliberately no rule about identifier syntax, target membership in the
requested resources, duplicates, or declared risk: none has established tool
semantics, and Root decides with its own registry.

## Digest protocol v1

The digest covers the full strict-parsed payload as stored, and nothing else (no
provenance, event identifier, timestamp of recording or Root data).

1. Canonical text, RFC 8785-compatible for this value domain (plain objects,
   arrays, well-formed strings, non-negative safe integers): members sorted by
   key as UTF-16 code units; array order kept; no whitespace; strings escaped as
   ECMAScript `JSON.stringify` escapes a well-formed string; integers in
   shortest decimal form; no Unicode normalization.
2. Input bytes: ASCII `AVEN-011-ACTION-PROPOSAL-DIGEST-V1`, one `0x00` byte,
   then the UTF-8 canonical text.
3. Digest: `{ algorithm: 'sha256', value: <lowercase hex> }`.

The frozen `DigestSchema` has no protocol field, so the protocol is selected by
the creation stamp inside the digested payload. `parametersDigest` in the
binding is the declared `parameters.artifact.digest`, copied, never computed.

What a digest does and does not show:

- Distinct v1 payloads have distinct canonical texts and therefore distinct
  digest inputs. Distinct inputs give distinct digests only with overwhelming
  probability, under SHA-256 collision resistance; this is not a mathematical
  guarantee.
- Domain separation keeps the input encodings apart from the untagged hash of
  the same text and from other tagged schemes; it does not make the output sets
  disjoint.
- Changing only the locator changes the proposal digest but not the parameters
  digest. Content changed behind an unchanged locator and unchanged declared
  digest is invisible here; only hashing the bytes at use can detect it.
- A matching digest shows integrity consistency only: not authorship, not the
  parameter content, not any approval or permission.

`test/digest-vectors.json` holds golden vectors produced by an independent
Python standard-library procedure recorded in the file, never by this code.

## Checks

```sh
pnpm --filter @aven/action-proposals typecheck
pnpm --filter @aven/action-proposals test
pnpm check
```

Tests use synthetic data only. They are boundary and mechanics tests, not
security proofs.
