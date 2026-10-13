/**
 * Post-AVEN-010 owner-first attribution gate. Frozen milestones are read-only.
 * Checks actual Git metadata; cannot authenticate the person who typed a commit.
 *
 * Run: node tooling/attribution/check-post-aven010.mjs
 * Unit cases: node tooling/attribution/check-post-aven010.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCommit } from './attribution.ts';

const V9 = '80057a217adb90132c5b6bc1c6a5c0f798db08c5';
const V10 = '76535d8647ee36e56bd2efd1a86642d1fc572ee7';
const TAG_OBJECTS = Object.freeze({
  'aven-009': 'adb32a0be958cd03be6af7534438fe37cd5af6ec',
  'aven-010': '4ef575c28f78504e77db8bb7d39df1ba8eda5041',
});
const MAINTENANCE_DELTA = Object.freeze({
  '.github/workflows/owner-first-attribution.yml': 'A',
  'AGENTS.md': 'M',
  'docs/POST_AVEN010_COMMIT_ATTRIBUTION.md': 'A',
  'package.json': 'M',
  'tooling/attribution/check-post-aven010.mjs': 'A',
});
const OWNER_NAMES = new Set(['Varun Karthik', 'varun-raj-77']);
const OWNER_EMAILS = new Set([
  'varunraj2117@gmail.com',
  '71327884+varun-raj-77@users.noreply.github.com',
]);
const CLAUDE = 'Co-authored-by: Claude <noreply@anthropic.com>';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function git(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(ROOT));
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', [
    '--no-replace-objects', '-c', 'log.showSignature=false',
    '-c', 'i18n.logOutputEncoding=UTF-8', '-c', 'trailer.separators=:',
    '-C', ROOT, ...args,
  ], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

function read(sha) {
  const fields = git(['show', '-s', '--format=%P%x00%an%x00%ae%x00%cn%x00%ce', sha])
    .split('\0');
  if (fields.length !== 5) throw new Error('Malformed commit metadata');
  const [parents, authorName, authorEmail, committerName, committerEmail] = fields;
  return {
    sha, parents: parents ? parents.split(' ') : [],
    authorName, authorEmail, committerName, committerEmail,
    message: git(['show', '-s', '--format=%B', sha]),
    trailers: git(['show', '-s', '--format=%(trailers:only,unfold)', sha])
      .split('\n').filter(Boolean),
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
    allRaw.length !== 1 || allRaw[0] !== CLAUDE ||
    allParsed.length !== 1 || allParsed[0] !== CLAUDE
  ) errors.push('unexpected_or_malformed_coauthor');
  return errors;
}

function requireTag(name, sha) {
  if (git(['rev-parse', '--verify', 'refs/tags/' + name + '^{commit}']) !== sha)
    throw new Error(name + ' moved from its frozen commit');
  if (git(['cat-file', '-t', 'refs/tags/' + name]) !== 'tag')
    throw new Error(name + ' is not annotated');
  if (git(['rev-parse', '--verify', 'refs/tags/' + name]) !== TAG_OBJECTS[name])
    throw new Error(name + ' annotated tag object was replaced');
}

function verify() {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true')
    throw new Error('Not a worktree');
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false')
    throw new Error('Cannot validate shallow history');
  requireTag('aven-009', V9);
  requireTag('aven-010', V10);
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  git(['merge-base', '--is-ancestor', V9, V10]);
  git(['merge-base', '--is-ancestor', V10, head]);

  const commits = git(['rev-list', '--reverse', V9 + '..' + head])
    .split('\n').filter(Boolean).map(read);
  let previous = V9;
  let countFrozen = 0;
  let countNew = 0;
  const errors = [];
  for (const commit of commits) {
    if (commit.parents.length !== 1 || commit.parents[0] !== previous)
      errors.push(commit.sha + ': history_not_linear');
    previous = commit.sha;
    if (countFrozen < 16) {
      const check = evaluateCommit(commit);
      errors.push(...check.violations.map((issue) => commit.sha + ': ' + issue));
      countFrozen += 1;
      if (countFrozen === 16 && commit.sha !== V10)
        errors.push('AVEN-010 must be sixteenth commit after AVEN-009');
    } else {
      countNew += 1;
      errors.push(...postFreezeViolations(commit)
        .map((issue) => commit.sha + ': ' + issue));
    }
  }
  if (countFrozen !== 16 || previous !== head)
    errors.push('History is not a complete linear extension of AVEN-010');

  // This post-freeze maintenance may change only the enumerated metadata,
  // scripts, policy and CI files. All historical runtime, evaluation and
  // frozen test files must stay byte-identical to the AVEN-010 tag.
  const diff = git(['diff', '--name-status', '--no-renames', V10, head]);
  for (const line of diff.split('\n').filter(Boolean)) {
    const match = /^([A-Z])\t(.+)$/.exec(line);
    if (!match || MAINTENANCE_DELTA[match[2]] !== match[1])
      errors.push('Unapproved post-freeze file delta: ' + line);
  }
  return { head, countFrozen, countNew, errors };
}

function selfTest() {
  const good = {
    parents: [V10], authorName: 'Varun Karthik',
    authorEmail: 'varunraj2117@gmail.com',
    committerName: 'Varun Karthik',
    committerEmail: '71327884+varun-raj-77@users.noreply.github.com',
    message: 'feat: example\n\n' + CLAUDE, trailers: [CLAUDE],
  };
  assert.deepEqual(postFreezeViolations(good), []);
  assert.deepEqual(postFreezeViolations({
    ...good, authorEmail: '71327884+varun-raj-77@users.noreply.github.com',
  }), []);
  assert(postFreezeViolations({ ...good, authorEmail: 'noreply@anthropic.com' })
    .includes('owner_not_primary_author'));
  assert(postFreezeViolations({ ...good, committerName: 'Claude' })
    .includes('owner_not_committer'));
  assert(postFreezeViolations({ ...good, message: 'feat: no trailer', trailers: [] })
    .includes('claude_trailer_missing_duplicate_or_unparsed'));
  assert(postFreezeViolations({
    ...good, message: good.message + '\n' + CLAUDE,
    trailers: [CLAUDE, CLAUDE],
  }).length > 0);
  assert(postFreezeViolations({ ...good, trailers: [] })
    .includes('claude_trailer_missing_duplicate_or_unparsed'));
  assert(postFreezeViolations({
    ...good, message: good.message + '\nCo-authored-by: Someone <other@example.com>',
    trailers: [CLAUDE, 'Co-authored-by: Someone <other@example.com>'],
  }).includes('unexpected_or_malformed_coauthor'));
  assert(postFreezeViolations({
    ...good, parents: [V10, V9],
  }).includes('nonlinear_commit'));
  console.log('PASS: nine owner-first attribution scenarios');
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    selfTest();
  } else if (process.argv.length !== 2) {
    throw new Error('Usage: node tooling/attribution/check-post-aven010.mjs [--self-test]');
  } else {
    const result = verify();
    console.log('AVEN attribution: HEAD ' + result.head + '; frozen=' +
      result.countFrozen + '; post-freeze=' + result.countNew);
    for (const error of result.errors) console.error('FAIL: ' + error);
    if (result.errors.length) process.exitCode = 1;
    else console.log('PASS: preserved frozen lineage and owner-first new commits');
  }
} catch (error) {
  console.error('FAIL: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
