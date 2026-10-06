# Reviewed v1 candidate (archived review evidence)

This directory preserves the AVEN-007 dataset **v1 candidate** byte-for-byte,
exactly as it was independently reviewed. It is **not** the current dataset and
**must not** be used for development, evaluation or tuning. No loader reads it;
only `pnpm dataset:check` hashes it.

| File            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `cases.jsonl`   | `162a879729293a28bad2afdec54936b66d0ad05aec56315afeed3295c1184cc8` |
| `oracle.jsonl`  | `5798eb24b68cffbc00ad40d9a76fd88ab8b7c83fd0a92800d19f18c0b388ff58` |
| `manifest.json` | `d6dc4bcdf3fbcb480f45222d2dc14aeaf7c3a8b0f4d4f60951570f8ba03f4205` |

The v1 manifest describes baseline configuration `aven-007-baseline-config-v1`
with tokenizer v1. Its stopword hash is
`74c2b0c091c094aa2b24a3a3d052e4585354891d78d88cdb0862ba239c71daae`.

History:

- v1 was never frozen as the final AVEN-007 benchmark. Its manifest field
  `contentStatus: "frozen"` described the candidate content, not an accepted
  freeze.
- v1 was independently reviewed (Codex verdict: ACCEPT WITH REQUIRED FIXES)
  before any condition C implementation and before any real-model result.
- It was superseded before freeze because of review findings H1–H3 and M1–M4
  (see `docs/AVEN_007_REPORT.md`, section 26).
- No C result existed when v2 was built. v2 was built from written
  construction principles. It was not tuned toward any B score, retrieval rate
  or outcome.

These files are excluded from formatting (`.prettierignore`), so their bytes
cannot change by accident.
