# AVEN-008 report: Context Broker v1

Status: **implemented on an isolated candidate branch; not merged; not tagged;
awaiting external review.** Validation ran in a Linux cloud container (section
22). Windows validation is pending. No model was called. Nothing in this report
is an experimental result, and no C-versus-B claim is made.

## 1. Purpose

AVEN-008 implements the Context Broker of the locked architecture (Master
Description section 3.3): **task-specific context assembly**. For one owner
request it selects a small, budgeted, inspectable set of context items from
candidates that injected sources offer, ranked by relevance, scope, provenance,
confidence, freshness, salience and trust, with supersession, revocation and
negative retrieval signals handled explicitly.

Context is not memory. The output is transient context for one task. It is not
owner memory, durable owner state, learned preference storage, a model inference
about the owner, or an authority or permission decision. The broker never writes
back what it selected.

## 2. Why the Context Broker comes before the Typed Owner Model

The Master Description's order (section 19) puts the Context Broker (AVEN-008)
before the Typed Owner Model (AVEN-009) and corrections (AVEN-010). AVEN-008 is
therefore **source-agnostic**. It defines the retrieval boundary that later
state will be adapted into, without pretending that durable owner state already
exists:

- No facts, preferences, procedures, episodes, intent-pattern or active-task
  tables or records were created.
- Candidates are a normalized, transient view supplied by injected
  `ContextSource` adapters. In this milestone, sources are deterministic
  in-memory test sources.
- AVEN-009 will adapt typed owner state into candidates (an Owner Model source);
  AVEN-010 will produce the supersession and negative-signal metadata that this
  broker only consumes.

## 3. Package and API

New private workspace package `packages/context-broker` (`@aven/context-broker`,
export `.` only), replacing the placeholder `.gitkeep`. Its dependencies are
`@aven/contracts` and `zod`. No new external dependency was added.

```text
packages/context-broker/
  package.json, tsconfig.json, README.md
  src/config.ts     CONTEXT_BROKER_CONFIG_V1 (versioned, pinned by test)
  src/types.ts      strict Zod schemas: ContextRequest, ContextCandidate, signals, local IDs
  src/errors.ts     ContextBrokerError (fixed message per code)
  src/relevance.ts  tokenizer v1, unique-query-term coverage
  src/scope.ts      declarative scope and task-binding matching
  src/ranking.ts    provenance, trust and freshness factors; composite; negative penalty
  src/broker.ts     createContextBroker: sources, validation, isolation, eligibility, ranking, budget, bundle, trace
  src/util.ts       code-point helpers, code-unit comparison, score rounding, deep freeze
  src/index.ts
  test/ authority, boundaries, budget, determinism, eligibility, isolation,
        ranking, relevance, sources (+ fixtures)
```

API:

```ts
const broker = createContextBroker({ sources }); // throws invalid_configuration
const { bundle, trace } = await broker.assemble(request);
```

`broker` is frozen and exposes only `sources` (the registered IDs and kinds) and
`assemble`. The output is deep-frozen.

The package does not depend on `@aven/storage`, `@aven/ledger`, `@aven/runtime`
or `@aven/baseline`. No frozen package needed to change; no architecture change
is proposed (section 21).

## 4. ContextRequest

```ts
{
  ownerId: OwnerId,                       // AVEN-002
  task: { sessionId, taskId },            // AVEN-002 TaskBinding
  request: string,                        // 1..8000 code points, non-whitespace
  referenceTime: Timestamp,               // the ONLY clock the broker uses
  taskDescriptor: {                       // explicit labels from the trusted caller
    domain?, taskType?,
    qualifiers?: { recipient?, entity?, context? },
  },
}
```

The schema is strict. A malformed request throws `invalid_request` before any
source is queried. Descriptor labels are at most 256 code points. Their names
mirror the frozen AVEN-002 bounded-scope dimensions, so matching is
label-to-label.

## 5. ContextCandidate (transient retrieval view)

Before inventing types I inspected `@aven/contracts`. The frozen schemas already
express most of what a candidate needs, so the candidate reuses them unchanged:

| Field         | Type                                                                                                                                                                                      | Source                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `candidateId` | local ID (NFC Unicode letters/numbers, `_ . : -`, ≤128)                                                                                                                                   | AVEN-008                             |
| `ownerId`     | `OwnerId`                                                                                                                                                                                 | AVEN-002                             |
| `reference`   | `ContextSource`: `evidence`, `owner_state` (+ lifecycle: observed, validated, trusted, superseded, revoked), `active_task_state` (+ task binding), `current_instruction` (+ task binding) | AVEN-002 `context.ts`                |
| `provenance`  | `Provenance` (seven kinds, with `untrusted` and `potentially_untrusted` labels)                                                                                                           | AVEN-002 `provenance.ts`             |
| `scope`       | `Scope`: unknown, uncertain, bounded, global (never defaulted)                                                                                                                            | AVEN-002 `scope.ts`                  |
| `text`        | 1..20000 code points; data only                                                                                                                                                           | AVEN-008                             |
| `timestamps`  | `recordedAt`, optional `lastValidatedAt` (not before `recordedAt`)                                                                                                                        | AVEN-008 (AVEN-002 timestamp format) |
| `signals`     | `confidence`, `salience`, `negativeRetrieval`, each finite in [0, 1]                                                                                                                      | AVEN-008                             |

The candidate schema is strict. Unknown fields at any level fail closed. Every
string inside `reference`, `provenance` and `scope` is bounded (scope labels 256
code points, other metadata 1000), because the frozen text fields carry no
length limit. A `current_instruction` must carry `explicit_owner_statement` or
`explicit_owner_correction` provenance, mirroring the frozen `ContextSelection`
rule for task instructions. Malformed signals (NaN, Infinity, out of range,
non-numeric, missing, extra) throw `invalid_score_metadata`; any other malformed
candidate throws `invalid_candidate`.

The frozen contracts deliberately define no numeric confidence or salience
(contracts README). The numeric `signals` are therefore AVEN-008-local,
adapter-supplied, uncalibrated ordinal ranking inputs, not probabilities. How
typed owner state maps to them belongs to AVEN-009 (decision D2).

## 6. ContextSource boundary and failure policy

```ts
interface ContextSource {
  readonly sourceId: string; // local ID, unique per broker
  readonly kind:
    | 'owner_state'
    | 'episode_history'
    | 'procedure'
    | 'active_task'
    | 'permitted_external';
  collect(
    query: ContextSourceQuery,
  ): readonly unknown[] | Promise<readonly unknown[]>;
}
```

- A trusted caller registers sources. The `sourceId`, `kind` and `collect`
  function are read once at registration, so a source cannot later change its
  identity. Up to 16 sources; duplicate IDs are rejected
  (`invalid_configuration`).
- Each source receives the same **deep-frozen** owner-scoped query (`ownerId`,
  task binding, request, `referenceTime`, descriptor, `maxCandidates`). Sources
  are processed in `sourceId` code-unit order.
- Source kind constrains structure: `owner_state` and `procedure` may return
  only `owner_state` references; `episode_history` `evidence` or `owner_state`;
  `active_task` `active_task_state` or `current_instruction`;
  `permitted_external` only `evidence` with `external_content` or `tool_result`
  provenance. An external adapter therefore cannot present its content as
  owner-origin, as owner state or as an instruction.
- **Failure policy (v1): fail closed for the whole assembly.** A source that
  throws or rejects, or returns a non-array, yields `source_failure`. More than
  500 candidates from one source, or more than 2000 in total, yields
  `candidate_limit_exceeded`. Limits are checked on the returned length before
  any validation or ranking. A malformed candidate or duplicate `candidateId`
  within a source yields `invalid_candidate` or `invalid_score_metadata`. When
  several sources fail, the first in `sourceId` order is reported. No partial
  bundle is returned: silently dropping a source would make an incomplete bundle
  look complete.
- Errors carry a fixed public message per code plus the caller-registered
  `sourceId` and the `candidateIndex`. A source's thrown error or the validation
  issues stay in `cause` only. A source that throws a spoofed
  `ContextBrokerError` is still reported as `source_failure`. There is no
  internal timeout; a source that never settles stalls the call. Timeouts are a
  later caller concern (limitation).

Error codes: `invalid_configuration`, `invalid_request`, `source_failure`,
`candidate_limit_exceeded`, `invalid_candidate`, `invalid_score_metadata`. Owner
isolation is deliberately not an error (section 7).

## 7. Owner isolation (hard invariant)

The broker enforces isolation itself and does not trust the source:

1. Every returned candidate is fully validated.
2. A candidate whose `ownerId` differs from the request owner, or whose
   owner-origin provenance (`explicit_owner_statement`,
   `explicit_owner_correction`, `owner_approval`) names another owner, is
   dropped **before any statistic, assessment or ranking**. It is only counted
   (`foreignOwnerExcluded`, `ownerProvenanceMismatchExcluded`). Its ID and text
   never appear in the bundle or trace.
3. Coverage relevance is per-candidate, so no corpus statistic exists that a
   foreign record could shift. A test still proves byte-identical bundle,
   candidate trace, ranking, query and budget with and without 40 foreign
   exact-match records.

The attack in the brief was tested directly: Owner A's request, Owner B's
exact-text match with maximal signals, and Owner A's weaker match. Only Owner
A's item is selected, and the output contains no trace of B's ID, owner ID or
text. Ownership is structured metadata; candidate text cannot claim it. External
candidates must be attached to the current owner by the adapter (`ownerId`); an
external candidate attached to another owner is excluded like any foreign
record. A source that floods foreign records still counts them against its
500-candidate cap.

Foreign-owner records are excluded rather than raising an error so that the
requesting owner is still served (the brief's attack requires a ranking for A).
This is decision D4.

## 8. Eligibility (decisions, never low scores)

Applied to each same-owner candidate in this fixed precedence; the first failing
rule is reported:

| #   | Rule                                                              | Exclusion reason                |
| --- | ----------------------------------------------------------------- | ------------------------------- |
| 1   | owner-state lifecycle is not `superseded`                         | `superseded`                    |
| 2   | owner-state lifecycle is not `revoked`                            | `revoked`                       |
| 3   | `recordedAt` and `lastValidatedAt` are not after `referenceTime`  | `recorded_after_reference_time` |
| 4   | a task-bound reference has exactly the request's session and task | `task_binding_mismatch`         |
| 5   | the declared scope has no explicit mismatch (section 10)          | `scope_mismatch`                |
| 6   | `negativeRetrieval` < 1                                           | `negative_signal_suppressed`    |
| 7   | at least one relevance channel (below)                            | `no_relevance_channel`          |

Eligible candidates are then ranked and budgeted. Budget exclusions are
`item_limit` and `context_budget`.

**Relevance floor (rule 7).** A candidate needs at least one explicit channel of
task relevance:

- `lexical_content_term`: at least one matched query term that is a content
  term, not a qualifier (section 9);
- `task`: an exact task binding, or a bounded scope whose `taskId` is the
  request's task;
- `scope_label`: an explicit match of at least one declared domain, task type or
  qualifier label (full or partial label match; section 10).

Global and unknown scope provide no channel. Metadata (trust, salience,
confidence, provenance) can never admit a candidate by itself. This is slightly
stricter than "nonzero lexical relevance" (decision D5): because negation and
temporal qualifiers are kept as terms, a match on "not" alone would otherwise
admit unrelated items ("Do not include the appendix" versus "I do not eat
mushrooms"). Such matches still count toward the coverage score once a candidate
is eligible.

## 9. Relevance (`aven-008-lexical-coverage-v1`, tokenizer `aven-008-tokenizer-v1`)

An AVEN-008-owned function. It is **not** the AVEN-007 BM25 and imports nothing
from `@aven/baseline` (a static tripwire and mutation M14b prove this).

1. Tokenize: Unicode NFKC, locale-independent lowercasing, negative-contraction
   expansion ("don't" to "do not"; "cannot", "can't", "won't", "shan't"
   explicitly), split on anything that is not a letter, combining mark or
   number, remove `STOPWORDS_V1`, then the Harman S plural fold for
   non-qualifier ASCII tokens longer than three characters.
2. `STOPWORDS_V1` (91 words) removes only articles, personal, possessive and
   reflexive pronouns, demonstratives, forms of "be", "have" and "do", common
   prepositions and conjunctions, a few question words, "here", "there",
   "please", "also", "very" and contraction fragments.
3. `QUALIFIER_TERMS_V1` (77 words) are **kept**: negation (no, not, nor, never,
   none, nothing, neither, nobody, nowhere); restriction and exclusion (only,
   just, except, unless, without, instead, rather, other, than, else); temporal
   and ordering (before, after, until, till, since, during, while, when,
   whenever, then, now, once, again, always, already, later, soon, still, yet,
   first, last, next, previous); conditional (if); quantity (all, any, some,
   each, every, both, either, few, more, most, less, least, many, much); bounds
   (above, below, beyond, over, under, within); modality (must, should, may,
   might, can, could, will, would, shall); and particles (off, out, up, down,
   too). They are not plural-folded. The two lists are disjoint (tested). The
   AVEN-007 v1 mistake (removing negation, restriction and temporal words) is
   not repeated; mutation X03 proves the tests catch it.
4. Query terms are the request's unique terms.
   `relevance = matched unique query terms / unique query terms`, in [0, 1] (0
   for a stopword-only request).
5. Relevance is computed on the **included item text** (after the 1600
   code-point cut), so every matched term is visible in the bundle.

It is deterministic, makes no model or network call and uses no randomness. It
was not tuned on AVEN-007 cases. It is not semantic relevance (section 20).

## 10. Scope semantics (declarative only)

Labels are compared after NFKC, locale-independent lowercasing, trimming and
whitespace collapsing, by exact equality. There is no ontology, synonym,
hierarchy or semantic inference.

For a frozen AVEN-002 **bounded** scope, each declared dimension is compared:

| Dimension                        | Compared with                 | Possible outcomes                                   |
| -------------------------------- | ----------------------------- | --------------------------------------------------- |
| `taskId`                         | request task ID               | matched / mismatched                                |
| `domain`, `taskType`             | request descriptor label      | matched / mismatched / indeterminate (not declared) |
| `recipient`, `entity`, `context` | request descriptor qualifiers | matched / mismatched / indeterminate                |
| `temporal` `[from, until)`       | `referenceTime`               | within (never a positive match) / mismatched        |

| Scope status          | Condition                                                            | Factor         | Channel       |
| --------------------- | -------------------------------------------------------------------- | -------------- | ------------- |
| `task_match`          | exact task binding, or bounded `taskId` matched; no mismatch         | 1.00           | `task`        |
| `label_match`         | bounded; at least one label matched, none indeterminate, no mismatch | 1.00           | `scope_label` |
| `partial_label_match` | bounded; at least one label matched, some indeterminate, no mismatch | 0.75           | `scope_label` |
| `global`              | explicit global declaration                                          | 0.50           | none          |
| `indeterminate`       | bounded; nothing comparable (request declares none of its labels)    | 0.25           | none          |
| `unknown`             | explicit unknown scope                                               | 0.25           | none          |
| `uncertain`           | uncertain scope with at least one possibility that does not mismatch | 0.25           | none          |
| `mismatch`            | any explicit mismatch (or every uncertain possibility mismatches)    | **ineligible** | —             |

An omitted request label is "not declared", never a wildcard match. A clear
mismatch is never rescued by lexical relevance: "Use terse answers for live
interview questions" (domain `Interviews`) is excluded for a research report
(domain `research`) although it shares three query terms (tested).

**Session scope.** The frozen contracts express session scope only inside a task
binding (`sessionId` plus `taskId`). Task-bound references (`active_task_state`,
`current_instruction`) must match both. A session-wide scope (any task in a
session) has no frozen representation; AVEN-010 will decide how session
overrides are represented (decision D6).

## 11. Ranking (`aven-008-context-broker-config-v1`)

```text
composite = 0.40 relevance + 0.20 scope + 0.10 provenance + 0.10 confidence
          + 0.07 freshness + 0.07 salience + 0.06 trust
final     = composite * (1 - negativeRetrieval)
```

These are the pre-specified weights, held as integer basis points
(4000/2000/1000/1000/700/700/600, total exactly 10000; an import-time guard and
a pinned test enforce them). They were not tuned on AVEN-007 cases or model
results. No frozen contract made a weight impossible or misleading. Each factor
value and each contribution is rounded to 9 decimal places so that ordering does
not depend on the last bits of floating-point arithmetic. Every factor,
contribution, the composite, the negative signal, the penalty and the final
score are reported for every eligible candidate, in both the bundle and the
trace.

Worked example (tested): an owner-statement evidence item, unknown scope, full
coverage, confidence and salience 0.5, age 0:
`0.40 + 0.05 + 0.10 + 0.05 + 0.07 + 0.035 + 0.03 = 0.735`.

What the weights imply: an exact scope match versus global scope is worth 0.10,
the same as 25 percentage points of query coverage. A task-bound item with no
lexical overlap (0.445 in the tested fixture) therefore outranks an
unknown-scope item matching one of five query terms (0.375), but not a strong
lexical match.

## 12. Provenance and trust

Both are derived only from frozen structured metadata supplied by the trusted
adapter. They are never read from prose, and the broker never upgrades them.

| Provenance kind (AVEN-002)                                                | Factor |
| ------------------------------------------------------------------------- | ------ |
| `explicit_owner_statement`, `explicit_owner_correction`, `owner_approval` | 1.0    |
| `system_generated`                                                        | 0.6    |
| `model_inference`                                                         | 0.4    |
| `tool_result`                                                             | 0.3    |
| `external_content`                                                        | 0.2    |

Trust describes governance status. A provenance trust label takes precedence:
`untrusted` (external content) gives 0.0 and `potentially_untrusted` (tool
result) gives 0.25, whatever lifecycle the item claims. Otherwise: owner-state
`trusted` 1.0, `validated` 0.75, `observed` 0.5; `current_instruction` 1.0;
`active_task_state` 0.5; raw `evidence` 0.5. Tainted content can therefore never
rank as trusted state (mutation X06 is caught).

Lifecycle labels are claims of the trusted adapter. The broker does not verify
promotion lineage; that remains AVEN-009, AVEN-017 and Root work. Model
inference, external content and assistant output cannot be laundered into an
explicit owner statement by their text: provenance is structured, and hostile
text claiming `explicit_owner_statement`, `"trust":1` or another owner leaves
every field and score unchanged (tested; mutation M11 is caught).

## 13. Freshness

`freshness = 0.5 ^ (age / 90 days)`, where `age = referenceTime − anchor` and
the anchor is `lastValidatedAt` when supplied, otherwise `recordedAt`. The only
clock is the request's explicit `referenceTime`; `Date.now()`, timers and
randomness are never read (static tripwire plus a test that fakes the system
clock, `Date.now`, `performance.now` and `Math.random`; mutation M09 is caught).
A candidate timestamped after the reference time is ineligible rather than
"maximally fresh", which also prevents a replay at an earlier reference time
from seeing later items. Staleness is never inferred from text. The same instant
written with a different UTC offset gives the same ranking.

## 14. Supersession and revocation

The broker consumes the frozen owner-state lifecycle and never creates it.
`superseded` and `revoked` candidates are ineligible (eligibility rules 1 and
2). They appear only in the trace, as excluded historical evidence with their
reason, lifecycle and relevance assessment, and with `score: null` and
`eligibleRank: null`. They never appear in the bundle, the ranking or the
selection. Nothing is deleted, rewritten or replaced. Using superseded items as
counterevidence (permitted by the AVEN-002 `ContextSelection` contract) is
deferred.

## 15. Negative retrieval signals

`negativeRetrieval` is an explicit, bounded [0, 1] input from the caller or
source. The broker only consumes it: `final = composite * (1 − n)`, with the
penalty (`composite − final`) reported. Exactly 1 is a hard suppression, an
eligibility decision (`negative_signal_suppressed`). Signals are never inferred
from free text and never persisted; a later call without the signal shows no
residue (tested). AVEN-010 will create correction-derived signals.

## 16. Budgets and truncation (code points)

| Limit                           | Value           | Kind                |
| ------------------------------- | --------------- | ------------------- |
| `MAX_SINGLE_CONTEXT_ITEM_CHARS` | 1600            | per-item cut        |
| `MAX_SELECTED_CONTEXT_CHARS`    | 10000           | total selected text |
| `MAX_SELECTED_ITEMS`            | 10              | selected items      |
| sources / per source / total    | 16 / 500 / 2000 | collection guards   |
| request / candidate text        | 8000 / 20000    | validation guards   |
| scope label / other metadata    | 256 / 1000      | validation guards   |

All character counts are Unicode code points (`Array.from`), so a surrogate pair
is never split and an emoji counts once. Each item's text is cut to its first
1600 code points (`truncated`, `originalChars` and `includedChars` are
reported). Structured metadata is never cut. Selection is a **rank-order
prefix**: items are taken in rank order while the item count is below 10 and the
total stays within 10000 code points. At the first eligible item that does not
fit, it and every lower-ranked eligible item are excluded with the reason that
stopped selection (`item_limit` or `context_budget`). Items are never reordered,
and a smaller lower-ranked item is not packed in afterwards (decision D7).
Tested at 1599, 1600 and 1601 code points with astral characters, at an exact
10000 fill, and at 12 candidates for the 10-item limit.

There is no per-source selection cap or diversity optimizer. One noisy source
can fill at most the global item and character limits, its collection is capped
at 500, and its foreign records count against that cap.

## 17. Deterministic ordering

Final score descending, then `sourceId` ascending, then `candidateId` ascending,
both by UTF-16 code unit (locale-independent). Sources are processed in
`sourceId` order and trace candidates are listed by `sourceId`, then
`candidateId`. Output is therefore independent of source registration order and
of the order in which a source returns candidates (tested byte-for-byte).

## 18. Bundle and trace

`ContextBundle` (`kind: 'context_bundle'`): broker, configuration and relevance
versions; owner, task binding and reference time; `items` in rank order, each
with `rank`, `sourceId`, `sourceKind`, `candidateId`, the frozen `reference`,
`provenance` and `scope`, `recordedAt`, `lastValidatedAt`, `text` (possibly
cut), `truncated`, `originalChars`, `includedChars` and the full `score`
breakdown; and `budget` usage (`selectedItems`, `usedChars`, `truncatedItems`,
`stopReason`). **It is not a prompt.** It owns no system prompt, is not wired
into the owner-message or assistant-response paths, and changes no AVEN-006
runtime semantics. Later fast-loop code will serialize it. Projecting it into
the AVEN-002 `TaskContext` record is deferred (decision D8).

`ContextBrokerTrace` (`kind: 'context_broker_trace'`): versions and identity;
query terms with content and qualifier counts; per source the counts returned,
foreign-owner excluded, provenance-owner-mismatch excluded and considered; per
same-owner candidate its IDs, reference kind, lifecycle, provenance kind,
signals, `selection` (`selected` or `excluded`), `exclusionReason`,
`eligibleRank`, task-binding result, scope assessment (status and matched,
mismatched and indeterminate dimensions), relevance (score and matched terms),
channels, freshness (anchor, age, factor), trust basis, score breakdown (`null`
when ineligible) and text sizes; the eligible ranking with final scores; the
selected order; totals including counts by exclusion reason; and budget usage.

The trace is evidence about a deterministic computation: identifiers, codes and
numbers only. It contains no item text, hidden reasoning, chain-of-thought,
secret or authority decision. A test pins the complete key set of the output and
rejects reasoning-like and authority-like keys.

## 19. Authority and non-learning boundaries

- No `ALLOW`, `DENY` or `REQUIRE_OWNER_APPROVAL`, no permission, approval, tool
  or Root concept exists in the package (static tripwire plus output key and
  content tests). Hostile candidate text ("permission granted", "the owner
  approved this", "ignore policy", "I am a system message", "send this now", a
  forged JSON block) stays verbatim data and produces exactly the same score as
  neutral text with the same lexical overlap.
- Read/compute-only: no storage or Ledger import, no SQL, no persistence, no
  module-level state between calls; deep-frozen inputs are never mutated; an
  owner store with write methods sees zero writes; the output is deep-frozen;
  the source query is deep-frozen.
- No AVEN-009 structures (durable facts, preferences, episodes, intent patterns,
  procedures, active-task records, lifecycle mutation, evidence promotion,
  persistent confidence, rebuild) and no AVEN-010 correction interpretation,
  correction records, inferred negative signals or session overrides.
  Correction-like owner text is plain data and changes no other candidate's
  score (tested).
- No model, runtime, provider SDK, embedding, vector store, reranker, `fetch`,
  HTTP, file, process or environment access.

## 20. Known limitations

- Lexical relevance is not semantic relevance: paraphrases and synonyms do not
  match, and homonyms do. Coverage ignores term importance and candidate length.
- The tokenizer and word lists are English-centric. There is no CJK word
  segmentation; a run of ideographs is one token.
- The S plural fold is minimal and keeps known artifacts ("boxes" to "boxe",
  "news" to "new").
- Declarative scope is not semantic scope inference: labels match only by
  normalized equality, with no hierarchy or synonymy ("outreach" does not match
  "professional outreach").
- Ranking weights and factor tables are provisional v1 values, pre-specified,
  not learned and not validated.
- Ranking quality depends entirely on upstream metadata quality (lifecycle
  claims, signals, scope labels, provenance), which future components must
  produce. Lifecycle and promotion claims are not verified here.
- No persistent Typed Owner Model exists yet (AVEN-009).
- No correction engine exists yet (AVEN-010); negative signals are consumed but
  not generated.
- No cross-source deduplication: the same underlying item offered by two sources
  is two candidates.
- No per-source timeout; a source that never settles stalls the call.
- Fail-closed source policy: one broken source prevents any context for that
  request.
- Budgets are in code points, not model tokens.
- No vector or embedding retrieval.
- No external source integration exists yet. Only the structural boundary for
  `permitted_external` adapters is defined.
- No permission decision occurs here; Root is later work.
- No real-model evaluation was run. Context selection is not proof that a
  foundation model will use the context correctly.
- No C-versus-B performance claim is made or implied.
- Static tripwires are pattern checks, not security guarantees. Package
  separation is not runtime isolation.

## 21. Decisions for external review

- **D1 Contract reuse.** The candidate reuses the frozen AVEN-002
  `ContextSource` (as `reference`), `Provenance` and `Scope` schemas unchanged,
  with local `timestamps`, `signals` and IDs. No frozen contract changed.
- **D2 Numeric signals.** AVEN-002 deliberately has no numeric confidence.
  Confidence, salience and negative retrieval are AVEN-008-local,
  adapter-supplied [0, 1] ordinal inputs. The alternative was to derive
  confidence from `EvidenceSignals.support`, which exists only for durable owner
  state.
- **D3 Trust derivation.** Trust is derived from lifecycle and provenance labels
  rather than accepted as a free number, so an adapter cannot assign high trust
  to tainted content. It overlaps partly with provenance for external and tool
  content (both low).
- **D4 Foreign-owner policy.** Exclude and count, rather than fail the call.
- **D5 Relevance floor.** Qualifier-only matches do not open the lexical
  channel.
- **D6 Session scope.** Only exact task bindings (session plus task); no
  session-wide scope until AVEN-010.
- **D7 Budget policy.** A rank-order prefix (as in AVEN-007), not greedy
  packing.
- **D8 Output shape.** A broker-local bundle, not the AVEN-002 `TaskContext`
  record, which would require record metadata, a context ID and qualitative
  relevance and freshness labels the broker would have to invent. Superseded
  items are not offered as `counterevidence`.
- **D9 Future timestamps** are ineligible rather than clamped to age zero.
- **D10 Relevance on included text.** Relevance is judged on the 1600 code-point
  included text, so matched terms are always visible. A term only in a truncated
  tail does not count.

Architecture-change proposals: **none**. The frozen contracts were sufficient;
no frozen layer needed to change.

## 22. Validation environment and commands

This was the first cloud-built milestone. It ran in an isolated Linux x64 cloud
container (Linux 6.18) with a fresh clone of `varun-raj-77/Project-Aven`. Node
24.21.0 was installed with nvm (the image ships Node 22; the repository requires
Node ≥24 <25), with Corepack 0.36.0 and pnpm 11.19.0 pinned through Corepack.

Baseline gate, before editing: `HEAD`, `main`, `origin/main` and `aven-007` all
resolved to `1658edac85cc1cf8f84ba79852ad6fd129f6a5ad`, and `aven-006` to
`8c8228d9f606529b146043419c226cebbe28b413` (tags fetched from `origin`).
`corepack pnpm install --frozen-lockfile --ignore-scripts`,
`corepack pnpm check` (544 tests passing) and `corepack pnpm dataset:check`
(AVEN-007 v2.0.0 valid, `execution=not_run`) all passed.

Commands run after the change:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm experiment:check
corepack pnpm dataset:check
corepack pnpm --filter @aven/context-broker test
corepack pnpm --filter @aven/baseline test
corepack pnpm --filter @aven/runtime test
corepack pnpm --filter @aven/api test
corepack pnpm --filter @aven/ledger test
corepack pnpm db:test
corepack pnpm test
corepack pnpm check
git diff --check
```

**Windows validation is pending.** Run the same commands on Windows. Expected:
642 tests passing.

## 23. Tests

| File                                               | Tests                  | Covers (brief letters)                                                                                                                                                     |
| -------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/context-broker/test/relevance.test.ts`   | 11                     | D, E, U: tokenizer, negation and qualifiers, contractions, plural fold, coverage, Unicode                                                                                  |
| `packages/context-broker/test/isolation.test.ts`   | 5                      | B, C: foreign exact match, provenance-owner mismatch, foreign-only source, ranking invariance, frozen query                                                                |
| `packages/context-broker/test/eligibility.test.ts` | 12                     | F, G, H, O, P, Q, R, S, AK: task binding, scope mismatch, qualifiers, temporal, uncertain, global/unknown, lifecycle, negative signals, relevance floor, future timestamps |
| `packages/context-broker/test/ranking.test.ts`     | 15                     | D, I, J, K, L, M, N, T, AJ: pinned config and weights, worked example, each factor alone flips order, ties, component visibility                                           |
| `packages/context-broker/test/budget.test.ts`      | 8                      | U, V, W, X: 1599/1600/1601, relevance on included text, total budget, exact fill, item limit, Unicode IDs                                                                  |
| `packages/context-broker/test/sources.test.ts`     | 18                     | Y, Z, AM, AN: source failures, ordering, invalid request/config, error codes, caps, floods, malformed signals and fields, laundering                                       |
| `packages/context-broker/test/authority.test.ts`   | 8                      | AA, AB, AC, AD, AF, AH, AI: hostile text, no authority output, pinned keys, no mutation, no writes, no state, no correction inference, no fetch                            |
| `packages/context-broker/test/determinism.test.ts` | 4                      | A, AL: byte-identical output, order independence, faked clocks and randomness, reference-time behavior                                                                     |
| `packages/context-broker/test/boundaries.test.ts`  | 14                     | AE, AF, AG, AH and others: static tripwires with known-bad samples, manifest, module set, public API                                                                       |
| `tooling/tests/aven-008-frozen-layers.test.ts`     | 3                      | AO: 169 aven-007 files byte-identical; no file added to 19 frozen directories                                                                                              |
| **Total**                                          | **642** (544 + 98 new) | All 544 pre-existing tests unchanged and passing                                                                                                                           |

Static tripwires (comments stripped, every rule also run against known-bad
samples): a named-import allowlist (`zod`: `z`; seven `@aven/contracts`
schemas); no storage or Ledger access or table names; no runtime, baseline,
provider SDK, embedding, vector or reranker; no file, network, process,
environment or `eval` capability; no wall clock, timers or randomness; no
`ALLOW`/`DENY`/`REQUIRE_OWNER_APPROVAL`, policy, approval, permission or Root;
no AVEN-009 owner-model structures or persistence; no correction or override
identifiers (AVEN-010); no reasoning fields; no test-only runtime. The manifest
dependencies, module set and public export surface are pinned.

## 24. Adversarial self-review (mutation testing)

Each mutation was applied by a script, the broker suite and the three
frozen-layer suites were run with the JSON reporter, and the mutated files were
restored and verified byte-identical by SHA-256. Detection counts only test
**assertion failures**; a suite that fails to load would have been reported as
an infrastructure failure, and none occurred. Type-only import mutations were
used where a value import would have broken module loading.

| #    | Mutation                                                         | Caught by (examples)                                |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------- |
| M01  | remove owner filtering                                           | isolation B, C, foreign-only source; flood test (4) |
| M02  | foreign candidates influence relevance normalization             | isolation C; O/P relevance values (2)               |
| M03  | let revoked through                                              | O/P/AK; determinism A (2)                           |
| M04  | let superseded through                                           | O/P/AK; precedence; AC; A (4)                       |
| M05  | ignore negative signal (penalty and suppression)                 | Q; R (2)                                            |
| M06  | remove scope gating                                              | F; G; qualifier/temporal; A; uncertain (5)          |
| M07  | remove relevance floor                                           | S; H; included-text test; A (4)                     |
| M08  | change one weight (relevance 0.39, salience 0.08; sum kept 1.00) | pinned weights and config; D worked example; F (4)  |
| M09  | `Date.now()` for freshness                                       | clock tripwire; determinism; AH; state test (13)    |
| M10  | exceed the context budget                                        | W; exact fill (2)                                   |
| M11  | candidate prose sets provenance/trust                            | AA hostile-claims test (1)                          |
| M12a | Ledger dependency (type import)                                  | import allowlist; storage rule (2)                  |
| M12b | storage write (`insert into experience_events`)                  | storage rule (1)                                    |
| M13  | import `@aven/runtime`                                           | import allowlist; runtime rule (2)                  |
| M14a | import `@aven/baseline`                                          | import allowlist; baseline rule (2)                 |
| M14b | reuse the baseline tokenizer by relative path                    | import allowlist (1)                                |
| M15  | add `fetch` network code                                         | network rule (1)                                    |
| M16  | add Owner Model persistence (module-level store)                 | AVEN-009 rule (1)                                   |
| M17  | infer a correction from free text                                | AH behavior; AVEN-010 rule (2)                      |
| M18  | add an `authority: 'ALLOW'` field                                | AB; AI pinned keys; authority rule (3)              |
| M19  | edit an AVEN-007 frozen file (`packages/baseline/src/config.ts`) | aven-008 frozen-layer test (1)                      |
| X01  | drop the `permitted_external` provenance restriction             | laundering test (1)                                 |
| X02  | qualifier-only matches open the lexical channel                  | S (1)                                               |
| X03  | put "not" back on the stoplist                                   | E; contractions; negated-vs-affirmative; S (5)      |
| X04  | greedy packing instead of a prefix                               | W (1)                                               |
| X05  | remove per-item truncation                                       | V; included-text test (2)                           |
| X06  | lifecycle overrides the untrusted label                          | M; I; AA (3)                                        |
| X07  | tie-break ignores `sourceId`                                     | T (1)                                               |
| X08  | relevance on full text, not included text                        | included-text test (1)                              |
| X09  | swallow source failures as empty collections                     | Z tests (3)                                         |
| X10  | per-source cap off by one                                        | cap test; flood test (2)                            |
| X11  | remove the total candidate bound                                 | total-bound test (1)                                |
| X12  | ignore `lastValidatedAt`                                         | K (1)                                               |
| X13  | non-strict candidate schema                                      | AN (1)                                              |
| X14  | let future-dated items through                                   | reference-time test (1)                             |
| X15  | skip the task-binding check                                      | session/task binding test (1)                       |
| X16  | unfrozen source query                                            | frozen-query test (1)                               |
| X17  | drop the owner-origin provenance owner check                     | provenance-owner isolation test (1)                 |
| X18  | compare scope labels without normalization                       | normalized-label test (1)                           |
| X19  | allow a current instruction with non-owner provenance            | instruction-provenance test (1)                     |

**40 of 40 mutations were caught. All were reverted** and the suites passed
again afterwards.

## 25. Frozen-layer comparison

- Modified tracked files (5): `package.json` (description; `typecheck` and
  `check` add the context-broker tsconfig, keeping the MAINT-001 composition),
  `pnpm-lock.yaml` (only the new `packages/context-broker` importer; no new
  external package), `README.md`, `AGENTS.md`, `docs/ROADMAP.md`.
- Deleted: `packages/context-broker/.gitkeep` (replaced by the package).
- Added: `packages/context-broker/**`,
  `tooling/tests/aven-008-frozen-layers.test.ts`, `docs/AVEN_008_REPORT.md`.
- Unchanged and checked: the new tripwire pins all 169 other files tracked at
  `aven-007` (contracts, storage, migration, Ledger, API, runtime, baseline
  package, dataset, oracle, controls, diagnostics, manifest, reviewed-v1
  archive, tooling, EXP-001, AVEN-002 to AVEN-007 and MAINT-001 reports,
  principles, decisions, source documents), hashed from the tag's blobs, and
  checks 19 frozen directories for added files. The AVEN-006 and AVEN-007
  tripwires are unchanged and pass. No semantics of any frozen layer changed.
  EXP-001, the AVEN-007 dataset and its `not_run` status are untouched.

## 26. Deferred AVEN-009 and AVEN-010 integration

- AVEN-009 (Typed Owner Model) will implement `owner_state` and `procedure`
  sources that adapt typed, provenance-carrying, lifecycle-managed state into
  candidates, define how evidence signals map to `confidence` and `salience`,
  and verify lifecycle and promotion claims before offering them.
- AVEN-010 (corrections and immediate session override) will produce
  supersession transitions and correction-derived `negativeRetrieval` values,
  and decide how session-wide overrides are represented (D6). The broker will
  consume them unchanged.
- Later fast-loop work will serialize a bundle into model input and decide
  whether to project it into the AVEN-002 `TaskContext` (D8).

AVEN-009 and AVEN-010 were **not** started.

## 27. Branch and handoff

Candidate commits are on an isolated branch only, to persist the cloud work for
review. `main` was not changed, no tag was created (in particular no `aven-008`
tag), nothing was merged and no history was rewritten. The commit and branch
identifiers are reported in the handoff message.
