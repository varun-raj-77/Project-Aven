/**
 * Post-AVEN-010 owner-first attribution gate, extended by AVEN-011 Patch 1
 * with file governance for the AVEN-011 milestone and by AVEN-012 Patch 1
 * with a successor era for the AVEN-012 milestone (governance version
 * `aven-012-governance-v1`). Frozen milestones are read-only.
 *
 * It audits recorded Git metadata, trees and blobs only. It cannot
 * authenticate the person who operated Git, and it is tooling discipline, not
 * a sandbox: a reviewer must run a trusted copy of this file (see "Trusted
 * evaluator" in docs/POST_AVEN010_COMMIT_ATTRIBUTION.md). The trusted
 * reference for --governance-frozen-at is always supplied on the command line
 * by that reviewer, never read from the repository.
 *
 * Run:        node tooling/attribution/check-post-aven010.mjs
 * Frozen:     node tooling/attribution/check-post-aven010.mjs --governance-frozen-at <40-hex SHA>
 * Self-test:  node tooling/attribution/check-post-aven010.mjs --self-test
 *
 * Eras after aven-010: the historical maintenance era (through the AVEN-011
 * baseline), the closed AVEN-011 era (through the annotated `aven-011` tag)
 * and the open AVEN-012 era (every later commit). The first two are judged
 * exactly as `aven-011-governance-v1` judged them; the AVEN-011 era's
 * accepted trusted reference is pinned, so no later change can reopen it.
 *
 * Checks:
 *  1. complete (non-shallow) history; annotated aven-009, aven-010 and
 *     aven-011 tags at their pinned commits and tag objects; aven-009 ->
 *     aven-010 -> AVEN-011 baseline -> aven-011 -> HEAD ancestry; one linear
 *     single-parent chain;
 *  2. the 16 frozen AVEN-009..AVEN-010 commits with the unchanged evaluator;
 *  3. owner-first identity and exactly one Claude trailer on every later commit;
 *  4. at EVERY post-freeze commit: per-commit file statuses and modes (against
 *     its parent) and cumulative file statuses and modes (against aven-010
 *     through aven-011, and against aven-011 after it), using the historical
 *     maintenance allowlist up to and including the AVEN-011 baseline, the
 *     AVEN-011 allowlist through aven-011 and the AVEN-012 allowlist after it;
 *  5. governance files change only in governance-only commits;
 *  6. in the AVEN-011 era: package.json in state P0/P1, pnpm-lock.yaml in
 *     state L0/L1, exactly seven commits, and no governance change after the
 *     pinned AVEN-011 trusted reference;
 *  7. in the AVEN-012 era: package.json in state Q0/Q1, pnpm-lock.yaml in
 *     state K0/K1 (both against aven-011) and, when requested, no governance
 *     change after the trusted reference.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OWNER_CO_AUTHOR_TRAILER, evaluateCommit } from './attribution.ts';

const V9 = '80057a217adb90132c5b6bc1c6a5c0f798db08c5';
const V10 = '76535d8647ee36e56bd2efd1a86642d1fc572ee7';
/** Frozen AVEN-011 milestone commit (annotated tag `aven-011`). */
const V11 = '44ba416d90624be67fde2fab31c716e8298648bb';
const TAG_OBJECTS = Object.freeze({
  'aven-009': 'adb32a0be958cd03be6af7534438fe37cd5af6ec',
  'aven-010': '4ef575c28f78504e77db8bb7d39df1ba8eda5041',
  'aven-011': '56a0e883b17b03be080af50ce5f60c692d409b83',
});
/** Reviewed main tip before AVEN-011; the last commit judged as history. */
const AVEN_011_BASELINE = 'c8b83ecbc8a1cae8cdb9e7a0de237fdf5bc1f2be';
/**
 * The accepted AVEN-011 trusted reference T (AVEN-011 Patch 1). Pinned: no
 * governance file changed after it within the AVEN-011 era.
 */
const AVEN_011_TRUSTED = '3761c775b5650e353816b3395e4d71022398afd1';
/** Accepted AVEN-011 commits after the baseline, through aven-011. */
const AVEN_011_COUNT = 7;
const AVEN_011_GOVERNANCE_VERSION = 'aven-011-governance-v1';
const GOVERNANCE_VERSION = 'aven-012-governance-v1';
/**
 * Historical post-freeze maintenance allowlist: path -> cumulative status
 * against aven-010. Unchanged; it governs every commit up to the baseline.
 */
const MAINTENANCE_DELTA = Object.freeze({
  '.github/workflows/owner-first-attribution.yml': 'A',
  'AGENTS.md': 'M',
  'docs/POST_AVEN010_COMMIT_ATTRIBUTION.md': 'A',
  'package.json': 'M',
  'tooling/attribution/check-post-aven010.mjs': 'A',
});
/** Added once in history; afterwards only governance-only modifications. */
const GOVERNANCE_PATHS = Object.freeze([
  '.github/workflows/owner-first-attribution.yml',
  'docs/POST_AVEN010_COMMIT_ATTRIBUTION.md',
  'tooling/attribution/check-post-aven010.mjs',
]);
/** The only files present at aven-010 that any allowlist may let change. */
const SHARED_FILES = Object.freeze([
  'AGENTS.md',
  'README.md',
  'docs/ROADMAP.md',
  'package.json',
  'pnpm-lock.yaml',
]);
/** The 26 package files of the accepted six-patch AVEN-011 plan, exactly. */
const AVEN_011_PACKAGE_FILES = Object.freeze([
  'packages/action-proposals/package.json',
  'packages/action-proposals/tsconfig.json',
  'packages/action-proposals/README.md',
  'packages/action-proposals/src/index.ts',
  'packages/action-proposals/src/config.ts',
  'packages/action-proposals/src/errors.ts',
  'packages/action-proposals/src/inert.ts',
  'packages/action-proposals/src/canonical.ts',
  'packages/action-proposals/src/proposal.ts',
  'packages/action-proposals/src/inspect.ts',
  'packages/action-proposals/test/fixtures.ts',
  'packages/action-proposals/test/digest-vectors.json',
  'packages/action-proposals/test/boundaries.test.ts',
  'packages/action-proposals/test/errors.test.ts',
  'packages/action-proposals/test/canonical.test.ts',
  'packages/action-proposals/test/proposal.test.ts',
  'packages/action-proposals/src/ledger/index.ts',
  'packages/action-proposals/src/ledger/stored.ts',
  'packages/action-proposals/src/ledger/record.ts',
  'packages/action-proposals/test/ledger-fixtures.ts',
  'packages/action-proposals/test/record.test.ts',
  'packages/action-proposals/test/reconcile.test.ts',
  'packages/action-proposals/src/ledger/history.ts',
  'packages/action-proposals/test/history.test.ts',
  'packages/action-proposals/test/cross-layer.test.ts',
  'packages/action-proposals/test/cross-layer-fixtures.ts',
]);
/** AVEN-011 allowlist: path -> cumulative status against aven-010. */
const AVEN_011_DELTA = Object.freeze({
  'README.md': 'M',
  'docs/ROADMAP.md': 'M',
  'pnpm-lock.yaml': 'M',
  'docs/AVEN_011_REPORT.md': 'A',
  ...Object.fromEntries(AVEN_011_PACKAGE_FILES.map((path) => [path, 'A'])),
});
/** package.json P1: the one approved script insertion and description. */
const PACKAGE_ANCHOR =
  'tsc --project packages/corrections/tsconfig.json --noEmit';
const PACKAGE_INSERTION =
  ' && tsc --project packages/action-proposals/tsconfig.json --noEmit';
const AVEN_011_DESCRIPTION =
  'Aven experiment foundation, contracts, storage, AVEN-004 Experience Ledger, AVEN-005 local session API, AVEN-006 model runtime boundary, AVEN-007 A/B baselines with prebuilt eval dataset, AVEN-008 Context Broker, AVEN-009 Typed Owner Model and AVEN-010 correction events (frozen), with the AVEN-011 action-proposal boundary';
/** pnpm-lock.yaml L1: one importer block, inserted before this line. */
const LOCK_ANCHOR = '\n  packages/baseline:\n';
const LOCK_LINK_SETS = Object.freeze([
  ['contracts'],
  ['contracts', 'ledger', 'storage'],
]);
const AVEN_011_PACKAGE_RULE = Object.freeze({
  anchor: PACKAGE_ANCHOR,
  insertion: PACKAGE_INSERTION,
  description: AVEN_011_DESCRIPTION,
});
const AVEN_011_LOCK_RULE = Object.freeze({
  importer: 'packages/action-proposals',
  anchor: LOCK_ANCHOR,
  linkSets: LOCK_LINK_SETS,
});

// ---------------------------------------------------------------------------
// AVEN-012 file governance (`aven-012-governance-v1`), judged against the
// frozen aven-011 tree. Everything present at aven-011 is frozen except the
// shared files and the governance files, which may only be modified.

/** The 33 package files of the accepted four-patch AVEN-012 plan, exactly. */
const AVEN_012_PACKAGE_FILES = Object.freeze([
  // Patch 2: the pure Root policy engine.
  'packages/root-policy/package.json',
  'packages/root-policy/tsconfig.json',
  'packages/root-policy/README.md',
  'packages/root-policy/src/index.ts',
  'packages/root-policy/src/config.ts',
  'packages/root-policy/src/errors.ts',
  'packages/root-policy/src/inert.ts',
  'packages/root-policy/src/canonical.ts',
  'packages/root-policy/src/timestamps.ts',
  'packages/root-policy/src/proposal.ts',
  'packages/root-policy/src/policy.ts',
  'packages/root-policy/src/authentication.ts',
  'packages/root-policy/src/approvals.ts',
  'packages/root-policy/src/evaluate.ts',
  'packages/root-policy/src/testing/index.ts',
  'packages/root-policy/test/fixtures.ts',
  'packages/root-policy/test/boundaries.test.ts',
  'packages/root-policy/test/errors.test.ts',
  'packages/root-policy/test/timestamps.test.ts',
  'packages/root-policy/test/proposal.test.ts',
  'packages/root-policy/test/policy.test.ts',
  'packages/root-policy/test/approvals.test.ts',
  'packages/root-policy/test/evaluate.test.ts',
  // Patch 3: approval checks and audited recording.
  'packages/root-policy/src/ledger/index.ts',
  'packages/root-policy/src/ledger/stored.ts',
  'packages/root-policy/src/ledger/gateway.ts',
  'packages/root-policy/src/ledger/record.ts',
  'packages/root-policy/test/ledger-fixtures.ts',
  'packages/root-policy/test/gateway.test.ts',
  'packages/root-policy/test/record.test.ts',
  'packages/root-policy/test/reconcile.test.ts',
  // Patch 4: the adversarial campaign.
  'packages/root-policy/test/adversarial-fixtures.ts',
  'packages/root-policy/test/adversarial.test.ts',
]);
/** AVEN-012 allowlist: path -> cumulative status against aven-011. */
const AVEN_012_DELTA = Object.freeze({
  ...Object.fromEntries(GOVERNANCE_PATHS.map((path) => [path, 'M'])),
  ...Object.fromEntries(SHARED_FILES.map((path) => [path, 'M'])),
  'docs/AVEN_012_REPORT.md': 'A',
  ...Object.fromEntries(AVEN_012_PACKAGE_FILES.map((path) => [path, 'A'])),
});
/** package.json Q1: the one approved script insertion and description. */
const AVEN_012_DESCRIPTION =
  'Aven experiment foundation, contracts, storage, AVEN-004 Experience Ledger, AVEN-005 local session API, AVEN-006 model runtime boundary, AVEN-007 A/B baselines with prebuilt eval dataset, AVEN-008 Context Broker, AVEN-009 Typed Owner Model, AVEN-010 correction events and AVEN-011 action-proposal boundary (frozen), with the AVEN-012 Root policy gateway';
const AVEN_012_PACKAGE_RULE = Object.freeze({
  anchor: 'tsc --project packages/action-proposals/tsconfig.json --noEmit',
  insertion: ' && tsc --project packages/root-policy/tsconfig.json --noEmit',
  description: AVEN_012_DESCRIPTION,
});
/** pnpm-lock.yaml K1: one importer block, inserted before packages/runtime. */
const AVEN_012_LOCK_RULE = Object.freeze({
  importer: 'packages/root-policy',
  anchor: '\n  packages/runtime:\n',
  linkSets: LOCK_LINK_SETS,
});
const OWNER_NAMES = new Set(['Varun Karthik', 'varun-raj-77']);
const OWNER_EMAILS = new Set([
  'varunraj2117@gmail.com',
  '71327884+varun-raj-77@users.noreply.github.com',
]);
const CLAUDE = 'Co-authored-by: Claude <noreply@anthropic.com>';
const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL_CONFIG = Object.freeze({
  root: ROOT,
  v9: V9,
  v10: V10,
  tagObjects: TAG_OBJECTS,
  baseline: AVEN_011_BASELINE,
  frozenCount: 16,
  v11: V11,
  aven011Trusted: AVEN_011_TRUSTED,
  aven011Count: AVEN_011_COUNT,
});
const USAGE =
  'Usage: node tooling/attribution/check-post-aven010.mjs [--self-test | --governance-frozen-at <full 40-character commit SHA>]';

function makeGit(root) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  );
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(root));
  env.GIT_TERMINAL_PROMPT = '0';
  const base = [
    '--no-replace-objects',
    '-c',
    'log.showSignature=false',
    '-c',
    'i18n.logOutputEncoding=UTF-8',
    '-c',
    'trailer.separators=:',
    '-C',
    root,
  ];
  const run = (args, encoding) =>
    execFileSync('git', [...base, ...args], {
      encoding,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  const git = (args) => run(args, 'utf8').trimEnd();
  git.raw = (args) => run(args, 'utf8');
  git.blob = (args) => run(args, 'buffer');
  git.succeeds = (args) => {
    try {
      run(args, 'utf8');
      return true;
    } catch {
      return false;
    }
  };
  return git;
}

function read(git, sha) {
  const fields = git([
    'show',
    '-s',
    '--format=%P%x00%an%x00%ae%x00%cn%x00%ce',
    sha,
  ]).split('\0');
  if (fields.length !== 5) throw new Error('Malformed commit metadata');
  const [parents, authorName, authorEmail, committerName, committerEmail] =
    fields;
  return {
    sha,
    parents: parents ? parents.split(' ') : [],
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    message: git(['show', '-s', '--format=%B', sha]),
    trailers: git(['show', '-s', '--format=%(trailers:only,unfold)', sha])
      .split('\n')
      .filter(Boolean),
  };
}

function isOwner(name, email) {
  return OWNER_NAMES.has(name) && OWNER_EMAILS.has(email);
}

export function postFreezeViolations(commit) {
  const errors = [];
  if (commit.parents.length !== 1) errors.push('nonlinear_commit');
  if (!isOwner(commit.authorName, commit.authorEmail))
    errors.push('owner_not_primary_author');
  if (!isOwner(commit.committerName, commit.committerEmail))
    errors.push('owner_not_committer');

  const lines = commit.message.replace(/\r\n?/g, '\n').split('\n');
  const exactRaw = lines.filter((line) => line === CLAUDE);
  const exactParsed = commit.trailers.filter((line) => line === CLAUDE);
  if (exactRaw.length !== 1 || exactParsed.length !== 1)
    errors.push('claude_trailer_missing_duplicate_or_unparsed');

  const isCoauthor = (line) => /^\s*co[\s_-]*authored[\s_-]*by\s*:/i.test(line);
  const allRaw = lines.filter(isCoauthor);
  const allParsed = commit.trailers.filter(isCoauthor);
  if (
    allRaw.length !== 1 ||
    allRaw[0] !== CLAUDE ||
    allParsed.length !== 1 ||
    allParsed[0] !== CLAUDE
  )
    errors.push('unexpected_or_malformed_coauthor');
  return errors;
}

function requireTag(git, name, sha, tagObject) {
  if (!git.succeeds(['rev-parse', '--verify', 'refs/tags/' + name]))
    throw new Error(name + ' tag is missing');
  if (git(['rev-parse', '--verify', 'refs/tags/' + name + '^{commit}']) !== sha)
    throw new Error(name + ' moved from its frozen commit');
  if (git(['cat-file', '-t', 'refs/tags/' + name]) !== 'tag')
    throw new Error(name + ' is not annotated');
  if (git(['rev-parse', '--verify', 'refs/tags/' + name]) !== tagObject)
    throw new Error(name + ' annotated tag object was replaced');
}

function requireAncestor(git, ancestor, descendant, message) {
  if (!git.succeeds(['merge-base', '--is-ancestor', ancestor, descendant]))
    throw new Error(message);
}

/** Parses `git diff-tree -r --raw -z --no-abbrev` output. */
function parseRaw(output) {
  const tokens = output.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '') continue;
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(
      tokens[i],
    );
    if (!meta || i + 1 >= tokens.length)
      throw new Error('Unparseable raw diff output');
    i += 1;
    entries.push({
      srcMode: meta[1],
      dstMode: meta[2],
      status: meta[3],
      path: tokens[i],
    });
  }
  return entries;
}

/**
 * Combines both allowlists and enforces, in code, that allowlist data cannot
 * open a frozen file: an addition must not exist at aven-010, and a
 * modification must name one of the SHARED_FILES present at aven-010.
 */
function aven011Allowlist(git, v10, delta) {
  const frozen = new Set(
    git
      .raw(['ls-tree', '-r', '-z', '--name-only', v10])
      .split('\0')
      .filter(Boolean),
  );
  const combined = { ...MAINTENANCE_DELTA };
  for (const [path, status] of Object.entries(delta)) {
    if (Object.hasOwn(combined, path) && combined[path] !== status)
      throw new Error('allowlist_conflict: ' + path);
    combined[path] = status;
  }
  for (const [path, status] of Object.entries(combined)) {
    const valid =
      status === 'A'
        ? !frozen.has(path)
        : status === 'M' && frozen.has(path) && SHARED_FILES.includes(path);
    if (!valid)
      throw new Error('allowlist_names_frozen_path: ' + status + ' ' + path);
  }
  for (const path of GOVERNANCE_PATHS)
    if (combined[path] !== 'A')
      throw new Error('allowlist_conflict: governance path ' + path);
  return Object.freeze(combined);
}

/**
 * The AVEN-012 allowlist, judged against the frozen aven-011 tree and
 * enforced in code like the AVEN-011 one: an addition must not exist at
 * aven-011 (so no AVEN-011 or earlier file can be reopened by listing it),
 * and a modification must name a shared or governance file present at
 * aven-011. Every governance file must be listed as modified.
 */
function aven012Allowlist(git, v11, delta) {
  const frozen = new Set(
    git
      .raw(['ls-tree', '-r', '-z', '--name-only', v11])
      .split('\0')
      .filter(Boolean),
  );
  const modifiable = [...SHARED_FILES, ...GOVERNANCE_PATHS];
  for (const [path, status] of Object.entries(delta)) {
    const valid =
      status === 'A'
        ? !frozen.has(path)
        : status === 'M' && frozen.has(path) && modifiable.includes(path);
    if (!valid)
      throw new Error('allowlist_names_frozen_path: ' + status + ' ' + path);
  }
  for (const path of GOVERNANCE_PATHS)
    if (delta[path] !== 'M')
      throw new Error('allowlist_conflict: governance path ' + path);
  return Object.freeze({ ...delta });
}

/**
 * Per-commit statuses (against the parent) derived from a cumulative
 * allowlist: an added path may be added (when its parent lacks it) and then
 * modified; a modified path may only be modified. After the baseline the
 * governance files exist, so they may only be modified.
 */
function perCommitTable(era, cumulative) {
  const table = {};
  for (const [path, status] of Object.entries(cumulative))
    table[path] =
      GOVERNANCE_PATHS.includes(path) && era !== 'history'
        ? ['M']
        : status === 'A'
          ? ['A', 'M']
          : ['M'];
  return Object.freeze(table);
}

function perCommitViolations(entries, table) {
  const errors = [];
  for (const entry of entries) {
    const allowed = table[entry.path];
    if (!allowed) errors.push('unauthorized_path ' + entry.path);
    else if (!allowed.includes(entry.status))
      errors.push('forbidden_status ' + entry.status + ' ' + entry.path);
    else if (
      entry.dstMode !== '100644' ||
      (entry.status === 'M' && entry.srcMode !== '100644')
    )
      errors.push(
        'forbidden_mode ' +
          entry.srcMode +
          '->' +
          entry.dstMode +
          ' ' +
          entry.path,
      );
  }
  if (
    entries.some((entry) => GOVERNANCE_PATHS.includes(entry.path)) &&
    entries.some(
      (entry) =>
        !GOVERNANCE_PATHS.includes(entry.path) && entry.path !== 'AGENTS.md',
    )
  )
    errors.push('governance_change_not_isolated');
  return errors;
}

function cumulativeViolations(entries, cumulative) {
  const errors = [];
  for (const entry of entries) {
    const expected = cumulative[entry.path];
    if (!expected) errors.push('cumulative_unauthorized ' + entry.path);
    else if (entry.status !== expected)
      errors.push('cumulative_status ' + entry.status + ' ' + entry.path);
    else if (entry.dstMode !== '100644')
      errors.push('cumulative_mode ' + entry.dstMode + ' ' + entry.path);
  }
  return errors;
}

const canonicalJson = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');

/**
 * P0: byte-identical to the baseline. P1: the canonical rendering of the
 * baseline with the approved description and/or the one approved insertion
 * in BOTH scripts.typecheck and scripts.check. Anything else: null. The
 * default rule is AVEN-011's (states P0/P1 against the AVEN-011 baseline);
 * the AVEN-012 rule yields the same shapes against aven-011 (Q0/Q1).
 */
export function packageJsonState(
  baseline,
  candidate,
  rule = AVEN_011_PACKAGE_RULE,
) {
  if (candidate.equals(baseline)) return 'P0';
  let base;
  try {
    base = JSON.parse(baseline.toString('utf8'));
  } catch {
    return null;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base))
    return null;
  const insert = (script) => {
    if (typeof script !== 'string') return null;
    const at = script.indexOf(rule.anchor);
    if (at < 0 || script.indexOf(rule.anchor, at + 1) >= 0) return null;
    const end = at + rule.anchor.length;
    return script.slice(0, end) + rule.insertion + script.slice(end);
  };
  const typecheck = insert(base?.scripts?.typecheck);
  const check = insert(base?.scripts?.check);
  for (const description of [base?.description, rule.description])
    for (const inserted of [false, true]) {
      if (inserted && (typecheck === null || check === null)) continue;
      const variant = structuredClone(base);
      variant.description = description;
      if (inserted) {
        variant.scripts.typecheck = typecheck;
        variant.scripts.check = check;
      }
      if (canonicalJson(variant).equals(candidate)) return 'P1';
    }
  return null;
}

/**
 * The importer block pnpm 11.19.0 writes for packages/action-proposals (or,
 * under the AVEN-012 rule, packages/root-policy).
 */
function importerBlock(links, importer = AVEN_011_LOCK_RULE.importer) {
  const lines = ['  ' + importer + ':', '    dependencies:'];
  for (const link of links)
    lines.push(
      `      '@aven/${link}':`,
      '        specifier: workspace:*',
      `        version: link:../${link}`,
    );
  lines.push(
    '      zod:',
    '        specifier: 4.6.5',
    '        version: 4.6.5',
    '    devDependencies:',
    '      typescript:',
    '        specifier: 5.9.3',
    '        version: 5.9.3',
    '      vitest:',
    '        specifier: 4.0.18',
    '        version: 4.0.18(@types/node@24.10.13)(yaml@2.9.1)',
    '',
    '',
  );
  return lines.join('\n');
}

/**
 * L0: byte-identical to the baseline. L1: the baseline with exactly one
 * approved importer block inserted immediately before `packages/baseline`.
 * Anything else: null. The AVEN-012 rule yields the same shapes against
 * aven-011 (K0/K1), with the block before `packages/runtime`.
 */
export function lockfileState(baseline, candidate, rule = AVEN_011_LOCK_RULE) {
  if (candidate.equals(baseline)) return 'L0';
  const text = baseline.toString('utf8');
  const at = text.indexOf(rule.anchor);
  if (
    at < 0 ||
    text.indexOf(rule.anchor, at + 1) >= 0 ||
    text.includes('\n  ' + rule.importer + ':')
  )
    return null;
  for (const links of rule.linkSets) {
    const expected =
      text.slice(0, at + 1) +
      importerBlock(links, rule.importer) +
      text.slice(at + 1);
    if (Buffer.from(expected, 'utf8').equals(candidate)) return 'L1';
  }
  return null;
}

function blobAt(git, sha, path) {
  try {
    return git.blob(['cat-file', 'blob', sha + ':' + path]);
  } catch {
    return null;
  }
}

function rawDiff(git, from, to, ...extra) {
  return parseRaw(
    git.raw([
      'diff-tree',
      '-r',
      '-z',
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--no-color',
      '--ignore-submodules=none',
      ...extra,
      from,
      to,
    ]),
  );
}

function verify(config, frozenAt) {
  const git = makeGit(config.root);
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true')
    throw new Error('Not a worktree');
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false')
    throw new Error('Cannot validate shallow history');
  requireTag(git, 'aven-009', config.v9, config.tagObjects['aven-009']);
  requireTag(git, 'aven-010', config.v10, config.tagObjects['aven-010']);
  // The AVEN-011 era is closed whenever the configuration names aven-011
  // (always, for the real repository); only synthetic fixtures of the
  // earlier, open AVEN-011 era omit it.
  const closed = Boolean(config.v11);
  if (closed)
    requireTag(git, 'aven-011', config.v11, config.tagObjects['aven-011']);
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  requireAncestor(git, config.v9, config.v10, 'aven-009 is not an ancestor');
  requireAncestor(git, config.v10, head, 'aven-010 is not an ancestor');
  requireAncestor(
    git,
    config.baseline,
    head,
    'AVEN-011 baseline is not an ancestor of HEAD',
  );
  if (closed) {
    requireAncestor(
      git,
      config.baseline,
      config.v11,
      'AVEN-011 baseline is not an ancestor of aven-011',
    );
    requireAncestor(
      git,
      config.v11,
      head,
      'aven-011 is not an ancestor of HEAD',
    );
  }
  const allowlists = {
    history: {
      cumulative: MAINTENANCE_DELTA,
      perCommit: perCommitTable('history', MAINTENANCE_DELTA),
      since: config.v10,
    },
  };
  const combined = aven011Allowlist(
    git,
    config.v10,
    config.aven011Delta ?? AVEN_011_DELTA,
  );
  allowlists.aven011 = {
    cumulative: combined,
    perCommit: perCommitTable('aven011', combined),
    since: config.v10,
  };
  const basePackage = blobAt(git, config.baseline, 'package.json');
  const baseLock = blobAt(git, config.baseline, 'pnpm-lock.yaml');
  if (!basePackage || !baseLock)
    throw new Error('AVEN-011 baseline lacks package.json or pnpm-lock.yaml');
  let v11Package = null;
  let v11Lock = null;
  if (closed) {
    const delta = aven012Allowlist(
      git,
      config.v11,
      config.aven012Delta ?? AVEN_012_DELTA,
    );
    allowlists.aven012 = {
      cumulative: delta,
      perCommit: perCommitTable('aven012', delta),
      since: config.v11,
    };
    v11Package = blobAt(git, config.v11, 'package.json');
    v11Lock = blobAt(git, config.v11, 'pnpm-lock.yaml');
    if (!v11Package || !v11Lock)
      throw new Error('aven-011 lacks package.json or pnpm-lock.yaml');
  }

  const commits = git(['rev-list', '--reverse', config.v9 + '..' + head])
    .split('\n')
    .filter(Boolean)
    .map((sha) => read(git, sha));
  let previous = config.v9;
  let countFrozen = 0;
  let countNew = 0;
  let countMilestone = 0;
  let countAven012 = 0;
  let era = config.baseline === config.v10 ? 'aven011' : 'history';
  let baselineSeen = config.baseline === config.v10;
  let v11Seen = false;
  let trustedSeen = false;
  let aven011TrustedSeen = false;
  const errors = [];
  for (const commit of commits) {
    const report = (codes) =>
      errors.push(...codes.map((code) => commit.sha + ': ' + code));
    if (commit.parents.length !== 1 || commit.parents[0] !== previous)
      errors.push(commit.sha + ': history_not_linear');
    previous = commit.sha;
    if (countFrozen < config.frozenCount) {
      report(evaluateCommit(commit).violations);
      countFrozen += 1;
      if (countFrozen === config.frozenCount && commit.sha !== config.v10)
        errors.push('AVEN-010 must be sixteenth commit after AVEN-009');
      continue;
    }
    countNew += 1;
    report(postFreezeViolations(commit));
    if (commit.parents.length === 1) {
      const lists = allowlists[era];
      const changed = rawDiff(
        git,
        commit.parents[0],
        commit.sha,
        '--no-commit-id',
      );
      report(perCommitViolations(changed, lists.perCommit));
      report(
        cumulativeViolations(
          rawDiff(git, lists.since, commit.sha),
          lists.cumulative,
        ),
      );
      const governanceChanged = changed.some((entry) =>
        GOVERNANCE_PATHS.includes(entry.path),
      );
      if (era === 'aven011') {
        countMilestone += 1;
        const pkg = blobAt(git, commit.sha, 'package.json');
        if (!pkg || !packageJsonState(basePackage, pkg))
          report(['package_json_state']);
        const lock = blobAt(git, commit.sha, 'pnpm-lock.yaml');
        if (!lock || !lockfileState(baseLock, lock)) report(['lockfile_state']);
        if (closed) {
          // The accepted AVEN-011 trusted reference is pinned, not supplied.
          if (aven011TrustedSeen && governanceChanged)
            report(['governance_change_after_aven011_trusted_reference']);
          if (commit.sha === config.aven011Trusted) aven011TrustedSeen = true;
        } else {
          if (trustedSeen && governanceChanged)
            report(['governance_change_after_trusted_reference']);
          if (commit.sha === frozenAt) trustedSeen = true;
        }
      } else if (era === 'aven012') {
        countAven012 += 1;
        const pkg = blobAt(git, commit.sha, 'package.json');
        if (!pkg || !packageJsonState(v11Package, pkg, AVEN_012_PACKAGE_RULE))
          report(['package_json_state']);
        const lock = blobAt(git, commit.sha, 'pnpm-lock.yaml');
        if (!lock || !lockfileState(v11Lock, lock, AVEN_012_LOCK_RULE))
          report(['lockfile_state']);
        if (trustedSeen && governanceChanged)
          report(['governance_change_after_trusted_reference']);
        if (commit.sha === frozenAt) trustedSeen = true;
      }
    }
    if (commit.sha === config.baseline) {
      era = 'aven011';
      baselineSeen = true;
    }
    if (closed && commit.sha === config.v11) {
      if (era !== 'aven011')
        errors.push('aven-011 is not an AVEN-011 era commit of HEAD');
      era = 'aven012';
      v11Seen = true;
    }
  }
  if (countFrozen !== config.frozenCount || previous !== head)
    errors.push('History is not a complete linear extension of AVEN-010');
  if (!baselineSeen)
    errors.push('AVEN-011 baseline is not a post-freeze commit of HEAD');
  if (closed) {
    if (!v11Seen) errors.push('aven-011 is not a post-freeze commit of HEAD');
    if (countMilestone !== config.aven011Count)
      errors.push(
        'AVEN-011 must have exactly ' +
          config.aven011Count +
          ' commits after its baseline; found ' +
          countMilestone,
      );
    if (!aven011TrustedSeen)
      errors.push(
        'AVEN-011 trusted reference ' +
          config.aven011Trusted +
          ' is not an AVEN-011 milestone commit of this history',
      );
  }
  if (frozenAt && !trustedSeen)
    throw new Error(
      'Trusted reference ' +
        frozenAt +
        ' is not an ' +
        (closed ? 'AVEN-012' : 'AVEN-011') +
        ' milestone commit of this history',
    );
  return {
    head,
    closed,
    countFrozen,
    countNew,
    countMilestone,
    countAven012,
    errors,
  };
}

function blobId(path) {
  const content = readFileSync(path);
  return createHash('sha1')
    .update('blob ' + content.length + '\0')
    .update(content)
    .digest('hex');
}

/**
 * Runs one invocation; returns the process exit code (0 pass, 1 fail), or,
 * for --self-test, a promise of it.
 */
export function main(argv, config = REAL_CONFIG) {
  try {
    if (argv.length === 1 && argv[0] === '--self-test') {
      if (config !== REAL_CONFIG) throw new Error(USAGE);
      return selfTest().then(
        () => 0,
        (error) => {
          console.error(
            'FAIL: ' + (error instanceof Error ? error.message : String(error)),
          );
          return 1;
        },
      );
    }
    let frozenAt = null;
    if (argv.length === 2 && argv[0] === '--governance-frozen-at') {
      if (!/^[0-9a-f]{40}$/.test(argv[1])) throw new Error(USAGE);
      frozenAt = argv[1];
    } else if (argv.length !== 0) throw new Error(USAGE);
    if (config.synthetic)
      console.log(
        '[synthetic fixture configuration: not a repository verdict]',
      );
    const result = verify(config, frozenAt);
    console.log(
      'AVEN attribution: HEAD ' +
        result.head +
        '; frozen=' +
        result.countFrozen +
        '; post-freeze=' +
        result.countNew,
    );
    if (result.closed) {
      console.log(
        'AVEN-011 governance (' +
          AVEN_011_GOVERNANCE_VERSION +
          ', closed at aven-011 ' +
          config.v11 +
          '): baseline ' +
          config.baseline +
          '; milestone commits=' +
          result.countMilestone +
          '; governance frozen at ' +
          config.aven011Trusted +
          ' (pinned)',
      );
      console.log(
        'AVEN-012 governance (' +
          GOVERNANCE_VERSION +
          '): baseline aven-011 ' +
          config.v11 +
          '; milestone commits=' +
          result.countAven012 +
          '; governance frozen at ' +
          (frozenAt ?? 'not requested'),
      );
    } else
      console.log(
        'AVEN-011 governance (' +
          AVEN_011_GOVERNANCE_VERSION +
          '): baseline ' +
          config.baseline +
          '; milestone commits=' +
          result.countMilestone +
          '; governance frozen at ' +
          (frozenAt ?? 'not requested'),
      );
    console.log(
      'Evaluator blobs: check-post-aven010.mjs ' +
        blobId(SELF) +
        '; attribution.ts ' +
        blobId(join(dirname(SELF), 'attribution.ts')),
    );
    for (const error of result.errors) console.error('FAIL: ' + error);
    if (result.errors.length) return 1;
    console.log(
      result.closed
        ? 'PASS: preserved frozen lineage, owner-first commits, the closed AVEN-011 history and AVEN-012 file governance'
        : 'PASS: preserved frozen lineage, owner-first commits and AVEN-011 file governance',
    );
    return 0;
  } catch (error) {
    console.error(
      'FAIL: ' + (error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Self-test: pure owner-first cases, CLI argument handling and a synthetic
// Git-history campaign. Synthetic repositories live only in temporary
// directories with isolated Git configuration; nothing touches this checkout.

const SYN_OWNER = Object.freeze({
  name: 'Varun Karthik',
  email: 'varunraj2117@gmail.com',
});
const SYN_CLAUDE = Object.freeze({
  name: 'Claude',
  email: 'noreply@anthropic.com',
});
const SYN_PACKAGE_V9 = {
  name: 'synthetic-aven',
  private: true,
  description: 'Synthetic baseline description',
  scripts: {
    typecheck:
      'tsc --project packages/contracts/tsconfig.json --noEmit && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit',
    test: 'vitest run --exclude packages/corrections/test/frozen-layers.test.ts',
    check:
      'prettier --check . && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit && vitest run',
  },
  devDependencies: { zod: '4.6.5' },
};
/** History era commit h3 adds a script, as the real maintenance did. */
const SYN_PACKAGE_BASE = {
  ...SYN_PACKAGE_V9,
  scripts: {
    ...SYN_PACKAGE_V9.scripts,
    'attribution:check': 'node tooling/attribution/check-post-aven010.mjs',
  },
};
/** Written out literally (not derived from the code under test). */
const SYN_PACKAGE_INSERTED = {
  ...SYN_PACKAGE_BASE,
  scripts: {
    ...SYN_PACKAGE_BASE.scripts,
    typecheck:
      'tsc --project packages/contracts/tsconfig.json --noEmit && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project packages/action-proposals/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit',
    check:
      'prettier --check . && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project packages/action-proposals/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit && vitest run',
  },
};
const SYN_PACKAGE_FINAL = {
  ...SYN_PACKAGE_INSERTED,
  description: AVEN_011_DESCRIPTION,
};
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const SYN_LOCK_HEAD = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      zod:
        specifier: 4.6.5
        version: 4.6.5

  apps/api:
    dependencies:
      zod:
        specifier: 4.6.5
        version: 4.6.5

`;
const SYN_LOCK_BASELINE = `  packages/baseline:
    dependencies:
      zod:
        specifier: 4.6.5
        version: 4.6.5

`;
/** A runtime importer gives the AVEN-012 block its anchor. */
const SYN_LOCK_REST = `  packages/runtime:
    dependencies:
      zod:
        specifier: 4.6.5
        version: 4.6.5

packages:

  zod@4.6.5:
    resolution: {integrity: sha512-synthetic}
`;
const SYN_LOCK_TAIL = SYN_LOCK_BASELINE + SYN_LOCK_REST;
const SYN_BLOCK_START = `  packages/action-proposals:
    dependencies:
      '@aven/contracts':
        specifier: workspace:*
        version: link:../contracts
`;
const SYN_BLOCK_LINKS = `      '@aven/ledger':
        specifier: workspace:*
        version: link:../ledger
      '@aven/storage':
        specifier: workspace:*
        version: link:../storage
`;
const SYN_BLOCK_END = `      zod:
        specifier: 4.6.5
        version: 4.6.5
    devDependencies:
      typescript:
        specifier: 5.9.3
        version: 5.9.3
      vitest:
        specifier: 4.0.18
        version: 4.0.18(@types/node@24.10.13)(yaml@2.9.1)

`;
const SYN_LOCK_BASE = SYN_LOCK_HEAD + SYN_LOCK_TAIL;
const SYN_BLOCK_1 = SYN_BLOCK_START + SYN_BLOCK_END;
const SYN_BLOCK_2 = SYN_BLOCK_START + SYN_BLOCK_LINKS + SYN_BLOCK_END;
const SYN_LOCK_1 = SYN_LOCK_HEAD + SYN_BLOCK_1 + SYN_LOCK_TAIL;
const SYN_LOCK_2 = SYN_LOCK_HEAD + SYN_BLOCK_2 + SYN_LOCK_TAIL;
// AVEN-012: the aven-011 state is SYN_LOCK_2; one root-policy block follows.
const SYN_012_BLOCK_START = `  packages/root-policy:
    dependencies:
      '@aven/contracts':
        specifier: workspace:*
        version: link:../contracts
`;
const SYN_012_BLOCK_1 = SYN_012_BLOCK_START + SYN_BLOCK_END;
const SYN_012_BLOCK_2 = SYN_012_BLOCK_START + SYN_BLOCK_LINKS + SYN_BLOCK_END;
const lock012With = (block) =>
  SYN_LOCK_HEAD + SYN_BLOCK_2 + SYN_LOCK_BASELINE + block + SYN_LOCK_REST;
const SYN_LOCK_012_1 = lock012With(SYN_012_BLOCK_1);
const SYN_LOCK_012_2 = lock012With(SYN_012_BLOCK_2);
/** The aven-011 package.json plus the one AVEN-012 insertion, literally. */
const SYN_PACKAGE_012_INSERTED = {
  ...SYN_PACKAGE_FINAL,
  scripts: {
    ...SYN_PACKAGE_FINAL.scripts,
    typecheck:
      'tsc --project packages/contracts/tsconfig.json --noEmit && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project packages/action-proposals/tsconfig.json --noEmit && tsc --project packages/root-policy/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit',
    check:
      'prettier --check . && tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project packages/action-proposals/tsconfig.json --noEmit && tsc --project packages/root-policy/tsconfig.json --noEmit && tsc --project apps/api/tsconfig.json --noEmit && vitest run',
  },
};
const SYN_PACKAGE_012_FINAL = {
  ...SYN_PACKAGE_012_INSERTED,
  description: AVEN_012_DESCRIPTION,
};

const put = (path, content, mode = '100644') => ({ path, content, mode });
const drop = (path) => ({ path, drop: true });
const gitlink = (path) => ({ path, gitlink: '1'.repeat(40) });
const ownerMessage = (subject) =>
  subject + '\n\nSynthetic fixture commit.\n\n' + CLAUDE + '\n';
const milestone = (id, changes) => ({
  id,
  author: SYN_OWNER,
  committer: SYN_OWNER,
  message: ownerMessage('synthetic ' + id),
  changes,
});
const synthetic = (path) =>
  path.endsWith('.json') ? '{}\n' : '// synthetic ' + path + '\n';
const pkg = (path) => 'packages/action-proposals/' + path;

/** The accepted six-patch file-change pattern, with synthetic content. */
const SYN_PATCHES = Object.freeze({
  p1: [
    put('tooling/attribution/check-post-aven010.mjs', '// gate v2\n'),
    put('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md', '# Policy v2\n'),
    put('AGENTS.md', '# Synthetic agents v2\n'),
  ],
  p2: [
    ...AVEN_011_PACKAGE_FILES.slice(0, 16).map((path) =>
      put(path, synthetic(path)),
    ),
    put('package.json', json(SYN_PACKAGE_INSERTED)),
    put('pnpm-lock.yaml', SYN_LOCK_1),
  ],
  p3: [
    ...AVEN_011_PACKAGE_FILES.slice(16, 22).map((path) =>
      put(path, synthetic(path)),
    ),
    put(pkg('package.json'), '{ "v": 3 }\n'),
    put(pkg('test/boundaries.test.ts'), '// boundaries v3\n'),
    put(pkg('README.md'), '# package v3\n'),
    put('pnpm-lock.yaml', SYN_LOCK_2),
  ],
  p4: [
    ...AVEN_011_PACKAGE_FILES.slice(22, 24).map((path) =>
      put(path, synthetic(path)),
    ),
    put(pkg('src/ledger/index.ts'), '// ledger index v4\n'),
    put(pkg('test/boundaries.test.ts'), '// boundaries v4\n'),
    put(pkg('README.md'), '# package v4\n'),
  ],
  p5: AVEN_011_PACKAGE_FILES.slice(24).map((path) =>
    put(path, synthetic(path)),
  ),
  p6: [
    put('docs/AVEN_011_REPORT.md', '# Synthetic AVEN-011 report\n'),
    put('README.md', '# Synthetic readme v6\n'),
    put('docs/ROADMAP.md', '# Synthetic roadmap v6\n'),
    put('AGENTS.md', '# Synthetic agents v6\n'),
    put('package.json', json(SYN_PACKAGE_FINAL)),
    put(pkg('README.md'), '# package v6\n'),
  ],
  // The real seventh AVEN-011 commit records finalization in the report.
  p7: [put('docs/AVEN_011_REPORT.md', '# Synthetic AVEN-011 report v7\n')],
});

const pkg012 = (path) => 'packages/root-policy/' + path;
const GATE = 'tooling/attribution/check-post-aven010.mjs';
const POLICY = 'docs/POST_AVEN010_COMMIT_ATTRIBUTION.md';
const WORKFLOW = '.github/workflows/owner-first-attribution.yml';
/** The accepted four-patch AVEN-012 file-change pattern, synthetic content. */
const SYN_012_PATCHES = Object.freeze({
  q1: [
    put(GATE, '// gate v3\n'),
    put(POLICY, '# Policy v3\n'),
    put(WORKFLOW, 'name: ci v3\n'),
    put('AGENTS.md', '# Synthetic agents v12\n'),
  ],
  q2: [
    ...AVEN_012_PACKAGE_FILES.slice(0, 23).map((path) =>
      put(path, synthetic(path)),
    ),
    put('package.json', json(SYN_PACKAGE_012_INSERTED)),
    put('pnpm-lock.yaml', SYN_LOCK_012_1),
  ],
  q3: [
    ...AVEN_012_PACKAGE_FILES.slice(23, 31).map((path) =>
      put(path, synthetic(path)),
    ),
    put(pkg012('package.json'), '{ "v": 3 }\n'),
    put(pkg012('src/index.ts'), '// root entry v3\n'),
    put(pkg012('test/boundaries.test.ts'), '// boundaries v3\n'),
    put(pkg012('README.md'), '# root-policy v3\n'),
    put('pnpm-lock.yaml', SYN_LOCK_012_2),
  ],
  q4: [
    ...AVEN_012_PACKAGE_FILES.slice(31).map((path) =>
      put(path, synthetic(path)),
    ),
    put('docs/AVEN_012_REPORT.md', '# Synthetic AVEN-012 report\n'),
    put('README.md', '# Synthetic readme v12\n'),
    put('docs/ROADMAP.md', '# Synthetic roadmap v12\n'),
    put('AGENTS.md', '# Synthetic agents v12, reconciled\n'),
    put('package.json', json(SYN_PACKAGE_012_FINAL)),
    put(pkg012('README.md'), '# root-policy v4\n'),
  ],
});

/** aven-009 root, 16 Claude-era commits, then the historical maintenance shape. */
function baseHistory(patches) {
  const commits = [
    {
      id: 'root',
      author: SYN_OWNER,
      committer: SYN_OWNER,
      message: 'synthetic frozen root\n',
      changes: [
        put('AGENTS.md', '# Synthetic agents\n'),
        put('README.md', '# Synthetic readme\n'),
        put('docs/ROADMAP.md', '# Synthetic roadmap\n'),
        put('docs/AVEN_010_REPORT.md', '# Synthetic frozen report\n'),
        put('packages/ledger/src/ledger.ts', 'export const frozen = 0;\n'),
        put('packages/ledger/test/ledger.test.ts', '// frozen test\n'),
        put('tooling/attribution/attribution.ts', '// frozen evaluator\n'),
        put('package.json', json(SYN_PACKAGE_V9)),
        put('pnpm-lock.yaml', SYN_LOCK_BASE),
      ],
    },
  ];
  for (let i = 1; i <= 16; i += 1)
    commits.push({
      id: 'f' + i,
      author: SYN_CLAUDE,
      committer: SYN_CLAUDE,
      message:
        'synthetic frozen-era change ' +
        i +
        '\n\n' +
        OWNER_CO_AUTHOR_TRAILER +
        '\n',
      changes: [
        put('packages/ledger/src/ledger.ts', `export const frozen = ${i};\n`),
      ],
    });
  commits.push(
    milestone('h1', [
      put('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md', '# Policy\n'),
    ]),
    milestone('h2', [
      put('tooling/attribution/check-post-aven010.mjs', '// gate\n'),
    ]),
    milestone('h3', [put('package.json', json(SYN_PACKAGE_BASE))]),
    milestone('h4', [put('AGENTS.md', '# Synthetic agents, maintained\n')]),
    milestone('h5', [
      put('.github/workflows/owner-first-attribution.yml', 'name: ci\n'),
    ]),
    milestone('h6', [
      put('.github/workflows/owner-first-attribution.yml', 'name: ci v2\n'),
    ]),
  );
  for (const id of patches)
    commits.push(milestone(id, structuredClone(SYN_PATCHES[id])));
  return {
    commits,
    tags: [
      { name: 'aven-009', at: 'root' },
      { name: 'aven-010', at: 'f16' },
    ],
    v10: 'f16',
    baseline: 'h6',
    argv: () => [],
    after: () => {},
  };
}

/**
 * The closed AVEN-011 era (seven commits, trusted reference p1, annotated
 * aven-011 at p7), followed by the given AVEN-012 patches.
 */
function closedHistory(patches) {
  const history = baseHistory(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  history.tags.push({ name: 'aven-011', at: 'p7' });
  history.v11 = 'p7';
  history.aven011Trusted = 'p1';
  for (const id of patches)
    history.commits.push(milestone(id, structuredClone(SYN_012_PATCHES[id])));
  return history;
}

function fixtureEnv(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  );
  writeFileSync(join(home, 'gitconfig'), '');
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    // Tagger identity for fixture-only tag tampering; never a real commit.
    GIT_COMMITTER_NAME: 'Synthetic Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

function fixtureGit(repo, env, args, input) {
  const result = spawnSync(
    'git',
    ['-c', 'core.autocrlf=false', '-C', repo, ...args],
    { env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(
      'fixture git ' + args.join(' ') + ' failed: ' + result.stderr,
    );
  return result.stdout.trim();
}

/** Builds one synthetic repository with `git fast-import`. */
function buildFixture(history) {
  const dir = mkdtempSync(join(tmpdir(), 'aven011-gate-'));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = fixtureEnv(home);
  fixtureGit(dir, env, ['init', '-q', repo]);
  fixtureGit(repo, env, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const marks = new Map(history.commits.map((c, i) => [c.id, i + 1]));
  const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream = '';
  history.commits.forEach((c, i) => {
    const time = 1790000000 + i * 60;
    stream += `commit refs/heads/${c.branch ?? 'main'}\nmark :${i + 1}\n`;
    stream += `author ${c.author.name} <${c.author.email}> ${time} +0000\n`;
    stream += `committer ${c.committer.name} <${c.committer.email}> ${time} +0000\n`;
    stream += data(c.message);
    const parent = c.from ?? (i > 0 ? history.commits[i - 1].id : null);
    if (parent) stream += `from :${marks.get(parent)}\n`;
    for (const extra of c.merge ?? []) stream += `merge :${marks.get(extra)}\n`;
    for (const change of c.changes) {
      if (change.drop) stream += `D ${change.path}\n`;
      else if (change.gitlink)
        stream += `M 160000 ${change.gitlink} ${change.path}\n`;
      else
        stream +=
          `M ${change.mode} inline ${change.path}\n` + data(change.content);
    }
    stream += '\n';
  });
  for (const tag of history.tags)
    stream +=
      `tag ${tag.name}\nfrom :${marks.get(tag.at)}\n` +
      `tagger ${SYN_OWNER.name} <${SYN_OWNER.email}> 1790000000 +0000\n` +
      data('synthetic ' + tag.name);
  const marksFile = join(dir, 'marks');
  fixtureGit(
    repo,
    env,
    ['fast-import', '--quiet', '--export-marks=' + marksFile],
    stream,
  );
  const shaByMark = new Map(
    readFileSync(marksFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' '))
      .map(([mark, sha]) => [Number(mark.slice(1)), sha]),
  );
  const sha = (id) => shaByMark.get(marks.get(id));
  // Pinned before any fixture-only tag tampering in `after`.
  const tagObjects = Object.fromEntries(
    history.tags.map((tag) => [
      tag.name,
      fixtureGit(repo, env, ['rev-parse', 'refs/tags/' + tag.name]),
    ]),
  );
  const run = (args) => fixtureGit(repo, env, args);
  history.after({ run, sha, env });
  return { dir, repo, home, sha, tagObjects };
}

const CHILD = `import { readFileSync } from 'node:fs';
import { main } from ${JSON.stringify(pathToFileURL(SELF).href)};
process.exitCode = main(JSON.parse(process.argv[2]), JSON.parse(readFileSync(process.argv[1], 'utf8')));`;

/** Removes one fixture directory, refusing anything but a fixture. */
function removeFixture(dir) {
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('aven011-gate-')
  )
    throw new Error('Unsafe synthetic fixture cleanup: ' + target);
  // Git may write read-only pack files (notably on Windows).
  const writable = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) writable(child);
      else if (entry.isFile()) chmodSync(child, 0o666);
    }
  };
  writable(target);
  rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Runs the gate's CLI entry point in a child process against a fixture.
 * The fixture is built synchronously; the child runs asynchronously, so a
 * bounded number of fixtures can be judged at once. Each child sees only its
 * own fixture repository, configuration file and isolated Git home.
 */
async function runFixture(history) {
  const fixture = buildFixture(history);
  try {
    const config = {
      root: fixture.repo,
      v9: fixture.sha('root'),
      v10: fixture.sha(history.v10),
      tagObjects: fixture.tagObjects,
      baseline: fixture.sha(history.baseline),
      frozenCount: 16,
      synthetic: true,
      ...(history.delta ? { aven011Delta: history.delta } : {}),
      ...(history.v11
        ? {
            v11: fixture.sha(history.v11),
            aven011Trusted: fixture.sha(history.aven011Trusted),
            aven011Count: 7,
          }
        : {}),
      ...(history.delta012 ? { aven012Delta: history.delta012 } : {}),
    };
    const configFile = join(fixture.dir, 'config.json');
    writeFileSync(configFile, JSON.stringify(config));
    return await new Promise((done) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          CHILD,
          configFile,
          JSON.stringify(history.argv(fixture.sha)),
        ],
        { env: fixtureEnv(fixture.home), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (text) => (output += text));
      child.stderr.setEncoding('utf8').on('data', (text) => (output += text));
      const timer = setTimeout(() => child.kill(), 300000);
      child.on('error', (error) => {
        clearTimeout(timer);
        done({ status: null, output: output + String(error) });
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, output });
      });
    });
  } finally {
    removeFixture(fixture.dir);
  }
}

/** Runs async jobs with at most `limit` in flight; results keep job order. */
async function pooled(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, worker),
  );
  return results;
}

const find = (history, id) => history.commits.find((c) => c.id === id);
/** Applies one defect to a fresh copy of a passing control history. */
function mutate(control, change) {
  const history = control();
  change(history);
  return history;
}
const insertAfter = (history, id, ...commits) =>
  history.commits.splice(
    history.commits.findIndex((c) => c.id === id) + 1,
    0,
    ...commits,
  );

const CONTROLS = Object.freeze({
  'history only (three historical additions)': () => baseHistory([]),
  'Patch 1 with unchanged package.json and lockfile': () => baseHistory(['p1']),
  'Patches 1-2 with the permitted importer addition': () =>
    baseHistory(['p1', 'p2']),
  'complete six-patch pattern': () =>
    baseHistory(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
  'six patches, governance frozen at Patch 1': () => ({
    ...baseHistory(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
    argv: (sha) => ['--governance-frozen-at', sha('p1')],
  }),
  'six patches plus a later governance-only commit (no freeze)': () => {
    const history = baseHistory(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    insertAfter(
      history,
      'p3',
      milestone('g1', [
        put('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md', '# Policy v3\n'),
      ]),
    );
    return history;
  },
});
const C0 = CONTROLS['history only (three historical additions)'];
const C1 = CONTROLS['Patch 1 with unchanged package.json and lockfile'];
const C2 = CONTROLS['Patches 1-2 with the permitted importer addition'];
const C6 = CONTROLS['complete six-patch pattern'];
const C6G =
  CONTROLS['six patches plus a later governance-only commit (no freeze)'];
const addTo =
  (id, ...changes) =>
  (h) =>
    find(h, id).changes.push(...changes);
const setIn = (id, path, content) => (h) => {
  const commit = find(h, id);
  commit.changes = commit.changes.filter((c) => c.path !== path);
  commit.changes.push(put(path, content));
};
const lockWith = (block) => SYN_LOCK_HEAD + block + SYN_LOCK_TAIL;

/** [name, control, defect, expected output fragment]. */
const VIOLATIONS = Object.freeze([
  // Historical era (up to and including the baseline).
  [
    'history: unlisted file',
    C0,
    addTo('h3', put('scripts/tmp.sh', 'x\n')),
    'unauthorized_path scripts/tmp.sh',
  ],
  [
    'history: README before AVEN-011',
    C0,
    addTo('h4', put('README.md', 'x\n')),
    'unauthorized_path README.md',
  ],
  [
    'history: frozen source',
    C0,
    addTo('h4', put('packages/ledger/src/ledger.ts', 'x\n')),
    'unauthorized_path packages/ledger/src/ledger.ts',
  ],
  [
    'history: executable governance file',
    C0,
    (h) => {
      find(h, 'h2').changes[0].mode = '100755';
    },
    'forbidden_mode 000000->100755',
  ],
  // A Git history cannot show `M` on a path its parent lacks, so "modified
  // before its first addition" is represented by its only Git equivalent:
  // a governance file deleted and later re-added.
  [
    'history: governance file deleted and re-added',
    C0,
    (h) => {
      insertAfter(
        h,
        'h4',
        milestone('hd', [drop('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md')]),
      );
      find(h, 'h5').changes.push(
        put('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md', '# Policy again\n'),
      );
    },
    'forbidden_status D docs/POST_AVEN010_COMMIT_ATTRIBUTION.md',
  ],
  // Frozen files during AVEN-011.
  [
    'AVEN-011: frozen source',
    C2,
    addTo('p2', put('packages/ledger/src/ledger.ts', 'x\n')),
    'unauthorized_path packages/ledger/src/ledger.ts',
  ],
  [
    'AVEN-011: frozen test',
    C2,
    addTo('p2', put('packages/ledger/test/ledger.test.ts', 'x\n')),
    'unauthorized_path packages/ledger/test/ledger.test.ts',
  ],
  [
    'AVEN-011: frozen evaluator',
    C2,
    addTo('p2', put('tooling/attribution/attribution.ts', 'x\n')),
    'unauthorized_path tooling/attribution/attribution.ts',
  ],
  [
    'AVEN-011: frozen report',
    C2,
    addTo('p2', put('docs/AVEN_010_REPORT.md', 'x\n')),
    'unauthorized_path docs/AVEN_010_REPORT.md',
  ],
  [
    'AVEN-011: frozen file modified then restored',
    C2,
    (h) =>
      insertAfter(
        h,
        'p2',
        milestone('t1', [put('packages/ledger/src/ledger.ts', 'tampered\n')]),
        milestone('t2', [
          put('packages/ledger/src/ledger.ts', 'export const frozen = 16;\n'),
        ]),
      ),
    'unauthorized_path packages/ledger/src/ledger.ts',
  ],
  [
    'AVEN-011: unlisted package file',
    C2,
    addTo('p2', put(pkg('src/extra.ts'), 'x\n')),
    'unauthorized_path packages/action-proposals/src/extra.ts',
  ],
  [
    'AVEN-011: unlisted nested package file',
    C6,
    addTo('p4', put(pkg('src/ledger/extra.ts'), 'x\n')),
    'unauthorized_path packages/action-proposals/src/ledger/extra.ts',
  ],
  [
    'allowlist data naming a frozen file',
    C2,
    (h) => {
      h.delta = { ...AVEN_011_DELTA, 'packages/ledger/src/ledger.ts': 'M' };
    },
    'allowlist_names_frozen_path: M packages/ledger/src/ledger.ts',
  ],
  [
    'allowlist data adding over a frozen file',
    C2,
    (h) => {
      h.delta = { ...AVEN_011_DELTA, 'docs/AVEN_010_REPORT.md': 'A' };
    },
    'allowlist_names_frozen_path: A docs/AVEN_010_REPORT.md',
  ],
  // Deletions, renames, modes and types.
  [
    'AVEN-011: deletion',
    C6,
    addTo('p3', drop(pkg('src/inspect.ts'))),
    'forbidden_status D packages/action-proposals/src/inspect.ts',
  ],
  [
    'AVEN-011: rename',
    C6,
    addTo(
      'p3',
      drop(pkg('src/inspect.ts')),
      put(pkg('src/inspection.ts'), 'x\n'),
    ),
    'forbidden_status D packages/action-proposals/src/inspect.ts',
  ],
  [
    'AVEN-011: governance file deleted and re-added',
    C1,
    (h) =>
      insertAfter(
        h,
        'p1',
        milestone('gd', [drop('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md')]),
        milestone('ga', [
          put('docs/POST_AVEN010_COMMIT_ATTRIBUTION.md', '# Policy again\n'),
        ]),
      ),
    'forbidden_status A docs/POST_AVEN010_COMMIT_ATTRIBUTION.md',
  ],
  [
    'AVEN-011: executable file',
    C2,
    (h) => {
      find(h, 'p2').changes.find((c) => c.path === pkg('src/index.ts')).mode =
        '100755';
    },
    'forbidden_mode 000000->100755 packages/action-proposals/src/index.ts',
  ],
  [
    'AVEN-011: symlink',
    C2,
    (h) => {
      find(h, 'p2').changes.find((c) => c.path === pkg('src/config.ts')).mode =
        '120000';
    },
    'forbidden_mode 000000->120000 packages/action-proposals/src/config.ts',
  ],
  [
    'AVEN-011: submodule',
    C2,
    (h) => {
      const p2 = find(h, 'p2');
      p2.changes = p2.changes.filter((c) => c.path !== pkg('src/errors.ts'));
      p2.changes.push(gitlink(pkg('src/errors.ts')));
    },
    'forbidden_mode 000000->160000 packages/action-proposals/src/errors.ts',
  ],
  [
    'AVEN-011: mode change',
    C6,
    addTo(
      'p3',
      put(pkg('src/index.ts'), synthetic(pkg('src/index.ts')), '100755'),
    ),
    'forbidden_mode 100644->100755 packages/action-proposals/src/index.ts',
  ],
  [
    'AVEN-011: type change to symlink',
    C6,
    addTo('p3', put(pkg('src/canonical.ts'), 'index.ts', '120000')),
    'forbidden_status T packages/action-proposals/src/canonical.ts',
  ],
  // Governance.
  [
    'governance change not isolated',
    C2,
    addTo('p1', put(pkg('package.json'), '{}\n')),
    'governance_change_not_isolated',
  ],
  [
    'governance change after the trusted reference',
    C6G,
    (h) => {
      h.argv = (sha) => ['--governance-frozen-at', sha('p1')];
    },
    'governance_change_after_trusted_reference',
  ],
  [
    'trusted reference outside the milestone',
    C6,
    (h) => {
      h.argv = (sha) => ['--governance-frozen-at', sha('h6')];
    },
    'is not an AVEN-011 milestone commit',
  ],
  // package.json.
  [
    'package.json test exclusions',
    C2,
    setIn(
      'p2',
      'package.json',
      json({
        ...SYN_PACKAGE_INSERTED,
        scripts: { ...SYN_PACKAGE_INSERTED.scripts, test: 'vitest run' },
      }),
    ),
    'package_json_state',
  ],
  [
    'package.json new dependency',
    C2,
    setIn(
      'p2',
      'package.json',
      json({ ...SYN_PACKAGE_INSERTED, dependencies: { leftpad: '1.0.0' } }),
    ),
    'package_json_state',
  ],
  [
    'package.json one script only',
    C2,
    setIn(
      'p2',
      'package.json',
      json({
        ...SYN_PACKAGE_INSERTED,
        scripts: {
          ...SYN_PACKAGE_INSERTED.scripts,
          check: SYN_PACKAGE_BASE.scripts.check,
        },
      }),
    ),
    'package_json_state',
  ],
  [
    'package.json unapproved description',
    C6,
    setIn(
      'p6',
      'package.json',
      json({ ...SYN_PACKAGE_INSERTED, description: 'Something else' }),
    ),
    'package_json_state',
  ],
  [
    'package.json non-canonical formatting',
    C2,
    setIn(
      'p2',
      'package.json',
      JSON.stringify(SYN_PACKAGE_INSERTED, null, 4) + '\n',
    ),
    'package_json_state',
  ],
  [
    'package.json tampered then restored',
    C2,
    (h) =>
      insertAfter(
        h,
        'p2',
        milestone('t1', [
          put(
            'package.json',
            json({
              ...SYN_PACKAGE_INSERTED,
              scripts: { ...SYN_PACKAGE_INSERTED.scripts, test: 'vitest run' },
            }),
          ),
        ]),
        milestone('t2', [put('package.json', json(SYN_PACKAGE_INSERTED))]),
      ),
    'package_json_state',
  ],
  // pnpm-lock.yaml.
  [
    'lockfile existing entry changed',
    C2,
    setIn(
      'p2',
      'pnpm-lock.yaml',
      SYN_LOCK_1.replace(
        '  apps/api:\n    dependencies:\n      zod:\n        specifier: 4.6.5',
        '  apps/api:\n    dependencies:\n      zod:\n        specifier: 4.6.6',
      ),
    ),
    'lockfile_state',
  ],
  [
    'lockfile block in wrong position',
    C2,
    setIn(
      'p2',
      'pnpm-lock.yaml',
      SYN_LOCK_HEAD +
        SYN_LOCK_TAIL.replace('packages:\n', SYN_BLOCK_1 + 'packages:\n'),
    ),
    'lockfile_state',
  ],
  [
    'lockfile duplicated block',
    C2,
    setIn('p2', 'pnpm-lock.yaml', lockWith(SYN_BLOCK_1 + SYN_BLOCK_1)),
    'lockfile_state',
  ],
  [
    'lockfile incomplete block',
    C2,
    setIn(
      'p2',
      'pnpm-lock.yaml',
      lockWith(
        SYN_BLOCK_START + SYN_BLOCK_END.split('    devDependencies:')[0] + '\n',
      ),
    ),
    'lockfile_state',
  ],
  [
    'lockfile unauthorized link',
    C2,
    setIn(
      'p2',
      'pnpm-lock.yaml',
      lockWith(
        SYN_BLOCK_START +
          "      '@aven/context-broker':\n        specifier: workspace:*\n        version: link:../context-broker\n" +
          SYN_BLOCK_END,
      ),
    ),
    'lockfile_state',
  ],
  [
    'lockfile unexpected version',
    C2,
    setIn(
      'p2',
      'pnpm-lock.yaml',
      lockWith(SYN_BLOCK_1.replace('version: 4.6.5', 'version: 4.6.6')),
    ),
    'lockfile_state',
  ],
  [
    'lockfile tampered then restored',
    C2,
    (h) =>
      insertAfter(
        h,
        'p2',
        milestone('t1', [put('pnpm-lock.yaml', SYN_LOCK_1 + '# tampered\n')]),
        milestone('t2', [put('pnpm-lock.yaml', SYN_LOCK_1)]),
      ),
    'lockfile_state',
  ],
  // Tags.
  [
    'aven-010 moved',
    C1,
    (h) => {
      h.after = ({ run, sha }) =>
        run(['tag', '-f', '-a', '-m', 'moved', 'aven-010', sha('f15')]);
    },
    'aven-010 moved from its frozen commit',
  ],
  [
    'aven-010 tag object replaced',
    C1,
    (h) => {
      h.after = ({ run, sha }) =>
        run(['tag', '-f', '-a', '-m', 'replaced', 'aven-010', sha('f16')]);
    },
    'aven-010 annotated tag object was replaced',
  ],
  [
    'aven-010 made lightweight',
    C1,
    (h) => {
      h.after = ({ run, sha }) => run(['tag', '-f', 'aven-010', sha('f16')]);
    },
    'aven-010 is not annotated',
  ],
  [
    'aven-009 moved',
    C1,
    (h) => {
      h.after = ({ run, sha }) =>
        run(['tag', '-f', '-a', '-m', 'moved', 'aven-009', sha('f1')]);
    },
    'aven-009 moved from its frozen commit',
  ],
  // Identity and trailers.
  [
    'author is not the owner',
    C1,
    (h) => {
      find(h, 'p1').author = SYN_CLAUDE;
    },
    'owner_not_primary_author',
  ],
  [
    'committer is not the owner',
    C1,
    (h) => {
      find(h, 'p1').committer = SYN_CLAUDE;
    },
    'owner_not_committer',
  ],
  [
    'owner name with unrecognized email',
    C1,
    (h) => {
      find(h, 'p1').author = {
        name: 'Varun Karthik',
        email: 'varun@example.com',
      };
    },
    'owner_not_primary_author',
  ],
  [
    'missing Claude trailer',
    C1,
    (h) => {
      find(h, 'p1').message = 'synthetic p1\n\nNo trailer.\n';
    },
    'claude_trailer_missing_duplicate_or_unparsed',
  ],
  [
    'duplicated Claude trailer',
    C1,
    (h) => {
      find(h, 'p1').message =
        'synthetic p1\n\n' + CLAUDE + '\n' + CLAUDE + '\n';
    },
    'claude_trailer_missing_duplicate_or_unparsed',
  ],
  [
    'malformed Claude trailer',
    C1,
    (h) => {
      find(h, 'p1').message =
        'synthetic p1\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n';
    },
    'unexpected_or_malformed_coauthor',
  ],
  [
    'Claude trailer not in the final block',
    C1,
    (h) => {
      find(h, 'p1').message =
        'synthetic p1\n\n' + CLAUDE + '\n\nA later paragraph.\n';
    },
    'claude_trailer_missing_duplicate_or_unparsed',
  ],
  [
    'extra co-author',
    C1,
    (h) => {
      find(h, 'p1').message =
        ownerMessage('synthetic p1') +
        'Co-authored-by: Someone <other@example.com>\n';
    },
    'unexpected_or_malformed_coauthor',
  ],
  // Linearity, frozen era and ancestry.
  [
    'merge commit',
    C2,
    (h) => {
      insertAfter(h, 'p1', {
        ...milestone('side', [put('README.md', '# side\n')]),
        branch: 'side',
        from: 'p1',
      });
      find(h, 'p2').from = 'p1';
      find(h, 'p2').merge = ['side'];
    },
    'nonlinear_commit',
  ],
  [
    'frozen-era commit without the owner trailer',
    C1,
    (h) => {
      find(h, 'f5').message = 'synthetic frozen-era change 5\n';
    },
    'missing_owner_trailer',
  ],
  [
    'seventeen frozen-era commits',
    C1,
    (h) => {
      insertAfter(h, 'f16', {
        ...find(h, 'f16'),
        id: 'f17',
        changes: [
          put('packages/ledger/src/ledger.ts', 'export const frozen = 17;\n'),
        ],
      });
      h.v10 = 'f17';
      h.tags[1].at = 'f17';
    },
    'AVEN-010 must be sixteenth commit after AVEN-009',
  ],
  [
    'baseline not an ancestor of HEAD',
    C1,
    (h) => {
      insertAfter(h, 'h5', {
        ...milestone('stray', [put('README.md', '# stray\n')]),
        branch: 'stray',
        from: 'h5',
      });
      find(h, 'h6').from = 'h5';
      h.baseline = 'stray';
    },
    'AVEN-011 baseline is not an ancestor of HEAD',
  ],
]);

// ---------------------------------------------------------------------------
// AVEN-012 era (`aven-012-governance-v1`). Each history closes the AVEN-011
// era with seven commits and an annotated aven-011 tag; that era is still
// judged by the unchanged AVEN-011 rules, now with its trusted reference
// pinned. The AVEN-012 rules are judged against the aven-011 tree.

const CONTROLS_012 = Object.freeze({
  'AVEN-011 closed at aven-011, no AVEN-012 commit': () => closedHistory([]),
  'AVEN-012 Patch 1 with unchanged package.json and lockfile': () =>
    closedHistory(['q1']),
  'AVEN-012 Patches 1-2 with the permitted importer addition': () =>
    closedHistory(['q1', 'q2']),
  'complete four-patch AVEN-012 pattern': () =>
    closedHistory(['q1', 'q2', 'q3', 'q4']),
  'four AVEN-012 patches, governance frozen at AVEN-012 Patch 1': () => ({
    ...closedHistory(['q1', 'q2', 'q3', 'q4']),
    argv: (sha) => ['--governance-frozen-at', sha('q1')],
  }),
  'four AVEN-012 patches plus a later governance-only commit (no freeze)':
    () => {
      const history = closedHistory(['q1', 'q2', 'q3', 'q4']);
      insertAfter(
        history,
        'q3',
        milestone('g2', [put(POLICY, '# Policy v4\n')]),
      );
      return history;
    },
});
const K0 = CONTROLS_012['AVEN-011 closed at aven-011, no AVEN-012 commit'];
const K1 =
  CONTROLS_012['AVEN-012 Patch 1 with unchanged package.json and lockfile'];
const K2 =
  CONTROLS_012['AVEN-012 Patches 1-2 with the permitted importer addition'];
const K4 = CONTROLS_012['complete four-patch AVEN-012 pattern'];
const K4G =
  CONTROLS_012[
    'four AVEN-012 patches plus a later governance-only commit (no freeze)'
  ];
const package012 = (scripts) =>
  json({
    ...SYN_PACKAGE_012_INSERTED,
    scripts: { ...SYN_PACKAGE_012_INSERTED.scripts, ...scripts },
  });

/** [name, control, defect, expected output fragment]. */
const VIOLATIONS_012 = Object.freeze([
  // AVEN-011 and earlier files are frozen in the AVEN-012 era.
  [
    'AVEN-012: AVEN-011 package source',
    K2,
    addTo('q2', put(pkg('src/index.ts'), 'x\n')),
    'unauthorized_path packages/action-proposals/src/index.ts',
  ],
  [
    'AVEN-012: AVEN-011 package test',
    K2,
    addTo('q2', put(pkg('test/boundaries.test.ts'), 'x\n')),
    'unauthorized_path packages/action-proposals/test/boundaries.test.ts',
  ],
  [
    'AVEN-012: AVEN-011 report',
    K2,
    addTo('q2', put('docs/AVEN_011_REPORT.md', 'x\n')),
    'unauthorized_path docs/AVEN_011_REPORT.md',
  ],
  [
    'AVEN-012: AVEN-011 file deleted',
    K2,
    addTo('q2', drop(pkg('src/inspect.ts'))),
    'unauthorized_path packages/action-proposals/src/inspect.ts',
  ],
  [
    'AVEN-012: AVEN-011 file modified then restored',
    K2,
    (h) =>
      insertAfter(
        h,
        'q2',
        milestone('t1', [put(pkg('src/index.ts'), 'tampered\n')]),
        milestone('t2', [
          put(pkg('src/index.ts'), synthetic(pkg('src/index.ts'))),
        ]),
      ),
    'unauthorized_path packages/action-proposals/src/index.ts',
  ],
  [
    'AVEN-012: frozen AVEN-010 source',
    K2,
    addTo('q2', put('packages/ledger/src/ledger.ts', 'x\n')),
    'unauthorized_path packages/ledger/src/ledger.ts',
  ],
  [
    'AVEN-012: frozen evaluator',
    K2,
    addTo('q2', put('tooling/attribution/attribution.ts', 'x\n')),
    'unauthorized_path tooling/attribution/attribution.ts',
  ],
  [
    'AVEN-012: Root placeholder directory',
    K2,
    addTo('q2', put('packages/root/index.ts', 'x\n')),
    'unauthorized_path packages/root/index.ts',
  ],
  [
    'AVEN-012: unlisted package file',
    K2,
    addTo('q2', put(pkg012('src/extra.ts'), 'x\n')),
    'unauthorized_path packages/root-policy/src/extra.ts',
  ],
  [
    'AVEN-012: unlisted nested package file',
    K4,
    addTo('q3', put(pkg012('src/ledger/extra.ts'), 'x\n')),
    'unauthorized_path packages/root-policy/src/ledger/extra.ts',
  ],
  [
    'AVEN-012: package file deleted',
    K4,
    addTo('q3', drop(pkg012('src/evaluate.ts'))),
    'forbidden_status D packages/root-policy/src/evaluate.ts',
  ],
  [
    'AVEN-012: executable package file',
    K2,
    (h) => {
      find(h, 'q2').changes.find(
        (c) => c.path === pkg012('src/index.ts'),
      ).mode = '100755';
    },
    'forbidden_mode 000000->100755 packages/root-policy/src/index.ts',
  ],
  [
    'AVEN-012: symlink',
    K2,
    (h) => {
      find(h, 'q2').changes.find(
        (c) => c.path === pkg012('src/config.ts'),
      ).mode = '120000';
    },
    'forbidden_mode 000000->120000 packages/root-policy/src/config.ts',
  ],
  [
    'AVEN-012: type change to symlink',
    K4,
    addTo('q3', put(pkg012('src/canonical.ts'), 'index.ts', '120000')),
    'forbidden_status T packages/root-policy/src/canonical.ts',
  ],
  [
    'AVEN-012: governance file deleted',
    K1,
    (h) => insertAfter(h, 'q1', milestone('gd', [drop(WORKFLOW)])),
    'forbidden_status D .github/workflows/owner-first-attribution.yml',
  ],
  [
    'AVEN-012 allowlist data naming an AVEN-011 file',
    K2,
    (h) => {
      h.delta012 = { ...AVEN_012_DELTA, [pkg('src/index.ts')]: 'M' };
    },
    'allowlist_names_frozen_path: M packages/action-proposals/src/index.ts',
  ],
  [
    'AVEN-012 allowlist data adding over the AVEN-011 report',
    K2,
    (h) => {
      h.delta012 = { ...AVEN_012_DELTA, 'docs/AVEN_011_REPORT.md': 'A' };
    },
    'allowlist_names_frozen_path: A docs/AVEN_011_REPORT.md',
  ],
  // Governance.
  [
    'AVEN-012: governance change not isolated',
    K2,
    addTo('q1', put(pkg012('package.json'), '{}\n')),
    'governance_change_not_isolated',
  ],
  [
    'AVEN-012: governance change after the trusted reference',
    K4G,
    (h) => {
      h.argv = (sha) => ['--governance-frozen-at', sha('q1')];
    },
    'governance_change_after_trusted_reference',
  ],
  [
    'AVEN-011 trusted reference offered for the AVEN-012 era',
    K1,
    (h) => {
      h.argv = (sha) => ['--governance-frozen-at', sha('p1')];
    },
    'is not an AVEN-012 milestone commit',
  ],
  [
    'AVEN-012 trusted reference at aven-011 itself',
    K4,
    (h) => {
      h.argv = (sha) => ['--governance-frozen-at', sha('p7')];
    },
    'is not an AVEN-012 milestone commit',
  ],
  // The closed AVEN-011 era.
  [
    'AVEN-011 era governance change after its pinned trusted reference',
    K0,
    (h) => {
      find(h, 'p7').changes = [put(POLICY, '# Policy v2, amended\n')];
    },
    'governance_change_after_aven011_trusted_reference',
  ],
  [
    'AVEN-011 pinned trusted reference outside the AVEN-011 era',
    K0,
    (h) => {
      h.aven011Trusted = 'h6';
    },
    'is not an AVEN-011 milestone commit',
  ],
  [
    'AVEN-011 era with an eighth commit',
    K1,
    (h) =>
      insertAfter(
        h,
        'p6',
        milestone('p6b', [put('README.md', '# Synthetic readme v6b\n')]),
      ),
    'AVEN-011 must have exactly 7 commits after its baseline; found 8',
  ],
  [
    'AVEN-011 era with a frozen-file change',
    K1,
    addTo('p5', put('packages/ledger/src/ledger.ts', 'x\n')),
    'unauthorized_path packages/ledger/src/ledger.ts',
  ],
  [
    'aven-011 moved',
    K1,
    (h) => {
      h.after = ({ run, sha }) =>
        run(['tag', '-f', '-a', '-m', 'moved', 'aven-011', sha('p6')]);
    },
    'aven-011 moved from its frozen commit',
  ],
  [
    'aven-011 tag object replaced',
    K1,
    (h) => {
      h.after = ({ run, sha }) =>
        run(['tag', '-f', '-a', '-m', 'replaced', 'aven-011', sha('p7')]);
    },
    'aven-011 annotated tag object was replaced',
  ],
  [
    'aven-011 made lightweight',
    K1,
    (h) => {
      h.after = ({ run, sha }) => run(['tag', '-f', 'aven-011', sha('p7')]);
    },
    'aven-011 is not annotated',
  ],
  [
    'aven-011 deleted',
    K1,
    (h) => {
      h.after = ({ run }) => run(['tag', '-d', 'aven-011']);
    },
    'aven-011 tag is missing',
  ],
  [
    'aven-011 not an ancestor of HEAD',
    K1,
    (h) => {
      find(h, 'q1').from = 'p6';
    },
    'aven-011 is not an ancestor of HEAD',
  ],
  // package.json.
  [
    'AVEN-012: package.json test exclusions',
    K2,
    setIn('q2', 'package.json', package012({ test: 'vitest run' })),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json one script only',
    K2,
    setIn(
      'q2',
      'package.json',
      package012({ check: SYN_PACKAGE_FINAL.scripts.check }),
    ),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json drops the AVEN-011 typecheck',
    K2,
    setIn(
      'q2',
      'package.json',
      package012({
        typecheck: SYN_PACKAGE_012_INSERTED.scripts.typecheck.replace(
          ' && tsc --project packages/action-proposals/tsconfig.json --noEmit',
          '',
        ),
      }),
    ),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json new dependency',
    K2,
    setIn(
      'q2',
      'package.json',
      json({ ...SYN_PACKAGE_012_INSERTED, dependencies: { leftpad: '1.0.0' } }),
    ),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json unapproved description',
    K4,
    setIn(
      'q4',
      'package.json',
      json({ ...SYN_PACKAGE_012_INSERTED, description: 'Something else' }),
    ),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json reverts to the pre-AVEN-011 description',
    K4,
    setIn(
      'q4',
      'package.json',
      json({
        ...SYN_PACKAGE_012_INSERTED,
        description: SYN_PACKAGE_V9.description,
      }),
    ),
    'package_json_state',
  ],
  [
    'AVEN-012: package.json tampered then restored',
    K2,
    (h) =>
      insertAfter(
        h,
        'q2',
        milestone('t1', [
          put('package.json', package012({ test: 'vitest run' })),
        ]),
        milestone('t2', [put('package.json', json(SYN_PACKAGE_012_INSERTED))]),
      ),
    'package_json_state',
  ],
  // pnpm-lock.yaml.
  [
    'AVEN-012: lockfile block in wrong position',
    K2,
    setIn(
      'q2',
      'pnpm-lock.yaml',
      SYN_LOCK_HEAD +
        SYN_BLOCK_2 +
        SYN_012_BLOCK_1 +
        SYN_LOCK_BASELINE +
        SYN_LOCK_REST,
    ),
    'lockfile_state',
  ],
  [
    'AVEN-012: lockfile links the AVEN-011 package',
    K2,
    setIn(
      'q2',
      'pnpm-lock.yaml',
      lock012With(
        SYN_012_BLOCK_START +
          "      '@aven/action-proposals':\n        specifier: workspace:*\n        version: link:../action-proposals\n" +
          SYN_BLOCK_END,
      ),
    ),
    'lockfile_state',
  ],
  [
    'AVEN-012: lockfile drops the AVEN-011 importer',
    K2,
    setIn(
      'q2',
      'pnpm-lock.yaml',
      SYN_LOCK_HEAD + SYN_LOCK_BASELINE + SYN_012_BLOCK_1 + SYN_LOCK_REST,
    ),
    'lockfile_state',
  ],
  [
    'AVEN-012: lockfile tampered then restored',
    K2,
    (h) =>
      insertAfter(
        h,
        'q2',
        milestone('t1', [
          put('pnpm-lock.yaml', SYN_LOCK_012_1 + '# tampered\n'),
        ]),
        milestone('t2', [put('pnpm-lock.yaml', SYN_LOCK_012_1)]),
      ),
    'lockfile_state',
  ],
  // Identity, trailers and linearity.
  [
    'AVEN-012: author is not the owner',
    K1,
    (h) => {
      find(h, 'q1').author = SYN_CLAUDE;
    },
    'owner_not_primary_author',
  ],
  [
    'AVEN-012: missing Claude trailer',
    K1,
    (h) => {
      find(h, 'q1').message = 'synthetic q1\n\nNo trailer.\n';
    },
    'claude_trailer_missing_duplicate_or_unparsed',
  ],
  [
    'AVEN-012: merge commit',
    K2,
    (h) => {
      insertAfter(h, 'q1', {
        ...milestone('side012', [put('README.md', '# side\n')]),
        branch: 'side012',
        from: 'q1',
      });
      find(h, 'q2').from = 'q1';
      find(h, 'q2').merge = ['side012'];
    },
    'nonlinear_commit',
  ],
]);

function cliArgumentChecks() {
  for (const args of [
    ['--bogus'],
    ['--governance-frozen-at'],
    ['--governance-frozen-at', 'HEAD'],
    ['--governance-frozen-at', 'A'.repeat(40)],
    ['--self-test', 'extra'],
  ]) {
    const result = spawnSync(process.execPath, [SELF, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, 'CLI must reject ' + args.join(' '));
    assert(result.stderr.includes('Usage:'), 'CLI usage for ' + args.join(' '));
  }
}

/**
 * Runs every control and then every single-defect violation whose control
 * passed. A violation must exit 1 and print its expected fragment.
 */
async function campaign(controls, violations, limit) {
  const failures = [];
  const controlEntries = Object.entries(controls);
  const controlResults = await pooled(
    controlEntries.map(
      ([, control]) =>
        () =>
          runFixture(control()),
    ),
    limit,
  );
  const passed = new Map();
  controlEntries.forEach(([name, control], index) => {
    const result = controlResults[index];
    passed.set(control, result.status === 0);
    if (result.status !== 0)
      failures.push('control "' + name + '" failed:\n' + result.output);
  });
  const runnable = violations.filter(([name, control]) => {
    if (passed.get(control)) return true;
    failures.push('violation "' + name + '" has no passing control');
    return false;
  });
  const results = await pooled(
    runnable.map(
      ([, control, defect]) =>
        () =>
          runFixture(mutate(control, defect)),
    ),
    limit,
  );
  runnable.forEach(([name, , , expected], index) => {
    const result = results[index];
    if (result.status !== 1 || !result.output.includes(expected))
      failures.push(
        'violation "' +
          name +
          '" expected exit 1 with "' +
          expected +
          '", got ' +
          result.status +
          ':\n' +
          result.output,
      );
  });
  return failures;
}

async function syntheticCampaign() {
  const limit = Math.max(2, Math.min(8, availableParallelism()));
  const failures = [
    ...(await campaign(CONTROLS, VIOLATIONS, limit)),
    ...(await campaign(CONTROLS_012, VIOLATIONS_012, limit)),
  ];
  if (failures.length) throw new Error(failures.join('\n\n'));
  return (
    Object.keys(CONTROLS).length +
    ' passing controls and ' +
    VIOLATIONS.length +
    ' single-defect violations of the open AVEN-011 era; ' +
    Object.keys(CONTROLS_012).length +
    ' passing controls and ' +
    VIOLATIONS_012.length +
    ' single-defect violations of the closed AVEN-011 and the AVEN-012 era'
  );
}

async function selfTest() {
  const good = {
    parents: [V10],
    authorName: 'Varun Karthik',
    authorEmail: 'varunraj2117@gmail.com',
    committerName: 'Varun Karthik',
    committerEmail: '71327884+varun-raj-77@users.noreply.github.com',
    message: 'feat: example\n\n' + CLAUDE,
    trailers: [CLAUDE],
  };
  assert.deepEqual(postFreezeViolations(good), []);
  assert.deepEqual(
    postFreezeViolations({
      ...good,
      authorEmail: '71327884+varun-raj-77@users.noreply.github.com',
    }),
    [],
  );
  assert(
    postFreezeViolations({
      ...good,
      authorEmail: 'noreply@anthropic.com',
    }).includes('owner_not_primary_author'),
  );
  assert(
    postFreezeViolations({ ...good, committerName: 'Claude' }).includes(
      'owner_not_committer',
    ),
  );
  assert(
    postFreezeViolations({
      ...good,
      message: 'feat: no trailer',
      trailers: [],
    }).includes('claude_trailer_missing_duplicate_or_unparsed'),
  );
  assert(
    postFreezeViolations({
      ...good,
      message: good.message + '\n' + CLAUDE,
      trailers: [CLAUDE, CLAUDE],
    }).length > 0,
  );
  assert(
    postFreezeViolations({ ...good, trailers: [] }).includes(
      'claude_trailer_missing_duplicate_or_unparsed',
    ),
  );
  assert(
    postFreezeViolations({
      ...good,
      message: good.message + '\nCo-authored-by: Someone <other@example.com>',
      trailers: [CLAUDE, 'Co-authored-by: Someone <other@example.com>'],
    }).includes('unexpected_or_malformed_coauthor'),
  );
  assert(
    postFreezeViolations({
      ...good,
      parents: [V10, V9],
    }).includes('nonlinear_commit'),
  );
  console.log('PASS: nine owner-first attribution scenarios');
  // In a linear single-parent history the per-commit rules and allowlist
  // invariants already imply the cumulative state, so no Git history can
  // reach these branches alone; they are defense in depth, checked directly.
  const entry = (status, path, dstMode = '100644') => ({
    srcMode: '100644',
    dstMode,
    status,
    path,
  });
  const gate = 'tooling/attribution/check-post-aven010.mjs';
  assert.deepEqual(
    cumulativeViolations([entry('A', gate)], MAINTENANCE_DELTA),
    [],
  );
  assert.deepEqual(
    cumulativeViolations([entry('M', gate)], MAINTENANCE_DELTA),
    ['cumulative_status M ' + gate],
  );
  assert.deepEqual(
    cumulativeViolations([entry('A', gate, '100755')], MAINTENANCE_DELTA),
    ['cumulative_mode 100755 ' + gate],
  );
  assert.deepEqual(
    cumulativeViolations([entry('M', 'README.md')], MAINTENANCE_DELTA),
    ['cumulative_unauthorized README.md'],
  );
  console.log('PASS: four direct cumulative-state cases');
  // AVEN-012 states, judged directly against the synthetic aven-011 state.
  const bytes = (text) => Buffer.from(text, 'utf8');
  const v11Package = bytes(json(SYN_PACKAGE_FINAL));
  for (const [candidate, state] of [
    [SYN_PACKAGE_FINAL, 'P0'],
    [SYN_PACKAGE_012_INSERTED, 'P1'],
    [SYN_PACKAGE_012_FINAL, 'P1'],
    [{ ...SYN_PACKAGE_FINAL, description: AVEN_012_DESCRIPTION }, 'P1'],
    [SYN_PACKAGE_INSERTED, null],
  ])
    assert.equal(
      packageJsonState(
        v11Package,
        bytes(json(candidate)),
        AVEN_012_PACKAGE_RULE,
      ),
      state,
    );
  for (const [candidate, state] of [
    [SYN_LOCK_2, 'L0'],
    [SYN_LOCK_012_1, 'L1'],
    [SYN_LOCK_012_2, 'L1'],
    [SYN_LOCK_1, null],
  ])
    assert.equal(
      lockfileState(bytes(SYN_LOCK_2), bytes(candidate), AVEN_012_LOCK_RULE),
      state,
    );
  // The AVEN-011 rule cannot admit the AVEN-012 block, nor the reverse.
  assert.equal(lockfileState(bytes(SYN_LOCK_2), bytes(SYN_LOCK_012_1)), null);
  assert.equal(
    lockfileState(bytes(SYN_LOCK_BASE), bytes(SYN_LOCK_1), AVEN_012_LOCK_RULE),
    null,
  );
  assert.deepEqual(
    cumulativeViolations([entry('M', gate)], AVEN_012_DELTA),
    [],
  );
  assert.deepEqual(cumulativeViolations([entry('A', gate)], AVEN_012_DELTA), [
    'cumulative_status A ' + gate,
  ]);
  assert.deepEqual(
    cumulativeViolations(
      [entry('M', 'packages/action-proposals/src/index.ts')],
      AVEN_012_DELTA,
    ),
    ['cumulative_unauthorized packages/action-proposals/src/index.ts'],
  );
  console.log('PASS: fourteen direct AVEN-012 state cases');
  cliArgumentChecks();
  console.log('PASS: CLI rejects malformed arguments with exit status 1');
  console.log(
    'PASS: synthetic-history campaign, ' + (await syntheticCampaign()),
  );
}

function invokedDirectly() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(resolve(process.argv[1])) === realpathSync(SELF)
    );
  } catch {
    return false;
  }
}

if (invokedDirectly())
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
