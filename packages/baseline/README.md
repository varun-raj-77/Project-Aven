# @aven/baseline (AVEN-007)

The experiment's two baseline conditions over the frozen AVEN-006
`ModelRuntime`:

- **A, `fresh`**: same runtime, same base prompt, same current request, an empty
  profile and empty history. It measures raw model capability inside the same
  execution envelope.
- **B, `naive_personalized`**: the same, plus an explicit editable owner profile
  and deterministic lexical search over the owner's interaction history. It is
  the strong, simple baseline that governed Aven (C) must beat.

C is not implemented here. Nothing in this package learns, persists, writes the
Ledger or storage, grants authority, or calls a network or provider.

## Modules

| Module              | Responsibility                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`         | `BASELINE_CONFIG_V2`: budgets, BM25 parameters, tokenizer v2, ordering and precedence (mirrored in the manifest)                                                                   |
| `types.ts`          | Strict Zod schemas: profile entry `{ id, text }`, profile, history record, `BaselineInput`                                                                                         |
| `profile.ts`        | Pure, explicit add/edit/remove and the deterministic profile budget                                                                                                                |
| `history-search.ts` | `NaiveHistorySearch`: tokenizer v2, BM25, owner filtering, budgets. Not the AVEN-008 Context Broker                                                                                |
| `prompt.ts`         | `BASELINE_SYSTEM_PROMPT_V1`, JSON context serialization, message assembly                                                                                                          |
| `runner.ts`         | `createBaselineHarness`: one runtime/timeout for both conditions; returns an observable `BaselineTrace`                                                                            |
| `dataset.ts`        | Case-input schema; `loadBaselineCases` (development only unless held-out is requested); `parseAllBaselineCasesForValidation` (raw, all splits, validation only); `toBaselineInput` |
| `run-record.ts`     | Serializable per-run record for future evaluation work (no hidden reasoning, never owner state)                                                                                    |

## Behavior

The profile is an owner-ordered list of free-text entries, each at most 1000
characters. Up to 64 entries are allowed. Scope, if any, is written in the text
itself, for example "For recruiter outreach, keep messages concise". The profile
changes only when a caller supplies a different profile. Model output and
history never edit it. Context budget: 4000 code points, taken as an owner-order
prefix and cut at an entry boundary.

History search uses the current request as the query and BM25 with k1 = 1.2, b =
0.75, IDF `ln(1 + (N - df + 0.5)/(df + 0.5))`, top-K 8. Only records of the
requesting owner are scored, and other owners never affect the statistics. Only
strictly positive scores are kept. Ordering is score descending, then
`occurredAt` descending (tie-break only), then `eventId` ascending. Each item is
cut to 1200 code points, and the history budget of 6000 code points is a
rank-order prefix.

Tokenizer v2 applies NFKC normalization, locale-independent lowercasing, and
expansion of negative contractions ("don't" becomes "do not", "cannot" becomes
"can not"). It then splits on anything that is not a letter, combining mark or
number, removes the 107 words listed in `STOPWORDS_V2`, and applies the Harman S
stemmer. `STOPWORDS_V2` holds articles, pronouns, auxiliaries and modals, common
prepositions and conjunctions, question words, a few intensifiers, "please" and
contraction fragments; every other word is kept. Tokenizer v1 also removed
negation, restriction, scope, ordering and temporal words such as "not", "only",
"before", "after" and "until". Review finding H1 showed that this collapsed
contrasts like "do send" versus "do not send", so v2 keeps them. This preserves
lexical evidence only: BM25 still does not understand negation. Modal verbs
remain stopwords. Known S-stemmer artifacts: "boxes" becomes "boxe", "ties"
becomes "ty", "series" becomes "sery", "news" becomes "new".

The model receives three messages: the shared base prompt (system), a
`BASELINE_CONTEXT_V1` system message with a JSON payload `{ profile, history }`
(both empty for A), and the verbatim current request (user). The prompt's fixed
precedence is current request > profile > retrieved history. Context text is
quoted data and grants nothing.

Fairness: the harness binds one injected runtime object, one call path, one
request shape and one timeout for both conditions. It cannot guarantee that a
custom runtime behaves identically across calls, so real-model paired runs
should compare each trace's reported `runtimeStamp` and `modelConfiguration`.

Dataset loading: `loadBaselineCases(text)` returns development cases only.
Held-out cases need `{ split: 'held_out' }` or `{ includeHeldOut: true }`.
`parseAllBaselineCasesForValidation` returns every split and is for validation
tooling only. This is research-discipline friction, not access control.

Runtime failures keep the AVEN-006 normalized codes and produce a `failed`
trace. Malformed input raises `BaselineError` before any runtime call.

Tests use `@aven/runtime/testing` from test code only. Scripted-runtime runs
validate mechanics and are not experimental results. Run:
`pnpm --filter @aven/baseline test`.
