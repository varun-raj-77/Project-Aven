# Evaluation scaffolding

`datasets/`, `held-out/`, `scorers/`, and `regression/` are empty placeholders.
No fixtures, private cases, scorers, or runtime regression suite are
implemented. The root Vitest tests validate bootstrap metadata only.

Later dataset records need owner/fixture identity, consent or synthetic label,
episode/scenario group, source references, expected scope/application and
non-application, oracle rubric, split, and version/hash. Related variants must
stay in one split. A/B/C share test cases and per-comparison model
configurations.

Development, promotion-eval, and final held-out are distinct. Root controls the
protected vault; learners cannot read final cases or feedback. Do not mistake
`held-out/` or `.gitignore` for access control. Commit safe synthetic
reproducibility artifacts only after inspection; private data belongs in
protected local storage.

Future scoring must measure completion, correct non-application, repeated
corrections/clarification, scope and retrieval errors, episodic recall,
disagreement, attempted versus executed unauthorized actions, stop compliance,
provenance, rollback/rebuild, owner minutes, latency, and cost. Freeze scorers
independently of candidate generation. Preserve regressions and negative
outcomes.
