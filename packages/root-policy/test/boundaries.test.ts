import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.ts';
import { ROOT_POLICY_CONFIG } from '../src/index.ts';
import * as testingApi from '../src/testing/index.ts';
import { deeplyFrozen } from './fixtures.ts';

/**
 * AVEN-012 Patch 2: static REGRESSION TRIPWIRES over the pure Root policy
 * engine. They make obvious regressions visible in review; they are pattern
 * checks, NOT security guarantees, and deliberately obfuscated code can
 * bypass them. Every rule is also run against known-bad samples, so a
 * weakened rule fails here. A later AVEN-012 patch that legitimately adds a
 * module, subpath or import updates these lists in its own reviewed change.
 */
const srcDir = new URL('../src/', import.meta.url);
const testingDir = new URL('../src/testing/', import.meta.url);
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
  it('contains exactly the root modules and the testing subpath', () => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([
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
    expect(text).not.toMatch(/policyInternals|isAuthenticated/);
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
      './testing': './src/testing/index.ts',
    });
    expect(manifest.dependencies).toEqual({
      '@aven/contracts': 'workspace:*',
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
