import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../src/index.ts';

/**
 * AVEN-008 static REGRESSION TRIPWIRES over the Context Broker source. They
 * are pattern checks that make obvious regressions visible in review; they
 * are NOT security guarantees and can be bypassed by deliberately obfuscated
 * code. Behavior is evidenced by the other broker tests. Every rule is also
 * run against known-bad samples, so a weakened rule fails here.
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

/** Exact named imports permitted per external module. No node:* module. */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  // Validation primitives and the frozen reference/provenance/scope views
  // only: no authority, approval, policy, learned-state, candidate,
  // correction, evidence-record or Ledger contract.
  '@aven/contracts': new Set([
    'ContextSourceSchema',
    'NonEmptyTextSchema',
    'OwnerIdSchema',
    'ProvenanceSchema',
    'ScopeSchema',
    'TaskBindingSchema',
    'TimestampSchema',
  ]),
};

function importViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const module = m[3] ?? '';
    if (/^\.\/[\w-]+\.ts$/.test(module)) continue;
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

/** Removes the one frozen provenance kind literal that names a correction. */
const withoutProvenanceKinds = (text: string) =>
  text.replaceAll('explicit_owner_correction', '');

const RULES: Record<string, RegExp[]> = {
  'storage or Ledger access (AE)': [
    /@aven\/(storage|ledger|api)|better-sqlite3|drizzle|sqlite|\.prepare\s*\(|openStorage|createLedger|appendEvent|\binsert\s+into\b/i,
    /\b(experience_events|owner_approvals|policy_decisions|action_proposals|learned_owner_state|learning_candidates|corrections|lifecycle_records|no_useful_lessons|tool_executions|verification_results|evaluations|active_task_state_records)\b/,
  ],
  'model runtime, AVEN-007 baseline, provider or semantic retrieval (AF)': [
    /@aven\/(runtime|baseline)|ModelRuntime|invokeModelRuntime|searchHistory|NaiveHistorySearch|\bbm25\b|BASELINE_/i,
    /openai|anthropic|gemini|ollama|strands|bedrock|vertex|mistral|cohere|huggingface|langchain|llamaindex|completion|embedding|vector|rerank/i,
  ],
  'file, network, process or environment capability (AF)': [
    /\bnode:|readFile|writeFile|appendFile|createReadStream|\bfs\./,
    // Any mention of fetch (direct, destructured or aliased), and quoted
    // network/process module names however they are imported.
    /\bfetch\b|\bhttps?\.|WebSocket|XMLHttpRequest|\bnet\.|\btls\./,
    /['"`](node:)?(https?|http2|net|tls|dns|dgram|child_process|worker_threads|fs)(\/[\w/]*)?['"`]/,
    /child_process|\bspawn\s*\(|\bexec(File|Sync)?\s*\(|worker_threads/,
    /process\.env|process\.binding|\bglobalThis\b/,
    /\beval\s*\(|new\s+Function\s*\(/,
    /localStorage|indexedDB/,
  ],
  // Timers are checked per file below: only deadline.ts may use them.
  'wall clock or randomness': [
    /Date\.now|new\s+Date\b|performance\.now|Math\.random|\bcrypto\b|randomUUID|hrtime/,
  ],
  'authority, approval, Root or tools': [
    /\b(ALLOW|DENY|REQUIRE_OWNER_APPROVAL)\b/,
    /PolicyDecision|PolicyOutcome|ActionProposal|Approval(Id|Schema|Reference)|AllowDecision|ToolExecution|@aven\/root/,
    /\bpermissions?\b|authori[sz]|\bgrant(ed|s)?\b|\bapproved?\b/i,
  ],
  'AVEN-009 Owner Model structures or persistence (AG)': [
    /DurableOwnerState|TrustedOwnerState|ActiveTaskStateSchema|OwnerStateSchema|LearnedContent|LearnedLifecycle|EvidenceSignals|EvidenceRecord|LearningCandidate|LearningTransition|LearningPromotion/,
    /@aven\/(owner-model|learning)|OwnerModel|FactRecord|PreferenceRecord|ProcedureRecord|IntentPattern|rebuildOwner|\bpersist|\bupsert|\bsaveState|\bstore\.(set|write|put)/i,
  ],
  'AVEN-010 correction interpretation (AH)': [/correct|override/i],
  'hidden reasoning fields': [
    /reasoning|chainOfThought|chain_of_thought|\bthoughts?\b|rationale|scratchpad/i,
  ],
  'test-only runtime': [
    /scripted|@aven\/runtime\/testing|\bmock|\bstub|\bfake/i,
  ],
};
const ruleText: Record<string, (text: string) => string> = {
  'AVEN-010 correction interpretation (AH)': withoutProvenanceKinds,
};
function violations(rule: string, text: string): string[] {
  const prepared = (ruleText[rule] ?? ((t: string) => t))(text);
  return RULES[rule]!.filter((p) => p.test(prepared)).map(String);
}

const KNOWN_BAD: Record<string, string[]> = {
  'storage or Ledger access (AE)': [
    `import { openStorage } from '@aven/storage';`,
    `ledger.appendEvent(event)`,
    `db.prepare('insert into learned_owner_state values (?)')`,
    `const table = 'experience_events';`,
  ],
  'model runtime, AVEN-007 baseline, provider or semantic retrieval (AF)': [
    `import { invokeModelRuntime } from '@aven/runtime';`,
    `import { searchHistory } from '@aven/baseline';`,
    `const s = bm25(query, docs);`,
    `const v = embedding(text);`,
    `client.chat.completions.create(x)`,
  ],
  'file, network, process or environment capability (AF)': [
    `const { fetch: get } = globalThis;`,
    `const request = fetch;`,
    `const transport = 'node:https';`,
    `export { request } from "http";`,
    `import { readFileSync } from 'node:fs';`,
    `await fetch('https://api.example.invalid')`,
    `const key = process.env.PROVIDER_KEY;`,
    `globalThis['fet' + 'ch']('x')`,
  ],
  'wall clock or randomness': [
    `const age = Date.now() - recordedAt;`,
    `const now = new Date();`,
    `const jitter = Math.random();`,
    `const t = process.hrtime();`,
  ],
  'authority, approval, Root or tools': [
    `return { decision: 'ALLOW' };`,
    `import { PolicyDecisionSchema } from '@aven/contracts';`,
    `if (text.includes('approved')) permission = true;`,
    `const isAuthorized = true;`,
  ],
  'AVEN-009 Owner Model structures or persistence (AG)': [
    `import { DurableOwnerStateSchema } from '@aven/contracts';`,
    `export class OwnerModel {}`,
    `store.set(candidate.id, selected)`,
    `persistScores(trace)`,
  ],
  'AVEN-010 correction interpretation (AH)': [
    `if (isCorrection(text)) negativeRetrieval = 1;`,
    `const override = createSessionOverride(text);`,
    `import { OwnerCorrectionSchema } from '@aven/contracts';`,
  ],
  'hidden reasoning fields': [
    `return { reasoning: steps };`,
    `trace.chainOfThought = x;`,
    `const rationale = '...';`,
  ],
  'test-only runtime': [
    `import { createScriptedModelRuntime } from '@aven/runtime/testing';`,
    `const source = mockSource();`,
  ],
};

describe('AVEN-008 Context Broker static regression tripwires (not runtime security)', () => {
  it('imports only zod, allowlisted frozen contract schemas and its own modules', () => {
    expect(importViolations(all)).toEqual([]);
    for (const bad of [
      `import { invokeModelRuntime } from '@aven/runtime';`,
      `import { searchHistory } from '@aven/baseline';`,
      `import { tokenize } from '../../baseline/src/history-search.ts';`,
      `import { createLedger } from '@aven/ledger';`,
      `import { openStorage } from '@aven/storage';`,
      `import { readFileSync } from 'node:fs';`,
      `import { PolicyDecisionSchema } from '@aven/contracts';`,
      `import { DurableOwnerStateSchema as S } from '@aven/contracts';`,
      `import * as contracts from '@aven/contracts';`,
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

  it('confines timers to the collection deadline, which no ranking module imports (H1)', () => {
    const TIMERS = /\bset(Timeout|Interval|Immediate)\b|\bclearTimeout\b/;
    const withTimers = Object.keys(source).filter((f) =>
      TIMERS.test(source[f]!),
    );
    expect(withTimers).toEqual(['deadline.ts']);
    // The deadline module reads no clock value and no randomness.
    expect(
      violations('wall clock or randomness', source['deadline.ts']!),
    ).toEqual([]);
    const importers = Object.keys(source).filter((f) =>
      /from\s+['"]\.\/deadline\.ts['"]/.test(source[f]!),
    );
    expect(importers).toEqual(['broker.ts']);
    for (const bad of [`setTimeout(rank, 1)`, `const id = setInterval(f, 5);`])
      expect(TIMERS.test(bad), bad).toBe(true);
  });

  it('declares only the production entry and depends only on contracts and zod', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      exports: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('@aven/context-broker');
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@aven/contracts',
      'zod',
    ]);
  });

  it('keeps all production modules in a known, reviewed set', () => {
    expect(files.sort()).toEqual(
      [
        'broker.ts',
        'config.ts',
        'deadline.ts',
        'errors.ts',
        'index.ts',
        'ranking.ts',
        'relevance.ts',
        'scope.ts',
        'types.ts',
        'util.ts',
      ].sort(),
    );
  });

  it('exports a pinned public surface with no Owner Model, correction or authority API', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'CONTEXT_BROKER_CONFIG_V2',
        'CONTEXT_BROKER_CONFIG_VERSION',
        'CONTEXT_BROKER_ERROR_CODES',
        'CONTEXT_BROKER_VERSION',
        'CONTEXT_SOURCE_KINDS',
        'CandidateSignalsSchema',
        'ContextBrokerError',
        'ContextCandidateSchema',
        'ContextRequestSchema',
        'EXCLUSION_REASONS',
        'FRESHNESS_HALF_LIFE_DAYS',
        'LocalIdSchema',
        'MAX_CANDIDATES_PER_SOURCE',
        'MAX_RAW_ITEMS_PER_SOURCE',
        'MAX_RAW_ITEMS_TOTAL',
        'MAX_SELECTED_CONTEXT_CHARS',
        'MAX_SELECTED_ITEMS',
        'MAX_SINGLE_CONTEXT_ITEM_CHARS',
        'MAX_SOURCES',
        'MAX_TOTAL_CANDIDATES',
        'PROVENANCE_FACTORS',
        'QUALIFIER_TERMS_V1',
        'RANKING_FACTORS',
        'RANKING_WEIGHTS_BASIS_POINTS',
        'RELEVANCE_VERSION',
        'SCOPE_FACTORS',
        'SCOPE_VERSION',
        'SOURCE_COLLECTION_DEADLINE_MS',
        'STOPWORDS_V1',
        'TOKENIZER_VERSION',
        'TRACE_VERSION',
        'TRUST_FACTORS',
        'TaskDescriptorSchema',
        'createContextBroker',
        'extractQueryTerms',
        'isQualifierTerm',
        'lexicalRelevance',
        'normalizeLabel',
        'pluralFold',
        'tokenize',
      ].sort(),
    );
  });

  it('documents that the broker is not the AVEN-007 baseline search', () => {
    const raw = readFileSync(new URL('relevance.ts', srcDir), 'utf8');
    expect(raw).toContain("NOT the AVEN-007 baseline's BM25");
  });
});
