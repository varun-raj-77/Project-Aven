# @aven/context-broker (AVEN-008)

Context Broker (configuration `aven-008-context-broker-config-v2`):
deterministic, owner-scoped, inspectable and budgeted **task-specific context
assembly**. Context is not memory. The broker takes one request and the
transient candidates that injected sources offer for it, and returns a
`ContextBundle` (selected context for that one task) plus an observable trace of
the computation.

It is read/compute-only. It owns no storage, appends nothing to the Ledger,
persists no score, signal or selection, mutates no source, creates no learned
owner state, correction or negative signal, calls no model or network, and makes
no permission decision. Its only dependencies are `@aven/contracts` and `zod`.
It does not use the AVEN-007 baseline (`@aven/baseline`) or the AVEN-006 runtime
(`@aven/runtime`).

```ts
import { createContextBroker } from '@aven/context-broker';

const broker = createContextBroker({
  sources: [ownerStateSource, episodeSource],
});
const { bundle, trace } = await broker.assemble({
  ownerId: 'owner_example',
  task: { sessionId: 'session_example', taskId: 'task_example' },
  request: 'Draft the recruiter reply',
  referenceTime: '2026-10-06T12:00:00Z',
  taskDescriptor: {
    domain: 'professional outreach',
    qualifiers: { recipient: 'recruiter' },
  },
});
// `bundle.items` is data for one task. It is not a prompt, not owner memory
// and not authority.
```

## Modules

| Module         | Responsibility                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `config.ts`    | `CONTEXT_BROKER_CONFIG_V2` (deep-frozen): weights, factor tables, half-life, budgets, deadline, limits (pinned) |
| `deadline.ts`  | The source-collection deadline: the only module with a timer; never feeds ranking                               |
| `types.ts`     | Strict Zod schemas: `ContextRequest`, `ContextCandidate` (reusing frozen AVEN-002 schemas), signals, IDs        |
| `errors.ts`    | `ContextBrokerError` with a fixed code and message per code and no `cause`                                      |
| `relevance.ts` | Tokenizer v1 and unique-query-term coverage (`aven-008-lexical-coverage-v1`)                                    |
| `scope.ts`     | Declarative scope rules v2 (every declared restriction must be satisfied) and task-binding matching             |
| `ranking.ts`   | Provenance, trust and freshness factors; the weighted composite and negative penalty                            |
| `broker.ts`    | `createContextBroker`: guarded source reads, isolation, quotas, validation, dedup, eligibility, ranking, budget |
| `util.ts`      | Code-point helpers, code-unit comparison, score rounding, deep freeze                                           |

## Candidates and sources

A `ContextCandidate` is a transient retrieval view, never durable owner state:
`candidateId`, `ownerId`, `reference` (an AVEN-002 `ContextSource`: evidence,
owner state with its lifecycle, active task state or current instruction),
`provenance` (AVEN-002 `Provenance`), `scope` (AVEN-002 `Scope`), `text`,
`timestamps` (`recordedAt`, optional `lastValidatedAt`) and `signals`
(`confidence`, `salience`, `negativeRetrieval`, each finite in [0, 1]). The
schema is strict; unknown fields fail closed.

A `ContextSource` is registered by a trusted caller with a `sourceId` and a
`kind` (`owner_state`, `episode_history`, `procedure`, `active_task`,
`permitted_external`) and implements `collect(query, { signal })`. One 5000 ms
deadline per call bounds every source (`source_timeout`; the `signal` aborts at
the deadline). Each kind may return only its declared reference kinds;
`permitted_external` may return only evidence with `external_content` or
`tool_result` provenance. Any source failure, malformed collection, malformed
candidate or limit breach fails the whole assembly with a typed error with a
fixed message and no `cause`; adapter exceptions, getters, proxies and sparse
arrays never leak raw errors. No partial bundle is returned.

## Selection

1. Bounds and isolation: a raw resource limit (10000 items per source, 40000 in
   total) is checked on length alone. Recognizable foreign-owner records are
   then dropped before owner-context quotas (500 per source, 2000 in total),
   validation, deduplication and any statistic, and leave no trace. Owner-origin
   provenance must name the candidate's owner, and direct owner evidence must
   cite its own event.
2. Identity deduplication: the same candidate ID, evidence ID, or learned item
   plus version keeps one slot. Disagreeing duplicates fail closed.
3. Eligibility, in this order: not a duplicate, not superseded, not revoked, not
   timestamped after `referenceTime`, matching task binding, no explicit scope
   mismatch, no unresolved declared scope restriction, negative signal below 1,
   and at least one relevance channel (a matched content term, an exact task
   match, or a fully matched scope label).
4. Ranking (unchanged):
   `composite = 0.40 relevance + 0.20 scope + 0.10 provenance + 0.10 confidence + 0.07 freshness + 0.07 salience + 0.06 trust`,
   then `final = composite * (1 - negativeRetrieval)`. Ties: `sourceId`, then
   `candidateId`, by code unit.
5. Budget: each item is cut to 1600 code points (relevance is judged on that
   included text). Ranked items that do not fit the remaining characters are
   skipped and later items still considered, up to 10 items and 10000 code
   points; survivors keep rank order.

The trace holds owner-local IDs, reason codes, counts and numbers only: no item
text, no request-derived terms and nothing about other owners. It is not a safe
place for secrets, because caller-chosen IDs appear verbatim.

See `docs/AVEN_008_REPORT.md` for the full specification, factor tables,
limitations and test evidence. Run:

```sh
pnpm --filter @aven/context-broker test
```

Tests use explicitly synthetic fixtures and in-memory sources. They are
mechanics checks, not evidence that a foundation model will use the selected
context correctly, and not a C-versus-B result.
