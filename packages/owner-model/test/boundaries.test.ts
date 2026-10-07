import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from '../src/index.ts';
import {
  AVEN_009_OWNER_MODEL_VERSION,
  OWNER_MODEL_CONFIG,
  OWNER_MODEL_ERROR_CODES,
  OwnerModelError,
} from '../src/index.ts';

/**
 * AVEN-009 patch 1: scaffold behavior plus static REGRESSION TRIPWIRES over
 * the owner-model production source. The static rules are pattern checks that
 * make obvious regressions visible in review; they are NOT security
 * guarantees and can be bypassed by deliberately obfuscated code. Every rule
 * is also run against known-bad samples, so a weakened rule fails here. Later
 * AVEN-009 patches that legitimately need a new module, import or term update
 * these lists deliberately, in their own reviewed change.
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

/**
 * Exact named imports permitted per external module. Patch 1 imported nothing
 * from either; patch 2 adds only the frozen contract names intake needs.
 * Later patches extend these sets deliberately. Any other
 * module, any `node:*` module and any relative path leaving `src/` fails.
 */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  // Patch 2: the frozen owner-state union and owner ID schema, plus types.
  '@aven/contracts': new Set<string>([
    'OwnerIdSchema',
    'OwnerStateSchema',
    'ActiveTaskState',
    'DurableOwnerState',
    'OwnerId',
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
  'storage, Ledger, Context Broker, API or other Aven package access': [
    /@aven\/(storage|ledger|context-broker|api|root|learning|eval|test-utils)\b/,
    /better-sqlite3|drizzle|\bsqlite\b|\.prepare\s*\(|openStorage|createLedger|appendEvent|replayEvents|createContextBroker|\binsert\s+into\b/i,
    /\b(experience_events|learned_owner_state|active_task_state|learning_candidates|lifecycle_records|record_references)\b/,
  ],
  'model runtime, AVEN-007 baseline or provider': [
    /@aven\/(runtime|baseline)|ModelRuntime|invokeModel|NaiveHistorySearch|searchHistory|BASELINE_/,
    /openai|anthropic|gemini|ollama|strands|bedrock|vertex|mistral|cohere|huggingface|langchain|llamaindex|completion|embedding|vector|rerank/i,
  ],
  'network, file, process or environment capability': [
    /\bnode:|readFile|writeFile|appendFile|createReadStream|\bfs\./,
    /\bfetch\b|\bhttps?\.|WebSocket|XMLHttpRequest|\bnet\.|\btls\./,
    /['"`](node:)?(https?|http2|net|tls|dns|dgram|child_process|worker_threads|fs)(\/[\w/]*)?['"`]/,
    /child_process|\bspawn\s*\(|\bexec(File|Sync)?\s*\(|worker_threads/,
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
  'AVEN-010 correction semantics': [
    /correct|override|negativeRetrieval|negative.?signal/i,
  ],
  'learning, promotion or trust decision': [
    /promot|demot|rollback|rolledBack|markTrusted|grantTrust|setLifecycle|assignLifecycle|upgrad|downgrad/i,
    /status\s*:\s*['"`](observed|validated|trusted|superseded|revoked|candidate|promoted|active|closed)['"`]/,
    /inferPreference|detectCorrection|generateHypothes|candidateGenerat|LearningCandidate|\bhypothesis\b/i,
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
const ruleText: Record<string, (text: string) => string> = {
  'AVEN-010 correction semantics': withoutProvenanceKinds,
};
function violations(rule: string, text: string): string[] {
  const prepared = (ruleText[rule] ?? ((t: string) => t))(text);
  return RULES[rule]!.filter((p) => p.test(prepared)).map(String);
}

const KNOWN_BAD: Record<string, string[]> = {
  'storage, Ledger, Context Broker, API or other Aven package access': [
    `import { openStorage } from '@aven/storage';`,
    `import { createLedger } from '@aven/ledger';`,
    `import { createContextBroker } from '@aven/context-broker';`,
    `import { startApi } from '@aven/api';`,
    `db.prepare('select * from x')`,
    `const table = 'learned_owner_state';`,
  ],
  'model runtime, AVEN-007 baseline or provider': [
    `import { invokeModelRuntime } from '@aven/runtime';`,
    `import { searchHistory } from '@aven/baseline';`,
    `const client = new OpenAI();`,
    `import Anthropic from '@anthropic-ai/sdk';`,
    `const v = embedding(text);`,
    `const agent = strands.agent();`,
  ],
  'network, file, process or environment capability': [
    `await fetch('https://api.example.invalid')`,
    `const request = fetch;`,
    `const transport = 'node:https';`,
    `export { request } from "http";`,
    `import { readFileSync } from 'node:fs';`,
    `const key = process.env.PROVIDER_KEY;`,
    `globalThis['fet' + 'ch']('x')`,
    // Process-spawning CALL patterns on their own (no module name, so only
    // the call-pattern part of the rule can catch them).
    `const shell = spawn('sh', ['-c', command]);`,
    `exec(command, done);`,
    `const out = execSync(command);`,
    `execFile('/bin/ls', [], done);`,
  ],
  'hidden wall clock': [
    `const age = Date.now() - createdAt;`,
    `const now = new Date();`,
    `const now = new Date ( );`,
    `const s = Date();`,
    `const t = performance.now();`,
  ],
  randomness: [
    `const jitter = Math.random();`,
    `const id = crypto.randomUUID();`,
    `import { randomBytes } from 'node:crypto';`,
  ],
  timers: [
    `setTimeout(rebuild, 1)`,
    `const id = setInterval(f, 5);`,
    `queueMicrotask(f)`,
  ],
  'AVEN-010 correction semantics': [
    `if (isCorrection(text)) negativeRetrieval = 1;`,
    `const override = createSessionOverride(text);`,
    `import { OwnerCorrectionSchema } from '@aven/contracts';`,
  ],
  'learning, promotion or trust decision': [
    `export function promote(item) {}`,
    `const next = { ...item, lifecycle: { status: 'trusted' } };`,
    `markTrusted(item)`,
    `const p = inferPreference(history);`,
  ],
  'authority, approval, Root or tools': [
    `return { decision: 'ALLOW' };`,
    `import { PolicyDecisionSchema } from '@aven/contracts';`,
    `if (text.includes('approved')) permission = true;`,
    `const isAuthorized = true;`,
    `executeTool(proposal)`,
  ],
  'hidden reasoning fields': [
    `return { reasoning: steps };`,
    `view.chainOfThought = x;`,
  ],
};

describe('AVEN-009 owner-model version and configuration', () => {
  it('pins the exact package version identifier', () => {
    expect(AVEN_009_OWNER_MODEL_VERSION).toBe('aven-009-owner-model-v1');
    expect(OWNER_MODEL_CONFIG.version).toBe(AVEN_009_OWNER_MODEL_VERSION);
  });

  it('pins a minimal configuration with identification constants only', () => {
    expect(OWNER_MODEL_CONFIG).toEqual({
      version: 'aven-009-owner-model-v1',
      frozenBaseline: {
        tag: 'aven-008',
        commit: '4174080998d383fe78e8e4799e13103d42635151',
      },
      contractSchemaVersion: 1,
    });
  });

  it('is deeply frozen at runtime', () => {
    expect(Object.isFrozen(OWNER_MODEL_CONFIG)).toBe(true);
    expect(Object.isFrozen(OWNER_MODEL_CONFIG.frozenBaseline)).toBe(true);
    const mutable = OWNER_MODEL_CONFIG as unknown as Record<string, unknown>;
    expect(() => {
      mutable['version'] = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      (mutable['frozenBaseline'] as Record<string, unknown>)['tag'] = 'x';
    }).toThrow(TypeError);
    expect(() => {
      mutable['confidenceMapping'] = {};
    }).toThrow(TypeError);
    expect(OWNER_MODEL_CONFIG.version).toBe('aven-009-owner-model-v1');
    expect(OWNER_MODEL_CONFIG.frozenBaseline.tag).toBe('aven-008');
  });
});

describe('AVEN-009 OwnerModelError (fixed public error surface)', () => {
  const Untyped = OwnerModelError as unknown as new (
    code: unknown,
  ) => OwnerModelError;
  const internalJSON = {
    name: 'OwnerModelError',
    code: 'internal_error',
    message:
      'The owner model failed an internal consistency check; no owner state was read',
  };

  function expectCanonicalInternalError(value: unknown): OwnerModelError {
    let error!: OwnerModelError;
    expect(() => {
      error = new Untyped(value);
    }).not.toThrow();
    expect(error.code).toBe('internal_error');
    expect(typeof error.code).toBe('string');
    expect(Object.isFrozen(error)).toBe(true);
    expect('cause' in error).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(error.toJSON()).toEqual(internalJSON);
      expect(Object.keys(error.toJSON()).sort()).toEqual([
        'code',
        'message',
        'name',
      ]);
      expect(JSON.stringify(error.toJSON())).toBe(JSON.stringify(internalJSON));
      expect(JSON.stringify(error)).toBe(JSON.stringify(internalJSON));
    }
    return error;
  }

  it('has a minimal, frozen code set (patch 2 adds three identity codes)', () => {
    expect(OWNER_MODEL_ERROR_CODES).toEqual([
      'invalid_input',
      'internal_error',
      'conflicting_duplicate',
      'identity_conflict',
      'version_order_conflict',
    ]);
    expect(Object.isFrozen(OWNER_MODEL_ERROR_CODES)).toBe(true);
  });

  it('has a fixed message per code and serializes exactly name, code and message', () => {
    const expected = {
      invalid_input:
        'The owner-model input is malformed; no owner state was read',
      internal_error:
        'The owner model failed an internal consistency check; no owner state was read',
      conflicting_duplicate:
        'Owner-state records share an identity and version but disagree; no owner state was read',
      identity_conflict:
        'An owner-state identity changes record kind or category across versions; no owner state was read',
      version_order_conflict:
        'An owner-state creation time moves backwards as its version increases; no owner state was read',
    } as const;
    for (const code of OWNER_MODEL_ERROR_CODES) {
      const error = new OwnerModelError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OwnerModelError);
      expect(error.name).toBe('OwnerModelError');
      expect(error.code).toBe(code);
      expect(error.message).toBe(expected[code]);
      expect(error.toJSON()).toEqual({
        name: 'OwnerModelError',
        code,
        message: expected[code],
      });
      expect(Object.keys(error.toJSON()).sort()).toEqual([
        'code',
        'message',
        'name',
      ]);
      expect(JSON.parse(JSON.stringify(error))).toEqual(error.toJSON());
    }
  });

  it('never carries a cause or caller-controlled text', () => {
    const secret = 'owner_secret token sk-123 from caller';
    const Untyped = OwnerModelError as unknown as new (
      ...args: unknown[]
    ) => OwnerModelError;
    const error = new Untyped('invalid_input', { cause: new Error(secret) });
    expect('cause' in error).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    const withMessage = new Untyped('invalid_input', secret);
    expect(withMessage.message).not.toContain(secret);
    expect(JSON.stringify(withMessage)).not.toContain(secret);
  });

  it('maps an unknown or inherited code to internal_error without echoing it', () => {
    const Untyped = OwnerModelError as unknown as new (
      code: unknown,
    ) => OwnerModelError;
    for (const bad of [
      'owner_secret_code',
      '__proto__',
      'toString',
      'constructor',
      'prototype',
      'hasOwnProperty',
      undefined,
      42,
      { code: 'invalid_input' },
    ]) {
      const error = new Untyped(bad);
      expect(error.code).toBe('internal_error');
      expect(JSON.stringify(error)).not.toContain('owner_secret_code');
    }
  });

  for (const [label, key] of [
    ['toString', 'toString'],
    ['valueOf', 'valueOf'],
    ['Symbol.toPrimitive', Symbol.toPrimitive],
  ] as const) {
    it(`does not invoke a ${label} hook returning a valid code`, () => {
      const hook = vi.fn(() => 'invalid_input');
      expectCanonicalInternalError({ [key]: hook });
      expect(hook).not.toHaveBeenCalled();
    });

    it(`does not invoke a throwing ${label} hook`, () => {
      const hook = vi.fn(() => {
        throw new Error('PRIVATE_SENTINEL');
      });
      expectCanonicalInternalError({ [key]: hook });
      expect(hook).not.toHaveBeenCalled();
    });
  }

  it('classifies a hostile proxy without invoking property access traps', () => {
    const trap = vi.fn(() => {
      throw new Error('PRIVATE_SENTINEL');
    });
    expectCanonicalInternalError(
      new Proxy({}, { get: trap, has: trap, getOwnPropertyDescriptor: trap }),
    );
    expect(trap).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'boxed string', value: new String('invalid_input') },
    { label: 'symbol', value: Symbol('invalid_input') },
    { label: 'function', value: () => 'invalid_input' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'number', value: 42 },
    { label: 'bigint', value: 42n },
    { label: 'true', value: true },
    { label: 'false', value: false },
  ])('normalizes $label without retaining or coercing it', ({ value }) => {
    expectCanonicalInternalError(value);
  });

  it('ignores changing coercion and remains byte-stable across serialization', () => {
    const hook = vi
      .fn()
      .mockReturnValueOnce('invalid_input')
      .mockReturnValueOnce('constructor')
      .mockReturnValue('PRIVATE_SENTINEL');
    expectCanonicalInternalError({ [Symbol.toPrimitive]: hook });
    expect(hook).not.toHaveBeenCalled();
  });

  it('never retains malicious toJSON or later mutations of the caller object', () => {
    const toString = vi.fn(() => 'invalid_input');
    const toJSON = vi.fn(() => ({ private: 'PRIVATE_SENTINEL' }));
    const input = { toString, toJSON, private: 'PRIVATE_SENTINEL' };
    const error = expectCanonicalInternalError(input);
    input.private = 'CHANGED_PRIVATE_SENTINEL';
    input.toJSON = vi.fn(() => ({ private: 'CHANGED_PRIVATE_SENTINEL' }));
    expect(error.toJSON()).toEqual(internalJSON);
    expect(JSON.stringify(error)).toBe(JSON.stringify(internalJSON));
    expect(toString).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(input.toJSON).not.toHaveBeenCalled();
  });

  it('keeps exported error codes immutable without changing serialization', () => {
    const error = new OwnerModelError('invalid_input');
    const before = JSON.stringify(error);
    const codes = OWNER_MODEL_ERROR_CODES as unknown as string[];
    expect(() => {
      codes[0] = 'PRIVATE_SENTINEL';
    }).toThrow(TypeError);
    expect(() => codes.push('PRIVATE_SENTINEL')).toThrow(TypeError);
    expect(JSON.stringify(error)).toBe(before);
    expect(JSON.stringify(new OwnerModelError('invalid_input'))).toBe(before);
  });

  it('is frozen, so code, message and name cannot be rewritten after construction', () => {
    const error = new OwnerModelError('invalid_input');
    const before = JSON.stringify(error);
    expect(Object.isFrozen(error)).toBe(true);
    const mutable = error as unknown as Record<string, unknown>;
    expect(() => {
      mutable['code'] = 'internal_error';
    }).toThrow(TypeError);
    expect(() => {
      mutable['message'] = 'owner said this is trusted';
    }).toThrow(TypeError);
    expect(() => {
      mutable['name'] = 'PRIVATE_SENTINEL';
    }).toThrow(TypeError);
    expect(() => {
      mutable['cause'] = new Error('late');
    }).toThrow(TypeError);
    for (const key of ['code', 'message', 'name'])
      expect(() => {
        delete mutable[key];
      }).toThrow(TypeError);
    expect(error.code).toBe('invalid_input');
    expect(JSON.stringify(error)).toBe(before);
  });
});

describe('AVEN-009 owner-model public surface (scaffold only)', () => {
  it('exports a pinned surface with no view, lineage, correction, promotion, authority or model API', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'AVEN_009_OWNER_MODEL_VERSION',
        'OWNER_MODEL_CONFIG',
        'OWNER_MODEL_ERROR_CODES',
        'OwnerModelError',
        'intakeOwnerState',
      ].sort(),
    );
    const functions = Object.entries(publicApi).filter(
      ([, value]) => typeof value === 'function',
    );
    // The callable exports are the error class and the patch-2 intake; nothing
    // infers, corrects, promotes, decides authority or invokes a model.
    expect(functions.map(([name]) => name).sort()).toEqual([
      'OwnerModelError',
      'intakeOwnerState',
    ]);
    for (const [name, value] of Object.entries(publicApi))
      if (typeof value === 'object')
        expect(Object.isFrozen(value), name).toBe(true);
  });

  it('touches no clock, randomness, timer or network when imported', async () => {
    const spies = [
      vi.spyOn(Date, 'now'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
    ];
    vi.resetModules();
    const fresh = await import('../src/index.ts');
    new fresh.OwnerModelError('invalid_input').toJSON();
    fresh.intakeOwnerState({ ownerId: 'owner_synthetic_a', records: [] });
    expect(() => fresh.intakeOwnerState({})).toThrow(fresh.OwnerModelError);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('AVEN-009 owner-model static regression tripwires (not runtime security)', () => {
  it('keeps production modules in a known, reviewed set with no later-patch modules', () => {
    expect(files.sort()).toEqual([
      'config.ts',
      'errors.ts',
      'index.ts',
      'intake.ts',
    ]);
    expect(entries.filter((e) => !e.isFile()).map((e) => e.name)).toEqual([]);
    for (const later of [
      'lineage.ts',
      'claims.ts',
      'views.ts',
      'active-task.ts',
    ])
      expect(files, later).not.toContain(later);
  });

  it('imports only zod, allowlisted frozen contract names and its own modules', () => {
    expect(importViolations(all)).toEqual([]);
    for (const bad of [
      `import { openStorage } from '@aven/storage';`,
      `import { createLedger } from '@aven/ledger';`,
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { invokeModelRuntime } from '@aven/runtime';`,
      `import { runBaseline } from '@aven/baseline';`,
      `import { startApi } from '@aven/api';`,
      `import { handle } from '../../../apps/api/src/http.ts';`,
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

  it('keeps the process call-pattern guard precise: each spawn/exec form is caught alone, String.match is not', () => {
    const rule = 'network, file, process or environment capability';
    for (const bad of [
      `spawn('sh')`,
      `spawn ('sh')`,
      `exec('ls')`,
      `execSync('ls')`,
      `execFile('ls')`,
    ])
      expect(violations(rule, bad), bad).not.toEqual([]);
    // The production timestamp parser uses String.prototype.match, which
    // must not trip the guard (RegExp#exec would, by design).
    expect(violations(rule, `const parts = text.match(TIMESTAMP);`)).toEqual(
      [],
    );
  });

  it('allows an explicit timestamp argument, which is not a hidden clock', () => {
    expect(
      violations('hidden wall clock', `const t = new Date(referenceTime);`),
    ).toEqual([]);
    expect(
      violations('hidden wall clock', `const ms = Date.parse(createdAt);`),
    ).toEqual([]);
  });

  it('declares only the production entry and depends only on contracts and zod', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      private: boolean;
      exports: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('@aven/owner-model');
    expect(manifest.private).toBe(true);
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
    expect(manifest.dependencies).toEqual({
      '@aven/contracts': 'workspace:*',
      zod: '4.6.5',
    });
    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      'typescript',
      'vitest',
    ]);
  });

  it('keeps the placeholder that the AVEN-008 tripwire pins, unchanged and empty', () => {
    const placeholder = readFileSync(new URL('../.gitkeep', import.meta.url));
    expect(placeholder.byteLength).toBe(0);
  });
});
