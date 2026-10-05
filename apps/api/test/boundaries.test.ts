import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Static REGRESSION TRIPWIRES over the API source, not security guarantees.
 *
 * They make obvious regressions visible in review: a model/network/tool import,
 * a direct write that bypasses the Experience Ledger, a new event type, or a
 * rewrite/delete route. They are pattern checks over source text and can be
 * bypassed by deliberately obfuscated code; the runtime tests remain the
 * evidence for behavior. Each rule below is also run against a known-bad sample
 * so a weakened rule fails here instead of silently passing.
 */
const srcDir = new URL('../src/', import.meta.url);
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
/** Code only: block comments and whole-line `//` comments are removed. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const source: Record<string, string> = Object.fromEntries(
  files.map((f) => [f, code(readFileSync(new URL(f, srcDir), 'utf8'))]),
);

/** Exact named imports permitted per external module ('*' = any name). */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  'node:crypto': new Set(['randomUUID']),
  'node:fs': new Set(['readdirSync']),
  'node:http': new Set([
    'createServer',
    'Server',
    'IncomingMessage',
    'ServerResponse',
  ]),
  'node:net': new Set(['AddressInfo']),
  'node:path': new Set(['isAbsolute', 'resolve']),
  'node:url': new Set(['fileURLToPath']),
  'node:util': new Set(['parseArgs']),
  zod: new Set(['z']),
  'drizzle-orm': new Set(['and', 'asc', 'eq', 'gt', 'or']),
  '@aven/contracts': new Set(['*']),
  '@aven/storage': new Set([
    'schema',
    'Storage',
    'openStorage',
    'migrationDirectory',
  ]),
  '@aven/ledger': new Set([
    'createLedger',
    'EventInput',
    'EvidenceInput',
    'LedgerError',
    'LedgerErrorCode',
  ]),
};

/** The only tables the API may write directly. History goes through the Ledger. */
const IDENTITY_TABLES = new Set(['owners', 'sessions', 'tasks']);
/** Drizzle export names of every frozen history, catalog, owner-state and authority table. */
const PROTECTED_TABLE_IDENTIFIERS = [
  'experienceEvents',
  'recordKeys',
  'recordVersions',
  'recordReferences',
  'learnedOwnerState',
  'activeTaskState',
  'learningCandidates',
  'noUsefulLessons',
  'corrections',
  'actionProposals',
  'policyDecisions',
  'ownerApprovals',
  'toolExecutions',
  'verificationResults',
  'evaluations',
  'lifecycleRecords',
];
/** SQL table names of the same tables, including the plain-word ones. */
const PROTECTED_SQL_TABLES = [
  'experience_events',
  'evidence',
  'record_keys',
  'record_versions',
  'record_references',
  'learned_owner_state',
  'active_task_state',
  'learning_candidates',
  'no_useful_lessons',
  'corrections',
  'action_proposals',
  'policy_decisions',
  'owner_approvals',
  'tool_executions',
  'verification_results',
  'evaluations',
  'lifecycle_records',
];

function importViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b([^;]*?)\bfrom\s+(['"])([^'"]+)\2/gs,
  )) {
    const clause = m[1] ?? '';
    const module = m[3] ?? '';
    if (module.startsWith('./')) continue;
    const allowed = IMPORT_ALLOWLIST[module];
    if (!allowed) {
      found.push(`module ${module}`);
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    // Default or namespace imports would expose every export of the module.
    if (
      !braces ||
      clause
        .replace(/\{[^}]*\}/, '')
        .replace(/\btype\b/, '')
        .trim()
    )
      found.push(`non-named import from ${module}`);
    for (const raw of (braces?.[1] ?? '').split(',')) {
      const name = raw
        .replace(/\btype\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && !allowed.has('*') && !allowed.has(name))
        found.push(`${module}.${name}`);
    }
  }
  if (/\bimport\s*['"]/.test(text)) found.push('side-effect import');
  if (/\bimport\s*\(/.test(text)) found.push('dynamic import');
  if (/\brequire\s*\(|createRequire/.test(text)) found.push('require');
  return found;
}

function outboundViolations(text: string): string[] {
  return [
    /\bfetch\s*\(/,
    /\brequest\s*\(/,
    /\bhttps?\.get\s*\(/,
    /\bconnect\s*\(/,
    /child_process|\bspawn\s*\(|\bexec(File|Sync)?\s*\(/,
    /WebSocket/,
    /openai|anthropic|gemini|ollama|completion/i,
    /\beval\s*\(|new\s+Function\s*\(/,
    /process\.binding|globalThis\s*\[/,
  ]
    .filter((p) => p.test(text))
    .map(String);
}

/** True when the text imports the storage table namespace `schema`. */
function importsStorageSchema(text: string): boolean {
  return /import\s*\{[^}]*\bschema\b[^}]*\}\s*from\s*'@aven\/storage'/.test(
    text,
  );
}

/**
 * `checkSchemaRefs` applies the `schema.<table>` rule; it is enabled for files
 * that import the storage `schema` namespace (other files use `schema` as an
 * ordinary Zod parameter name) and for every known-bad sample.
 */
function directWriteViolations(text: string, checkSchemaRefs = true): string[] {
  const found: string[] = [];
  if (/\bschema\s+as\s+\w+/.test(text)) found.push('renamed schema import');
  if (checkSchemaRefs) {
    // Every `schema.<table>` reference must name an identity table, so aliasing
    // a protected table (`const t = schema.experienceEvents`) is caught too.
    for (const m of text.matchAll(/\bschema\s*(?:\.\s*(\w+)|\[)/g))
      if (!m[1] || !IDENTITY_TABLES.has(m[1]))
        found.push(`schema.${m[1] ?? '[computed]'}`);
    if (/\}\s*=\s*schema\b/.test(text)) found.push('destructured schema');
  }
  for (const name of PROTECTED_TABLE_IDENTIFIERS)
    if (new RegExp(`\\b${name}\\b`).test(text)) found.push(name);
  // Every Drizzle insert must target an identity table literally.
  const inserts = [...text.matchAll(/\.insert\s*\(([^)]*)\)/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  for (const target of inserts)
    if (!/^schema\.(owners|sessions|tasks)$/.test(target))
      found.push(`insert(${target})`);
  if (/\.(update|delete)\s*\(/.test(text)) found.push('update/delete');
  // Raw SQL entry points and SQL write statements.
  if (/\.prepare\s*\(|\.exec\s*\(|\bsql\s*`|\.run\s*\(\s*[^)\s]/.test(text))
    found.push('raw SQL');
  if (
    /\b(insert\s+(or\s+\w+\s+)?into|update\s+\w+\s+set|delete\s+from|replace\s+into|drop\s+table|alter\s+table|create\s+(temp\w*\s+)?(table|trigger|index))\b/i.test(
      text,
    )
  )
    found.push('SQL write statement');
  if (/pragma\s*\(\s*['"`][^'"`]*=/.test(text)) found.push('pragma write');
  for (const table of PROTECTED_SQL_TABLES)
    if (
      new RegExp(
        `\\b(into|update|from|table|join)\\s+["'\`]?${table}\\b`,
        'i',
      ).test(text) ||
      (table.includes('_') && new RegExp(`\\b${table}\\b`).test(text))
    )
      found.push(`SQL table ${table}`);
  return found;
}

const all = Object.values(source).join('\n');

describe('AVEN-005 API static regression tripwires (not runtime security)', () => {
  it('imports only allowlisted names from local, storage, Ledger, contract and validation modules', () => {
    expect(importViolations(all)).toEqual([]);
    // node:net is used for a type only.
    expect(source['server.ts']).toMatch(
      /import type \{ AddressInfo \} from 'node:net'/,
    );
    for (const bad of [
      `import { request } from 'node:http';`,
      `import * as http from 'node:http';`,
      `import http from 'node:http';`,
      `import { sql } from 'drizzle-orm';`,
      `import { experienceEvents } from '@aven/storage';`,
      `import { migrate } from '@aven/storage';`,
      `import x from 'openai';`,
      `const m = await import('node:https');`,
      `import 'node:net';`,
    ])
      expect(importViolations(bad), bad).not.toEqual([]);
  });

  it('contains no outbound network, process, model-provider or tool execution call', () => {
    expect(outboundViolations(all)).toEqual([]);
    for (const bad of [
      `await fetch('https://example.invalid')`,
      `request({ host: 'x' }).end()`,
      `globalThis['fet' + 'ch']('x')`,
      `const c = provider.completion(prompt)`,
    ])
      expect(outboundViolations(bad), bad).not.toEqual([]);
  });

  it('writes only owners, sessions and tasks directly; history goes through the Ledger', () => {
    for (const [file, text] of Object.entries(source))
      expect(
        directWriteViolations(text, importsStorageSchema(text)),
        file,
      ).toEqual([]);
    expect(
      Object.keys(source).filter((f) => importsStorageSchema(source[f]!)),
    ).toEqual(['identity-store.ts']);
    const inserts = [...all.matchAll(/\.insert\(schema\.(\w+)\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(inserts)).toEqual(IDENTITY_TABLES);
    // The single historical write is a Ledger append bound to the path owner.
    expect([...all.matchAll(/\bappendEvent\s*\(/g)]).toHaveLength(1);
    expect(all).toMatch(/createLedger\(storage, ownerId\)\.appendEvent\(/);
    for (const bad of [
      `const ev = schema.experienceEvents; db.insert(ev).values(row).run();`,
      `const { evidence: e } = schema; db.insert(e).values(row).run();`,
      `db.insert(schema.evidence).values(row).run();`,
      `db.insert(schema['recordKeys']).values(row).run();`,
      `db.update(schema.sessions).set({ createdAt: x }).run();`,
      `db.delete(schema.tasks).run();`,
      `db.run(sql\`select 1\`);`,
      `storage.sqlite.prepare('select 1').get();`,
      `storage.sqlite.exec('select 1');`,
      `const s = 'INSERT INTO experience_events VALUES (1)';`,
      `const s = "insert or ignore into evidence values (1)";`,
      `const s = 'update record_versions set x = 1';`,
      `const s = 'delete from learned_owner_state';`,
      `storage.sqlite.pragma('foreign_keys = OFF');`,
      `const t = activeTaskState;`,
      `const t = ownerApprovals;`,
      `import { schema as s } from '@aven/storage'; s.evidence;`,
    ])
      expect(directWriteViolations(bad), bad).not.toEqual([]);
  });

  it('constructs only owner_request events with explicit owner-statement provenance', () => {
    const eventTypes = [...all.matchAll(/eventType:\s*'(\w+)'/g)].map(
      (m) => m[1],
    );
    expect(new Set(eventTypes)).toEqual(new Set(['owner_request']));
    const provenanceKinds = [
      ...all.matchAll(/kind:\s*'(\w+)'\s+as const/g),
    ].map((m) => m[1]);
    expect(provenanceKinds).toEqual(['explicit_owner_statement']);
    expect(all).not.toMatch(
      /assistant_response|model_inference|system_generated|owner_approval|owner_correction|tool_result|external_content/,
    );
  });

  it('registers only GET and POST handlers', () => {
    const methods = [
      ...source['http.ts']!.matchAll(
        /^\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):/gm,
      ),
    ].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['GET', 'POST']));
  });
});
