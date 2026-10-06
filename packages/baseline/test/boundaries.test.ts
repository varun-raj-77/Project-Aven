import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AVEN-007 static REGRESSION TRIPWIRES over the baseline package source. They
 * are pattern checks that make obvious regressions visible in review; they are
 * NOT security guarantees and can be bypassed by deliberately obfuscated code.
 * Behavior is evidenced by the other baseline tests. Every rule is also run
 * against known-bad samples so a weakened rule fails here.
 *
 * Every module in src/ is production code: the package has no test-only
 * module and must never import the AVEN-006 scripted runtime.
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
const all = Object.values(source).join('\n');

/** Exact named imports permitted per external module. No node:* module at all. */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  // Validation primitives and runtime identity only: no authority, approval,
  // policy, learned-state, candidate, correction or Ledger contract.
  '@aven/contracts': new Set([
    'EventIdSchema',
    'NonEmptyTextSchema',
    'OwnerIdSchema',
    'TimestampSchema',
    'UsageSchema',
    'ModelConfiguration',
    'RuntimeStampSchema',
  ]),
  // Production runtime entry only; '@aven/runtime/testing' is not allowlisted.
  '@aven/runtime': new Set([
    'invokeModelRuntime',
    'InvokeOptionsSchema',
    'ModelRuntimeError',
    'MODEL_RUNTIME_ERROR_CODES',
    'ReportedModelSchema',
    'ReportedRuntimeSchema',
    'FinishReason',
    'ModelInputMessage',
    'ModelRuntime',
    'ModelRuntimeErrorCode',
    'ModelRuntimeResult',
  ]),
};

function importViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const module = m[3] ?? '';
    if (module.startsWith('./')) continue;
    const allowed = IMPORT_ALLOWLIST[module];
    if (!allowed) {
      found.push(module);
      continue;
    }
    const clause = m[1] ?? '';
    if (!clause.startsWith('{')) {
      found.push(`${module}: non-named import`);
      continue;
    }
    for (const raw of clause.slice(1, -1).split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name && !allowed.has(name)) found.push(`${module}: ${name}`);
    }
  }
  if (/\bimport\s*['"]/.test(text)) found.push('side-effect import');
  if (/\bimport\s*\(/.test(text)) found.push('dynamic import');
  if (/\brequire\s*\(|createRequire/.test(text)) found.push('require');
  return found;
}

const RULES: Record<string, RegExp[]> = {
  'test runtime': [
    /scripted|@aven\/runtime\/testing|createScriptedModelRuntime|fake|mock|stub/i,
  ],
  'storage or Ledger access': [
    /@aven\/(storage|ledger|api)|better-sqlite3|drizzle|sqlite|\.prepare\s*\(|openStorage|createLedger|appendEvent/i,
    /\b(experience_events|owner_approvals|policy_decisions|action_proposals|learned_owner_state|learning_candidates|corrections|lifecycle_records|no_useful_lessons|tool_executions|verification_results|evaluations|active_task_state)\b/,
  ],
  'file, network, process or environment capability': [
    /\bnode:|readFile|writeFile|appendFile|createReadStream|\bfs\./,
    /\bfetch\s*\(|\bhttps?\.|WebSocket|XMLHttpRequest|\bnet\.|\btls\./,
    /child_process|\bspawn\s*\(|\bexec(File|Sync)?\s*\(|worker_threads/,
    /process\.env|process\.binding|globalThis\s*\[/,
    /\beval\s*\(|new\s+Function\s*\(/,
    /localStorage|indexedDB/,
  ],
  'provider SDK, framework or live adapter': [
    /openai|anthropic|gemini|ollama|strands|bedrock|vertex|mistral|cohere|huggingface|langchain|llamaindex|completion/i,
    /implements\s+ModelRuntime|\binvoke\s*(\(|:|=)|\binvoke\s*\(/,
  ],
  'authority, approval, Root, tools or learned state': [
    /PolicyDecision|ActionProposal|OwnerApproval|Approval(Id|Schema)|ToolExecution|LearnedItem|LearningCandidate|Candidate(Id|Schema)|Correction(Schema|Event)|Promotion|@aven\/(root|learning|eval)/,
  ],
  'Context Broker or Owner Model machinery': [
    /ContextBroker|context-broker|OwnerModel|owner-model|@aven\/(context-broker|owner-model)/i,
    /salience|trust(Score|Weight|Level|Class)|\bconfidence\b|supersed|provenance|negativeSignal|counterexample|embedding|rerank|semanticScope/i,
  ],
  'oracle access': [
    /oracle|expectedBehaviorClass|expectedRelevantContextIds|expectedIrrelevantContextIds|requiredBehavior|forbiddenBehavior|notesForFutureScorer|\.jsonl|evals\//i,
  ],
};
function violations(rule: string, text: string): string[] {
  return RULES[rule]!.filter((p) => p.test(text)).map(String);
}

const KNOWN_BAD: Record<string, string[]> = {
  'test runtime': [
    `import { createScriptedModelRuntime } from '@aven/runtime/testing';`,
    `const runtime = createFakeRuntime();`,
  ],
  'storage or Ledger access': [
    `import { openStorage } from '@aven/storage';`,
    `ledger.appendEvent(event)`,
    `db.prepare('insert into learned_owner_state values (?)')`,
    `const t = 'owner_approvals';`,
  ],
  'file, network, process or environment capability': [
    `import { readFileSync } from 'node:fs';`,
    `const text = readFile('evals/aven-007/oracle.jsonl')`,
    `await fetch('https://api.example.invalid')`,
    `const key = process.env.PROVIDER_KEY;`,
    `localStorage.setItem('profile', x)`,
  ],
  'provider SDK, framework or live adapter': [
    `import OpenAI from 'openai';`,
    `import { Agent } from 'strands-agents';`,
    `class LiveRuntime implements ModelRuntime {}`,
    `const runtime = { invoke: async () => out };`,
  ],
  'authority, approval, Root, tools or learned state': [
    `import { PolicyDecisionSchema } from '@aven/contracts';`,
    `const id: LearnedItemId = x;`,
    `createCandidateId()`,
    `import { gate } from '@aven/root';`,
  ],
  'Context Broker or Owner Model machinery': [
    `export class ContextBroker {}`,
    `const score = bm25 * trustWeight;`,
    `if (record.supersededBy) skip();`,
    `rank(record.provenance)`,
    `const v = embedding(text)`,
  ],
  'oracle access': [
    `const labels = loadOracle();`,
    `input.expectedBehaviorClass`,
    `parse('evals/aven-007/cases.jsonl')`,
  ],
};

describe('AVEN-007 baseline static regression tripwires (not runtime security)', () => {
  it('imports only zod, allowlisted contract primitives and the production runtime entry', () => {
    expect(importViolations(all)).toEqual([]);
    for (const bad of [
      `import { createScriptedModelRuntime } from '@aven/runtime/testing';`,
      `import { openStorage } from '@aven/storage';`,
      `import { readFileSync } from 'node:fs';`,
      `import { PolicyDecisionSchema } from '@aven/contracts';`,
      `import { LearnedItemSchema as L } from '@aven/contracts';`,
      `import * as contracts from '@aven/contracts';`,
      `import OpenAI from 'openai';`,
      `export * from '@aven/runtime/testing';`,
      `const m = await import('node:https');`,
      `import 'dotenv/config';`,
      `const fs = require('node:fs');`,
    ])
      expect(importViolations(bad), bad).not.toEqual([]);
  });

  for (const rule of Object.keys(RULES))
    it(`has no ${rule}`, () => {
      expect(violations(rule, all)).toEqual([]);
      for (const bad of KNOWN_BAD[rule]!)
        expect(violations(rule, bad), bad).not.toEqual([]);
    });

  it('names its retriever NaiveHistorySearch, never a Context Broker', () => {
    const raw = readFileSync(new URL('history-search.ts', srcDir), 'utf8');
    expect(raw).toContain('NaiveHistorySearch');
    expect(raw).toContain('NOT the AVEN-008 Context Broker');
  });

  it('declares only the production entry and no provider, storage or test-runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@aven/contracts',
      '@aven/runtime',
      'zod',
    ]);
  });

  it('keeps all production modules in a known, reviewed set', () => {
    expect(files.sort()).toEqual(
      [
        'config.ts',
        'dataset.ts',
        'errors.ts',
        'history-search.ts',
        'index.ts',
        'profile.ts',
        'prompt.ts',
        'run-record.ts',
        'runner.ts',
        'types.ts',
      ].sort(),
    );
  });
});
