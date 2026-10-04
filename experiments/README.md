# Experiments

Each experiment keeps a falsifiable hypothesis, competing/null hypothesis,
machine-readable manifest, and protocol. EXP-001 is a **draft, not run**. No
datasets, scores, learned owner state, or study results exist yet.

Preserve three systems: A Fresh, B Naive Personalized with editable scoped
profile and searchable history, and C Governed Learned Aven. C must materially
beat B. Baseline quality, fixed Root authority, equal model configurations,
held-out protection, independent scoring, failed runs, and supervision/cost
accounting are part of the experiment, not optional polish.

`pnpm experiment:check` validates draft metadata. It does not run an evaluator,
freeze artifacts, implement a vault, or assert security. A frozen manifest
requires concrete model, dataset/split, Root policy, scorer, implementation, and
protocol hashes. Final held-out cases cannot feed candidate learning/promotion
evaluation. Changing a frozen protocol requires a new revision and an explicit
reason before seeing the replacement final cases; do not overwrite earlier
outcomes.

Future run records go in `results/` following its README. Private data belongs
in controlled local storage, never this source scaffold.
