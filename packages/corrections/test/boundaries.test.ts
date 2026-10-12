import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from '../src/index.ts';
import * as ledgerApi from '../src/ledger/index.ts';
import {
  AVEN_010_CORRECTIONS_VERSION,
  CORRECTION_ERROR_CODES,
  CORRECTIONS_CONFIG,
  CorrectionError,
} from '../src/index.ts';

/**
 * AVEN-010 patches 2-3: scaffold behavior plus static REGRESSION TRIPWIRES
 * over the corrections production source. The ROOT modules (`src/*.ts`) stay
 * pure; only the `./ledger` subpath (`src/ledger/*.ts`, patch 3) may use
 * storage and the Ledger, under its own rules below. The static rules are pattern checks that
 * make obvious regressions visible in review; they are NOT security
 * guarantees and can be bypassed by deliberately obfuscated code. Every rule
 * is also run against known-bad samples, so a weakened rule fails here. Later
 * AVEN-010 patches that legitimately need a new module, import, subpath or
 * term update these lists deliberately, in their own reviewed change. All
 * identifiers and texts below are SYNTHETIC.
 */
const srcDir = new URL('../src/', import.meta.url);
const entries = readdirSync(srcDir, { withFileTypes: true });
const files = entries.filter((e) => e.isFile()).map((e) => e.name);
/** Code only: block comments and whole-line `//` comments are removed. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const source: Record<string, string> = Object.fromEntries(
  files.map((f) => [f, code(readFileSync(new URL(f, srcDir), 'utf8'))]),
);
const all = Object.values(source).join('\n');

const ledgerDir = new URL('../src/ledger/', import.meta.url);
const ledgerEntries = readdirSync(ledgerDir, { withFileTypes: true });
const ledgerFile = (name: string) =>
  code(readFileSync(new URL(name, ledgerDir), 'utf8'));
/**
 * Patch 5 splits the subpath's static rules per module: the recorder
 * (`record.ts`) keeps its patch-3 rules unchanged, the read-only history
 * module (`history.ts`) has its own stricter rules, and `index.ts` may only
 * re-export them.
 */
const ledgerSource = ledgerFile('record.ts');
/** Patch 6: the Context Broker integration subpath, under its own rules. */
const contextDir = new URL('../src/context-source/', import.meta.url);
const contextEntries = readdirSync(contextDir, { withFileTypes: true });
const contextFile = (name: string) =>
  code(readFileSync(new URL(name, contextDir), 'utf8'));
const integrationSource = contextFile('integration.ts');
const contextIndexSource = contextFile('index.ts');
const historySource = ledgerFile('history.ts');
const ledgerIndexSource = ledgerFile('index.ts');

/**
 * Exact named imports permitted per external module for the ROOT modules.
 * Patch 4 adds the frozen schemas the pure resolver validates with and the
 * side-effect-free Proxy check of `node:util` (used by `inert.ts`). Any other
 * module, any other `node:*` module and any relative path leaving `src/`
 * fails.
 */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  'node:util': new Set(['types']),
  '@aven/contracts': new Set([
    'EvidenceRecordSchema',
    'ExperienceEventSchema',
    'OwnerIdSchema',
    'SessionIdSchema',
    'TaskIdSchema',
    'TimestampSchema',
  ]),
};
/** The one permitted `node:` import, removed before the capability rules run. */
const PERMITTED_NODE_IMPORT = `import { types } from 'node:util';`;

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

const RULES: Record<string, RegExp[]> = {
  'storage, Ledger, Context Broker, Owner Model, API or other Aven package access':
    [
      /@aven\/(storage|ledger|context-broker|owner-model|api|root|learning|eval|test-utils)\b/,
      /apps\/api|better-sqlite3|drizzle|\bsqlite\b|\.prepare\s*\(|openStorage|createLedger|appendEvent|replayEvents|listEvents|getEvent|createContextBroker|rebuildOwnerModel|\binsert\s+into\b|\bselect\s+.+\s+from\b/i,
      /\b(experience_events|corrections|learned_owner_state|active_task_state|learning_candidates|lifecycle_records|record_references|record_versions)\b\s*['"`]/,
    ],
  'model runtime, AVEN-007 baseline or provider': [
    /@aven\/(runtime|baseline)|ModelRuntime|invokeModel|NaiveHistorySearch|searchHistory|BASELINE_/,
    /openai|anthropic|gemini|ollama|strands|bedrock|vertex|mistral|cohere|huggingface|langchain|llamaindex|completion|embedding|vector|rerank/i,
  ],
  'network, file, process or environment capability': [
    /\bnode:|readFile|writeFile|appendFile|createReadStream|\bfs\./,
    /\bfetch\b|\bhttps?\.|WebSocket|XMLHttpRequest|\bnet\.|\btls\./,
    /['"`](node:)?(https?|http2|net|tls|dns|dgram|child_process|worker_threads|fs)(\/[\w/]*)?['"`]/,
    /child_process|\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(|worker_threads/,
    /process\.env|process\.binding|\bglobalThis\b/,
    /\beval\s*\(|new\s+Function\s*\(/,
  ],
  'hidden wall clock': [
    /Date\.now|new\s+Date\s*\(\s*\)|(?<![\w.])Date\s*\(\s*\)|performance\.now|hrtime/,
  ],
  randomness: [
    /Math\.random|\bcrypto\b|randomUUID|getRandomValues|randomBytes|randomInt/,
  ],
  timers: [
    /\bset(Timeout|Interval|Immediate)\b|\bclear(Timeout|Interval|Immediate)\b|queueMicrotask|\bscheduler\./,
  ],
  'correction recording or Ledger write (the ./ledger subpath only)': [
    /recordOwnerCorrection|record(Owner)?Correction|OwnerCorrectionSchema|CorrectionTargetSchema|EventInput|EvidenceInput|\breceipt\s*[:=]/,
  ],
  'persisted history or Context Broker integration (patches 5-6)': [
    /readCorrectionHistory|listCorrectionEvidence|current_instruction|ContextSource|ContextCandidate|ContextBundle|override/i,
    /negativeRetrieval|salience|confidence|candidateId|\brank|\bscore\b|exposure|\bexposed\b/i,
  ],
  'original behavior or durable scope hint in immediate resolution': [
    /originalBehavior|durableScopeHint/,
  ],
  'state mutation, learning or promotion': [
    /promot|demot|rollback|rolledBack|markTrusted|grantTrust|setLifecycle|assignLifecycle|upgrad|downgrad|markSuperseded|setSuperseded|revok/i,
    /status\s*:\s*['"`](observed|validated|trusted|superseded|revoked|candidate|promoted|active|closed)['"`]/,
    /inferPreference|detectCorrection|generateHypothes|candidateGenerat|LearningCandidate|\bhypothesis\b|\blearn(s|ed|ing)?\b/i,
  ],
  'authority, approval, Root or tools': [
    /\b(ALLOW|DENY|REQUIRE_OWNER_APPROVAL)\b/,
    /PolicyDecision|ActionProposal|Approval|AllowDecision|ToolExecution|executeTool|@aven\/root/,
    /\bpermissions?\b|authori[sz]|\bgrant(ed|s)?\b|\bapproved?\b/i,
  ],
  'hidden reasoning fields': [
    /reasoning|chainOfThought|chain_of_thought|\bthoughts?\b|rationale|scratchpad/i,
  ],
};
/**
 * Text the rules see: the permitted `node:util` import and the frozen
 * `'permission'` category literal (a recorded category, never authority) are
 * removed first; every other occurrence still counts.
 */
const ruleText: Record<string, (text: string) => string> = {
  'network, file, process or environment capability': (t) =>
    t.replaceAll(PERMITTED_NODE_IMPORT, ''),
  'authority, approval, Root or tools': (t) =>
    t.replaceAll(`=== 'permission'`, ''),
};
function violations(rule: string, text: string): string[] {
  const prepared = (ruleText[rule] ?? ((t: string) => t))(text);
  return RULES[rule]!.filter((p) => p.test(prepared)).map(String);
}

const KNOWN_BAD: Record<string, string[]> = {
  'storage, Ledger, Context Broker, Owner Model, API or other Aven package access':
    [
      `import { openStorage } from '@aven/storage';`,
      `import { createLedger } from '@aven/ledger';`,
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { rebuildOwnerModel } from '@aven/owner-model/persistence';`,
      `import { startApi } from '@aven/api';`,
      `import { handle } from '../../../apps/api/src/http.ts';`,
      `ledger.appendEvent(event, { evidence })`,
      `db.prepare('select * from x')`,
      `const table = 'corrections';`,
    ],
  'model runtime, AVEN-007 baseline or provider': [
    `import { invokeModelRuntime } from '@aven/runtime';`,
    `import { searchHistory } from '@aven/baseline';`,
    `const client = new OpenAI();`,
    `import Anthropic from '@anthropic-ai/sdk';`,
    `const v = embedding(text);`,
  ],
  'network, file, process or environment capability': [
    `await fetch('https://api.example.invalid')`,
    `const transport = 'node:https';`,
    `import { readFileSync } from 'node:fs';`,
    `import { types, inspect } from 'node:util';`,
    `const key = process.env.PROVIDER_KEY;`,
    `globalThis['fet' + 'ch']('x')`,
    `execFileSync('git', ['log'])`,
  ],
  'hidden wall clock': [
    `const recordedAt = new Date().toISOString();`,
    `const now = new Date ( );`,
    `const age = Date.now() - createdAt;`,
    `const t = performance.now();`,
  ],
  randomness: [
    `const id = crypto.randomUUID();`,
    `const jitter = Math.random();`,
    `import { randomBytes } from 'node:crypto';`,
  ],
  timers: [`setTimeout(expire, 1000)`, `queueMicrotask(f)`],
  'correction recording or Ledger write (the ./ledger subpath only)': [
    `export function recordOwnerCorrection(storage, submission) {}`,
    `import { OwnerCorrectionSchema } from '@aven/contracts';`,
    `const event: EventInput = build();`,
    `const receipt = { accepted: true };`,
  ],
  'persisted history or Context Broker integration (patches 5-6)': [
    `const history = readCorrectionHistory(storage, owner);`,
    `const source = { kind: 'current_instruction' };`,
    `candidate.signals.negativeRetrieval = 1;`,
    `const salience = 1;`,
    `const sessionOverride = {};`,
    `return { exposure: 'selected' };`,
  ],
  'original behavior or durable scope hint in immediate resolution': [
    `instruction: payload.originalBehavior,`,
    `if (payload.durableScopeHint.kind === 'global') widen();`,
  ],
  'state mutation, learning or promotion': [
    `export function promote(item) {}`,
    `const next = { ...item, lifecycle: { status: 'trusted' } };`,
    `markTrusted(item)`,
    `const p = inferPreference(history);`,
    `const learned = toPreference(correction);`,
    `markSuperseded(previous)`,
  ],
  'authority, approval, Root or tools': [
    `return { decision: 'ALLOW' };`,
    `import { PolicyDecisionSchema } from '@aven/contracts';`,
    `if (category === 'permission') permissions.add(x);`,
    `const allowed = category === 'permission' && grant(x);`,
    `authorize(correction.category);`,
    `const isAuthorized = true;`,
    `executeTool(proposal)`,
  ],
  'hidden reasoning fields': [
    `return { reasoning: steps };`,
    `view.chainOfThought = x;`,
  ],
};

describe('AVEN-010 corrections version and configuration', () => {
  it('pins the exact package version identifier', () => {
    expect(AVEN_010_CORRECTIONS_VERSION).toBe('aven-010-corrections-v1');
    expect(CORRECTIONS_CONFIG.version).toBe(AVEN_010_CORRECTIONS_VERSION);
  });

  it('pins a minimal configuration with identification constants only', () => {
    expect(CORRECTIONS_CONFIG).toEqual({
      version: 'aven-010-corrections-v1',
      frozenBaseline: {
        tag: 'aven-009',
        commit: '80057a217adb90132c5b6bc1c6a5c0f798db08c5',
      },
      contractSchemaVersion: 1,
    });
    expect(Object.keys(CORRECTIONS_CONFIG)).toEqual([
      'version',
      'frozenBaseline',
      'contractSchemaVersion',
    ]);
  });

  it('is deeply frozen at runtime', () => {
    expect(Object.isFrozen(CORRECTIONS_CONFIG)).toBe(true);
    expect(Object.isFrozen(CORRECTIONS_CONFIG.frozenBaseline)).toBe(true);
    const mutable = CORRECTIONS_CONFIG as unknown as Record<string, unknown>;
    expect(() => {
      mutable['version'] = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      (mutable['frozenBaseline'] as Record<string, unknown>)['commit'] = 'x';
    }).toThrow(TypeError);
    expect(() => {
      mutable['negativeRetrieval'] = 1;
    }).toThrow(TypeError);
    expect(CORRECTIONS_CONFIG.version).toBe('aven-010-corrections-v1');
    expect(CORRECTIONS_CONFIG.frozenBaseline.tag).toBe('aven-009');
  });
});

const EXPECTED_MESSAGES = {
  invalid_submission:
    'The correction submission is malformed; nothing was recorded',
  unknown_binding:
    'The correction session or task does not exist for this owner; nothing was recorded',
  unresolved_target:
    'The correction target does not resolve for this owner; nothing was recorded',
  identifier_collision:
    'A correction identifier is already in use for this owner; nothing was recorded',
  storage_failure:
    'Correction storage failed; no correction receipt was issued',
  invalid_correction_history:
    'The correction history or query is malformed or inconsistent; no correction view was built',
  internal_error:
    'The corrections package failed an internal consistency check; no correction receipt was issued',
} as const;

describe('AVEN-010 CorrectionError (fixed public error surface)', () => {
  it('has exactly the accepted, frozen code vocabulary', () => {
    expect(CORRECTION_ERROR_CODES).toEqual([
      'invalid_submission',
      'unknown_binding',
      'unresolved_target',
      'identifier_collision',
      'storage_failure',
      'invalid_correction_history',
      'internal_error',
    ]);
    expect(Object.isFrozen(CORRECTION_ERROR_CODES)).toBe(true);
  });

  it('has a fixed message per code and a deterministic serialized shape', () => {
    for (const code of CORRECTION_ERROR_CODES) {
      const error = new CorrectionError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CorrectionError);
      expect(error.name).toBe('CorrectionError');
      expect(error.code).toBe(code);
      expect(error.message).toBe(EXPECTED_MESSAGES[code]);
      const json = error.toJSON();
      expect(Object.getPrototypeOf(json)).toBeNull();
      expect(Object.isFrozen(json)).toBe(true);
      expect(Object.keys(json)).toEqual(['name', 'code', 'message']);
      expect(JSON.stringify(error)).toBe(
        `{"name":"CorrectionError","code":${JSON.stringify(code)},"message":${JSON.stringify(EXPECTED_MESSAGES[code])}}`,
      );
      expect(JSON.stringify(error)).toBe(
        JSON.stringify(new CorrectionError(code)),
      );
    }
  });

  it('keeps every message free of identifiers, correction text, SQL, validation detail and stacks', () => {
    const messages = CORRECTION_ERROR_CODES.map(
      (c) => new CorrectionError(c).message,
    );
    expect(new Set(messages).size).toBe(CORRECTION_ERROR_CODES.length);
    for (const message of messages) {
      expect(message).not.toMatch(
        /\b(owner|session|task|event|evidence|learned|candidate)_[A-Za-z0-9]/,
      );
      expect(message).not.toMatch(
        /SQLITE|constraint|FOREIGN KEY|select |insert |ZodError|issues|expected|received|\bat\s+\S+\s+\(|stack|cause/i,
      );
      expect(message).not.toMatch(/["'`{}[\]<>\d]/);
      expect(message).not.toMatch(
        /\b(allow|deny|approve|permission|grant|trust)/i,
      );
    }
  });

  it('never carries a cause, caller text, identifiers or a stack in its serialized form', () => {
    const secrets = [
      'owner_synthetic_secret',
      'session_synthetic_secret',
      'task_synthetic_secret',
      'event_synthetic_secret',
      'evidence_synthetic_secret',
      'Synthetic correction text: always reply tersely',
      'SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed',
      '[{"code":"invalid_type","path":["target"]}]',
    ];
    const Untyped = CorrectionError as unknown as new (
      ...args: unknown[]
    ) => CorrectionError;
    for (const secret of secrets) {
      const withCause = new Untyped('unresolved_target', {
        cause: new Error(secret),
      });
      expect('cause' in withCause).toBe(false);
      expect(withCause.cause).toBeUndefined();
      const withText = new Untyped('invalid_submission', secret);
      const asCode = new Untyped(secret);
      for (const error of [withCause, withText, asCode]) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain('stack');
        expect(JSON.stringify(error.toJSON())).toBe(JSON.stringify(error));
      }
      expect(asCode.code).toBe('internal_error');
    }
  });

  it('maps unsupported, inherited or coerced codes to internal_error without echoing them', () => {
    const Untyped = CorrectionError as unknown as new (
      code: unknown,
    ) => CorrectionError;
    for (const bad of [
      'synthetic_unknown_code',
      'INVALID_SUBMISSION',
      ' invalid_submission',
      'invalid_input',
      'not_exposed',
      '__proto__',
      'toString',
      'constructor',
      'hasOwnProperty',
      undefined,
      null,
      42,
      ['invalid_submission'],
      { code: 'invalid_submission' },
      { toString: () => 'invalid_submission' },
      Object('invalid_submission'),
    ]) {
      const error = new Untyped(bad);
      expect(error.code).toBe('internal_error');
      expect(error.message).toBe(EXPECTED_MESSAGES.internal_error);
      expect(JSON.stringify(error)).not.toContain('synthetic_unknown_code');
    }
  });

  it('is frozen, so code and message cannot be rewritten after construction', () => {
    const error = new CorrectionError('unknown_binding');
    expect(Object.isFrozen(error)).toBe(true);
    const mutable = error as unknown as Record<string, unknown>;
    expect(() => {
      mutable['code'] = 'internal_error';
    }).toThrow(TypeError);
    expect(() => {
      mutable['message'] = 'synthetic replacement';
    }).toThrow(TypeError);
    expect(() => {
      mutable['cause'] = new Error('late');
    }).toThrow(TypeError);
    expect(error.code).toBe('unknown_binding');
  });

  it('cannot be redirected by Object.prototype pollution during serialization', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['toJSON'] = () => 'synthetic polluted';
    proto['extra'] = 'synthetic polluted';
    try {
      const text = JSON.stringify(new CorrectionError('storage_failure'));
      expect(text).toBe(
        `{"name":"CorrectionError","code":"storage_failure","message":${JSON.stringify(EXPECTED_MESSAGES.storage_failure)}}`,
      );
    } finally {
      delete proto['toJSON'];
      delete proto['extra'];
    }
  });
});

describe('AVEN-010 corrections public surface (scaffold only)', () => {
  it('exports exactly identity, the error surface and the pure resolver, and nothing that records or decides', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'AVEN_010_CORRECTIONS_VERSION',
        'CORRECTIONS_CONFIG',
        'CORRECTION_ERROR_CODES',
        'CorrectionError',
        'IMMEDIATE_RESOLUTION_VERSION',
        'resolveImmediateCorrections',
      ].sort(),
    );
    const functions = Object.entries(publicApi).filter(
      ([, value]) => typeof value === 'function',
    );
    // The only callables are the error class and the pure resolver: nothing
    // records a correction, mutates state, learns, promotes, decides
    // authority or executes a tool.
    expect(functions.map(([name]) => name).sort()).toEqual([
      'CorrectionError',
      'resolveImmediateCorrections',
    ]);
    for (const [name, value] of Object.entries(publicApi))
      if (typeof value === 'object')
        expect(Object.isFrozen(value), name).toBe(true);
  });

  it('touches no clock, randomness, timer or network when imported or used', async () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis.crypto, 'randomUUID'),
    ];
    vi.resetModules();
    const fresh = await import('../src/index.ts');
    for (const code of fresh.CORRECTION_ERROR_CODES)
      JSON.stringify(new fresh.CorrectionError(code));
    const view = fresh.resolveImmediateCorrections(
      { ownerId: 'owner_synthetic', entries: [] },
      {
        ownerId: 'owner_synthetic',
        sessionId: 'session_synthetic',
        taskId: 'task_synthetic',
      },
      { referenceTime: '2026-10-10T00:00:00Z', throughSequence: null },
    );
    expect(view.active).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('AVEN-010 corrections static regression tripwires (not runtime security)', () => {
  it('keeps production modules in a known, reviewed set (root plus the ledger subpath only)', () => {
    expect(files.sort()).toEqual([
      'config.ts',
      'errors.ts',
      'index.ts',
      'inert.ts',
      'resolve.ts',
    ]);
    expect(
      entries
        .filter((e) => !e.isFile())
        .map((e) => e.name)
        .sort(),
    ).toEqual(['context-source', 'ledger']);
    expect(
      contextEntries
        .map((e) => `${e.isFile() ? 'file' : 'dir'}:${e.name}`)
        .sort(),
    ).toEqual(['file:index.ts', 'file:integration.ts']);
    expect(
      ledgerEntries
        .map((e) => `${e.isFile() ? 'file' : 'dir'}:${e.name}`)
        .sort(),
    ).toEqual(['file:history.ts', 'file:index.ts', 'file:record.ts']);
  });

  it('imports only zod, allowlisted frozen contract names and its own modules', () => {
    expect(importViolations(all)).toEqual([]);
    for (const bad of [
      `import { openStorage } from '@aven/storage';`,
      `import { createLedger } from '@aven/ledger';`,
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { rebuildOwnerModel } from '@aven/owner-model/persistence';`,
      `import { invokeModelRuntime } from '@aven/runtime';`,
      `import { runBaseline } from '@aven/baseline';`,
      `import { startApi } from '@aven/api';`,
      `import { handle } from '../../../apps/api/src/http.ts';`,
      `import { x } from './ledger/record.ts';`,
      `import { readFileSync } from 'node:fs';`,
      `import { execFileSync } from 'node:child_process';`,
      `import { OwnerCorrectionSchema } from '@aven/contracts';`,
      `import { OwnerCorrectionSchema as S } from '@aven/contracts';`,
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

  it('checks code, not comments: a comment cannot hide or fake a violation', () => {
    expect(
      code(`/* createLedger */ const a = 1;\n// appendEvent\n`),
    ).not.toMatch(/createLedger|appendEvent/);
    expect(code(`const a = createLedger; /* note */`)).toMatch(/createLedger/);
  });
});

describe('AVEN-010 corrections manifest, workspace resolution and root wiring', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    name: string;
    private: boolean;
    type: string;
    exports: Record<string, string>;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    [key: string]: unknown;
  };

  it('declares the root entry and the ledger subpath only, with storage and Ledger for that subpath', () => {
    expect(manifest.name).toBe('@aven/corrections');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './ledger': './src/ledger/index.ts',
      './context-source': './src/context-source/index.ts',
    });
    expect(manifest.dependencies).toEqual({
      '@aven/context-broker': 'workspace:*',
      '@aven/contracts': 'workspace:*',
      '@aven/ledger': 'workspace:*',
      '@aven/storage': 'workspace:*',
      zod: '4.6.5',
    });
    expect(manifest.devDependencies).toEqual({
      typescript: '5.9.3',
      vitest: '4.0.18',
    });
    for (const field of [
      'peerDependencies',
      'optionalDependencies',
      'bundledDependencies',
    ])
      expect(manifest, field).not.toHaveProperty([field]);
    expect(manifest.scripts).toEqual({
      typecheck: 'tsc --project tsconfig.json --noEmit',
      test: 'vitest run --configLoader native --root ../.. --config vitest.config.ts packages/corrections/test',
    });
  });

  it('resolves contracts, Ledger, storage and zod through its own workspace links, and links nothing else', () => {
    // Checks the package-local links pnpm installed for this manifest. A
    // runtime require.resolve is not used: pnpm's bin shims put the hoisted
    // node_modules/.pnpm/node_modules (holding every workspace package) on
    // NODE_PATH, so it would depend on how the test runner was launched.
    const local = new URL('../node_modules/', import.meta.url);
    const linked = (name: string) => realpathSync(new URL(name, local));
    expect(readdirSync(new URL('@aven/', local)).sort()).toEqual([
      'context-broker',
      'contracts',
      'ledger',
      'storage',
    ]);
    for (const name of ['context-broker', 'contracts', 'ledger', 'storage'])
      expect(linked(`@aven/${name}`)).toBe(
        realpathSync(new URL(`../../${name}/`, import.meta.url)),
      );
    expect(
      readdirSync(local)
        .filter((n) => !n.startsWith('.'))
        .sort(),
    ).toEqual(['@aven', 'typescript', 'vitest', 'zod']);
    expect(linked('zod')).toMatch(/[\\/]zod@4\.6\.5[\\/]node_modules[\\/]zod$/);
    const require = createRequire(new URL('../package.json', import.meta.url));
    expect(realpathSync(require.resolve('@aven/contracts'))).toBe(
      realpathSync(
        fileURLToPath(new URL('../../contracts/src/index.ts', import.meta.url)),
      ),
    );
  });

  it('is typechecked by the root scripts while check keeps its MAINT-001 composition', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const s = root.scripts;
    const own = 'tsc --project packages/corrections/tsconfig.json --noEmit';
    expect(s['typecheck']!.split(' && ').filter((c) => c === own)).toHaveLength(
      1,
    );
    expect(s['check']).toBe(
      [
        s['format:check'],
        s['typecheck'],
        s['experiment:check'],
        s['test'],
      ].join(' && '),
    );
    expect(s['check']).not.toContain('attribution');
    expect(s['attribution:check']).toBe(
      'node tooling/attribution/check-attribution.ts',
    );
    const tsconfig = JSON.parse(
      readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(tsconfig).toEqual({
      extends: '../../tsconfig.base.json',
      compilerOptions: { types: ['node'] },
      include: ['src/**/*.ts', 'test/**/*.ts'],
    });
  });
});

/**
 * The `./ledger` recorder (patch 3): exact named imports per module. It is
 * the only place allowed to write through the Ledger, and to use the default
 * clock (`new Date()`) and the default identifier source (`randomUUID`).
 */
const LEDGER_IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  'node:crypto': new Set(['randomUUID']),
  'node:util': new Set(['types']),
  '@aven/contracts': new Set([
    'CorrectionTargetSchema',
    'EventIdSchema',
    'EvidenceIdSchema',
    'EvidenceRecordSchema',
    'ExperienceEventSchema',
    'OwnerCorrectionSchema',
    'OwnerIdSchema',
    'ScopeSchema',
    'SessionIdSchema',
    'TaskIdSchema',
  ]),
  '@aven/ledger': new Set([
    'createLedger',
    'LedgerError',
    'EventInput',
    'EvidenceInput',
  ]),
  '@aven/storage': new Set(['Storage']),
  '../config.ts': new Set(['AVEN_010_CORRECTIONS_VERSION']),
  '../errors.ts': new Set(['CorrectionError', 'CorrectionErrorCode']),
  '../inert.ts': new Set(['inertCopy']),
};
/** The read-only history module (patch 5): a strictly smaller surface. */
const HISTORY_IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  '@aven/contracts': new Set(['OwnerIdSchema']),
  '@aven/ledger': new Set(['createLedger', 'LedgerError']),
  '@aven/storage': new Set(['Storage']),
  '../errors.ts': new Set(['CorrectionError', 'CorrectionErrorCode']),
  '../resolve.ts': new Set([
    'validateCorrectionHistory',
    'CorrectionHistory',
    'CorrectionHistoryEntry',
  ]),
};
/** The subpath entry only re-exports its two modules. */
const LEDGER_INDEX_IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  './record.ts': new Set([
    'recordOwnerCorrection',
    'CorrectionIdPrefix',
    'CorrectionReceipt',
    'CorrectionRecordingOptions',
    'CorrectionSubmission',
  ]),
  './history.ts': new Set([
    'buildCorrectionEvidenceIndex',
    'readCorrectionHistory',
    'CorrectionEvidenceIndex',
    'IndexedCorrection',
    'IndexedEvidence',
    'PersistedCorrectionHistory',
  ]),
};

function ledgerImportViolations(
  text: string,
  allowlist: Record<string, ReadonlySet<string>> = LEDGER_IMPORT_ALLOWLIST,
): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const module = m[3] ?? '';
    const allowed = allowlist[module];
    const clause = m[1] ?? '';
    if (!allowed || !clause.startsWith('{')) {
      found.push(module);
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

const count = (text: string, pattern: RegExp) =>
  [
    ...text.matchAll(
      new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
      ),
    ),
  ].length;

const LEDGER_RULES: Record<string, (text: string) => boolean> = {
  'other Aven packages, the API, runtimes or providers': (t) =>
    /@aven\/(context-broker|owner-model|api|root|learning|eval|test-utils|runtime|baseline)\b|apps\/api|ModelRuntime|invokeModel|openai|anthropic|gemini|ollama|bedrock|langchain|\bprompt/i.test(
      t,
    ),
  'network, files, processes, environment or timers': (t) =>
    /\bfetch\b|\bhttps?\.|WebSocket|\bnet\.|\btls\.|readFile|writeFile|\bfs\.|child_process|\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(|worker_threads|process\.env|\bglobalThis\b|\beval\s*\(|new\s+Function\s*\(|\bset(Timeout|Interval|Immediate)\b|queueMicrotask/.test(
      t,
    ),
  'SQL writes, transactions or schema changes': (t) =>
    /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA|ATTACH|VACUUM)\b|\.(exec|run|transaction|pragma|iterate)\s*\(|\bmigrate\s*\(|openStorage|serializeContract|\.db\b/.test(
      t,
    ),
  'a SQL statement that is not an owner-scoped SELECT': (t) =>
    [
      ...t.matchAll(/(['"`])((?:(?!\1)[\s\S])*\bFROM\b(?:(?!\1)[\s\S])*)\1/g),
    ].some((m) => !/^SELECT .+ FROM \w+ WHERE owner_id = \?/.test(m[2] ?? '')),
  'more than one Ledger append or Ledger instance': (t) =>
    count(t, /\bappendEvent\s*\(/) !== 1 ||
    count(t, /\bcreateLedger\s*\(/) !== 1,
  'an event type or provenance other than an owner correction': (t) =>
    /'(owner_request|assistant_response|owner_approval|policy_decision|action_proposed|tool_execution|verification|learning_[a-z_]+|explicit_owner_statement|model_inference|system_generated|external_content|tool_result)'/.test(
      t,
    ) ||
    [...t.matchAll(/eventType:\s*'([a-z_]+)'/g)].some(
      (m) => m[1] !== 'owner_correction',
    ) ||
    [...t.matchAll(/kind:\s*'(explicit_[a-z_]+)'/g)].some(
      (m) => m[1] !== 'explicit_owner_correction',
    ),
  'owner-state writes, learning, promotion or correction interpretation': (t) =>
    /learned_owner_state|active_task_state|lifecycle_records|learning_candidates|promot|supersed|revok|markTrusted|setLifecycle|negativeRetrieval|salience|suppress|current_instruction|ContextSource|ContextCandidate|resolveImmediate|override|\brank|\bscore\b|inferPreference|detectCorrection|hypothes/i.test(
      t,
    ),
  'authority, approval, Root or tools': (t) =>
    /\b(ALLOW|DENY|REQUIRE_OWNER_APPROVAL)\b|PolicyDecision|ActionProposal|OwnerApproval|ToolExecution|executeTool|@aven\/root|authori[sz]|\bgrant(ed|s)?\b|approv/i.test(
      t,
    ),
  'a clock or randomness beyond the injectable defaults': (t) =>
    count(t, /new\s+Date\s*\(\s*\)/) !== 1 ||
    count(t, /\brandomUUID\s*\(/) !== 1 ||
    /Date\.now|performance\.now|hrtime|Math\.random|getRandomValues|randomBytes|randomInt|(?<![\w.])(?<!new\s+)Date\s*\(\s*\)/.test(
      t,
    ),
  'hidden reasoning fields': (t) =>
    /reasoning|chainOfThought|chain_of_thought|\bthoughts?\b|rationale|scratchpad/i.test(
      t,
    ),
};

const BASE = ledgerSource;
const LEDGER_KNOWN_BAD: Record<string, string[]> = {
  'other Aven packages, the API, runtimes or providers': [
    `${BASE}\nimport { createContextBroker } from '@aven/context-broker';`,
    `${BASE}\nimport { rebuildOwnerModel } from '@aven/owner-model/persistence';`,
    `${BASE}\nimport { handle } from '../../../../apps/api/src/http.ts';`,
    `${BASE}\nconst out = await runtime.invokeModel(prompt);`,
  ],
  'network, files, processes, environment or timers': [
    `${BASE}\nawait fetch('https://example.invalid');`,
    `${BASE}\nconst key = process.env.KEY;`,
    `${BASE}\nsetTimeout(expire, 1000);`,
    `${BASE}\nexecFileSync('sqlite3', []);`,
  ],
  'SQL writes, transactions or schema changes': [
    `${BASE}\nstorage.sqlite.prepare('INSERT INTO corrections(record_json) VALUES (?)').run(json);`,
    `${BASE}\nstorage.sqlite.exec('BEGIN IMMEDIATE');`,
    `${BASE}\nstorage.sqlite.transaction(() => append())();`,
    `${BASE}\nmigrate(storage.sqlite);`,
  ],
  'a SQL statement that is not an owner-scoped SELECT': [
    `${BASE}\nconst q = 'SELECT 1 FROM experience_events WHERE record_id = ?';`,
    `${BASE}\nconst q = 'SELECT owner_id FROM evidence WHERE record_id = ? AND owner_id = ?';`,
    `${BASE}\nconst q = "SELECT * FROM tasks";`,
  ],
  'more than one Ledger append or Ledger instance': [
    `${BASE}\nledger.appendEvent(second, {});`,
    `${BASE}\nconst other = createLedger(storage, otherOwner);`,
    BASE.replace(/appendEvent\s*\(/, 'append('),
  ],
  'an event type or provenance other than an owner correction': [
    `${BASE}\nconst e = { eventType: 'owner_request' };`,
    `${BASE}\nconst p = { kind: 'explicit_owner_statement' };`,
    `${BASE}\nconst p = { kind: 'owner_approval' };`,
    `${BASE}\nconst p = { kind: 'model_inference' };`,
  ],
  'owner-state writes, learning, promotion or correction interpretation': [
    `${BASE}\nconst table = 'learned_owner_state';`,
    `${BASE}\ncandidate.signals.negativeRetrieval = 1;`,
    `${BASE}\nexport function resolveImmediateCorrections() {}`,
    `${BASE}\npromote(candidate);`,
  ],
  'authority, approval, Root or tools': [
    `${BASE}\nif (category === 'permission') return { decision: 'ALLOW' };`,
    `${BASE}\nconst approval = toOwnerApproval(submission);`,
    `${BASE}\nexecuteTool(proposal);`,
    `${BASE}\nconst authorized = true;`,
  ],
  'a clock or randomness beyond the injectable defaults': [
    `${BASE}\nconst recordedAt = new Date().toISOString();`,
    `${BASE}\nconst t = Date.now();`,
    `${BASE}\nconst id = randomUUID();`,
    `${BASE}\nconst j = Math.random();`,
    `${BASE}\nconst s = Date();`,
  ],
  'hidden reasoning fields': [`${BASE}\nreturn { reasoning: steps };`],
};

describe('AVEN-010 corrections ledger subpath boundaries (patch 3; not runtime security)', () => {
  it('exports exactly the recorder and the read-only history and index from the subpath, and nothing more', () => {
    expect(Object.keys(ledgerApi).sort()).toEqual([
      'buildCorrectionEvidenceIndex',
      'readCorrectionHistory',
      'recordOwnerCorrection',
    ]);
    for (const value of Object.values(ledgerApi))
      expect(typeof value).toBe('function');
    expect(Object.keys(publicApi)).not.toContain('readCorrectionHistory');
    expect(Object.keys(publicApi)).not.toContain(
      'buildCorrectionEvidenceIndex',
    );
  });

  it('keeps the recorder out of the root entry', () => {
    expect(Object.keys(publicApi)).not.toContain('recordOwnerCorrection');
    expect(all).not.toMatch(/ledger\//);
  });

  it('imports only allowlisted names, and the subpath only from itself or the root modules', () => {
    expect(ledgerImportViolations(ledgerSource)).toEqual([]);
    expect(
      ledgerImportViolations(historySource, HISTORY_IMPORT_ALLOWLIST),
    ).toEqual([]);
    expect(
      ledgerImportViolations(ledgerIndexSource, LEDGER_INDEX_IMPORT_ALLOWLIST),
    ).toEqual([]);
    // The entry is re-exports only, and the recorder imports nothing from
    // the history module (or the reverse).
    expect(
      ledgerIndexSource
        .replace(/export\s*\{[^}]*\}\s*from\s*'\.\/(record|history)\.ts';/g, '')
        .trim(),
    ).toBe('');
    expect(ledgerSource).not.toMatch(/history\.ts/);
    expect(historySource).not.toMatch(/record\.ts/);
    for (const bad of [
      `import { recordOwnerCorrection } from './record.ts';`,
      `import { randomUUID } from 'node:crypto';`,
      `import { serializeContract } from '@aven/storage';`,
      `import { EventInput } from '@aven/ledger';`,
      `import { resolveImmediateCorrections } from '../resolve.ts';`,
      `import { inertCopy } from '../inert.ts';`,
      `import { createContextBroker } from '@aven/context-broker';`,
    ])
      expect(
        ledgerImportViolations(bad, HISTORY_IMPORT_ALLOWLIST),
        bad,
      ).not.toEqual([]);
    for (const bad of [
      `import { openStorage } from '@aven/storage';`,
      `import { migrate } from '@aven/storage';`,
      `import { serializeContract } from '@aven/storage';`,
      `import * as ledger from '@aven/ledger';`,
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { OwnerApprovalSchema } from '@aven/contracts';`,
      `import { PolicyDecisionSchema } from '@aven/contracts';`,
      `import { randomBytes } from 'node:crypto';`,
      `import { readFileSync } from 'node:fs';`,
      `import { request } from 'node:https';`,
      `import { x } from '../../../ledger/src/records.ts';`,
      `const m = await import('node:child_process');`,
    ])
      expect(ledgerImportViolations(bad), bad).not.toEqual([]);
  });

  for (const [rule, violates] of Object.entries(LEDGER_RULES))
    it(`has no ${rule}`, () => {
      expect(violates(ledgerSource), rule).toBe(false);
      for (const bad of LEDGER_KNOWN_BAD[rule]!)
        expect(violates(bad), bad.slice(BASE.length)).toBe(true);
    });

  it('pins the owner-scoped precheck statements exactly', () => {
    const statements = [
      ...ledgerSource.matchAll(
        /(['"`])((?:(?!\1)[\s\S])*\bFROM\b(?:(?!\1)[\s\S])*)\1/g,
      ),
    ].map((m) => m[2]);
    expect(statements).toEqual([
      'SELECT 1 AS found FROM owners WHERE owner_id = ?',
      'SELECT session_id FROM tasks WHERE owner_id = ? AND task_id = ?',
      'SELECT 1 AS found FROM experience_events WHERE owner_id = ? AND record_id = ?',
      'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ?',
      'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ? AND event_id = ?',
      "SELECT 1 AS found FROM record_versions WHERE owner_id = ? AND record_kind = 'owner_state' AND record_id = ? AND record_version = ?",
    ]);
  });
});

/**
 * The read-only history module (patch 5), under its OWN rules: one Ledger
 * instance and one owner-correction replay, and nothing that writes, opens a
 * transaction, issues SQL, reads a clock or randomness, records or builds
 * correction events, filters by task or session, interprets corrections or
 * touches authority. The recorder's rules above still apply to `record.ts`
 * alone, unchanged.
 */
const HISTORY_RULES: Record<string, (text: string) => boolean> = {
  'any Ledger write, or anything but one owner-correction replay': (t) =>
    /\bappendEvent\b|\blistEvents\b|\bgetEvent\b|\binspectIntegrity\b/.test(
      t,
    ) ||
    count(t, /\bcreateLedger\s*\(/) !== 1 ||
    count(t, /\breplayEvents\s*\(/) !== 1 ||
    [...t.matchAll(/eventType:\s*'([a-z_]+)'/g)].map((m) => m[1]).join(',') !==
      'owner_correction',
  'task, session or sequence pre-filtering of the replay': (t) =>
    /\bsessionId\b|\btaskId\b|immediateApplicability|afterSequence|throughSequence|\blimit\s*:/.test(
      t,
    ),
  'SQL, transactions, migrations or direct storage access': (t) =>
    /\.sqlite\b|\.prepare\s*\(|\.(exec|run|transaction|pragma|iterate)\s*\(|\bmigrate\s*\(|openStorage|serializeContract|deserializeContract|\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA|ATTACH|VACUUM)\b/.test(
      t,
    ),
  'a clock, randomness or identifier source': (t) =>
    /new\s+Date\b|Date\.now|(?<![\w.])Date\s*\(|performance\.now|hrtime|randomUUID|\bcrypto\b|Math\.random|getRandomValues|randomBytes|randomInt/.test(
      t,
    ),
  'correction recording or event construction': (t) =>
    /recordOwnerCorrection|EventInput|EvidenceInput|OwnerCorrectionSchema|CorrectionTargetSchema|\breceipt\b|explicit_owner_correction/i.test(
      t,
    ),
  'other Aven packages, the API, runtimes, Broker, Root or providers': (t) =>
    LEDGER_RULES['other Aven packages, the API, runtimes or providers']!(t),
  'network, files, processes, environment or timers': (t) =>
    LEDGER_RULES['network, files, processes, environment or timers']!(t),
  'owner-state writes, learning, promotion or correction interpretation': (t) =>
    LEDGER_RULES[
      'owner-state writes, learning, promotion or correction interpretation'
    ]!(t),
  'authority, approval, Root or tools': (t) =>
    LEDGER_RULES['authority, approval, Root or tools']!(t) ||
    /\bpermission\b/i.test(t),
  'hidden reasoning fields': (t) => LEDGER_RULES['hidden reasoning fields']!(t),
};

const HISTORY_BASE = historySource;
const HISTORY_KNOWN_BAD: Record<string, string[]> = {
  'any Ledger write, or anything but one owner-correction replay': [
    `${HISTORY_BASE}\nledger.appendEvent(event, { evidence });`,
    `${HISTORY_BASE}\nconst page = ledger.listEvents({ eventType: 'owner_correction' });`,
    `${HISTORY_BASE}\nconst second = createLedger(storage, otherOwner);`,
    `${HISTORY_BASE}\nfor (const e of ledger.replayEvents()) use(e);`,
    `${HISTORY_BASE}\nconst f = { eventType: 'owner_request' };`,
    HISTORY_BASE.replace(/replayEvents\s*\(/, 'replay('),
  ],
  'task, session or sequence pre-filtering of the replay': [
    `${HISTORY_BASE}\nledger.replay({ eventType: 'owner_correction', taskId });`,
    `${HISTORY_BASE}\nconst f = { sessionId: binding.sessionId };`,
    `${HISTORY_BASE}\nconst f = { throughSequence: 1000 };`,
    `${HISTORY_BASE}\nconst f = { limit: 1000 };`,
  ],
  'SQL, transactions, migrations or direct storage access': [
    `${HISTORY_BASE}\nstorage.sqlite.prepare('SELECT record_json FROM corrections WHERE owner_id = ?').all(owner);`,
    `${HISTORY_BASE}\nconst q = 'INSERT INTO corrections(record_json) VALUES (?)';`,
    `${HISTORY_BASE}\ndb.transaction(() => read())();`,
    `${HISTORY_BASE}\nmigrate(storage.sqlite);`,
    `${HISTORY_BASE}\nconst e = deserializeContract('experience_events', json);`,
  ],
  'a clock, randomness or identifier source': [
    `${HISTORY_BASE}\nconst at = new Date();`,
    `${HISTORY_BASE}\nconst t = Date.now();`,
    `${HISTORY_BASE}\nconst id = randomUUID();`,
    `${HISTORY_BASE}\nconst j = Math.random();`,
  ],
  'correction recording or event construction': [
    `${HISTORY_BASE}\nrecordOwnerCorrection(storage, submission);`,
    `${HISTORY_BASE}\nconst e: EventInput = build();`,
    `${HISTORY_BASE}\nconst p = { kind: 'explicit_owner_correction' };`,
  ],
  'other Aven packages, the API, runtimes, Broker, Root or providers': [
    `${HISTORY_BASE}\nimport { createContextBroker } from '@aven/context-broker';`,
    `${HISTORY_BASE}\nimport { decide } from '@aven/root';`,
    `${HISTORY_BASE}\nconst out = await runtime.invokeModel(prompt);`,
  ],
  'network, files, processes, environment or timers': [
    `${HISTORY_BASE}\nawait fetch('https://example.invalid');`,
    `${HISTORY_BASE}\nconst k = process.env.KEY;`,
    `${HISTORY_BASE}\nsetTimeout(refresh, 1000);`,
  ],
  'owner-state writes, learning, promotion or correction interpretation': [
    `${HISTORY_BASE}\nconst table = 'learned_owner_state';`,
    `${HISTORY_BASE}\nconst view = resolveImmediateCorrections(h, q, o);`,
    `${HISTORY_BASE}\nif (sameTarget) supersede(earlier);`,
    `${HISTORY_BASE}\nconst p = inferPreference(history);`,
  ],
  'authority, approval, Root or tools': [
    `${HISTORY_BASE}\nif (category === 'permission') allow();`,
    `${HISTORY_BASE}\nreturn { decision: 'ALLOW' };`,
    `${HISTORY_BASE}\nconst authorized = true;`,
  ],
  'hidden reasoning fields': [`${HISTORY_BASE}\nreturn { rationale: why };`],
};

describe('AVEN-010 corrections read-only history module boundaries (patch 5; not runtime security)', () => {
  for (const [rule, violates] of Object.entries(HISTORY_RULES))
    it(`has no ${rule}`, () => {
      expect(violates(historySource), rule).toBe(false);
      for (const bad of HISTORY_KNOWN_BAD[rule]!)
        expect(violates(bad), bad.slice(HISTORY_BASE.length)).toBe(true);
    });

  it('keeps the recorder the only Ledger writer, with its own clock and identifier source', () => {
    expect(count(ledgerSource, /\bappendEvent\s*\(/)).toBe(1);
    expect(count(historySource, /\bappendEvent\b/)).toBe(0);
    expect(count(ledgerSource, /new\s+Date\s*\(\s*\)/)).toBe(1);
    expect(count(ledgerSource, /\brandomUUID\s*\(/)).toBe(1);
    expect(historySource).not.toMatch(/new\s+Date|randomUUID/);
  });
});

/**
 * The Context Broker integration (patch 6), under its OWN rules: it may use
 * the frozen Broker's public API, the pure resolver and a SHA-256 digest for
 * candidate identities, and nothing that reads or writes storage, appends to
 * the Ledger, reads owner state, learns, calls a model or network, uses a
 * clock or randomness, touches Broker internals or limits, renders the
 * original behavior, judges exposure from the trace ranking, or decides
 * authority. The recorder's and history module's rules are unchanged.
 */
const CONTEXT_IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  'node:crypto': new Set(['createHash']),
  '@aven/contracts': new Set(['OwnerIdSchema']),
  '@aven/context-broker': new Set([
    // Patch 6 remediation (F3, F4): the Broker's PUBLIC error vocabulary and
    // its public raw and owner-quota limits, mirrored in the wrapper's
    // preprocessing order. Weights, budgets and internals stay forbidden.
    'CONTEXT_BROKER_ERROR_CODES',
    'MAX_CANDIDATES_PER_SOURCE',
    'MAX_RAW_ITEMS_PER_SOURCE',
    'MAX_RAW_ITEMS_TOTAL',
    // Patch 6 follow-up (N1): the public source-count limit.
    'MAX_SOURCES',
    'MAX_TOTAL_CANDIDATES',
    'ContextBrokerError',
    'ContextCandidateSchema',
    'ContextRequestSchema',
    'createContextBroker',
    'ContextBrokerErrorCode',
    'ContextBrokerTrace',
    'ContextBundle',
    'ContextBundleItem',
    'ContextCandidate',
    'ContextRequest',
    'ContextSource',
    'ContextSourceCollectOptions',
    'ContextSourceQuery',
    'ExclusionReason',
  ]),
  '../errors.ts': new Set(['CorrectionError']),
  '../resolve.ts': new Set([
    'resolveImmediateCorrections',
    'ActiveCorrection',
    'ImmediateCorrectionView',
  ]),
};
const CONTEXT_INDEX_IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  './integration.ts': new Set([
    'assembleWithCorrections',
    'CORRECTION_INSTRUCTION_SOURCE_ID',
    'CorrectionAssemblyInput',
    'CorrectionAssemblyOutcome',
    'InstructionIdentity',
    'MissingInstruction',
    'NotExposedReason',
  ]),
};

const CONTEXT_RULES: Record<string, (text: string) => boolean> = {
  'storage, Ledger, SQL or persisted-history access': (t) =>
    /@aven\/(storage|ledger)\b|\.prepare\s*\(|\bsqlite\b|appendEvent|createLedger|replayEvents|listEvents|readCorrectionHistory|recordOwnerCorrection|\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|BEGIN|COMMIT)\b|\bmigrate\s*\(|openStorage/.test(
      t,
    ),
  'other Aven packages, runtimes, Root or providers': (t) =>
    /@aven\/(owner-model|api|root|learning|eval|test-utils|runtime|baseline)\b|apps\/api|context-broker\/src|ModelRuntime|invokeModel|openai|anthropic|gemini|ollama|bedrock|langchain|\bprompt/i.test(
      t,
    ),
  'network, files, processes, environment or timers': (t) =>
    /\bfetch\b|\bhttps?\.|WebSocket|\bnet\.|\btls\.|readFile|writeFile|\bfs\.|child_process|\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(|worker_threads|process\.env|\bglobalThis\b|\beval\s*\(|new\s+Function\s*\(|\bset(Timeout|Interval|Immediate)\b|queueMicrotask/.test(
      t,
    ),
  'a clock or randomness': (t) =>
    /Date\.now|new\s+Date\b|(?<![\w.])Date\s*\(|performance\.now|hrtime|randomUUID|Math\.random|getRandomValues|randomBytes|randomInt/.test(
      t,
    ),
  'Broker internals, limits or ranking configuration': (t) =>
    /RANKING_WEIGHTS|SCOPE_FACTORS|PROVENANCE_FACTORS|TRUST_FACTORS|FRESHNESS_|MAX_SELECTED|MAX_SINGLE_CONTEXT|MAX_CANDIDATE_TEXT|MAX_LABEL|MAX_METADATA|MAX_LOCAL_ID|MAX_REQUEST|SOURCE_COLLECTION_DEADLINE|NEGATIVE_SIGNAL|\bINTERNAL\b|CONTEXT_BROKER_CONFIG/.test(
      t,
    ),
  // Only two expressions are allowed: `MAX_SOURCES - 1` (one slot reserved
  // for the instruction source, exactly once) and the over-limit stand-in
  // `MAX_RAW_ITEMS_PER_SOURCE + 1` (at most once). No other arithmetic on a
  // limit and no literal re-statement of one.
  'altered or re-invented Broker raw and quota limits': (t) => {
    const rest = t
      .replaceAll('MAX_SOURCES - 1', 'SOURCE_SLOTS')
      .replaceAll('MAX_RAW_ITEMS_PER_SOURCE + 1', 'RAW_STAND_IN');
    return (
      count(t, /MAX_SOURCES - 1/) !== 1 ||
      count(t, /MAX_RAW_ITEMS_PER_SOURCE \+ 1/) > 1 ||
      /(MAX_RAW_ITEMS_PER_SOURCE|MAX_RAW_ITEMS_TOTAL|MAX_CANDIDATES_PER_SOURCE|MAX_TOTAL_CANDIDATES|MAX_SOURCES)\s*[-+*/%]|[-+*/%]\s*(MAX_RAW_ITEMS_PER_SOURCE|MAX_RAW_ITEMS_TOTAL|MAX_CANDIDATES_PER_SOURCE|MAX_TOTAL_CANDIDATES|MAX_SOURCES)\b|\b(10_?000|10_?001|40_?000|500|2_?000|15|16|17)\b/.test(
        rest,
      )
    );
  },
  'fixed instruction signals': (t) =>
    count(t, /confidence:\s*1,\s*salience:\s*1,\s*negativeRetrieval:\s*0/) !==
      1 ||
    count(t, /\bconfidence\s*:/) !== 1 ||
    count(t, /\bsalience\s*:/) !== 1 ||
    count(t, /\bnegativeRetrieval\s*:/) !== 2,
  'original behavior or durable scope hint': (t) =>
    /originalBehavior|durableScopeHint/.test(t),
  'exposure judged from the trace ranking instead of the bundle': (t) =>
    /\.ranking\b|\.selected\b|eligibleRank|\.totals\b/.test(t),
  'owner-state writes, learning or promotion': (t) =>
    /learned_owner_state|lifecycle_records|learning_candidates|promot|demot|markTrusted|grantTrust|setLifecycle|inferPreference|detectCorrection|hypothes|\blearn(s|ed|ing)?\b/i.test(
      t,
    ),
  'authority, approval, Root or tools': (t) =>
    /\b(ALLOW|DENY|REQUIRE_OWNER_APPROVAL)\b|PolicyDecision|ActionProposal|OwnerApproval|ToolExecution|executeTool|authori[sz]|\bgrant(ed|s)?\b|approv/i.test(
      t,
    ),
  'hidden reasoning fields': (t) =>
    /reasoning|chainOfThought|chain_of_thought|\bthoughts?\b|rationale|scratchpad/i.test(
      t,
    ),
};

const CONTEXT_BASE = integrationSource;
const CONTEXT_KNOWN_BAD: Record<string, string[]> = {
  'storage, Ledger, SQL or persisted-history access': [
    `${CONTEXT_BASE}\nimport { openStorage } from '@aven/storage';`,
    `${CONTEXT_BASE}\nconst h = readCorrectionHistory(storage, owner);`,
    `${CONTEXT_BASE}\nledger.appendEvent(event);`,
    `${CONTEXT_BASE}\nconst q = 'SELECT 1 FROM corrections';`,
  ],
  'other Aven packages, runtimes, Root or providers': [
    `${CONTEXT_BASE}\nimport { createOwnerModelContextSources } from '@aven/owner-model/context-source';`,
    `${CONTEXT_BASE}\nimport { assess } from '../../../context-broker/src/broker.ts';`,
    `${CONTEXT_BASE}\nconst out = await runtime.invokeModel(prompt);`,
  ],
  'network, files, processes, environment or timers': [
    `${CONTEXT_BASE}\nawait fetch('https://example.invalid');`,
    `${CONTEXT_BASE}\nsetTimeout(retry, 1000);`,
    `${CONTEXT_BASE}\nconst k = process.env.KEY;`,
  ],
  'a clock or randomness': [
    `${CONTEXT_BASE}\nconst at = new Date().toISOString();`,
    `${CONTEXT_BASE}\nconst id = randomUUID();`,
    `${CONTEXT_BASE}\nconst j = Math.random();`,
  ],
  'altered or re-invented Broker raw and quota limits': [
    `${CONTEXT_BASE}\nif (length > MAX_RAW_ITEMS_PER_SOURCE + 1) skip();`,
    `${CONTEXT_BASE}\nconst limit = 2 * MAX_TOTAL_CANDIDATES;`,
    `${CONTEXT_BASE}\nif (length > 10000) skip();`,
    `${CONTEXT_BASE}\nif (total > 40_000) skip();`,
    `${CONTEXT_BASE}\nif (owned > 500) skip();`,
    `${CONTEXT_BASE}\nif (count > MAX_SOURCES - 2) refuse();`,
    `${CONTEXT_BASE}\nif (count > 15) refuse();`,
    CONTEXT_BASE.replace('MAX_SOURCES - 1', 'MAX_SOURCES'),
  ],
  'Broker internals, limits or ranking configuration': [
    `${CONTEXT_BASE}\nif (items.length > MAX_SELECTED_ITEMS) trim();`,
    `${CONTEXT_BASE}\nif (text.length > MAX_CANDIDATE_TEXT_CHARS) cut();`,
    `${CONTEXT_BASE}\nconst w = RANKING_WEIGHTS_BASIS_POINTS.relevance;`,
    `${CONTEXT_BASE}\nINTERNAL.candidate.parse(x);`,
  ],
  'fixed instruction signals': [
    CONTEXT_BASE.replace(/salience:\s*1,/, 'salience: 0.9,'),
    `${CONTEXT_BASE}\nconst boosted = { confidence: 0.9 };`,
    `${CONTEXT_BASE}\nconst s = { negativeRetrieval: 0.5 };`,
  ],
  'original behavior or durable scope hint': [
    `${CONTEXT_BASE}\nconst text = correction.originalBehavior;`,
    `${CONTEXT_BASE}\nif (payload.durableScopeHint.kind === 'global') widen();`,
  ],
  'exposure judged from the trace ranking instead of the bundle': [
    `${CONTEXT_BASE}\nconst ok = assembly.trace.selected.some(match);`,
    `${CONTEXT_BASE}\nconst ok = assembly.trace.ranking.length > 0;`,
    `${CONTEXT_BASE}\nconst ok = candidate.eligibleRank !== null;`,
  ],
  'owner-state writes, learning or promotion': [
    `${CONTEXT_BASE}\nconst table = 'learned_owner_state';`,
    `${CONTEXT_BASE}\npromote(correction);`,
    `${CONTEXT_BASE}\nconst p = inferPreference(history);`,
  ],
  'authority, approval, Root or tools': [
    `${CONTEXT_BASE}\nif (category === 'permission') return { decision: 'ALLOW' };`,
    `${CONTEXT_BASE}\nconst authorized = true;`,
    `${CONTEXT_BASE}\nexecuteTool(proposal);`,
  ],
  'hidden reasoning fields': [`${CONTEXT_BASE}\nreturn { reasoning: why };`],
};

describe('AVEN-010 corrections context-source subpath boundaries (patch 6; not runtime security)', () => {
  it('imports only allowlisted names, and the entry only re-exports the integration', () => {
    expect(
      ledgerImportViolations(integrationSource, CONTEXT_IMPORT_ALLOWLIST),
    ).toEqual([]);
    expect(
      ledgerImportViolations(
        contextIndexSource,
        CONTEXT_INDEX_IMPORT_ALLOWLIST,
      ),
    ).toEqual([]);
    expect(
      contextIndexSource
        .replace(/export\s*\{[^}]*\}\s*from\s*'\.\/integration\.ts';/g, '')
        .trim(),
    ).toBe('');
    for (const bad of [
      `import { randomUUID } from 'node:crypto';`,
      `import { readCorrectionHistory } from '../ledger/index.ts';`,
      `import { createLedger } from '@aven/ledger';`,
      `import { CONTEXT_BROKER_CONFIG_V2 } from '@aven/context-broker';`,
      `import { recordOwnerCorrection } from '../ledger/record.ts';`,
      `import * as broker from '@aven/context-broker';`,
    ])
      expect(
        ledgerImportViolations(bad, CONTEXT_IMPORT_ALLOWLIST),
        bad,
      ).not.toEqual([]);
  });

  for (const [rule, violates] of Object.entries(CONTEXT_RULES))
    it(`has no ${rule}`, () => {
      expect(violates(integrationSource), rule).toBe(false);
      for (const bad of CONTEXT_KNOWN_BAD[rule]!)
        expect(violates(bad), bad.slice(CONTEXT_BASE.length)).toBe(true);
    });

  it('keeps the root entry free of the Broker and the other subpaths free of each other', () => {
    expect(all).not.toMatch(/context-broker|context-source/);
    expect(ledgerSource + historySource).not.toMatch(
      /context-broker|context-source/,
    );
    expect(integrationSource).not.toMatch(/ledger\//);
  });
});
