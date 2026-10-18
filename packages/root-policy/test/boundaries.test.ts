import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.ts';
import { ROOT_POLICY_CONFIG } from '../src/index.ts';
import * as ledgerApi from '../src/ledger/index.ts';
import { READ_SQL } from '../src/ledger/stored.ts';
import * as testingApi from '../src/testing/index.ts';
import { deeplyFrozen } from './fixtures.ts';

/**
 * AVEN-012 Patches 2 and 3: static REGRESSION TRIPWIRES over the pure Root
 * policy engine and the `./ledger` subpath. They make obvious regressions
 * visible in review; they are pattern
 * checks, NOT security guarantees, and deliberately obfuscated code can
 * bypass them. Every rule is also run against known-bad samples, so a
 * weakened rule fails here. A later AVEN-012 patch that legitimately adds a
 * module, subpath or import updates these lists in its own reviewed change.
 */
const srcDir = new URL('../src/', import.meta.url);
const testingDir = new URL('../src/testing/', import.meta.url);
const ledgerDir = new URL('../src/ledger/', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
/** Code only: block comments and whole-line `//` comments are removed. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sourceOf = (url: URL, name: string) =>
  code(readFileSync(new URL(name, url), 'utf8'));

const SRC_FILES = [
  'approvals.ts',
  'authentication.ts',
  'canonical.ts',
  'config.ts',
  'errors.ts',
  'evaluate.ts',
  'index.ts',
  'inert.ts',
  'policy.ts',
  'proposal.ts',
  'timestamps.ts',
];
/** Exact named imports permitted per external module, and where. */
const PERMITTED: Record<string, { names: string[]; files: string[] }> = {
  '@aven/contracts': {
    names: [
      'ActionProposalSchema',
      'NonEmptyTextSchema',
      'OwnerApprovalSchema',
      'OwnerIdSchema',
      'PolicyDecisionIdSchema',
      'PolicyDecisionSchema',
      'ProposalBindingSchema',
      'RequestedAuthoritySchema',
      'ResourceTargetSchema',
      'SessionIdSchema',
      'TaskIdSchema',
      'TimestampSchema',
      'ActionProposal',
      'EvidenceReference',
      'OwnerApproval',
      'PolicyDecision',
      'ProposalBinding',
    ],
    files: [
      'approvals.ts',
      'authentication.ts',
      'evaluate.ts',
      'policy.ts',
      'proposal.ts',
      'timestamps.ts',
    ],
  },
  zod: { names: ['z'], files: ['evaluate.ts', 'policy.ts', 'proposal.ts'] },
  'node:crypto': { names: ['createHash'], files: ['canonical.ts'] },
  'node:util': { names: ['types'], files: ['inert.ts'] },
};
const FORBIDDEN_CODE: [string, RegExp][] = [
  ['clock or Date arithmetic', /\bDate\b|\bperformance\.now\b/],
  [
    'randomness',
    /\bMath\.random\b|\brandomUUID\b|\brandomBytes\b|\bgetRandomValues\b/,
  ],
  ['process or environment', /\bprocess\./],
  [
    'network',
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|node:(https?|net|dgram|tls)/,
  ],
  [
    'dynamic code',
    /\beval\s*\(|\bnew Function\b|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(/,
  ],
  ['timers', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/],
  ['global object', /\bglobalThis\b/],
  [
    'storage, Ledger, runtime or other Aven layers',
    /@aven\/(storage|ledger|runtime|baseline|context-broker|owner-model|corrections|api)\b|better-sqlite3|drizzle/,
  ],
  ['filesystem or child processes', /node:(fs|child_process|worker_threads)/],
  ['console output', /\bconsole\./],
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

function violations(file: string, text: string, local: string[]): string[] {
  const errors: string[] = [];
  for (const { module, names } of importsOf(text)) {
    if (module.startsWith('.')) {
      if (!local.includes(module))
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
const ROOT_LOCAL = SRC_FILES.map((f) => `./${f}`);

describe('pure Root policy engine: static boundaries', () => {
  it('contains exactly the root modules and the ledger and testing subpaths', () => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([
      'ledger',
      'testing',
    ]);
    expect(
      entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort(),
    ).toEqual(SRC_FILES);
    expect(readdirSync(testingDir)).toEqual(['index.ts']);
  });

  it.each(SRC_FILES)('%s imports and calls only what is permitted', (file) => {
    expect(violations(file, sourceOf(srcDir, file), ROOT_LOCAL)).toEqual([]);
  });

  it('the testing subpath only re-exports the synthetic capability', () => {
    const text = sourceOf(testingDir, 'index.ts');
    expect(
      violations('testing/index.ts', text, ['../authentication.ts']),
    ).toEqual([]);
    expect(importsOf(text)).toEqual([
      {
        module: '../authentication.ts',
        names: [
          'createSyntheticApprovalChannel',
          'ApprovalAuthenticator',
          'SyntheticApprovalChannel',
        ],
      },
    ]);
  });

  it('names the proposing package only as the v1 stamp it revalidates', () => {
    // Importing it is refused by the import rule above; the name may appear
    // in code only as the frozen AVEN-011 creation stamp in config.ts.
    for (const file of SRC_FILES) {
      const matches = sourceOf(srcDir, file).match(/@aven\/action-proposals/g);
      expect(matches?.length ?? 0).toBe(file === 'config.ts' ? 1 : 0);
    }
    expect(sourceOf(srcDir, 'config.ts')).toContain(
      "component: '@aven/action-proposals',",
    );
  });

  it('the root entry does not expose the synthetic capability', () => {
    const text = sourceOf(srcDir, 'index.ts');
    expect(text).not.toMatch(/createSyntheticApprovalChannel|attest/);
    expect(text).not.toMatch(/policyInternals|producedBy|isAuthenticated/);
  });

  it.each([
    ['evaluate.ts', `import { createLedger } from '@aven/ledger';`],
    ['evaluate.ts', `import { openStorage } from '@aven/storage';`],
    [
      'proposal.ts',
      `import { validateActionProposal } from '@aven/action-proposals';`,
    ],
    ['policy.ts', `import { readFileSync } from 'node:fs';`],
    ['policy.ts', `import { request } from 'node:https';`],
    ['evaluate.ts', `import { randomUUID } from 'node:crypto';`],
    ['canonical.ts', `import { createHash, randomBytes } from 'node:crypto';`],
    ['evaluate.ts', `import { types } from 'node:util';`],
    ['evaluate.ts', `import { x } from './ledger/record.ts';`],
    ['evaluate.ts', `import './extra.ts';`],
    ['evaluate.ts', `const t = Date.now();`],
    ['timestamps.ts', `const t = Date.parse(a);`],
    ['evaluate.ts', `const r = Math.random();`],
    ['evaluate.ts', `const e = process.env.X;`],
    ['evaluate.ts', `await fetch('https://example.invalid');`],
    ['evaluate.ts', `const m = await import('node:fs');`],
    ['evaluate.ts', `setTimeout(() => 1, 0);`],
    ['evaluate.ts', `console.log('x');`],
    ['evaluate.ts', `const g = globalThis;`],
    ['evaluate.ts', `import { spawn } from 'node:child_process';`],
    ['evaluate.ts', `import { ExecutionResultSchema } from '@aven/contracts';`],
  ])('rejects the known-bad sample %# in %s', (file, sample) => {
    expect(violations(file, sample, ROOT_LOCAL).length).toBeGreaterThan(0);
  });

  it('exports exactly the accepted root API', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'APPROVAL_REASONS',
      'AVEN_012_ROOT_POLICY_VERSION',
      'PROPOSAL_DIGEST_PROTOCOL',
      'ROOT_DENY_ALL_POLICY_DEFINITION',
      'ROOT_POLICY_COMPONENT',
      'ROOT_POLICY_CONFIG',
      'ROOT_POLICY_DEFINITION_FORMAT',
      'ROOT_POLICY_DIGEST_PROTOCOL',
      'ROOT_POLICY_ERROR_CODES',
      'ROOT_POLICY_OUTCOMES',
      'ROOT_REASON_CODES',
      'ROOT_V1_REFERENCE_RISK_TABLE',
      'RootPolicyError',
      'createRootPolicy',
      'evaluateActionProposal',
      'revalidateProposal',
    ]);
    expect(Object.keys(testingApi)).toEqual(['createSyntheticApprovalChannel']);
  });

  it('exports nothing that executes, records, persists or learns', () => {
    for (const name of [...Object.keys(publicApi), ...Object.keys(testingApi)])
      expect(name).not.toMatch(
        /execut|record|persist|store|learn|promot|append|write|send|publish/i,
      );
  });

  it('pins the deeply frozen configuration', () => {
    expect(ROOT_POLICY_CONFIG).toEqual({
      version: 'aven-012-root-policy-v1',
      creation: {
        component: '@aven/root-policy',
        version: 'aven-012-root-policy-v1',
      },
      policyDigest: {
        protocol: 'AVEN-012-ROOT-POLICY-DIGEST-V1',
        algorithm: 'sha256',
      },
      proposal: {
        protocol: 'AVEN-011-ACTION-PROPOSAL-DIGEST-V1',
        algorithm: 'sha256',
        stamp: {
          component: '@aven/action-proposals',
          version: 'aven-011-action-proposals-v1',
        },
        recordVersion: 1,
      },
      frozenBaseline: {
        tag: 'aven-011',
        commit: '44ba416d90624be67fde2fab31c716e8298648bb',
      },
      contractSchemaVersion: 1,
      limits: {
        proposal: {
          maxDepth: 16,
          maxNodes: 2048,
          maxArrayLength: 256,
          maxStringLength: 20000,
        },
        request: {
          maxDepth: 18,
          maxNodes: 65536,
          maxArrayLength: 256,
          maxStringLength: 20000,
        },
        policy: {
          maxDepth: 8,
          maxNodes: 65536,
          maxArrayLength: 1024,
          maxStringLength: 512,
        },
        maxApprovalRecords: 64,
        maxApprovalAgeSeconds: 2592000,
      },
    });
    expect(deeplyFrozen(ROOT_POLICY_CONFIG)).toBe(true);
  });

  it('keeps the inert-copy body a verbatim copy of the frozen AVEN-010 module', () => {
    const body = (text: string) =>
      text.slice(text.indexOf('export interface InertLimits'));
    expect(body(readFileSync(new URL('inert.ts', srcDir), 'utf8'))).toBe(
      body(
        readFileSync(
          new URL('packages/corrections/src/inert.ts', repoRoot),
          'utf8',
        ),
      ),
    );
  });
});

/** The `./ledger` subpath: the only modules that may touch storage. */
const LEDGER_FILES = ['gateway.ts', 'index.ts', 'record.ts', 'stored.ts'];
const LEDGER_LOCAL = [
  './gateway.ts',
  './record.ts',
  './stored.ts',
  '../canonical.ts',
  '../config.ts',
  '../errors.ts',
  '../evaluate.ts',
  '../inert.ts',
  '../policy.ts',
  '../proposal.ts',
  '../timestamps.ts',
];
const LEDGER_PERMITTED: Record<string, { names: string[]; files: string[] }> = {
  '@aven/contracts': {
    names: [
      'EventIdSchema',
      'EvidenceReferenceSchema',
      'ExperienceEventSchema',
      'OwnerIdSchema',
      'PolicyDecisionIdSchema',
      'PolicyDecisionSchema',
      'TaskBindingSchema',
      'TimestampSchema',
      'EvidenceReference',
      'ExperienceEvent',
      'OwnerApproval',
      'PolicyDecision',
      'ProposalBinding',
    ],
    files: ['gateway.ts', 'record.ts', 'stored.ts'],
  },
  '@aven/ledger': {
    names: ['createLedger', 'LedgerError', 'EventInput'],
    files: ['record.ts'],
  },
  '@aven/storage': {
    names: ['deserializeContract', 'Storage'],
    files: ['gateway.ts', 'record.ts', 'stored.ts'],
  },
  zod: { names: ['z'], files: ['gateway.ts', 'record.ts'] },
};
const LEDGER_FORBIDDEN: [string, RegExp][] = [
  ...FORBIDDEN_CODE.filter(([label]) => !label.startsWith('storage')),
  [
    'runtime or other Aven layers',
    /@aven\/(runtime|baseline|context-broker|owner-model|corrections|api)\b|better-sqlite3|drizzle/,
  ],
  [
    'SQL write or transaction statement',
    /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/,
  ],
  [
    'direct connection control',
    /\.(exec|run|iterate|pragma|backup|serialize|close|function|aggregate|table|loadExtension|unsafeMode|defaultSafeIntegers)\s*\(/,
  ],
  [
    'other Ledger operations',
    /\b(getEvent|listEvents|replayEvents|inspectIntegrity)\b/,
  ],
  ['connection lifecycle', /\b(openStorage|migrate)\b/],
  [
    'connection access other than prepare, inTransaction and transaction',
    /\.sqlite\.(?!prepare\(|inTransaction\b|transaction\()/,
  ],
];

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
  // One read-snapshot helper owns the only transaction, always deferred.
  const transactions = text.match(/\.transaction\(/g)?.length ?? 0;
  const deferred =
    text.match(/\.transaction\(read\)\.deferred\(\)/g)?.length ?? 0;
  if (
    transactions !== (file === 'stored.ts' ? 1 : 0) ||
    deferred !== transactions
  )
    errors.push(`${file}: ${transactions} transactions`);
  // Only the gateway reads the Root clock, through the configured function.
  if (file !== 'gateway.ts' && /\bclock\b/.test(text))
    errors.push(`${file}: clock access`);
  return errors;
}

describe('./ledger subpath: static boundaries', () => {
  it('contains exactly the Patch 3 modules', () => {
    const entries = readdirSync(ledgerDir, { withFileTypes: true });
    expect(entries.every((e) => e.isFile())).toBe(true);
    expect(entries.map((e) => e.name).sort()).toEqual(LEDGER_FILES);
  });

  it.each(LEDGER_FILES)(
    '%s imports and calls only what is permitted',
    (file) => {
      expect(ledgerViolations(file, sourceOf(ledgerDir, file))).toEqual([]);
    },
  );

  it('uses only pinned, owner-scoped SELECT statements', () => {
    const statements: string[] = Object.values(READ_SQL);
    expect(statements).toHaveLength(9);
    for (const sql of statements) {
      expect(sql).toMatch(
        /^SELECT [^;]+ FROM [a-z_]+ WHERE owner_id = \?( |$)/,
      );
      expect(sql).not.toMatch(/;|--|\/\*/);
    }
    expect(Object.isFrozen(READ_SQL)).toBe(true);
    // No statement outside READ_SQL appears in the subpath.
    for (const file of LEDGER_FILES) {
      const text = sourceOf(ledgerDir, file);
      const literal = text.match(/'SELECT [^']*'/g) ?? [];
      expect(
        literal.every((sql) => statements.includes(sql.slice(1, -1))),
      ).toBe(true);
    }
  });

  it('never reads earlier policy decisions as an input to evaluation', () => {
    // The only statement naming policy_decisions checks identifier use.
    expect(
      Object.entries(READ_SQL)
        .filter(([, sql]) => /policy_decisions/.test(sql))
        .map(([name]) => name),
    ).toEqual(['decisionInUse']);
    expect(sourceOf(ledgerDir, 'gateway.ts')).not.toMatch(/decisionInUse/);
  });

  it.each([
    ['record.ts', `import { openStorage } from '@aven/storage';`],
    ['record.ts', `import { migrate } from '@aven/storage';`],
    ['stored.ts', `import { createLedger } from '@aven/ledger';`],
    ['gateway.ts', `import { x } from '@aven/runtime';`],
    ['gateway.ts', `import { x } from '@aven/action-proposals/ledger';`],
    ['record.ts', `import { ExecutionResultSchema } from '@aven/contracts';`],
    ['record.ts', `import Database from 'better-sqlite3';`],
    ['record.ts', `import { x } from '../ledger-extra.ts';`],
    ['index.ts', `import { createLedger } from '@aven/ledger';`],
    ['stored.ts', `storage.sqlite.exec('BEGIN IMMEDIATE');`],
    ['stored.ts', `db.run();`],
    ['record.ts', `storage.sqlite.transaction(() => 1).immediate();`],
    ['stored.ts', `storage.sqlite.transaction(read).immediate();`],
    ['record.ts', `const q = 'INSERT INTO policy_decisions VALUES (?)';`],
    ['record.ts', `const q = 'UPDATE owner_approvals SET x = 1';`],
    ['stored.ts', `storage.sqlite.pragma('foreign_keys = OFF');`],
    ['stored.ts', `const open = storage.sqlite.open;`],
    ['gateway.ts', `ledger.appendEvent(event);`],
    ['record.ts', `ledger.getEvent(id);`],
    ['stored.ts', `ledger.listEvents();`],
    ['record.ts', `const t = new Date().toISOString();`],
    ['record.ts', `const now = internals.clock();`],
    ['record.ts', `const r = randomUUID();`],
    ['record.ts', `console.log('x');`],
    ['gateway.ts', `import { spawn } from 'node:child_process';`],
  ])('rejects the known-bad sample %# in %s', (file, sample) => {
    const appended =
      file === 'record.ts' ? `${sample}\nledger.appendEvent(e);` : sample;
    const text =
      file === 'stored.ts'
        ? `${appended}\nstorage.sqlite.transaction(read).deferred();`
        : appended;
    expect(ledgerViolations(file, text).length).toBeGreaterThan(0);
  });

  it('flags a second append in the recorder', () => {
    expect(
      ledgerViolations('record.ts', 'l.appendEvent(a);\nl.appendEvent(b);'),
    ).toEqual(['record.ts: 2 appendEvent calls']);
  });

  it('exports exactly the gateway, the recorder and reconciliation', () => {
    expect(Object.keys(ledgerApi).sort()).toEqual([
      'createRootGateway',
      'evaluateRecordedProposal',
      'reconcileRootDecisionRecording',
      'recordRootDecision',
    ]);
    for (const name of Object.keys(ledgerApi))
      expect(name).not.toMatch(
        /execut|approv|learn|promot|grant|send|publish/i,
      );
  });
});

describe('package manifest and dependency direction', () => {
  const manifestText = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  );
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;

  it('declares only the accepted entries and dependencies', () => {
    expect(manifest.name).toBe('@aven/root-policy');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './ledger': './src/ledger/index.ts',
      './testing': './src/testing/index.ts',
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

  it('never depends on the proposing package (a frozen AVEN-011 tripwire too)', () => {
    expect(manifestText).not.toContain('@aven/action-proposals');
  });

  it('is imported by no other workspace package', () => {
    const dependents: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const pkg of readdirSync(new URL(`${group}/`, repoRoot))) {
        if (group === 'packages' && pkg === 'root-policy') continue;
        const text = (() => {
          try {
            return readFileSync(
              new URL(`${group}/${pkg}/package.json`, repoRoot),
              'utf8',
            );
          } catch {
            return '';
          }
        })();
        if (text.includes('@aven/root-policy'))
          dependents.push(`${group}/${pkg}`);
      }
    }
    expect(dependents).toEqual([]);
  });

  it('is type-checked by the root check scripts after the AVEN-011 package', () => {
    const root = JSON.parse(
      readFileSync(new URL('package.json', repoRoot), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const script of ['typecheck', 'check'])
      expect(root.scripts[script]).toContain(
        'tsc --project packages/action-proposals/tsconfig.json --noEmit && tsc --project packages/root-policy/tsconfig.json --noEmit',
      );
  });
});
