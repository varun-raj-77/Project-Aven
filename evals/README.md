# Evaluation scaffolding

`aven-007/` holds the synthetic AVEN-007 dataset version 2 (64 cases, 32
families, 48 development / 16 held-out) with model-visible `cases.jsonl`,
scorer-only oracle, exposure-control, construction and diagnostics files, a
hash-checked manifest, and the byte-identical archive of the reviewed v1
candidate; see its README. Its held-out split is frozen but not secret and is
not EXP-001 promotion-eval or final held-out data. `datasets/`, `held-out/`,
`scorers/`, and `regression/` remain empty placeholders. No scorer or runtime
regression suite is implemented, and no model has been run on any case.

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
