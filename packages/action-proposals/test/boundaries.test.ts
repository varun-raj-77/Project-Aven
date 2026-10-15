import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.ts';
import { ACTION_PROPOSALS_CONFIG } from '../src/index.ts';
import * as ledgerApi from '../src/ledger/index.ts';
import { PRECHECK_SQL } from '../src/ledger/record.ts';
import { READ_SQL } from '../src/ledger/stored.ts';

/**
 * AVEN-011 Patches 2 and 3: static REGRESSION TRIPWIRES over the pure root
 * entry and the `./ledger` subpath. They make obvious regressions visible in
 * review; they are pattern checks, NOT security guarantees, and deliberately
 * obfuscated code can bypass them. Every rule is also run against known-bad
 * samples, so a weakened rule fails here. Later AVEN-011 patches that
 * legitimately add a module, subpath or import update these lists in their
 * own reviewed change.
 */
const srcDir = new URL('../src/', import.meta.url);
const ledgerDir = new URL('../src/ledger/', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
/** Code only: block comments and whole-line `//` comments are removed. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sourceOf = (name: string) =>
  code(readFileSync(new URL(name, srcDir), 'utf8'));
const ledgerSourceOf = (name: string) =>
  code(readFileSync(new URL(name, ledgerDir), 'utf8'));

const SRC_FILES = [
  'canonical.ts',
  'config.ts',
  'errors.ts',
  'index.ts',
  'inert.ts',
  'inspect.ts',
  'proposal.ts',
];
/** Exact named imports permitted per external module, and where. */
const PERMITTED: Record<string, { names: string[]; files: string[] }> = {
  '@aven/contracts': {
    names: [
      'ActionProposalIdSchema',
      'ActionProposalSchema',
      'OwnerIdSchema',
      'ProposalBindingSchema',
      'SessionIdSchema',
      'TaskIdSchema',
      'TimestampSchema',
      'ActionProposal',
      'ProposalBinding',
    ],
    files: ['inspect.ts', 'proposal.ts'],
  },
  zod: { names: ['z'], files: ['inspect.ts', 'proposal.ts'] },
  'node:crypto': { names: ['createHash'], files: ['canonical.ts'] },
  'node:util': { names: ['types'], files: ['inert.ts'] },
};
const FORBIDDEN_CODE: [string, RegExp][] = [
  ['clock', /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/],
  [
    'randomness',
    /\bMath\.random\b|\brandomUUID\b|\brandomBytes\b|\bgetRandomValues\b/,
  ],
  ['process or environment', /\bprocess\./],
  ['network', /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/],
  [
    'dynamic code',
    /\beval\s*\(|\bnew Function\b|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(/,
  ],
  ['timers', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/],
  ['global object', /\bglobalThis\b/],
  [
    'storage, Ledger, runtime or other Aven layers',
    /@aven\/(storage|ledger|runtime|baseline|context-broker|owner-model|corrections|api|root)\b|better-sqlite3|drizzle/,
  ],
  ['console output', /\bconsole\./],
];

/** The `./ledger` subpath: the only modules that may touch storage. */
const LEDGER_FILES = ['index.ts', 'record.ts', 'stored.ts'];
const LEDGER_LOCAL = [
  './record.ts',
  './stored.ts',
  '../canonical.ts',
  '../config.ts',
  '../errors.ts',
  '../inert.ts',
  '../proposal.ts',
];
const LEDGER_PERMITTED: Record<string, { names: string[]; files: string[] }> = {
  '@aven/contracts': {
    names: [
      'ActionProposalIdSchema',
      'EventIdSchema',
      'ExperienceEventSchema',
      'ModelInferenceProvenanceSchema',
      'OwnerIdSchema',
      'ProvenanceSchema',
      'SessionIdSchema',
      'SystemGeneratedProvenanceSchema',
      'TaskIdSchema',
      'TimestampSchema',
      'ActionProposal',
      'ProposalBinding',
    ],
    files: ['record.ts', 'stored.ts'],
  },
  '@aven/ledger': {
    names: ['createLedger', 'LedgerError', 'EventInput', 'StoredEvent'],
    files: ['record.ts', 'stored.ts'],
  },
  '@aven/storage': {
    names: ['deserializeContract', 'Storage'],
    files: ['record.ts', 'stored.ts'],
  },
  zod: { names: ['z'], files: ['record.ts'] },
};
const LEDGER_FORBIDDEN: [string, RegExp][] = [
  ...FORBIDDEN_CODE.filter(([label]) => !label.startsWith('storage')),
  [
    'runtime or other Aven layers',
    /@aven\/(runtime|baseline|context-broker|owner-model|corrections|api|root)\b|better-sqlite3|drizzle/,
  ],
  [
    'SQL write or transaction control',
    /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/,
  ],
  [
    'direct connection control',
    /\.(exec|run|iterate|transaction|pragma|backup|serialize|close|function|aggregate|table|loadExtension|unsafeMode|defaultSafeIntegers)\s*\(/,
  ],
  ['other Ledger operations', /\b(listEvents|replayEvents|inspectIntegrity)\b/],
  ['connection lifecycle', /\b(openStorage|migrate)\b/],
  // Timestamps are ordered exactly (Codex F1): no millisecond Date values.
  ['Date-based time arithmetic', /\bDate\b/],
  [
    'connection access other than prepare and inTransaction',
    /\.sqlite\.(?!prepare\(|inTransaction\b)/,
  ],
];

interface ImportClause {
  readonly module: string;
  readonly names: string[];
}
function importsOf(text: string): ImportClause[] {
  const found: ImportClause[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const clause = m[1] ?? '';
    const names = clause.startsWith('{')
      ? clause
          .slice(1, -1)
          .split(',')
          .map((part) => part.trim().replace(/^type\s+/, ''))
          .filter(Boolean)
          .map((part) => part.split(/\s+as\s+/)[0]!.trim())
      : [clause.trim() || '<side effect>'];
    found.push({ module: m[3]!, names });
  }
  if (/\bimport\s+['"]/.test(text))
    found.push({ module: '<bare import>', names: [] });
  return found;
}
function violations(file: string, text: string): string[] {
  const errors: string[] = [];
  for (const { module, names } of importsOf(text)) {
    if (/^\.\/[a-z-]+\.ts$/.test(module)) {
      if (!SRC_FILES.includes(module.slice(2)))
        errors.push(`${file}: unknown local module ${module}`);
      continue;
    }
    const rule = PERMITTED[module];
    if (!rule || !rule.files.includes(file)) {
      errors.push(`${file}: import from ${module}`);
      continue;
    }
    for (const name of names)
      if (!rule.names.includes(name))
        errors.push(`${file}: ${name} from ${module}`);
  }
  for (const [label, pattern] of FORBIDDEN_CODE)
    if (pattern.test(text)) errors.push(`${file}: ${label}`);
  return errors;
}

function ledgerViolations(file: string, text: string): string[] {
  const errors: string[] = [];
  for (const { module, names } of importsOf(text)) {
    if (module.startsWith('.')) {
      if (!LEDGER_LOCAL.includes(module))
        errors.push(`${file}: unknown local module ${module}`);
      continue;
    }
    const rule = LEDGER_PERMITTED[module];
    if (!rule || !rule.files.includes(file)) {
      errors.push(`${file}: import from ${module}`);
      continue;
    }
    for (const name of names)
      if (!rule.names.includes(name))
        errors.push(`${file}: ${name} from ${module}`);
  }
  for (const [label, pattern] of LEDGER_FORBIDDEN)
    if (pattern.test(text)) errors.push(`${file}: ${label}`);
  const appends = text.match(/\bappendEvent\b/g)?.length ?? 0;
  if (appends !== (file === 'record.ts' ? 1 : 0))
    errors.push(`${file}: ${appends} appendEvent calls`);
  return errors;
}

describe('pure root entry: static boundaries', () => {
  it('contains exactly the root modules and the ledger subpath', () => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([
      'ledger',
    ]);
    expect(
      entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort(),
    ).toEqual(SRC_FILES);
  });

  it.each(SRC_FILES)('%s imports and calls only what is permitted', (file) => {
    expect(violations(file, sourceOf(file))).toEqual([]);
  });

  it.each([
    ['proposal.ts', `import { PolicyDecisionSchema } from '@aven/contracts';`],
    ['proposal.ts', `import { OwnerApprovalSchema } from '@aven/contracts';`],
    ['proposal.ts', `import { createLedger } from '@aven/ledger';`],
    ['proposal.ts', `import { openStorage } from '@aven/storage';`],
    ['proposal.ts', `import { readFileSync } from 'node:fs';`],
    ['proposal.ts', `import { request } from 'node:https';`],
    ['proposal.ts', `import { randomUUID } from 'node:crypto';`],
    ['canonical.ts', `import { createHash, randomBytes } from 'node:crypto';`],
    ['proposal.ts', `import { types } from 'node:util';`],
    ['inert.ts', `import { types, inspect } from 'node:util';`],
    ['proposal.ts', `import './extra.ts';`],
    ['proposal.ts', `import { x } from './ledger/record.ts';`],
    ['proposal.ts', `const t = Date.now();`],
    ['proposal.ts', `const t = new Date();`],
    ['proposal.ts', `const r = Math.random();`],
    ['proposal.ts', `const e = process.env.X;`],
    ['proposal.ts', `await fetch('https://example.invalid');`],
    ['proposal.ts', `const m = await import('node:fs');`],
    ['proposal.ts', `setTimeout(() => 1, 0);`],
    ['proposal.ts', `console.log('x');`],
    ['proposal.ts', `const g = globalThis;`],
  ])('rejects the known-bad sample %# in %s', (file, sample) => {
    expect(violations(file, sample).length).toBeGreaterThan(0);
  });

  it('exports exactly the accepted root API', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'ACTION_PROPOSALS_CONFIG',
      'ACTION_PROPOSAL_CREATION_COMPONENT',
      'ACTION_PROPOSAL_DIGEST_PROTOCOL',
      'ACTION_PROPOSAL_ERROR_CODES',
      'ACTION_PROPOSAL_OUTCOMES',
      'AVEN_011_ACTION_PROPOSALS_VERSION',
      'ActionProposalError',
      'computeActionProposalDigest',
      'constructActionProposal',
      'inspectActionProposal',
      'validateActionProposal',
    ]);
  });

  it('pins the deeply frozen configuration', () => {
    expect(ACTION_PROPOSALS_CONFIG).toEqual({
      version: 'aven-011-action-proposals-v1',
      creation: {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
      },
      digest: {
        protocol: 'AVEN-011-ACTION-PROPOSAL-DIGEST-V1',
        algorithm: 'sha256',
      },
      frozenBaseline: {
        tag: 'aven-010',
        commit: '76535d8647ee36e56bd2efd1a86642d1fc572ee7',
      },
      contractSchemaVersion: 1,
      limits: {
        maxDepth: 16,
        maxNodes: 2048,
        maxArrayLength: 256,
        maxStringLength: 20000,
      },
    });
    const frozen = (value: unknown): boolean =>
      value === null ||
      typeof value !== 'object' ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(ACTION_PROPOSALS_CONFIG)).toBe(true);
  });
});

describe('./ledger subpath: static boundaries', () => {
  it('contains exactly the Patch 3 modules', () => {
    const entries = readdirSync(ledgerDir, { withFileTypes: true });
    expect(entries.every((e) => e.isFile())).toBe(true);
    expect(entries.map((e) => e.name).sort()).toEqual(LEDGER_FILES);
  });

  it.each(LEDGER_FILES)(
    '%s imports and calls only what is permitted',
    (file) => {
      expect(ledgerViolations(file, ledgerSourceOf(file))).toEqual([]);
    },
  );

  it('uses only pinned, owner-scoped SELECT statements', () => {
    const statements = [
      ...Object.values(READ_SQL),
      ...Object.values(PRECHECK_SQL),
    ];
    expect(statements).toHaveLength(7);
    for (const sql of statements) {
      expect(sql).toMatch(
        /^SELECT [^;]+ FROM [a-z_]+ WHERE owner_id = \?( |$)/,
      );
      expect(sql).not.toMatch(/;|--|\/\*/);
    }
    expect(Object.isFrozen(READ_SQL) && Object.isFrozen(PRECHECK_SQL)).toBe(
      true,
    );
  });

  it.each([
    ['record.ts', `import { openStorage } from '@aven/storage';`],
    ['record.ts', `import { migrate } from '@aven/storage';`],
    ['record.ts', `import { serializeContract } from '@aven/storage';`],
    ['stored.ts', `import { z } from 'zod';`],
    ['record.ts', `import { x } from '@aven/runtime';`],
    ['record.ts', `import { x } from '@aven/corrections/ledger';`],
    ['record.ts', `import { PolicyDecisionSchema } from '@aven/contracts';`],
    ['record.ts', `import Database from 'better-sqlite3';`],
    ['record.ts', `import { x } from '../ledger-extra.ts';`],
    ['index.ts', `import { createLedger } from '@aven/ledger';`],
    ['record.ts', `storage.sqlite.exec('BEGIN IMMEDIATE');`],
    ['record.ts', `db.run();`],
    ['record.ts', `storage.sqlite.transaction(() => 1)();`],
    ['record.ts', `const q = 'INSERT INTO owners VALUES (?)';`],
    ['record.ts', `const q = 'DELETE FROM tasks';`],
    ['record.ts', `storage.sqlite.pragma('foreign_keys = OFF');`],
    ['record.ts', `const open = storage.sqlite.open;`],
    ['stored.ts', `ledger.appendEvent(event);`],
    ['record.ts', `ledger.listEvents();`],
    ['record.ts', `const t = new Date().toISOString();`],
    [
      'record.ts',
      `if (Date.parse(a) > Date.parse(b)) fail('timestamp_order');`,
    ],
    ['record.ts', `const t = Date.UTC(2026, 9, 14);`],
    ['record.ts', `const r = randomUUID();`],
    ['record.ts', `console.log('x');`],
  ])('rejects the known-bad sample %# in %s', (file, sample) => {
    const text =
      file === 'record.ts' ? `${sample}\nledger.appendEvent(e);` : sample;
    expect(ledgerViolations(file, text).length).toBeGreaterThan(0);
  });

  it('flags a second append in the recorder', () => {
    expect(
      ledgerViolations('record.ts', 'l.appendEvent(a);\nl.appendEvent(b);'),
    ).toEqual(['record.ts: 2 appendEvent calls']);
  });

  it('exports exactly the recorder and reconciliation', () => {
    expect(Object.keys(ledgerApi).sort()).toEqual([
      'reconcileActionProposalRecording',
      'recordActionProposal',
    ]);
  });
});

describe('package manifest and dependency direction', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  it('declares only the two entries and the permitted dependencies', () => {
    expect(manifest.name).toBe('@aven/action-proposals');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './ledger': './src/ledger/index.ts',
    });
    expect(manifest.dependencies).toEqual({
      '@aven/contracts': 'workspace:*',
      '@aven/ledger': 'workspace:*',
      '@aven/storage': 'workspace:*',
      zod: '4.6.5',
    });
    expect(manifest.devDependencies).toEqual({
      typescript: '5.9.3',
      vitest: '4.0.18',
    });
  });

  it('is imported by no other workspace package', () => {
    const dependents: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const pkg of readdirSync(new URL(`${group}/`, repoRoot))) {
        if (group === 'packages' && pkg === 'action-proposals') continue;
        const dir = new URL(`${group}/${pkg}/`, repoRoot);
        const manifestText = (() => {
          try {
            return readFileSync(new URL('package.json', dir), 'utf8');
          } catch {
            return '';
          }
        })();
        if (manifestText.includes('@aven/action-proposals'))
          dependents.push(`${group}/${pkg}`);
      }
    }
    expect(dependents).toEqual([]);
  });

  it('is type-checked by the root check scripts', () => {
    const root = JSON.parse(
      readFileSync(new URL('package.json', repoRoot), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const script of ['typecheck', 'check'])
      expect(root.scripts[script]).toContain(
        'tsc --project packages/corrections/tsconfig.json --noEmit && tsc --project packages/action-proposals/tsconfig.json --noEmit',
      );
  });
});
