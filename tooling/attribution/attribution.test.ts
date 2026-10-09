import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkAttribution,
  CLAUDE_IDENTITY,
  evaluateCommit,
  formatReport,
  FROZEN_BASELINE,
  OWNER_AUTHOR_NAMES,
  OWNER_CO_AUTHOR_TRAILER,
  OWNER_IDENTITY,
  VIOLATION_CODES,
  type CommitRecord,
  type Identity,
} from './attribution.ts';
import { runAttributionCheck } from './check-attribution.ts';

/*
 * SYNTHETIC test data only: every repository below is a throwaway Git
 * repository created in the OS temp directory with empty commits and invented
 * messages. The owner and Claude identities are the gate's fixed constants.
 */

const OWNER_LINE = OWNER_CO_AUTHOR_TRAILER;
const TOOLING_TRAILERS = [
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
  'Claude-Session: https://example.invalid/synthetic-session',
];
const message = (trailers: readonly string[], subject = 'chore: synthetic') =>
  `${subject}\n\nSynthetic body paragraph.\n\n${trailers.join('\n')}\n`;
const GOOD = message([...TOOLING_TRAILERS, OWNER_LINE]);

function record(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    authorName: CLAUDE_IDENTITY.name,
    authorEmail: CLAUDE_IDENTITY.email,
    committerName: CLAUDE_IDENTITY.name,
    committerEmail: CLAUDE_IDENTITY.email,
    message: GOOD,
    trailers: [...TOOLING_TRAILERS, OWNER_LINE],
    ...overrides,
  };
}

describe('attribution gate constants', () => {
  it('pins the frozen baseline, identities and the exact owner trailer', () => {
    expect(FROZEN_BASELINE).toEqual({
      milestone: 'AVEN-009',
      tag: 'aven-009',
      commit: '80057a217adb90132c5b6bc1c6a5c0f798db08c5',
    });
    expect(CLAUDE_IDENTITY).toEqual({
      name: 'Claude',
      email: 'noreply@anthropic.com',
    });
    expect(OWNER_IDENTITY).toEqual({
      name: 'Varun Karthik',
      email: 'varunraj2117@gmail.com',
    });
    expect(OWNER_CO_AUTHOR_TRAILER).toBe(
      'Co-authored-by: Varun Karthik <varunraj2117@gmail.com>',
    );
    expect(OWNER_AUTHOR_NAMES).toEqual(['Varun Karthik', 'varun-raj-77']);
    for (const value of [
      FROZEN_BASELINE,
      CLAUDE_IDENTITY,
      OWNER_IDENTITY,
      OWNER_AUTHOR_NAMES,
      VIOLATION_CODES,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it('keeps attribution:check separate from the pinned check command and argument-free', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(root.scripts['attribution:check']).toBe(
      'node tooling/attribution/check-attribution.ts',
    );
    expect(root.scripts['check']).not.toContain('attribution');
    const cli = readFileSync(
      new URL('./check-attribution.ts', import.meta.url),
      'utf8',
    );
    expect(cli).toContain('baseline: FROZEN_BASELINE');
    expect(cli).not.toMatch(/argv\[2|argv\.slice|parseArgs/);
  });
});

describe('evaluateCommit (pure rules, synthetic records)', () => {
  it('accepts a Claude commit with the exact parsed owner trailer and tooling trailers', () => {
    const result = evaluateCommit(record());
    expect(result.violations).toEqual([]);
    expect(result.authoredBy).toBe('claude');
    expect(result.ownerTrailer).toBe(OWNER_LINE);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.violations)).toBe(true);
  });

  it('requires the owner trailer on every Claude-authored commit', () => {
    const result = evaluateCommit(
      record({
        message: message(TOOLING_TRAILERS),
        trailers: TOOLING_TRAILERS,
      }),
    );
    expect(result.violations).toEqual(['missing_owner_trailer']);
    expect(result.ownerTrailer).toBeNull();
  });

  it('rejects an owner line that Git did not parse as a trailer', () => {
    const result = evaluateCommit(
      record({
        message: `subject\n\n${OWNER_LINE}\n\nprose after it\n`,
        trailers: [],
      }),
    );
    expect(result.violations).toEqual([
      'missing_owner_trailer',
      'unparsed_owner_attribution',
    ]);
  });

  it('rejects duplicate owner trailers', () => {
    const result = evaluateCommit(
      record({
        message: message([OWNER_LINE, OWNER_LINE]),
        trailers: [OWNER_LINE, OWNER_LINE],
      }),
    );
    expect(result.violations).toEqual(['duplicate_owner_trailer']);
    expect(result.ownerTrailer).toBeNull();
  });

  it('rejects an exact trailer repeated in the body as a duplicate', () => {
    const result = evaluateCommit(
      record({
        message: `subject\n\n${OWNER_LINE}\n\nbody\n\n${OWNER_LINE}\n`,
        trailers: [OWNER_LINE],
      }),
    );
    expect(result.violations).toEqual([
      'duplicate_owner_trailer',
      'unparsed_owner_attribution',
    ]);
  });

  it.each([
    [
      'other email',
      'Co-authored-by: Varun Karthik <varunraj.other@example.com>',
    ],
    ['email case', 'Co-authored-by: Varun Karthik <VarunRaj2117@gmail.com>'],
    ['key case', 'Co-Authored-By: Varun Karthik <varunraj2117@gmail.com>'],
    ['name variant', 'Co-authored-by: Varun K <varunraj2117@gmail.com>'],
    ['no brackets', 'Co-authored-by: Varun Karthik varunraj2117@gmail.com'],
    ['extra space', 'Co-authored-by:  Varun Karthik <varunraj2117@gmail.com>'],
    [
      'trailing space',
      'Co-authored-by: Varun Karthik <varunraj2117@gmail.com> ',
    ],
    ['spaced key', 'Co-authored by: Varun Karthik <varunraj2117@gmail.com>'],
    [
      'underscore key',
      'co_authored_by: Varun Karthik <varunraj2117@gmail.com>',
    ],
  ])('rejects a malformed owner attribution (%s)', (_label, line) => {
    const alone = evaluateCommit(
      record({ message: message([line]), trailers: [line] }),
    );
    expect(alone.violations).toEqual([
      'missing_owner_trailer',
      'malformed_owner_attribution',
    ]);
    // An exact trailer does not excuse a conflicting one beside it.
    const beside = evaluateCommit(
      record({
        message: message([line, OWNER_LINE]),
        trailers: [line, OWNER_LINE],
      }),
    );
    expect(beside.violations).toEqual(['malformed_owner_attribution']);
  });

  it('rejects owner-like co-author prose anywhere in the message (fail closed)', () => {
    const result = evaluateCommit(
      record({
        message: `subject\n\nVarun was co-authored by mistake here.\n\n${OWNER_LINE}\n`,
      }),
    );
    expect(result.violations).toEqual(['malformed_owner_attribution']);
  });

  it.each([
    'Co-authored-by: Someone Else <someone@example.com>',
    'Co-authored-by: Claude <claude@example.com>',
    'Co-authored-by: NotClaude <noreply@anthropic.com>',
  ])('rejects an unexpected co-author trailer: %s', (line) => {
    const result = evaluateCommit(
      record({
        message: message([line, OWNER_LINE]),
        trailers: [line, OWNER_LINE],
      }),
    );
    expect(result.violations).toEqual(['unexpected_co_author']);
  });

  it('accepts owner-authored commits only with the verified email', () => {
    for (const name of OWNER_AUTHOR_NAMES) {
      const owner = evaluateCommit(
        record({
          authorName: name,
          authorEmail: OWNER_IDENTITY.email,
          committerName: name,
          committerEmail: OWNER_IDENTITY.email,
          message: 'chore: owner synthetic\n',
          trailers: [],
        }),
      );
      expect(owner.violations).toEqual([]);
      expect(owner.authoredBy).toBe('owner');
    }
    const wrongEmail = evaluateCommit(
      record({
        authorName: 'Varun Karthik',
        authorEmail: 'varunraj.other@example.com',
        message: 'chore: owner synthetic\n',
        trailers: [],
      }),
    );
    expect(wrongEmail.violations).toEqual(['incorrect_owner_email']);
    expect(wrongEmail.authoredBy).toBe('unknown');
    const wrongName = evaluateCommit(
      record({
        authorName: 'V. K.',
        authorEmail: OWNER_IDENTITY.email,
        trailers: [],
        message: 'chore: synthetic\n',
      }),
    );
    expect(wrongName.violations).toEqual(['unknown_author']);
  });

  it.each<[string, Partial<CommitRecord>, string]>([
    [
      'Claude name, other email',
      { authorEmail: 'NoReply@anthropic.com' },
      'unknown_author',
    ],
    ['other Claude name', { authorName: 'Claude Code' }, 'unknown_author'],
    [
      'unrelated author',
      { authorName: 'Synthetic Person', authorEmail: 'person@example.com' },
      'unknown_author',
    ],
    [
      'unrelated committer',
      { committerName: 'CI Bot', committerEmail: 'ci@example.com' },
      'unknown_committer',
    ],
    [
      'owner-like committer email',
      { committerName: 'Varun Karthik', committerEmail: 'varun@example.com' },
      'incorrect_owner_email',
    ],
  ])(
    'rejects identities that are neither Claude nor the verified owner (%s)',
    (_label, overrides, code) => {
      const result = evaluateCommit(record(overrides));
      expect(result.violations).toContain(code);
    },
  );

  it('rejects merge and root commits', () => {
    expect(
      evaluateCommit(record({ parents: ['b'.repeat(40), 'c'.repeat(40)] }))
        .violations,
    ).toEqual(['merge_commit']);
    expect(evaluateCommit(record({ parents: [] })).violations).toEqual([
      'root_commit',
    ]);
  });

  it('normalizes CRLF messages and trailers', () => {
    const result = evaluateCommit(
      record({
        message: GOOD.replace(/\n/g, '\r\n'),
        trailers: [...TOOLING_TRAILERS, OWNER_LINE].map((t) => `${t}\r`),
      }),
    );
    expect(result.violations).toEqual([]);
  });

  it('is deterministic, reports codes in fixed order and does not modify its input', () => {
    const input = record({
      parents: [],
      authorName: 'Synthetic Person',
      authorEmail: 'person@example.com',
      committerName: 'CI Bot',
      committerEmail: 'ci@example.com',
    });
    const copy = structuredClone(input);
    const first = evaluateCommit(input);
    expect(evaluateCommit(input)).toEqual(first);
    expect(input).toEqual(copy);
    expect(first.violations).toEqual([
      'root_commit',
      'unknown_author',
      'unknown_committer',
    ]);
    const order = first.violations.map((v) => VIOLATION_CODES.indexOf(v));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

// ---------------------------------------------------------------------------
// Real Git: synthetic throwaway repositories
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'aven-attribution-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyConfig = join(scratch, 'empty.gitconfig');
writeFileSync(emptyConfig, '');
let counter = 0;

/** Git for building fixtures: isolated from any user or system configuration. */
function fixtureGit(
  dir: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    ...extraEnv,
  });
  return execFileSync(
    'git',
    [
      '-c',
      'init.defaultBranch=main',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      '-C',
      dir,
      ...args,
    ],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

interface CommitSpec {
  readonly author?: Identity;
  readonly committer?: Identity;
  readonly body?: string;
  readonly cleanup?: 'strip' | 'verbatim';
}

class SyntheticRepo {
  readonly dir: string;
  readonly baseline: string;
  constructor(tag: string | null = 'aven-009-synthetic') {
    this.dir = join(scratch, `repo-${++counter}`);
    mkdirSync(this.dir);
    fixtureGit(this.dir, ['init', '-q']);
    this.baseline = this.commit({
      author: { name: 'Synthetic Baseline', email: 'baseline@example.com' },
      committer: { name: 'Synthetic Baseline', email: 'baseline@example.com' },
      body: 'synthetic baseline\n',
    });
    if (tag) this.tag(tag, this.baseline);
  }
  commit(spec: CommitSpec = {}): string {
    const author = spec.author ?? CLAUDE_IDENTITY;
    const committer = spec.committer ?? author;
    const file = join(scratch, `message-${++counter}.txt`);
    writeFileSync(file, spec.body ?? GOOD);
    const n = String(counter).padStart(4, '0');
    fixtureGit(
      this.dir,
      [
        'commit',
        '-q',
        '--allow-empty',
        '--no-verify',
        `--cleanup=${spec.cleanup ?? 'strip'}`,
        '-F',
        file,
      ],
      {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: `2026-10-09T00:00:00Z`,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: `2026-10-09T00:${n.slice(0, 2)}:${n.slice(2)}Z`,
      },
    );
    return this.git(['rev-parse', 'HEAD']);
  }
  tag(name: string, sha: string): void {
    this.git(['tag', '-f', name, sha]);
  }
  git(args: readonly string[]): string {
    return fixtureGit(this.dir, args);
  }
  check(tag = 'aven-009-synthetic', commit = this.baseline) {
    return checkAttribution({ repoDir: this.dir, baseline: { tag, commit } });
  }
}

const OWNER_AUTHOR: Identity = {
  name: 'varun-raj-77',
  email: OWNER_IDENTITY.email,
};
const real = { timeout: 30_000 };

describe('checkAttribution over real synthetic Git history', () => {
  it(
    'passes a linear range of attributed Claude and owner commits, checking each',
    real,
    () => {
      const repo = new SyntheticRepo();
      const a = repo.commit();
      const b = repo.commit({
        author: OWNER_AUTHOR,
        body: 'chore: owner synthetic\n',
      });
      const c = repo.commit();
      const report = repo.check();
      expect(report.ok).toBe(true);
      expect(report.repositoryViolations).toEqual([]);
      expect(report.head).toBe(c);
      expect(report.commits.map((x) => x.sha)).toEqual([a, b, c]);
      expect(report.commits.map((x) => x.authoredBy)).toEqual([
        'claude',
        'owner',
        'claude',
      ]);
      expect(report.commits[0]!.ownerTrailer).toBe(OWNER_LINE);
      expect(report.commits[0]!.author).toEqual(CLAUDE_IDENTITY);
      expect(report.commits[0]!.committer).toEqual(CLAUDE_IDENTITY);
      expect(Object.isFrozen(report)).toBe(true);
    },
  );

  it('passes an empty range (HEAD is the baseline)', real, () => {
    const report = new SyntheticRepo().check();
    expect(report.ok).toBe(true);
    expect(report.commits).toEqual([]);
  });

  it('checks every commit, not only HEAD', real, () => {
    const repo = new SyntheticRepo();
    repo.commit();
    const bad = repo.commit({ body: message(TOOLING_TRAILERS) });
    repo.commit();
    const report = repo.check();
    expect(report.ok).toBe(false);
    expect(
      report.commits
        .filter((c) => c.violations.length > 0)
        .map((c) => [c.sha, c.violations]),
    ).toEqual([[bad, ['missing_owner_trailer']]]);
  });

  it(
    'uses Git trailer parsing: an owner line followed by prose is not a trailer',
    real,
    () => {
      const repo = new SyntheticRepo();
      repo.commit({
        body: `chore: synthetic\n\n${OWNER_LINE}\nThis prose line keeps Git from parsing a trailer block.\n`,
      });
      const [commit] = repo.check().commits;
      expect(commit!.violations).toEqual([
        'missing_owner_trailer',
        'unparsed_owner_attribution',
      ]);
    },
  );

  it(
    'uses Git trailer parsing: an owner line in a middle paragraph is not a trailer',
    real,
    () => {
      const repo = new SyntheticRepo();
      repo.commit({
        body: `chore: synthetic\n\n${OWNER_LINE}\n\n${TOOLING_TRAILERS.join('\n')}\n`,
      });
      const [commit] = repo.check().commits;
      expect(commit!.violations).toEqual([
        'missing_owner_trailer',
        'unparsed_owner_attribution',
      ]);
    },
  );

  it(
    'rejects duplicate, malformed and wrong-email trailers in real commits',
    real,
    () => {
      const repo = new SyntheticRepo();
      repo.commit({ body: message([OWNER_LINE, OWNER_LINE]) });
      repo.commit({
        body: message([
          'Co-authored-by: Varun Karthik <varunraj.other@example.com>',
        ]),
      });
      repo.commit({
        body: message([
          'Co-Authored-By: Varun Karthik <varunraj2117@gmail.com>',
        ]),
      });
      repo.commit({ body: message([`${OWNER_LINE} `]), cleanup: 'verbatim' });
      const report = repo.check();
      expect(report.ok).toBe(false);
      expect(report.commits.map((c) => c.violations)).toEqual([
        ['duplicate_owner_trailer'],
        ['missing_owner_trailer', 'malformed_owner_attribution'],
        ['missing_owner_trailer', 'malformed_owner_attribution'],
        // Git's trailer parser trims trailing whitespace, so the parsed
        // trailer is exact; the raw line still differs and fails the commit.
        ['malformed_owner_attribution'],
      ]);
    },
  );

  it('rejects incorrect authors and committers in real commits', real, () => {
    const repo = new SyntheticRepo();
    repo.commit({
      author: { name: 'Varun Karthik', email: 'varunraj.other@example.com' },
      body: 'chore: synthetic\n',
    });
    repo.commit({ committer: { name: 'CI Bot', email: 'ci@example.com' } });
    repo.commit({ author: { name: 'Claude', email: 'claude@example.com' } });
    expect(repo.check().commits.map((c) => c.violations)).toEqual([
      ['incorrect_owner_email'],
      ['unknown_committer'],
      ['unknown_author', 'unknown_committer'],
    ]);
  });

  it('rejects merge commits and non-linear history', real, () => {
    const repo = new SyntheticRepo();
    repo.commit();
    repo.git(['checkout', '-q', '-b', 'side', repo.baseline]);
    repo.commit();
    repo.git(['checkout', '-q', 'main']);
    const file = join(scratch, `merge-${++counter}.txt`);
    writeFileSync(file, GOOD);
    fixtureGit(
      repo.dir,
      ['merge', '-q', '--no-ff', '--no-verify', '-F', file, 'side'],
      {
        GIT_AUTHOR_NAME: CLAUDE_IDENTITY.name,
        GIT_AUTHOR_EMAIL: CLAUDE_IDENTITY.email,
        GIT_COMMITTER_NAME: CLAUDE_IDENTITY.name,
        GIT_COMMITTER_EMAIL: CLAUDE_IDENTITY.email,
      },
    );
    const report = repo.check();
    expect(report.ok).toBe(false);
    expect(report.repositoryViolations).toEqual(['history_not_linear']);
    expect(report.commits.flatMap((c) => c.violations)).toContain(
      'merge_commit',
    );
  });

  it('fails closed when the baseline is not an ancestor of HEAD', real, () => {
    const repo = new SyntheticRepo();
    repo.git(['checkout', '-q', '--orphan', 'unrelated']);
    repo.commit();
    const report = repo.check();
    expect(report).toMatchObject({
      ok: false,
      repositoryViolations: ['baseline_not_ancestor'],
      commits: [],
    });
  });

  it(
    'fails closed when the baseline commit is missing or malformed',
    real,
    () => {
      const repo = new SyntheticRepo();
      repo.commit();
      expect(
        repo.check('aven-009-synthetic', 'f'.repeat(40)).repositoryViolations,
      ).toEqual(['baseline_missing']);
      expect(
        repo.check('aven-009-synthetic', 'HEAD').repositoryViolations,
      ).toEqual(['baseline_missing']);
    },
  );

  it(
    'fails closed when the baseline tag is missing or points elsewhere',
    real,
    () => {
      const untagged = new SyntheticRepo(null);
      untagged.commit();
      expect(untagged.check().repositoryViolations).toEqual([
        'baseline_tag_missing',
      ]);
      const moved = new SyntheticRepo();
      moved.tag('aven-009-synthetic', moved.commit());
      expect(moved.check().repositoryViolations).toEqual([
        'baseline_tag_mismatch',
      ]);
    },
  );

  it('fails closed on a shallow clone', real, () => {
    const source = new SyntheticRepo();
    source.commit();
    source.commit();
    const clone = join(scratch, `shallow-${++counter}`);
    fixtureGit(scratch, [
      'clone',
      '-q',
      '--depth',
      '1',
      pathToFileURL(source.dir).href,
      clone,
    ]);
    const report = checkAttribution({
      repoDir: clone,
      baseline: { tag: 'aven-009-synthetic', commit: source.baseline },
    });
    expect(report).toMatchObject({
      ok: false,
      repositoryViolations: ['shallow_history'],
      commits: [],
    });
  });

  it(
    'fails closed outside a repository and never inspects a parent repository',
    real,
    () => {
      const empty = join(scratch, `empty-${++counter}`);
      mkdirSync(empty);
      expect(
        checkAttribution({
          repoDir: empty,
          baseline: { tag: 'x', commit: 'f'.repeat(40) },
        }).repositoryViolations,
      ).toEqual(['not_a_git_repository']);
      const repo = new SyntheticRepo();
      repo.commit();
      const nested = join(repo.dir, 'nested');
      mkdirSync(nested);
      expect(
        checkAttribution({
          repoDir: nested,
          baseline: { tag: 'aven-009-synthetic', commit: repo.baseline },
        }).repositoryViolations,
      ).toEqual(['not_a_git_repository']);
    },
  );

  it('ignores git replace substitutions of recorded commits', real, () => {
    const repo = new SyntheticRepo();
    const bad = repo.commit({ body: message(TOOLING_TRAILERS) });
    repo.git(['checkout', '-q', '-b', 'decoy', repo.baseline]);
    const decoy = repo.commit();
    repo.git(['checkout', '-q', 'main']);
    repo.git(['replace', bad, decoy]);
    const report = repo.check();
    expect(report.commits.map((c) => [c.sha, c.violations])).toEqual([
      [bad, ['missing_owner_trailer']],
    ]);
  });

  it(
    'ignores an inherited GIT_DIR that points at another repository',
    real,
    () => {
      const good = new SyntheticRepo();
      good.commit();
      const bad = new SyntheticRepo();
      bad.commit({ body: message(TOOLING_TRAILERS) });
      const saved = process.env['GIT_DIR'];
      process.env['GIT_DIR'] = join(good.dir, '.git');
      try {
        expect(bad.check().ok).toBe(false);
      } finally {
        if (saved === undefined) delete process.env['GIT_DIR'];
        else process.env['GIT_DIR'] = saved;
      }
    },
  );

  it(
    'reports through the CLI runner with fixed lines and a boolean result',
    real,
    () => {
      const repo = new SyntheticRepo();
      repo.commit();
      repo.commit({ body: message(TOOLING_TRAILERS) });
      const lines: string[] = [];
      const ok = runAttributionCheck(
        {
          repoDir: repo.dir,
          baseline: { tag: 'aven-009-synthetic', commit: repo.baseline },
        },
        (line) => lines.push(line),
      );
      expect(ok).toBe(false);
      expect(lines[0]).toBe(
        `AVEN-010 attribution check: baseline aven-009-synthetic ${repo.baseline}`,
      );
      expect(lines.at(-1)).toBe(
        'FAIL: 2 commit(s) checked after aven-009-synthetic; 1 failure(s).',
      );
      expect(
        lines.filter((l) => l.includes('violations=missing_owner_trailer')),
      ).toHaveLength(1);
      expect(formatReport(repo.check())).toEqual(lines);
    },
  );
});
