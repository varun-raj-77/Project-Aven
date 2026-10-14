# Post-AVEN-010 owner-first commit attribution

Status: owner-authorized attribution-policy maintenance, merged to `main` at
`c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be`, extended by the AVEN-011 Patch 1
candidate with file governance for the AVEN-011 milestone (gate version
`aven-011-governance-v1`). The frozen `aven-010` tag and all earlier commit IDs
remain unchanged. This document supersedes the AVEN-010-specific D11 authorship
choice **only for commits after** `76535d8647ee36e56bd2efd1a86642d1fc572ee7`.

## Required identity for new Aven commits

- Primary **author**: `Varun Karthik` or `varun-raj-77`, with either the owner's
  verified `varunraj2117@gmail.com` email or GitHub's authenticated
  account-linked `71327884+varun-raj-77@users.noreply.github.com` address.
  GitHub's Contents API uses the latter by default; the API independently
  resolved both author and committer of the first two maintenance commits to
  GitHub user `varun-raj-77`.
- **Committer**: the same owner account identity (one of those two accepted
  names and one of those two recognized emails).
- AI assistance must remain transparent: for commits assisted by Claude, append
  exactly one valid Git trailer:
  `Co-authored-by: Claude <noreply@anthropic.com>`.
- Never attribute a commit to the owner without the owner's authorization and
  review; do not use an owner identity for changes made independently without
  their direction.
- Keep every patch as a separate, linear, inspectable commit; no squash, rebase,
  force-push, synthetic activity, or rewriting frozen milestone tags.
- A valid Git commit is **not** proof the GitHub contribution graph has updated.
  Verify the GitHub API author/committer mapping after the first commit, and
  verify profile counting separately when GitHub has indexed the activity.

## Operator preflight before any future commit

On the checkout used to create the commit, verify the repository-local identity:

```powershell
git config --local user.name "Varun Karthik"
git config --local user.email "varunraj2117@gmail.com"
git config --local --get user.name
git config --local --get user.email
```

For each Claude-assisted commit, put this trailer in the **final trailer block**
of the commit message:

```text
Co-authored-by: Claude <noreply@anthropic.com>
```

Before pushing, inspect the resulting commit and run both the immutable
AVEN-010-era gate and the new post-freeze gate:

```powershell
git show -s --format=fuller HEAD
git log -1 --format=%B HEAD
pnpm attribution:check
pnpm attribution:self-test
```

Stop if any check fails; repair only an **unpushed** candidate and re-review.
Never alter the `aven-010` tag. Stage explicit paths only; never stage untracked
local directories.

`pnpm attribution:check` is the combined gate: it preserves the immutable
AVEN-009-to-010 audit using the old evaluator, then checks all post-freeze
commits under the new policy. The old AVEN-010 CLI remains in the repository for
historical reproducibility; do not use it on new branch HEADs because its frozen
email policy intentionally rejects GitHub's authenticated noreply alias.

## AVEN-011 file governance (`aven-011-governance-v1`)

The gate audits every commit after `aven-010` in two eras. The **history era**
is the 28 maintenance commits up to and including the baseline `c8b83ec`, which
is pinned and must be an ancestor of `HEAD`. The **AVEN-011 era** is every
commit after the baseline. Two separate comparisons run at **every** post-freeze
commit, not only at the branch tip, so a temporary unauthorized change that a
later commit restores is still rejected:

- **Cumulative** status: `aven-010` against the checked commit.
- **Per-commit** status: the checked commit against its single parent.

Cumulative statuses (exact paths, no wildcards):

| Path                                                 | Cumulative | Allowlist                    |
| ---------------------------------------------------- | ---------- | ---------------------------- |
| `tooling/attribution/check-post-aven010.mjs`         | A          | historical maintenance       |
| `docs/POST_AVEN010_COMMIT_ATTRIBUTION.md`            | A          | historical maintenance       |
| `.github/workflows/owner-first-attribution.yml`      | A          | historical maintenance       |
| `AGENTS.md`, `package.json`                          | M          | historical maintenance       |
| `README.md`, `docs/ROADMAP.md`, `pnpm-lock.yaml`     | M          | AVEN-011 only                |
| `docs/AVEN_011_REPORT.md`                            | A          | AVEN-011 only                |
| the 26 enumerated `packages/action-proposals/` files | A          | AVEN-011 only (listed in it) |

Per-commit statuses:

- History era: each governance file may be added (`A`) when it first appears, as
  the real history did (`a439567` the policy document, `6053a91` the gate,
  `bf06107` the workflow), and is modified (`M`) afterwards; `AGENTS.md` and
  `package.json` are `M` only. Nothing else may change.
- AVEN-011 era: the governance files already exist, so they are `M` only, and
  only in governance-only commits (which may also touch `AGENTS.md`). The five
  shared files are `M` only. The report and the 26 package files are `A` when
  their parent lacks them and `M` afterwards.
- Always rejected: deletions, renames (they appear as a deletion), type changes,
  and any mode other than `100644` (executables, symlinks, submodules).

The allowlist data cannot open a frozen file on its own: the gate fails unless
every added path is absent from the `aven-010` tree and every modified path is
one of `AGENTS.md`, `README.md`, `docs/ROADMAP.md`, `package.json` or
`pnpm-lock.yaml`.

Content states, checked at every AVEN-011-era commit against the baseline:

- `package.json` is **P0** (byte-identical) or **P1**: the canonical
  two-space-JSON rendering of the baseline with only the approved AVEN-011
  description and/or the single insertion of
  ` && tsc --project packages/action-proposals/tsconfig.json --noEmit`
  immediately after the corrections project check in **both**
  `scripts.typecheck` and `scripts.check`. Dependencies, test exclusions and
  every other field stay identical.
- `pnpm-lock.yaml` is **L0** (byte-identical) or **L1**: the baseline with
  exactly one `packages/action-proposals` importer block inserted immediately
  before `packages/baseline`, in the exact pnpm 11.19.0 rendering, linking only
  `@aven/contracts` (Patch 2) or `@aven/contracts`, `@aven/ledger` and
  `@aven/storage` (Patch 3), plus `zod` 4.6.5, `typescript` 5.9.3 and `vitest`
  4.0.18. Patch 1 is P0 and L0.

## Trusted evaluator for the isolated milestone branch

AVEN-011 patches are committed by the owner on the isolated branch
`aven-011/action-proposals`, never merged into `main` during the milestone.
Candidate CI is advisory: a candidate can change its own gate and workflow. A
reviewer therefore runs a **trusted** copy of the gate on their own machine:

- Patch 1 is evaluated with the gate from the baseline `c8b83ec` (blob
  `d909d3ea9fb3967b3d2311998f0158ff586aba53`).
- After the owner-created Patch 1 commit is independently accepted, its exact
  SHA becomes the trusted reference `T`. Patches 2 to 6 are evaluated with the
  gate from `T`, run with `--governance-frozen-at T`, which rejects any change
  to a governance file after `T`.

The trusted SHA is always supplied on the command line by the reviewer; the gate
never reads it from the repository. Procedure (POSIX shell; `X` is the candidate
commit, `T` the trusted reference):

```sh
git fetch origin --tags
git merge-base --is-ancestor c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be "$X"
git merge-base --is-ancestor "$T" "$X"
test -z "$(git rev-list --merges c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be.."$X")"
git worktree add --detach ../aven-trusted-eval "$X"
git -C ../aven-trusted-eval checkout "$T" -- \
  tooling/attribution/check-post-aven010.mjs tooling/attribution/attribution.ts
git -C ../aven-trusted-eval hash-object tooling/attribution/check-post-aven010.mjs
git rev-parse "$T:tooling/attribution/check-post-aven010.mjs"   # must match
node ../aven-trusted-eval/tooling/attribution/check-post-aven010.mjs --self-test
node ../aven-trusted-eval/tooling/attribution/check-post-aven010.mjs \
  --governance-frozen-at "$T"   # omit this option when T is c8b83ec
git diff-tree -r --no-renames --name-status <previous accepted SHA> "$X"
git worktree remove --force ../aven-trusted-eval
```

The gate only reads commits, so the two files checked out from `T` into the
disposable worktree do not affect what is evaluated. The successor gate prints
the Git blob IDs of the evaluator files it loaded; compare them with `T`. The
final `diff-tree` must list exactly the accepted file inventory of that patch.

## Frozen tests versus future tests

AVEN-010's repository-layout and attribution tests deliberately assert exact
historical filenames and package scripts. Those tests remain **byte-identical**
and are run from an isolated checkout at annotated tag `aven-010`, using its
original complete `check` command (including all 1,899 tests at that tag).
Future-checkout `pnpm test` excludes only six historically scoped test files:
`packages/corrections/test/frozen-layers.test.ts`,
`packages/corrections/test/boundaries.test.ts`,
`tooling/tests/repository-maintenance.test.ts`,
`tooling/tests/aven-008-frozen-layers.test.ts`,
`tooling/tests/aven-009-frozen-layers.test.ts`, and
`tooling/attribution/attribution.test.ts`. Every other existing functional test
runs against the new checkout.

The successor gate separately verifies exact annotated tag objects, complete
linear AVEN-009-to-010 attribution, owner-first commits after the tag, and the
exact versioned file governance above. Changes to runtime, Ledger, Root,
evaluations, frozen source and frozen tests are **not** allowed. Any later
change to the allowlist is a governance change that needs its own independent
review and a new trusted reference.

`pnpm check` retains the MAINT-001 composition of format-check, typecheck,
experiment-check and current-checkout tests. `pnpm attribution:check` is the
separate mandatory postfreeze history gate. `pnpm attribution:self-test` runs
the owner-first cases, CLI argument checks and a synthetic Git-history campaign
(temporary repositories built with `git fast-import` under isolated Git
configuration; each violation is a passing control plus one defect, run through
the gate's CLI entry point in a child process). CI runs the checks and the
historical full-suite check from the original tag; no historical assertions are
deleted or weakened.

The post-freeze gate enforces owner author/committer identity and a Claude
co-author trailer for the policy/AI-assisted series; if owner-only commits are
later needed, propose an independently tested, explicitly authorized versioned
exception first. Do not silently relax the check.

## Limitations

- The gate audits recorded Git metadata, trees and blobs. It does not
  authenticate who operated Git; author and committer fields can be set by
  anyone who can create a commit.
- It is not a sandbox. Its protection against a weakened gate rests on a
  reviewer running a trusted copy from an independent checkout; GitHub branch
  protection and required checks are outside the repository.
- The synthetic campaign drives the same `main` entry point with fixture
  constants, because synthetic histories cannot reproduce the pinned real SHAs.
  The real constants are exercised only by running the gate on the real
  repository.
