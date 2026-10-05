# MAINT-001 — Source-artifact bytes and Corepack-safe scripts

Status: **READY TO FREEZE MAINT-001** (uncommitted, awaiting review). Base:
`54b0d1a` (`aven-004`, `main`, `origin/main`). This is repository maintenance
between AVEN-004 and AVEN-005. It does not start AVEN-005 and changes no Aven
architecture, contract, storage, Ledger, or EXP-001 meaning.

## 1. Original problem

1. `docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt` appeared modified on
   checkouts that re-hash files (reported in `docs/AVEN_004_REPORT.md`,
   section 2) but clean on the owner's Windows checkout.
2. On the owner's Windows machine `pnpm` is not on `PATH`, while
   `corepack pnpm …` runs the pinned pnpm `11.19.0`. `corepack pnpm test` worked
   but `corepack pnpm check` failed because root scripts called a nested plain
   `pnpm`.

## 2. Verified root causes

### Source artifact

Verified from the owner's working tree and the Git objects at `aven-004`:

| Item                           | Value                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| On-disk bytes                  | 15,519 bytes; 603 CRLF, 0 bare LF, 0 bare CR; no final newline; no BOM     |
| On-disk SHA-256                | `3D8CAD37688476E0F9C0501D9A597A8B2EC038E490F8C9219C5B385BDE159EC4`         |
| Recorded SHA-256               | Same value, `docs/REPOSITORY_INSPECTION.md` (AVEN-001)                     |
| Blob at `aven-001`…`aven-004`  | `4eb7a7347bf71396ca8f9ee573e20e917cc250e3`, 14,916 bytes, 603 LF, 0 CR     |
| Blob with LF→CRLF              | Reproduces the recorded SHA-256 exactly (content otherwise identical)      |
| Raw blob of on-disk bytes      | `cd8d9594b8016c35381a3e2ec583268fcbef333f`                                 |
| Every other tracked file (104) | On-disk bytes identical to the `aven-004` blob                             |
| PDF                            | Disk = blob `323aaa10…`; SHA-256 `D76E014F…E446` matches record; untouched |

Cause: the AVEN-001 commit had no `.gitattributes`, and the file was stored with
LF line endings (consistent with a CRLF-normalizing Git setting at that time;
the owner's global Git configuration was not inspected). AVEN-002 added
`docs/sources/** -text`, which stops future conversion but does not rewrite an
existing blob. The file was never re-staged. On Windows the index stat cache
still matched the untouched file, so Git never re-hashed it and reported it
clean; checkouts that re-hash (for example Linux) showed it as modified.

This was reproduced in a scratch repository: a CRLF file committed under CRLF→LF
normalization, followed by a `-text` rule and a non-racy index, shows clean
status, a plain `git add` stages nothing, and `git add --renormalize` stages the
original CRLF bytes.

The existing `.gitattributes` rule was already the narrow, correct
byte-preservation rule. The remaining gaps were: the stale LF blob;
`git diff --check` treating each preserved CR as trailing whitespace; and
`.editorconfig` telling editors to convert this file to LF and add a final
newline.

### Scripts

Root `typecheck`, `check`, `db:migrate`, and `db:test` called `pnpm …`. pnpm
puts `node_modules/.bin` on the script `PATH` but not its own executable, so a
nested `pnpm` only works when a global `pnpm` exists. pnpm does set
`npm_execpath` to its entry point, but using it needs `$npm_execpath` in `sh`
and `%npm_execpath%` in `cmd.exe`, so it is not portable. Calling the tools
directly avoids the problem. Reproduced on Node `24.21.0` with Corepack and no
`pnpm` on `PATH`: `format:check`, `experiment:check`, `test`, and each
`--filter @aven/<pkg> typecheck` passed; `typecheck`, `check`, and `db:test`
failed with `pnpm: not found`.

## 3. Exact files changed

| File                                                  | Change                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt` | **Index/blob only.** Re-staged from the unchanged on-disk original; blob `4eb7a73` → `cd8d959`.                         |
| `.gitattributes`                                      | `docs/sources/** -text` → `docs/sources/** -text whitespace=cr-at-eol`, plus a comment line.                            |
| `.editorconfig`                                       | New `[docs/sources/**]` section unsetting `charset`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace`. |
| `package.json`                                        | Root `typecheck`, `check`, `db:migrate`, `db:test` call tools directly; no nested `pnpm`.                               |
| `tooling/tests/repository-maintenance.test.ts`        | New: 5 regression tests for script portability and source-artifact bytes.                                               |
| `README.md`                                           | One paragraph: use the `corepack` prefix when `pnpm` is not on `PATH`.                                                  |
| `docs/MAINT_001_REPORT.md`                            | This report.                                                                                                            |

Not changed: the PDF and its blob; the text of either source document; package
`package.json` files; `pnpm-lock.yaml`; `packageManager`/`engines`;
dependencies; tsconfig files; `vitest.config.ts`; any `src/`, `test/`, or
`migrations/` file; `experiments/`; `AGENTS.md`; principles, threat model,
roadmap, risk register; and previous milestone reports.

## 4. Line-ending / source-artifact fix

- `git add --renormalize -- "docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt"`
  stores the on-disk bytes. The staged blob is `cd8d9594…333f`, equal to
  `git hash-object --no-filters` of the original. `git ls-files --eol` reports
  `i/crlf w/crlf attr/-text`.
- `git diff --cached --ignore-cr-at-eol` for the file is empty: the change is
  line endings only.
- `whitespace=cr-at-eol` is scoped to `docs/sources/**`. It treats CR before LF
  as part of the line terminator. Other whitespace checks remain on, and no
  repository-wide line-ending handling changed (`* text=auto eol=lf` remains).
- The `.editorconfig` section is a guard only. It stops editors from rewriting
  frozen sources on save. It has no effect on Git or Prettier (`docs/sources/`
  is already Prettier-ignored).
- Fresh checkout: a scratch commit of these changes was cloned with
  `core.autocrlf=true`, `input`, and `false`. All three clones had a clean
  `git status`, file SHA-256 `3D8CAD37…159EC4`, and nothing changed after
  `git add --renormalize -A`.

## 5. Script / tooling fix

Root scripts now invoke the pinned binaries that pnpm already places on the
script `PATH` (`prettier`, `tsc`, `vitest`, `node`):

```json
"typecheck": "tsc --project tsconfig.json --noEmit && tsc --project packages/contracts/tsconfig.json --noEmit && tsc --project packages/storage/tsconfig.json --noEmit && tsc --project packages/ledger/tsconfig.json --noEmit",
"db:migrate": "node packages/storage/src/migrate-cli.ts",
"db:test": "vitest run --configLoader native packages/storage/test",
"check": "<format:check> && <typecheck> && <experiment:check> && <test>"
```

Equivalence:

- `tsc --project packages/<pkg>/tsconfig.json` is what each package's own
  `typecheck` runs. tsconfig `include`, `extends`, and `types` resolve relative
  to the tsconfig file, not the working directory, and the lockfile has one
  TypeScript (`5.9.3`). Package `typecheck` scripts are unchanged and still work
  with `--filter`.
- `db:test` is the storage package's `test` command without
  `--root ../.. --config vitest.config.ts` (the root default).
- `db:migrate` runs the same CLI. Its default database path comes from
  `import.meta.url`, so it is still `data/aven.sqlite`.
- `check` is exactly the four root scripts joined with `&&`. A test enforces
  this, so the inline copy cannot drift.

No dependency, runtime, Windows path, or shell-specific syntax was added. `&&`
works in both `sh` and `cmd.exe`. `packageManager: pnpm@11.19.0` is unchanged.

The new tests check that no package script calls
`pnpm`/`npm`/`npx`/`yarn`/`corepack`, that `check` matches its parts, that root
`typecheck` covers the root and every package with a `typecheck` script, that
the storage aliases match the storage package, and that both source artifacts
keep their recorded SHA-256 values.

## 6. Commands run

All runs used Linux, Node `24.21.0`, Corepack `0.36.0`, and pnpm `11.19.0`. The
"owner-like" environment had **no `pnpm` on `PATH`**. The working tree was a
reconstruction of the owner's repository from its Git objects. The 105 tracked
files were checked: 104 matched their blobs byte for byte, and the source file
differed only in line endings.

- Before the change (owner-like):
  `corepack pnpm install --frozen-lockfile --ignore-scripts`;
  `corepack pnpm check` / `typecheck` / `db:test` (FAIL, `pnpm: not found`);
  `corepack pnpm test` (300 pass); `format:check`, `experiment:check`, each
  `--filter @aven/<pkg> typecheck` (pass).
- After the change (owner-like): `corepack pnpm check`, `typecheck`,
  `format:check`, `experiment:check`, `test`, `db:test`, `db:migrate`,
  `db:migrate <absolute path>`;
  `corepack pnpm --filter @aven/{contracts,storage,ledger} typecheck`;
  `corepack pnpm --filter @aven/ledger test`;
  `corepack pnpm --filter @aven/contracts test --configLoader native`;
  `corepack pnpm --filter @aven/storage test`.
- After the change, with `pnpm` on `PATH` (Linux/macOS workflow): `pnpm check`,
  `pnpm typecheck`, `pnpm db:test`.
- Fault injection (restored afterwards): a type error in each of contracts,
  storage, Ledger, and root tooling; a failing Ledger test; a Prettier
  violation; an invalid EXP-001 manifest.
- Git: `git diff --check`, `git diff --cached --check`,
  `git diff --cached --ignore-cr-at-eol`, `git ls-files --eol`,
  `git check-attr -a`, fresh clones under three `core.autocrlf` values.

## 7. Results

| Check                                              | Result                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `corepack pnpm check` (no `pnpm` on `PATH`)        | **PASS**, exit 0, full pipeline                                                              |
| Formatting                                         | PASS                                                                                         |
| Root / contracts / storage / Ledger typecheck      | PASS (root script and each `--filter` script)                                                |
| Experiment check                                   | PASS; EXP-001 valid draft, `not_run`, results absent                                         |
| All tests                                          | **305 pass**: 300 baseline (60 Ledger, 73 storage, 155 contracts, 12 AVEN-001) + 5 MAINT-001 |
| `db:test` / `db:migrate`                           | PASS (73 tests; schema migrated to default and absolute paths)                               |
| `pnpm check` with `pnpm` on `PATH`                 | PASS, 305 tests                                                                              |
| Fault injection                                    | Every injected fault failed `check`/`test` with non-zero exit                                |
| `git diff --check` and `git diff --cached --check` | PASS (no output)                                                                             |
| Fresh clone, `autocrlf` true/input/false           | Clean status; source SHA-256 matches record                                                  |

## 8. Limitations

- Validation ran on Linux against a byte-verified reconstruction of the owner's
  repository. **`corepack pnpm check` has not been run on the owner's Windows
  machine** for this ticket. `cmd.exe` handles `&&` and forward-slash paths, but
  the Windows run is the remaining confirmation.
- `db:migrate <relative-path>` now resolves a relative path from the repository
  root instead of `packages/storage/`. The documented form,
  `pnpm --filter @aven/storage migrate <absolute-path>`, is unchanged, and the
  default path is unchanged.
- Root `typecheck` lists the three packages explicitly, as before. A new package
  must be added there; the regression test fails until it is.
- Whether a Windows Git setting caused the original LF normalization is
  inferred, not inspected. The fix does not depend on it.

## 9. Owner manual steps

Run these on the Windows checkout. The source file's bytes are already correct
on disk, but the stat cache hides the difference, so a plain `git add` may do
nothing:

```sh
git add --renormalize -- "docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt"
git add .gitattributes .editorconfig package.json README.md docs/MAINT_001_REPORT.md tooling/tests/repository-maintenance.test.ts
git ls-files -s -- "docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt"   # expect cd8d9594b8016c35381a3e2ec583268fcbef333f
git diff --cached --check
git diff --cached --ignore-cr-at-eol --stat -- "docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt"   # expect no output
corepack pnpm check   # expect exit 0 and 305 tests
git status
```

Then review, commit, and tag after approval. Nothing on the machine itself
(`PATH`, global pnpm, `corepack enable`, administrator rights) needs to change.

Do not start AVEN-005.
