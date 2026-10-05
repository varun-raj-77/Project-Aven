import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Static REGRESSION TRIPWIRES over the runtime package source, not security
 * guarantees. They make it visible in review if the runtime boundary acquires
 * storage/Ledger access, a network or process capability, a provider SDK,
 * credentials from the environment, or Ledger/provenance knowledge. They are
 * pattern checks and can be bypassed by obfuscated code; behavior is evidenced
 * by the runtime tests. Each rule is also run against known-bad samples.
 *
 * Test-only code: `scripted.ts` is reachable only through the explicit
 * `@aven/runtime/testing` export. Every other module in src/ is production
 * code and must neither import nor re-export it, directly or transitively
 * (external review M3).
 */
const srcDir = new URL('../src/', import.meta.url);
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const source: Record<string, string> = Object.fromEntries(
  files.map((f) => [f, code(readFileSync(new URL(f, srcDir), 'utf8'))]),
);
const all = Object.values(source).join('\n');

/** The only test-only module in src/. Everything else is production code. */
const TEST_ONLY = new Set(['scripted.ts']);
const production = Object.keys(source).filter((f) => !TEST_ONLY.has(f));
const TEST_RUNTIME_TERMS = /scripted|@aven\/runtime\/testing|fake|mock|stub/i;

/** Local module specifiers of static imports/re-exports and dynamic imports, as src/ file names. */
function localDependencies(text: string): string[] {
  const specs = [
    ...text.matchAll(/\bfrom\s+(['"])(\.\/[^'"]+)\1/g),
    ...text.matchAll(/\bimport\s*\(\s*(['"])(\.\/[^'"]+)\1/g),
  ].map((m) => m[2] ?? '');
  return specs.map((spec) => {
    const file = spec.slice(2).replace(/\.js$/, '.ts');
    return file.endsWith('.ts') ? file : `${file}.ts`;
  });
}
function testRuntimeViolations(text: string): string[] {
  const found = localDependencies(text)
    .filter((f) => TEST_ONLY.has(f))
    .map((f) => `depends on ${f}`);
  if (TEST_RUNTIME_TERMS.test(text)) found.push('test-runtime reference');
  return found;
}
/** Test-only modules reachable from `entry` through local imports/re-exports. */
function reachableTestOnly(
  modules: Record<string, string>,
  entry: string,
): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...localDependencies(modules[file] ?? ''));
  }
  return [...seen].filter((f) => TEST_ONLY.has(f));
}

/** The runtime package may import only validation and frozen contracts. */
const ALLOWED_MODULES = new Set(['zod', '@aven/contracts']);
function importViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b[^;]*?\bfrom\s+(['"])([^'"]+)\1/gs,
  )) {
    const module = m[2] ?? '';
    if (!module.startsWith('./') && !ALLOWED_MODULES.has(module))
      found.push(module);
  }
  if (/\bimport\s*['"]/.test(text)) found.push('side-effect import');
  if (/\bimport\s*\(/.test(text)) found.push('dynamic import');
  if (/\brequire\s*\(|createRequire/.test(text)) found.push('require');
  return found;
}

function capabilityViolations(text: string): string[] {
  return [
    /@aven\/(storage|ledger|api)|better-sqlite3|drizzle|sqlite|\.prepare\s*\(/i,
    /\bfetch\s*\(|\bhttps?\b|node:net|node:tls|node:dns|WebSocket|XMLHttpRequest/,
    /child_process|\bspawn\s*\(|\bexec(File|Sync)?\s*\(|node:worker_threads/,
    /process\.env|process\.binding|globalThis\s*\[/,
    /openai|anthropic|gemini|ollama|strands|bedrock|vertex|mistral|cohere|huggingface|completion/i,
    /\beval\s*\(|new\s+Function\s*\(/,
  ]
    .filter((p) => p.test(text))
    .map(String);
}

/** The runtime generates; it never names Ledger records, provenance or authority. */
function ledgerKnowledgeViolations(text: string): string[] {
  return [
    /appendEvent|createLedger|experience_event|eventType/,
    /assistant_response|owner_request|model_inference|explicit_owner_statement/,
    /ownerId|sessionId|taskId/,
    /approval|permission|policy|learned|correction/i,
  ]
    .filter((p) => p.test(text))
    .map(String);
}

describe('AVEN-006 runtime static regression tripwires (not runtime security)', () => {
  it('imports only zod and frozen contracts', () => {
    expect(importViolations(all)).toEqual([]);
    for (const bad of [
      `import { openStorage } from '@aven/storage';`,
      `import { createLedger } from '@aven/ledger';`,
      `import OpenAI from 'openai';`,
      `import { request } from 'node:https';`,
      `const m = await import('node:http');`,
      `import 'dotenv/config';`,
      `const fs = require('node:fs');`,
    ])
      expect(importViolations(bad), bad).not.toEqual([]);
  });

  it('has no storage, network, process, environment-credential or provider capability', () => {
    expect(capabilityViolations(all)).toEqual([]);
    for (const bad of [
      `await fetch('https://api.example.invalid')`,
      `const key = process.env.PROVIDER_KEY;`,
      `new WebSocket('wss://x')`,
      `db.prepare('select 1')`,
      `client.chat.completions.create(x)`,
      `globalThis['fet' + 'ch']('x')`,
    ])
      expect(capabilityViolations(bad), bad).not.toEqual([]);
  });

  it('knows nothing about Ledger records, owner identity, provenance or authority', () => {
    expect(ledgerKnowledgeViolations(all)).toEqual([]);
    for (const bad of [
      `ledger.appendEvent(event)`,
      `const kind = 'model_inference';`,
      `request.ownerId`,
      `if (output.approval) grant()`,
      `const permissions = []`,
    ])
      expect(ledgerKnowledgeViolations(bad), bad).not.toEqual([]);
  });

  it('keeps every production module free of the test-only runtime, directly and transitively', () => {
    expect(production.sort()).toEqual(
      ['errors.ts', 'index.ts', 'invoke.ts', 'types.ts'].sort(),
    );
    for (const file of production) {
      expect(testRuntimeViolations(source[file]!), file).toEqual([]);
      expect(reachableTestOnly(source, file), file).toEqual([]);
    }
    // The exact mutation that survived external review (M3): a production
    // module importing and using the scripted runtime.
    const reviewMutation = `${source['invoke.ts']!}
import { createScriptedModelRuntime } from './scripted.ts';
void createScriptedModelRuntime;`;
    expect(testRuntimeViolations(reviewMutation)).not.toEqual([]);
    expect(
      reachableTestOnly({ ...source, 'invoke.ts': reviewMutation }, 'index.ts'),
    ).toEqual(['scripted.ts']);
    for (const bad of [
      `import { createScriptedModelRuntime } from './scripted.ts';`,
      `import { createScriptedModelRuntime as make } from './scripted.js';`,
      `import type { ScriptedStep } from './scripted';`,
      `export * from './scripted.ts';`,
      `export { createScriptedModelRuntime } from './scripted.ts';`,
      `const m = await import('./scripted.ts');`,
      `import { createScriptedModelRuntime } from '@aven/runtime/testing';`,
      `export const createFakeRuntime = () => ({ invoke })`,
    ])
      expect(testRuntimeViolations(bad), bad).not.toEqual([]);
    // Transitive: a chain of innocuous-looking re-exports still reaches it.
    expect(
      reachableTestOnly(
        {
          'index.ts': `export { a } from './a.ts';`,
          'a.ts': `export { b as a } from './b.js';`,
          'b.ts': `export { createScriptedModelRuntime as b } from './scripted.ts';`,
          'scripted.ts': '',
        },
        'index.ts',
      ),
    ).toEqual(['scripted.ts']);
  });

  it('exposes the test-only runtime solely through the explicit testing export', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './testing': './src/scripted.ts',
    });
    // No provider SDK, HTTP client or storage dependency.
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@aven/contracts',
      'zod',
    ]);
  });
});
