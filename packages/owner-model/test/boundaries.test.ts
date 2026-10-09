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
    // Patch 3: the frozen learned-item ID type, for durable lineage nodes.
    'LearnedItemId',
    // Patch 4: the frozen recorded-transition union and reference types.
    'LearningTransitionSchema',
    'LearningTransition',
    'LearnedItemReference',
    'EventId',
    // Patch 5: the frozen timestamp schema, for the explicit reference time.
    'TimestampSchema',
    // Patch 6: the frozen session and task ID schemas, for the exact binding.
    'SessionIdSchema',
    'TaskIdSchema',
    'SessionId',
    'TaskId',
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
/**
 * Removes the frozen contract names Patch 4 must read to find a promotion
 * claim (the trusted lifecycle pointer and the transition kind). They name
 * recorded data; nothing here promotes.
 */
const withoutPromotionContractNames = (text: string) =>
  text.replaceAll('promotionEventId', '').replaceAll('learning_promotion', '');
const ruleText: Record<string, (text: string) => string> = {
  'AVEN-010 correction semantics': withoutProvenanceKinds,
  'learning, promotion or trust decision': withoutPromotionContractNames,
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
    // The frozen-name exemption is exact: other promotion code still trips.
    `applyPromotion(record, learning_promotion);`,
    `const promotionEventIds = promoteAll(records);`,
    `if (t.kind === 'learning_rollback') restore(t.restore);`,
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

  it('has a minimal, frozen code set (patch 2 adds three identity codes, patch 3 two lineage codes, patch 4 one claim code, patch 5 one view code, patch 6 one task code, patch 7 one persisted code, patch 8 one context code)', () => {
    expect(OWNER_MODEL_ERROR_CODES).toEqual([
      'invalid_input',
      'internal_error',
      'conflicting_duplicate',
      'identity_conflict',
      'version_order_conflict',
      'invalid_lineage_reference',
      'lineage_cycle',
      'invalid_lifecycle_claim',
      'invalid_owner_state_view',
      'active_task_conflict',
      'invalid_persisted_owner_model',
      'invalid_owner_model_context',
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
      invalid_lineage_reference:
        'An owner-state lineage reference does not resolve to a version of the same category; no lineage was built',
      lineage_cycle:
        'Owner-state lineage references form a cycle; no lineage was built',
      invalid_lifecycle_claim:
        'Owner-state lifecycle claims do not agree with recorded transitions; no verified owner model was built',
      invalid_owner_state_view:
        'An owner-state record is inconsistent with its category; no owner-state view was built',
      active_task_conflict:
        'Several active task states declare the same task binding; no active task view was built',
      invalid_persisted_owner_model:
        'Persisted owner state failed read-only reconstruction; no owner model was built',
      invalid_owner_model_context:
        'Owner-model context candidates do not fit the context source contract; no candidates were offered',
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
      'active-task.ts',
      'ambient.ts',
      'canonical-text.ts',
      'claims.ts',
      'config.ts',
      'errors.ts',
      'index.ts',
      'intake.ts',
      'lineage.ts',
      'timestamps.ts',
      'views.ts',
    ]);
    // Patch 7/8: the only subdirectories are the two reviewed subpaths.
    expect(
      entries
        .filter((e) => !e.isFile())
        .map((e) => e.name)
        .sort(),
    ).toEqual(['context-source', 'persistence']);
    for (const later of [
      'persistence.ts',
      'rebuild.ts',
      'context-source.ts',
      'adapter.ts',
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

  it('keeps the committed regression suites, including the fresh-process pre-import test', () => {
    const tests = readdirSync(new URL('./', import.meta.url)).filter((f) =>
      f.endsWith('.test.ts'),
    );
    expect(tests.sort()).toEqual([
      'active-task.test.ts',
      'boundaries.test.ts',
      'claims.test.ts',
      'context-source.test.ts',
      'fresh-process.test.ts',
      'intake.test.ts',
      'lineage.test.ts',
      'persistence.test.ts',
      'views.test.ts',
    ]);
  });

  it('keeps lineage functions non-recursive, so long chains cannot overflow the stack', () => {
    /** Names of declared functions whose own body calls them by name. */
    function selfRecursive(text: string): string[] {
      const found: string[] = [];
      for (const m of text.matchAll(/function\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
        const name = m[1]!;
        const open = text.indexOf('{', m.index + m[0].length);
        let depth = 0;
        let end = open;
        for (; end < text.length; end += 1) {
          if (text[end] === '{') depth += 1;
          else if (text[end] === '}' && --depth === 0) break;
        }
        const body = text.slice(open + 1, end);
        if (new RegExp(`\\b${name}\\s*\\(`).test(body)) found.push(name);
      }
      return found;
    }
    expect(selfRecursive(source['lineage.ts']!)).toEqual([]);
    expect(
      selfRecursive(`function visit(at: Node): void {
        if (seen.has(at)) return;
        seen.add(at);
        const to = next.get(at);
        if (to) { visit(to); }
      }`),
    ).toEqual(['visit']);
  });

  it('keeps the active task view declarative: no expiry, clock, ranking, candidate, execution, coercion or durable state', () => {
    // Patch 6 reads only intake.activeTasks, selects each ID's head, and
    // tests exact binding and an active lifecycle. Expiry, Broker candidates,
    // execution and persistence are later work or never.
    const PATCH_6_SCOPE: Record<string, RegExp> = {
      'expiry, age or time semantics':
        /expir|\bttl\b|\bage\b|stale|timeout|timed.?out|freshness|closedAt|createdAt|referenceTime|asOf/i,
      'ranking or Context Broker candidate':
        /\brank|\bscore|relevan|salien|confidence|ContextCandidate|contextSource|candidate/i,
      'execution, tools or proposals':
        /execut|\btool|proposal|schedul|\bresume|\.outcome\b|completed|cancelled/i,
      'durable state or category views':
        /\.durable\b|DurableOwnerState|\bfacts\b|preferences|episodes|intentPatterns|procedures|categor/i,
      'coercion of task IDs':
        /\bString\s*\(|toString|`[^`]*\$\{|\+\s*''|''\s*\+|toLowerCase|toUpperCase|\.trim\s*\(/,
      'Root, storage or Ledger':
        /\bauthority\b|\bRoot\b|@aven\/(storage|ledger|context-broker)/,
    };
    const taskCode = source['active-task.ts']!;
    for (const [label, pattern] of Object.entries(PATCH_6_SCOPE))
      expect(pattern.test(taskCode), label).toBe(false);
    for (const [label, bad] of [
      [
        'expiry, age or time semantics',
        `if (age(head.metadata.createdAt) > TTL) continue;`,
      ],
      [
        'expiry, age or time semantics',
        `const expired = head.lifecycle.closedAt < now;`,
      ],
      [
        'ranking or Context Broker candidate',
        `return { kind: 'active_task', confidence: 1 } as ContextCandidate;`,
      ],
      [
        'ranking or Context Broker candidate',
        `matches.sort((a, b) => b.score - a.score);`,
      ],
      ['execution, tools or proposals', `executeTool(head.openLoops[0]);`],
      [
        'execution, tools or proposals',
        `if (head.lifecycle.outcome === 'cancelled') return older;`,
      ],
      [
        'durable state or category views',
        `for (const record of intake.durable) if (match(record)) hit = record;`,
      ],
      ['durable state or category views', `views.facts.push(state);`],
      ['coercion of task IDs', `const taskId = String(request.taskId);`],
      ['coercion of task IDs', 'const key = `${sessionId}/${taskId}`;'],
      ['coercion of task IDs', `const taskId = request.taskId.trim();`],
      [
        'Root, storage or Ledger',
        `import { openStorage } from '@aven/storage';`,
      ],
    ] as const)
      expect(PATCH_6_SCOPE[label]!.test(bad), bad).toBe(true);
  });

  it('keeps durable category views declared-only: no Root selection, Broker matching, task view, truth or transition following', () => {
    // Patch 5 groups typed durable state and projects it as of an explicit
    // time. Root selects trusted versions; the Context Broker matches and
    // ranks; Patch 6 owns active tasks; nothing here follows replacement or
    // fallback, executes procedures or declares truth.
    const PATCH_5_SCOPE: Record<string, RegExp> = {
      'Root or trusted-version selection':
        /chooseTrusted|preferTrusted|rootSelected|selectedByRoot|authorityWinner|trustedWinner|approvedCurrent|authoritative|\bofficial|effectiveTruth|\bwinner\b|\bauthority\b/i,
      'authority-style current or effective selection':
        /current(?!Declared)|effective|\bselect\w*|\bbest\w*|latestUsable|inForce/i,
      'Context Broker matching or ranking':
        /relevan|salien|confidence|\brank|\bscore|freshness|negative|\bquery|\.domain\b|taskType|\.taskId\b|qualifiers|recipient|\bentity\b|\.context\b/i,
      'active-task view': /activeTask|active_task/i,
      'transition or lineage-edge following':
        /\.replacement\b|\.fallback\b|\.edges\b|\.claims\b|learning_|transition/i,
      'semantic invention':
        /\btruth|isTrue|polarity|personality|\bstrength|universal|inferredIntent|\bglobal\b|execute|\bsteps\b/i,
    };
    const viewsCode = source['views.ts']!;
    for (const [label, pattern] of Object.entries(PATCH_5_SCOPE))
      expect(pattern.test(viewsCode), label).toBe(false);
    for (const [label, bad] of [
      [
        'Root or trusted-version selection',
        `const v = chooseTrustedVersion(history);`,
      ],
      ['Root or trusted-version selection', `if (preferTrusted) pick(v1);`],
      ['Root or trusted-version selection', `view.authoritative = true;`],
      [
        'authority-style current or effective selection',
        `view.current = latest;`,
      ],
      [
        'authority-style current or effective selection',
        `const effective = older;`,
      ],
      [
        'Context Broker matching or ranking',
        `items.sort((a, b) => b.score - a.score);`,
      ],
      [
        'Context Broker matching or ranking',
        `if (record.scope.domain !== query.domain) continue;`,
      ],
      [
        'Context Broker matching or ranking',
        `const relevance = coverage(record);`,
      ],
      ['active-task view', `views.activeTasks = intake.activeTasks;`],
      [
        'transition or lineage-edge following',
        `const head = index.get(record.lifecycle.replacement);`,
      ],
      [
        'transition or lineage-edge following',
        `for (const edge of lineage.edges) follow(edge);`,
      ],
      ['semantic invention', `view.isTrue = true;`],
      ['semantic invention', `view.global = true;`],
      ['semantic invention', `view.personality = 'direct';`],
      [
        'semantic invention',
        `for (const step of content.steps) execute(step);`,
      ],
    ] as const)
      expect(PATCH_5_SCOPE[label]!.test(bad), bad).toBe(true);
  });

  it('keeps lifecycle-claim verification read-only: no in-force selection, Root conclusion or transition application', () => {
    // Patch 4 checks that recorded transitions AGREE with lifecycle claims.
    // Views (which version applies) are Patch 5; Root authenticity is never
    // concluded here; rejection and rollback records are never applied.
    const PATCH_4_SCOPE: Record<string, RegExp> = {
      'in-force selection (Patch 5)':
        /current|effective|selected|\bselect\w*|winner|winning|\bbest\w*|latest|newest|inForce|\bactive\b/i,
      'Root or policy authority conclusion':
        /\.authority\b|\bauthority\s*[:=]|authenticat|rootApproved|verifiedBy|\bdecision\b|policyDecision/i,
      'transition application':
        /learning_rollback|learning_rejection|rejectionEventId|revocationEventId|\brestore\b|previousTrustedState|\bapply\w*/i,
    };
    const claimsCode = source['claims.ts']!;
    for (const [label, pattern] of Object.entries(PATCH_4_SCOPE))
      expect(pattern.test(claimsCode), label).toBe(false);
    for (const [label, bad] of [
      ['in-force selection (Patch 5)', `verified.current = claims.at(-1);`],
      ['in-force selection (Patch 5)', `const effective = byEvent.get(id);`],
      ['in-force selection (Patch 5)', `const bestVersion = pick(history);`],
      ['in-force selection (Patch 5)', `history.latestUsable = record;`],
      ['in-force selection (Patch 5)', `const winner = versions[0];`],
      [
        'Root or policy authority conclusion',
        `if (transition.authority.decisionId) ok = true;`,
      ],
      [
        'Root or policy authority conclusion',
        `trace.authority = transition.authority;`,
      ],
      ['Root or policy authority conclusion', `verified.rootApproved = true;`],
      ['Root or policy authority conclusion', `claim.authenticated = true;`],
      [
        'transition application',
        `if (t.kind === 'learning_rollback') drop(t.from);`,
      ],
      [
        'transition application',
        `if (t.kind === 'learning_rejection') remove(t);`,
      ],
      ['transition application', `const restored = restore(t);`],
      ['transition application', `applyTransition(record, t);`],
    ] as const)
      expect(PATCH_4_SCOPE[label]!.test(bad), bad).toBe(true);
  });

  it('validates recorded transitions only as inert snapshots', () => {
    // The frozen schema is applied to the inert own-data copy alone, and
    // every caller element passes through the descriptor-only snapshot.
    const claimsCode = source['claims.ts']!;
    const inertOnly = (text: string) => [
      [...text.matchAll(/\.safeParse\(\s*(\w+)\s*\)/g)].map((m) => m[1]),
      /copies\.push\(\s*inert\(\s*value\s*\)\s*\)/.test(text),
      /Reflect\.get\s*\(|\bfor\s*\(\s*const\s+\w+\s+in\b/.test(text),
    ];
    expect(inertOnly(claimsCode)).toEqual([['copy'], true, false]);
    for (const bad of [
      claimsCode.replace('safeParse(copy)', 'safeParse(value)'),
      claimsCode.replace('copies.push(inert(value))', 'copies.push(value)'),
      `${claimsCode}\nconst v = Reflect.get(target, key);`,
      `${claimsCode}\nfor (const key in value) record[key] = value[key];`,
    ])
      expect(inertOnly(bad)).not.toEqual([['copy'], true, false]);
  });

  it('indexes recorded transitions once and never scans them per claim', () => {
    // The validated transition array is traversed exactly once, to build the
    // exact-event index; claims then resolve by Map lookup only.
    const claimsCode = source['claims.ts']!;
    const scans = (text: string) => [
      (text.match(/\brecorded\b/g) ?? []).length !== 2,
      /\.(find|findLast|findIndex|filter|some|every|indexOf|lastIndexOf|includes|reduce)\s*\(/.test(
        text,
      ),
      /\bbyEvent\s*\.\s*(values|entries|keys|forEach)\b/.test(text),
    ];
    expect(scans(claimsCode)).toEqual([false, false, false]);
    expect(
      scans(
        claimsCode.replace(
          'byEvent.get(claim.eventId)',
          'recorded.find((t) => t.eventId === claim.eventId)',
        ),
      ).some(Boolean),
    ).toBe(true);
    expect(
      scans(
        `const recorded = all(); for (const t of recorded) index(t); for (const t of recorded) if (t.eventId === id) hit = t;`,
      ).some(Boolean),
    ).toBe(true);
    expect(
      scans(
        `for (const t of byEvent.values()) if (t.eventId === id) hit = t;`,
      ).some(Boolean),
    ).toBe(true);
  });

  it('keeps durable lineage structural: no lifecycle-claim checks and no in-force selection (later-patch scope)', () => {
    // Patch 3 reads lifecycle status only to find the structural reference
    // field. Claim agreement (event IDs, timestamps, reasons, evaluations,
    // candidates) and any notion of which version applies are later patches.
    const LATER_PATCH_SCOPE = [
      /\b(eventId|promotionEventId|evaluations|candidate\w*|supersededAt|revokedAt|reason|lastValidatedAt)\b/,
      /current|effective|winner|winning|selected|\bselect\w*|\bactive\b|\bactiveTasks\b|inForce|latest|newest|nearest/i,
    ];
    const lineageCode = source['lineage.ts']!;
    expect(
      LATER_PATCH_SCOPE.filter((p) => p.test(lineageCode)).map(String),
    ).toEqual([]);
    for (const bad of [
      `if (source.lifecycle.eventId !== target.eventId) throw REFERENCE;`,
      `const ok = lifecycle.promotionEventId === undefined;`,
      `if (lifecycle.evaluations.length === 0) return;`,
      `if (lifecycle.supersededAt < target.metadata.createdAt) throw CYCLE;`,
      `const at = lifecycle.revokedAt;`,
      `if (lifecycle.reason === '') throw REJECT;`,
      `const v = lifecycle.lastValidatedAt;`,
      `const candidates = records.filter(isLive);`,
      `history.current = versions.at(-1);`,
      `const effective = pick(history);`,
      `const winner = versions[0];`,
      `history.selectedVersion = 3;`,
      `const records = [...intake.durable, ...intake.activeTasks];`,
      `const target = latestVersion(index.get(id));`,
      `const target = nearest(index.get(id), version);`,
    ])
      expect(
        LATER_PATCH_SCOPE.some((p) => p.test(bad)),
        bad,
      ).toBe(true);
  });

  it('confines JSON.stringify to the own-data canonical serializer', () => {
    const users = Object.keys(source).filter((f) =>
      /JSON\s*\.\s*stringify/.test(source[f]!),
    );
    expect(users).toEqual(['canonical-text.ts']);
  });

  it('allows an explicit timestamp argument, which is not a hidden clock', () => {
    expect(
      violations('hidden wall clock', `const t = new Date(referenceTime);`),
    ).toEqual([]);
    expect(
      violations('hidden wall clock', `const ms = Date.parse(createdAt);`),
    ).toEqual([]);
  });

  it('declares the root and persistence entries and only the reviewed dependencies', () => {
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
    // Patch 7: the ./persistence subpath and its two read dependencies.
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './persistence': './src/persistence/index.ts',
      './context-source': './src/context-source/index.ts',
    });
    expect(manifest.dependencies).toEqual({
      '@aven/context-broker': 'workspace:*',
      '@aven/contracts': 'workspace:*',
      '@aven/ledger': 'workspace:*',
      '@aven/storage': 'workspace:*',
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

/**
 * AVEN-009 patch 7: static regression tripwires for the read-only
 * persistence subpath. Like the core tripwires, these are pattern checks
 * over code (comments removed), not runtime isolation.
 */
const persistenceDir = new URL('../src/persistence/', import.meta.url);
const persistenceEntries = readdirSync(persistenceDir, { withFileTypes: true });
const persistenceFiles = persistenceEntries
  .filter((e) => e.isFile())
  .map((e) => e.name);
const persistenceSource: Record<string, string> = Object.fromEntries(
  persistenceFiles.map((f) => [
    f,
    code(readFileSync(new URL(f, persistenceDir), 'utf8')),
  ]),
);
const persistenceCode = Object.values(persistenceSource).join('\n');

const PERSISTENCE_IMPORTS: Record<string, ReadonlySet<string>> = {
  '@aven/contracts': new Set([
    'OwnerIdSchema',
    'ActiveTaskState',
    'DurableOwnerState',
    'LearningTransition',
    'OwnerId',
  ]),
  '@aven/ledger': new Set(['createLedger', 'StoredEvent']),
  '@aven/storage': new Set(['deserializeContract', 'Storage']),
};
function persistenceImportViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const module = m[3] ?? '';
    if (/^\.\.?\/[\w-]+\.ts$/.test(module)) continue;
    const allowed = PERSISTENCE_IMPORTS[module];
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
  if (/\bimport\s*['"]|\bimport\s*\(|\brequire\s*\(/.test(text))
    found.push('side-effect, dynamic or require import');
  return found;
}

const PERSISTENCE_RULES: Record<string, RegExp> = {
  'Context Broker, runtime, baseline, API or Root':
    /@aven\/(context-broker|runtime|baseline|api|root)|ContextCandidate|confidence|salience|\bRoot\b|\bauthority\b|\bALLOW\b|PolicyDecision/,
  'network, file, process or environment':
    /\bnode:|readFile|writeFile|\bfs\.|\bfetch\b|WebSocket|child_process|\bspawn\s*\(|process\.env|\bglobalThis\b/,
  'clock, randomness or timers':
    /Date\.now|new\s+Date\s*\(|performance\.now|Math\.random|randomUUID|\bcrypto\b|\bset(Timeout|Interval|Immediate)\b/,
  'writes, migration or Ledger append':
    // SQL keywords are matched in upper case (as written in SQL) so that
    // `Object.create` is not a false positive; lower-case SQL phrases too.
    /appendEvent|\bmigrate\b|\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|PRAGMA|ATTACH)\b|\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b|\.exec\s*\(|\.run\s*\(|\.pragma\s*\(|BEGIN\s+(IMMEDIATE|EXCLUSIVE)/,
  'projection or event tables read directly':
    /lifecycle_records|experience_events|\bevidence\s+WHERE|record_references|latest_learned/,
  'writer or transition-application API':
    /\b(save|write|update|delete|promote|revoke|supersede|apply|restore|insert)\w*\s*\(/i,
  'projection inputs or selection':
    /referenceTime|sessionId|taskId|buildDurableCategoryViews|buildActiveTaskView|current|effective|winner|trustedVersion/i,
};

describe('AVEN-009 owner-model persistence subpath tripwires (not runtime security)', () => {
  it('keeps exactly the reviewed persistence modules and surface', async () => {
    expect(persistenceFiles.sort()).toEqual(['index.ts', 'rebuild.ts']);
    expect(persistenceEntries.filter((e) => !e.isFile())).toEqual([]);
    const surface = await import('../src/persistence/index.ts');
    expect(Object.keys(surface).sort()).toEqual(['rebuildOwnerModel']);
  });

  it('imports only the reviewed storage, Ledger and contract names and owner-model modules', () => {
    expect(persistenceImportViolations(persistenceCode)).toEqual([]);
    for (const bad of [
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { migrate } from '@aven/storage';`,
      `import { openStorage } from '@aven/storage';`,
      `import { createLedger, LedgerError } from '@aven/ledger';`,
      `import * as storage from '@aven/storage';`,
      `import { readFileSync } from 'node:fs';`,
      `import Database from 'better-sqlite3';`,
      `const m = await import('@aven/storage');`,
    ])
      expect(persistenceImportViolations(bad), bad).not.toEqual([]);
  });

  for (const [rule, pattern] of Object.entries(PERSISTENCE_RULES))
    it(`has no ${rule}`, () => {
      expect(pattern.test(persistenceCode), rule).toBe(false);
    });

  it('rejects known-bad persistence samples', () => {
    for (const [rule, bad] of [
      ['writes, migration or Ledger append', `ledger.appendEvent(input);`],
      ['writes, migration or Ledger append', `migrate(storage.sqlite);`],
      [
        'writes, migration or Ledger append',
        `storage.sqlite.prepare('UPDATE learned_owner_state SET x = 1').run();`,
      ],
      [
        'writes, migration or Ledger append',
        `storage.sqlite.exec('DELETE FROM active_task_state');`,
      ],
      [
        'writes, migration or Ledger append',
        `const sql = 'INSERT INTO owners VALUES (?, ?)';`,
      ],
      [
        'writes, migration or Ledger append',
        `const sql = 'insert into owners values (?, ?)';`,
      ],
      [
        'projection or event tables read directly',
        `prepare('SELECT record_json FROM lifecycle_records WHERE owner_id = ?')`,
      ],
      [
        'projection or event tables read directly',
        `prepare('SELECT record_json FROM experience_events WHERE owner_id = ?')`,
      ],
      [
        'writer or transition-application API',
        `export function saveOwnerState(state) {}`,
      ],
      [
        'writer or transition-application API',
        `applyRollback(record, transition);`,
      ],
      [
        'projection inputs or selection',
        `rebuildOwnerModel(storage, ownerId, { referenceTime })`,
      ],
      [
        'projection inputs or selection',
        `const current = pickTrusted(history);`,
      ],
      [
        'Context Broker, runtime, baseline, API or Root',
        `return { kind: 'owner_state', confidence: 1 } as ContextCandidate;`,
      ],
      [
        'Context Broker, runtime, baseline, API or Root',
        `if (transition.authority.decision === 'ALLOW') trusted = true;`,
      ],
      ['clock, randomness or timers', `const now = Date.now();`],
      [
        'network, file, process or environment',
        `const raw = readFileSync(path);`,
      ],
    ] as const)
      expect(PERSISTENCE_RULES[rule]!.test(bad), bad).toBe(true);
  });

  it('selects only owner-scoped snapshot rows, ordered by identity', () => {
    const sql = [...persistenceCode.matchAll(/'([^']*\bSELECT\b[^']*)'/gi)].map(
      (m) => m[1],
    );
    expect(sql).toEqual([
      'SELECT record_json FROM learned_owner_state WHERE owner_id = ? ORDER BY record_id, record_version',
      'SELECT record_json FROM active_task_state WHERE owner_id = ? ORDER BY record_id, record_version',
    ]);
    // Every FROM in the code is one of those two owner-scoped selections.
    expect((persistenceCode.match(/\bFROM\b/g) ?? []).length).toBe(2);
  });

  it('keeps the core pure: no core module reaches storage, the Ledger or the subpath', () => {
    for (const [file, text] of Object.entries(source)) {
      expect(/@aven\/(storage|ledger)/.test(text), file).toBe(false);
      expect(/from\s+['"]\.\/persistence/.test(text), file).toBe(false);
    }
    expect(
      importViolations(
        `import { rebuildOwnerModel } from './persistence/index.ts';`,
      ),
    ).not.toEqual([]);
    expect(
      importViolations(`import { createLedger } from '@aven/ledger';`),
    ).not.toEqual([]);
  });
});

/**
 * AVEN-009 patch 8: static regression tripwires for the read-only Context
 * Broker source adapter subpath (pattern checks over code, not isolation).
 */
const contextDir = new URL('../src/context-source/', import.meta.url);
const contextEntries = readdirSync(contextDir, { withFileTypes: true });
const contextFiles = contextEntries
  .filter((e) => e.isFile())
  .map((e) => e.name);
const contextCode = contextFiles
  .map((f) => code(readFileSync(new URL(f, contextDir), 'utf8')))
  .join('\n');

const CONTEXT_IMPORTS: Record<string, ReadonlySet<string>> = {
  '@aven/contracts': new Set([
    'ActiveTaskState',
    'DurableOwnerState',
    'OwnerId',
  ]),
  '@aven/context-broker': new Set([
    'ContextCandidateSchema',
    'ContextCandidate',
    'ContextSource',
    'ContextSourceKind',
    'ContextSourceQuery',
  ]),
  'node:crypto': new Set(['createHash']),
};
function contextImportViolations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /\b(?:import|export)\b\s*(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)?\s*from\s+(['"])([^'"]+)\2/gs,
  )) {
    const module = m[3] ?? '';
    if (/^\.\.?\/([\w-]+\/)?[\w-]+\.ts$/.test(module)) {
      if (module.startsWith('../') && module.split('/').length > 2)
        if (module !== '../persistence/rebuild.ts') found.push(module);
      continue;
    }
    const allowed = CONTEXT_IMPORTS[module];
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
  if (/\bimport\s*['"]|\bimport\s*\(|\brequire\s*\(/.test(text))
    found.push('side-effect, dynamic or require import');
  return found;
}

const CONTEXT_RULES: Record<string, RegExp> = {
  'runtime, API, baseline, storage, Ledger, Root or a new Broker':
    /@aven\/(runtime|api|baseline|storage|ledger|root)|createContextBroker|rebuildOwnerModel\s*\(|openStorage|createLedger/,
  'network, file, process or environment':
    /node:(?!crypto['"])|readFile|writeFile|\bfs\.|\bfetch\b|WebSocket|child_process|\bspawn\s*\(|process\.env|\bglobalThis\b/,
  'clock, randomness or timers':
    /Date\.now|new\s+Date\s*\(|performance\.now|Math\.random|randomUUID|randomBytes|getRandomValues|\bset(Timeout|Interval|Immediate)\b/,
  'permission or authority':
    /\b(ALLOW|DENY|REQUIRE_OWNER_APPROVAL)\b|PolicyDecision|permission|authori[sz]|approved/,
  'current instruction, prompt assembly or correction':
    /current_instruction|prompt|systemMessage|\brole\s*:|messages\s*[:=]|correct|override|negative.?signal/i,
  'ranking, relevance or retrieval':
    /relevan|\brank|\bscore|freshness|trustFactor|scopeFactor|weight|embedding|vector|cosine|similarity/i,
  'text parsing, truncation or trimming':
    /\.slice\s*\(|substring|substr\s*\(|truncat|\.padEnd|\.includes\s*\(|\.indexOf\s*\(|\.test\s*\(|\.match\s*\(|RegExp|toLowerCase|toUpperCase|\.trim\s*\(/,
  'writes or transition application':
    /appendEvent|\bmigrate\b|\b(INSERT|UPDATE|DELETE|REPLACE)\b|\b(save|write|promote|revoke|supersede|apply|restore)\w*\s*\(/,
};

describe('AVEN-009 owner-model context-source subpath tripwires (not runtime security)', () => {
  it('keeps exactly the reviewed adapter modules and surface', async () => {
    expect(contextFiles.sort()).toEqual(['index.ts', 'sources.ts']);
    expect(contextEntries.filter((e) => !e.isFile())).toEqual([]);
    const surface = await import('../src/context-source/index.ts');
    expect(Object.keys(surface).sort()).toEqual([
      'AVEN_OWNER_MODEL_SOURCE_CONFIG_V1',
      'createOwnerModelContextSources',
    ]);
  });

  it('imports only the reviewed Broker, contract and crypto names and owner-model modules', () => {
    expect(contextImportViolations(contextCode)).toEqual([]);
    for (const bad of [
      `import { createContextBroker } from '@aven/context-broker';`,
      `import { RANKING_WEIGHTS_BASIS_POINTS } from '@aven/context-broker';`,
      `import * as broker from '@aven/context-broker';`,
      `import { openStorage } from '@aven/storage';`,
      `import { randomUUID } from 'node:crypto';`,
      `import { readFileSync } from 'node:fs';`,
      `import { invokeModelRuntime } from '@aven/runtime';`,
      `import { secret } from '../../ledger/src/index.ts';`,
    ])
      expect(contextImportViolations(bad), bad).not.toEqual([]);
  });

  for (const [rule, pattern] of Object.entries(CONTEXT_RULES))
    it(`has no ${rule}`, () => {
      expect(pattern.test(contextCode), rule).toBe(false);
    });

  it('rejects known-bad adapter samples', () => {
    for (const [rule, bad] of [
      [
        'current instruction, prompt assembly or correction',
        `reference: { kind: 'current_instruction', evidence, task }`,
      ],
      [
        'current instruction, prompt assembly or correction',
        `const systemPrompt = candidates.map((c) => c.text).join('\\n');`,
      ],
      [
        'current instruction, prompt assembly or correction',
        `if (record.provenance.kind === 'explicit_owner_correction') narrow(scope);`,
      ],
      [
        'ranking, relevance or retrieval',
        `candidates.sort((a, b) => b.score - a.score);`,
      ],
      [
        'ranking, relevance or retrieval',
        `const relevance = coverage(query.request, text);`,
      ],
      ['text parsing, truncation or trimming', `text: text.slice(0, 20000),`],
      [
        'text parsing, truncation or trimming',
        `if (text.includes('trusted')) lifecycle = 'trusted';`,
      ],
      [
        'text parsing, truncation or trimming',
        `return candidates.slice(0, query.maxCandidates);`,
      ],
      [
        'permission or authority',
        `if (record.provenance.kind === 'owner_approval') decision = 'ALLOW';`,
      ],
      ['clock, randomness or timers', `const id = \`om:\${Date.now()}\`;`],
      ['clock, randomness or timers', `const salt = Math.random();`],
      [
        'runtime, API, baseline, storage, Ledger, Root or a new Broker',
        `const broker = createContextBroker({ sources });`,
      ],
      ['writes or transition application', `ledger.appendEvent(event);`],
    ] as const)
      expect(CONTEXT_RULES[rule]!.test(bad), bad).toBe(true);
  });

  it('sets negativeRetrieval only from the frozen v1 constant', () => {
    const uses = [
      ...contextCode.matchAll(/negativeRetrieval\s*:\s*([^,\n}]+)/g),
    ].map((m) => m[1]!.trim());
    expect(uses.sort()).toEqual([
      '0',
      'CONFIG.negativeRetrieval',
      'CONFIG.negativeRetrieval',
    ]);
  });

  it('keeps @aven/context-broker out of the core and persistence modules', () => {
    for (const [file, text] of Object.entries(source))
      expect(
        /@aven\/context-broker|from\s+['"]\.\/context-source/.test(text),
        file,
      ).toBe(false);
    expect(/@aven\/context-broker/.test(persistenceCode)).toBe(false);
  });
});
