import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

/**
 * AVEN-010 commit attribution gate (repository tooling discipline, not
 * security: it reads recorded commit metadata and cannot prove who typed a
 * commit or authenticate any identity).
 *
 * Every commit after the frozen AVEN-009 baseline must satisfy:
 *   - a linear history: exactly one parent per commit (no merge, no root),
 *     the oldest commit's parent is the baseline, and the baseline is an
 *     ancestor of HEAD; the `aven-009` tag must exist and peel to the frozen
 *     baseline commit;
 *   - complete history: a shallow repository, a missing baseline commit or
 *     an unresolvable HEAD fails closed (nothing is assumed);
 *   - author and committer are each exactly Claude <noreply@anthropic.com> or
 *     the owner with the verified owner email;
 *   - a Claude-authored commit carries EXACTLY ONE byte-exact
 *     `Co-authored-by: Varun Karthik <varunraj2117@gmail.com>` that Git itself
 *     parses as a trailer (`%(trailers:only,unfold)`), and that line appears
 *     exactly once in the raw message;
 *   - no commit carries a malformed, misplaced, duplicated or wrong-email
 *     owner attribution, and every parsed co-author trailer names either the
 *     owner (exactly) or Claude at <noreply@anthropic.com>.
 *
 * Git is invoked with replacement objects disabled, so `git replace` cannot
 * substitute a different commit for the one recorded in history. Only commit
 * objects are read; Git configuration is never treated as evidence.
 */

export const FROZEN_BASELINE = Object.freeze({
  milestone: 'AVEN-009',
  tag: 'aven-009',
  commit: '80057a217adb90132c5b6bc1c6a5c0f798db08c5',
});

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export const CLAUDE_IDENTITY: Identity = Object.freeze({
  name: 'Claude',
  email: 'noreply@anthropic.com',
});

export const OWNER_IDENTITY: Identity = Object.freeze({
  name: 'Varun Karthik',
  email: 'varunraj2117@gmail.com',
});

/** Display names the owner has authored commits under with the verified email. */
export const OWNER_AUTHOR_NAMES: readonly string[] = Object.freeze([
  'Varun Karthik',
  'varun-raj-77',
]);

export const OWNER_CO_AUTHOR_TRAILER =
  'Co-authored-by: Varun Karthik <varunraj2117@gmail.com>';

/** Fixed violation codes, in reporting order. */
export const VIOLATION_CODES = Object.freeze([
  'not_a_git_repository',
  'shallow_history',
  'baseline_missing',
  'baseline_tag_missing',
  'baseline_tag_mismatch',
  'head_unresolved',
  'baseline_not_ancestor',
  'history_not_linear',
  'root_commit',
  'merge_commit',
  'unknown_author',
  'unknown_committer',
  'incorrect_owner_email',
  'missing_owner_trailer',
  'duplicate_owner_trailer',
  'unparsed_owner_attribution',
  'malformed_owner_attribution',
  'unexpected_co_author',
] as const);
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface CommitRecord {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  /** Raw message (`%B`). */
  readonly message: string;
  /** Trailer lines exactly as Git parses them (`%(trailers:only,unfold)`). */
  readonly trailers: readonly string[];
}

export interface CommitResult {
  readonly sha: string;
  readonly authoredBy: 'claude' | 'owner' | 'unknown';
  readonly author: Identity;
  readonly committer: Identity;
  /** The parsed, byte-exact owner trailer when present exactly once. */
  readonly ownerTrailer: string | null;
  readonly violations: readonly ViolationCode[];
}

export interface AttributionReport {
  readonly ok: boolean;
  readonly baseline: { readonly tag: string; readonly commit: string };
  readonly head: string | null;
  readonly repositoryViolations: readonly ViolationCode[];
  readonly commits: readonly CommitResult[];
}

const CO_AUTHOR_KEY = /co[\s_-]*authored[\s_-]*by/i;
const OWNER_LIKE = /varun|karthik/i;
const CLAUDE_CO_AUTHOR =
  /^Claude(?: [^<>\r\n]*[^<>\s])? <noreply@anthropic\.com>$/;

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.name === b.name && a.email === b.email;
}

function isOwner(identity: Identity): boolean {
  return (
    identity.email === OWNER_IDENTITY.email &&
    OWNER_AUTHOR_NAMES.includes(identity.name)
  );
}

/** Claims to be the owner (by name or email) without being the verified owner. */
function ownerLike(identity: Identity): boolean {
  return (
    identity.email !== OWNER_IDENTITY.email &&
    (OWNER_LIKE.test(identity.name) || OWNER_LIKE.test(identity.email))
  );
}

function ordered(codes: Iterable<ViolationCode>): ViolationCode[] {
  const set = new Set(codes);
  return VIOLATION_CODES.filter((code) => set.has(code));
}

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Pure per-commit rules. Deterministic; the input is not modified. */
export function evaluateCommit(commit: CommitRecord): CommitResult {
  const violations: ViolationCode[] = [];
  const author = Object.freeze({
    name: commit.authorName,
    email: commit.authorEmail,
  });
  const committer = Object.freeze({
    name: commit.committerName,
    email: commit.committerEmail,
  });

  if (commit.parents.length === 0) violations.push('root_commit');
  if (commit.parents.length > 1) violations.push('merge_commit');

  const authoredBy = sameIdentity(author, CLAUDE_IDENTITY)
    ? 'claude'
    : isOwner(author)
      ? 'owner'
      : 'unknown';
  if (authoredBy === 'unknown')
    violations.push(
      ownerLike(author) ? 'incorrect_owner_email' : 'unknown_author',
    );
  if (!sameIdentity(committer, CLAUDE_IDENTITY) && !isOwner(committer))
    violations.push(
      ownerLike(committer) ? 'incorrect_owner_email' : 'unknown_committer',
    );

  const parsed = commit.trailers.map((t) => t.replace(/\r$/, ''));
  const parsedExact = parsed.filter((t) => t === OWNER_CO_AUTHOR_TRAILER);
  const rawLines = lines(commit.message);
  const rawExact = rawLines.filter((l) => l === OWNER_CO_AUTHOR_TRAILER);

  if (parsedExact.length > 1 || rawExact.length > 1)
    violations.push('duplicate_owner_trailer');
  if (rawExact.length > parsedExact.length)
    violations.push('unparsed_owner_attribution');
  if (authoredBy === 'claude' && parsedExact.length === 0)
    violations.push('missing_owner_trailer');

  // Any owner-like co-author line, parsed or not, must be the exact trailer.
  const malformed = rawLines.some(
    (l) =>
      l !== OWNER_CO_AUTHOR_TRAILER &&
      CO_AUTHOR_KEY.test(l) &&
      OWNER_LIKE.test(l),
  );
  if (malformed) violations.push('malformed_owner_attribution');

  for (const trailer of parsed) {
    const separator = trailer.indexOf(':');
    const key = separator < 0 ? trailer : trailer.slice(0, separator);
    if (!CO_AUTHOR_KEY.test(key)) continue;
    if (trailer === OWNER_CO_AUTHOR_TRAILER) continue;
    const value = trailer.slice(separator + 1).trim();
    if (OWNER_LIKE.test(trailer)) {
      violations.push('malformed_owner_attribution');
    } else if (!CLAUDE_CO_AUTHOR.test(value)) {
      violations.push('unexpected_co_author');
    }
  }

  const codes = ordered(violations);
  return Object.freeze({
    sha: commit.sha,
    authoredBy,
    author,
    committer,
    ownerTrailer:
      parsedExact.length === 1 && rawExact.length === 1
        ? OWNER_CO_AUTHOR_TRAILER
        : null,
    violations: Object.freeze(codes),
  });
}

class GitFailure extends Error {}

function gitRunner(repoDir: string) {
  const env: NodeJS.ProcessEnv = {};
  // Only this repository is inspected: inherited GIT_* overrides (GIT_DIR,
  // GIT_INDEX_FILE, replacement or graft settings, ...) are dropped.
  for (const [key, value] of Object.entries(process.env))
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  // Never discover a repository above `repoDir`: it must itself be the root.
  env['GIT_CEILING_DIRECTORIES'] = dirname(resolve(repoDir));
  env['GIT_TERMINAL_PROMPT'] = '0';
  const base = [
    '--no-replace-objects',
    '-c',
    'log.showSignature=false',
    '-c',
    'i18n.logOutputEncoding=UTF-8',
    '-c',
    'trailer.separators=:',
    '-C',
    repoDir,
  ];
  return (args: readonly string[]): string => {
    try {
      return execFileSync('git', [...base, ...args], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      throw new GitFailure();
    }
  };
}

function attempt(fn: () => string): string | null {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GitFailure) return null;
    throw error;
  }
}

const FIELD = '%x00';

function readCommit(git: (args: readonly string[]) => string, sha: string) {
  const header = git([
    'show',
    '-s',
    '--no-show-signature',
    `--format=%P${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce`,
    sha,
  ]).replace(/\n$/, '');
  const [parents = '', an = '', ae = '', cn = '', ce = ''] = header.split('\0');
  const message = git([
    'show',
    '-s',
    '--no-show-signature',
    '--format=%B',
    sha,
  ]);
  const trailers = git([
    'show',
    '-s',
    '--no-show-signature',
    '--format=%(trailers:only,unfold)',
    sha,
  ])
    .split('\n')
    .filter((l) => l.length > 0);
  return {
    sha,
    parents: parents.split(' ').filter((p) => p.length > 0),
    authorName: an,
    authorEmail: ae,
    committerName: cn,
    committerEmail: ce,
    message,
    trailers,
  };
}

export interface AttributionOptions {
  readonly repoDir: string;
  readonly baseline: { readonly tag: string; readonly commit: string };
}

/**
 * Checks every commit in `<baseline>..HEAD`. Any repository-level failure
 * (missing history, wrong ancestry) fails closed and no commit is reported
 * as checked.
 */
export function checkAttribution(
  options: AttributionOptions,
): AttributionReport {
  const git = gitRunner(options.repoDir);
  const baseline = Object.freeze({
    tag: options.baseline.tag,
    commit: options.baseline.commit,
  });
  const fail = (
    code: ViolationCode,
    head: string | null = null,
  ): AttributionReport =>
    Object.freeze({
      ok: false,
      baseline,
      head,
      repositoryViolations: Object.freeze([code]),
      commits: Object.freeze([]),
    });

  if (
    attempt(() => git(['rev-parse', '--is-inside-work-tree']))?.trim() !==
    'true'
  )
    return fail('not_a_git_repository');
  if (
    attempt(() => git(['rev-parse', '--is-shallow-repository']))?.trim() !==
    'false'
  )
    return fail('shallow_history');
  if (!/^[0-9a-f]{40}$/.test(baseline.commit)) return fail('baseline_missing');
  if (
    attempt(() => git(['cat-file', '-e', `${baseline.commit}^{commit}`])) ===
    null
  )
    return fail('baseline_missing');
  const tagged = attempt(() =>
    git([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/tags/${baseline.tag}^{commit}`,
    ]),
  )?.trim();
  if (!tagged) return fail('baseline_tag_missing');
  if (tagged !== baseline.commit) return fail('baseline_tag_mismatch');
  const head = attempt(() =>
    git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  )?.trim();
  if (!head) return fail('head_unresolved');
  if (
    attempt(() =>
      git(['merge-base', '--is-ancestor', baseline.commit, head]),
    ) === null
  )
    return fail('baseline_not_ancestor', head);

  const listed = git(['rev-list', '--reverse', `${baseline.commit}..${head}`])
    .split('\n')
    .filter((l) => l.length > 0);
  const records = listed.map((sha) => readCommit(git, sha));
  const commits = records.map(evaluateCommit);

  // A linear chain: each commit's only parent is the previous commit (the
  // first one's is the baseline) and the last one is HEAD. Merges and roots
  // are also reported per commit.
  const repositoryViolations: ViolationCode[] = [];
  let expected = baseline.commit;
  for (const record of records) {
    if (record.parents.length !== 1 || record.parents[0] !== expected) {
      repositoryViolations.push('history_not_linear');
      break;
    }
    expected = record.sha;
  }
  if (expected !== head) repositoryViolations.push('history_not_linear');

  const ok =
    repositoryViolations.length === 0 &&
    commits.every((c) => c.violations.length === 0);
  return Object.freeze({
    ok,
    baseline,
    head,
    repositoryViolations: Object.freeze(ordered(repositoryViolations)),
    commits: Object.freeze(commits),
  });
}

/** Human-readable report lines (identities and fixed codes only). */
export function formatReport(report: AttributionReport): string[] {
  const out = [
    `AVEN-010 attribution check: baseline ${report.baseline.tag} ${report.baseline.commit}`,
    `HEAD: ${report.head ?? 'unresolved'}`,
  ];
  for (const code of report.repositoryViolations)
    out.push(`repository: FAIL ${code}`);
  for (const c of report.commits) {
    out.push(
      `${c.sha} ${c.violations.length === 0 ? 'ok' : 'FAIL'} author=${c.author.name} <${c.author.email}> committer=${c.committer.name} <${c.committer.email}> owner-trailer=${c.ownerTrailer ?? 'none'}${c.violations.length === 0 ? '' : ` violations=${c.violations.join(',')}`}`,
    );
  }
  const failing =
    report.repositoryViolations.length +
    report.commits.filter((c) => c.violations.length > 0).length;
  out.push(
    `${report.ok ? 'PASS' : 'FAIL'}: ${report.commits.length} commit(s) checked after ${report.baseline.tag}; ${failing} failure(s).`,
  );
  return out;
}
