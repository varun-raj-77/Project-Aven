import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.ts';
import { ACTION_PROPOSALS_CONFIG } from '../src/index.ts';

/**
 * AVEN-011 Patch 2: static REGRESSION TRIPWIRES over the pure root entry.
 * They make obvious regressions visible in review; they are pattern checks,
 * NOT security guarantees, and deliberately obfuscated code can bypass them.
 * Every rule is also run against known-bad samples, so a weakened rule fails
 * here. Later AVEN-011 patches that legitimately add a module, subpath or
 * import update these lists in their own reviewed change.
 */
const srcDir = new URL('../src/', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
/** Code only: block comments and whole-line `//` comments are removed. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sourceOf = (name: string) =>
  code(readFileSync(new URL(name, srcDir), 'utf8'));

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

describe('pure root entry: static boundaries', () => {
  it('contains exactly the Patch 2 modules and no subpath yet', () => {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual(
      [],
    );
    expect(entries.map((e) => e.name).sort()).toEqual(SRC_FILES);
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

  it('exports exactly the accepted API', () => {
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

describe('package manifest and dependency direction', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  it('declares only the root entry and the permitted dependencies', () => {
    expect(manifest.name).toBe('@aven/action-proposals');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(manifest.dependencies).toEqual({
      '@aven/contracts': 'workspace:*',
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
