# AVEN-007-DATASET-001 (version 2.0.0)

A prebuilt, **synthetic** benchmark for the A (Fresh) and B (Naive Personalized)
baselines, and later for the governed condition C. Version 2 replaces the
independently reviewed v1 candidate before any freeze. The v1 files are
preserved byte-for-byte in [`reviewed-v1/`](reviewed-v1/README.md) as review
evidence. **No model has been run on either version**: `manifest.json` records
`execution.status: not_run` and `results: null`.

## Files

| File                        | Role                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cases.jsonl`               | Model-visible inputs, one case per line: `caseId`, `scenarioFamilyId`, `split`, `category`, `ownerId`, `profile`, `history`, `request`                 |
| `oracle.jsonl`              | Scorer-only. `behavior` (primary correctness definition) and `contextDiagnostics` (diagnostic labels only), one row per case in case order             |
| `b-mechanics-controls.json` | Scorer-only. Cases whose purpose needs B's lexical search to expose specific history (or none). Checks B mechanics; never a behavioral criterion for C |
| `construction.json`         | Scorer-only. Construction intent recorded before diagnostics: designed lexical overlap, size class and top-K competition records per case              |
| `diagnostics.json`          | Scorer-only. Lexical construction diagnostics per split, recomputed and compared by the validator                                                      |
| `manifest.json`             | Counts, split policy, `BASELINE_CONFIG_V2`, prompt and stopword hashes, SHA-256 of every file above, the record of superseded v1, execution status     |
| `reviewed-v1/`              | The reviewed v1 candidate, byte-identical, never used for development or evaluation                                                                    |

Only `ownerId`, `request`, `profile` and `history` can reach prompt assembly
(`toBaselineInput` in `@aven/baseline`). The case ID, family, split and category
are bookkeeping. The production baseline package reads no file and never sees
any scorer-only file. A sentinel test plants unique strings in every oracle and
control field and checks that none reaches a runtime request.

## Oracle contract

`behavior` holds the correctness definition:

- `expectedBehaviorClass`
- `requiredBehavior`
- `forbiddenBehavior`
- `acceptableAlternatives`: defensible behaviors that are not failures.
- `scorerNotes`

It never names raw context IDs, and the validator rejects any that do.

`contextDiagnostics` labels every profile entry and history record of the case
exactly once, as supporting, stale-or-conflicting, or distractor. These labels
exist to inspect B's mechanics. They do **not** mean that a future system must
retrieve those exact raw IDs, and retrieving stale or conflicting evidence is
not by itself wrong. Condition C may use derived state, extra evidence or a
different representation. C must not be coupled to B's profile representation or
BM25 ranking.

## Structure

- 64 cases = 32 scenario families × 2 variants (a paraphrase or nearby task
  testing the same principle). The two variants have their own, variant-specific
  requirements.
- 8 categories × 4 families: `preference_application`,
  `preference_non_application`, `procedure_application`,
  `changed_or_stale_preference`, `conflict_or_ambiguity`, `episodic_recall`,
  `disagreement_preservation`, `irrelevant_history_resistance`.
- Per category there are 3 development families (6 cases) and 1 held-out family
  (2 cases). Totals: 48 development and 16 held-out (25%). The split unit is the
  family, and a family never spans splits.
- IDs: family `aven007-<cc>-<nn>`, case `<family>-v1|v2`, synthetic owner
  `owner_syn_<cc><nn>`, history `event_syn_...`, profile entry `pentry_...`.

## v2 construction principles (fixed before any v2 diagnostic)

1. **Diverse distractors.** Every family has its own near-miss distractors that
   share request words, plus a disjoint slice of unique filler lines. No history
   text appears in two families.
2. **Retrieval competition.** Corpus sizes follow a fixed cycle (6, 10 or 16
   records) assigned by case position, independent of split. A fixed competition
   set of 6/48 development and 2/16 held-out cases adds 8 lexically overlapping
   distractors each, so top-K ranking matters. This set was added after the
   first v2 draft had no case with more positive candidates than top-K.
3. **Mixed lexical difficulty in both splits.** The primary supporting record is
   designed with high (3 or more shared content tokens), partial (1–2) or low
   (0) overlap with the request. Both splits contain all three levels. Relevant
   history is not required to be retrievable by BM25.
4. **Balanced distractor overlap.** Near-miss counts depend on size class only,
   never on split.
5. **Category meaning preserved.** Each held-out family tests the same concept
   as its category's development families without paraphrasing them.
6. **Exposure only where the purpose needs it.** 22 cases have B-mechanics
   exposure controls: injected, permission and homonym history that must be
   retrieved, zero-overlap cases that must retrieve nothing, and the
   stale-versus-current and conflict cases whose mechanism needs history in
   view.

`diagnostics.json` reports lexical diagnostics for each split. They are **not
model accuracy and not targets**. They exist to detect systematic imbalance,
such as v1's held-out split, where every relevant record was retrievable.

## Held-out policy and EXP-001

The held-out split is **frozen but NOT secret**. It is version-controlled in
this repository. `loadBaselineCases` returns development cases unless
`{ split: 'held_out' }` or `{ includeHeldOut: true }` is passed. Raw access to
every split is available only through `parseAllBaselineCasesForValidation`,
which exists for validation tooling. This is research-discipline friction, not
access control and not an eval vault.

This dataset is a separate AVEN-007 baseline and evaluation-development asset.
Its 48/16 split does **not** alter EXP-001. The 16 held-out cases are **not**
promotion-eval data, **not** EXP-001's final held-out set and **not** a
substitute for the future Root-protected evaluation vault. A later, explicit
EXP-001 protocol freeze must allocate its own development, promotion-eval and
final held-out resources. These 16 cases may not be reused automatically for any
of them.

## Synthetic data

Every owner, profile note, history record, organization, venue, book and product
name is fictional. Public city names are generic places only. No real person's
private life, contact details, health, immigration status, relationships,
employment correspondence or accounts are encoded. A validator tripwire rejects
email-, phone- and SSN-like strings in model-visible text.

## Validation

`pnpm dataset:check` and `tooling/tests/aven-007-dataset.test.ts` fail closed on
any problem with:

- counts, splits, family integrity or category balance;
- ID formats or cross-family text reuse;
- the oracle (one-to-one coverage, the behavior/diagnostic separation,
  exhaustive labels);
- the exposure controls or the recomputed diagnostics;
- `BASELINE_CONFIG_V2`, the prompt or stopword hashes, or any file hash;
- the byte identity of `reviewed-v1/`.
