# Post-AVEN-010 owner-first commit attribution

Status: owner-authorized attribution-policy maintenance candidate; not part of
AVEN-010 or AVEN-011. The frozen `aven-010` tag and all earlier commit IDs
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
For a merge of this policy candidate, preserve individual commits and do not
alter the `aven-010` tag. AVEN-011 implementation remains unauthorized until the
owner explicitly begins that milestone.

`pnpm attribution:check` is the new combined gate: it preserves the immutable
AVEN-009-to-010 audit using the old evaluator, then checks all post-freeze
commits under the new policy. The old AVEN-010 CLI remains in the repository for
historical reproducibility; do not use it on new branch HEADs because its frozen
email policy intentionally rejects GitHub's authenticated noreply alias.

## Frozen tests versus future tests

AVEN-010's repository-layout and attribution tests deliberately assert exact
historical filenames and package scripts. Those tests remain **byte-identical**
and are run from an isolated checkout at annotated tag `aven-010`, using its
original complete `check` command (including all 1,899 tests at that tag).
Future-checkout `pnpm test` excludes only five historically scoped test files:
`packages/corrections/test/frozen-layers.test.ts`,
`tooling/tests/repository-maintenance.test.ts`,
`tooling/tests/aven-008-frozen-layers.test.ts`,
`tooling/tests/aven-009-frozen-layers.test.ts`, and
`tooling/attribution/attribution.test.ts`.
Every other existing functional test runs against the new checkout.

The successor gate separately verifies exact annotated tag objects, complete
linear AVEN-009-to-010 attribution, owner-first commits after the tag, and a
narrow exact file/change-type allowlist against the AVEN-010 tree. Its allowlist
must be versioned and independently reviewed before future milestones change
additional files. Changes to runtime, Ledger, Root, evaluations, and frozen
source are **not** allowed by this maintenance candidate.

`pnpm check` retains the MAINT-001 composition of format-check, typecheck,
experiment-check and current-checkout tests. `pnpm attribution:check` is the
separate mandatory postfreeze history gate. CI runs both checks and the
historical full-suite check from the original tag; no historical assertions
are deleted or weakened.

The post-freeze gate enforces owner author/committer identity and a Claude
co-author trailer for the policy/AI-assisted series; if owner-only commits are
later needed, propose an independently tested, explicitly authorized versioned
exception first. Do not silently relax the check.
