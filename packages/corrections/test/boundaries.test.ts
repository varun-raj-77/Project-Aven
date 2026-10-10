import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as publicApi from '../src/index.ts';
import {
  AVEN_010_CORRECTIONS_VERSION,
  CORRECTION_ERROR_CODES,
  CORRECTIONS_CONFIG,
  CorrectionError,
} from '../src/index.ts';

/**
 * AVEN-010 patch 2: scaffold behavior plus static REGRESSION TRIPWIRES over
 * the corrections production source. The static rules are pattern checks that
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

/**
 * Exact named imports permitted per external module. Patch 2 imports nothing
 * from either; later patches extend these sets deliberately. Any other
 * module, any `node:*` module and any relative path leaving `src/` fails.
 */
const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  zod: new Set(['z']),
  '@aven/contracts': new Set<string>(),
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

const RULES: Record<string, RegExp[]> = {
  'storage, Ledger, Context Broker, Owner Model, API or other Aven package access':
    [
      /@aven\/(storage|ledger|context-broker|owner-model|api|root|learning|eval|test-utils)\b/,
      /apps\/api|better-sqlite3|drizzle|\bsqlite\b|\.prepare\s*\(|openStorage|createLedger|appendEvent|replayEvents|listEvents|getEvent|createContextBroker|rebuildOwnerModel|\binsert\s+into\b|\bselect\s+.+\s+from\b/i,
      /\b(experience_events|evidence|corrections|learned_owner_state|active_task_state|learning_candidates|lifecycle_records|record_references)\b\s*['"`]/,
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
  'correction recording or Ledger write (patch 3)': [
    /recordOwnerCorrection|record(Owner)?Correction|owner_correction|OwnerCorrectionSchema|CorrectionTargetSchema|ExperienceEvent|EvidenceRecord|evidenceIds|\breceipt\s*[:=]/,
  ],
  'override resolution, history or context source (patches 4-6)': [
    /resolve(Immediate)?(Correction|Override)|override|applicab|current_task|current_session|current_instruction|ContextSource|ContextCandidate|readCorrectionHistory|listCorrectionEvidence/i,
    /negativeRetrieval|salience|confidence|candidateId|suppress|\brank|\bscore\b|exposure|\bexposed\b/i,
  ],
  'state mutation, learning or promotion': [
    /promot|demot|rollback|rolledBack|markTrusted|grantTrust|setLifecycle|assignLifecycle|upgrad|downgrad|supersed|revok/i,
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
function violations(rule: string, text: string): string[] {
  return RULES[rule]!.filter((p) => p.test(text)).map(String);
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
  'correction recording or Ledger write (patch 3)': [
    `export function recordOwnerCorrection(storage, submission) {}`,
    `const event = { eventType: 'owner_correction' };`,
    `import { OwnerCorrectionSchema } from '@aven/contracts';`,
    `const receipt = { accepted: true };`,
  ],
  'override resolution, history or context source (patches 4-6)': [
    `export function resolveImmediateCorrections(history, binding) {}`,
    `const kind = 'current_session';`,
    `const source = { kind: 'current_instruction' };`,
    `candidate.signals.negativeRetrieval = 1;`,
    `const salience = 1;`,
    `function suppress(candidate) {}`,
    `const sessionOverride = {};`,
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
  it('exports exactly identity and the error surface, and nothing that records, resolves or decides', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'AVEN_010_CORRECTIONS_VERSION',
        'CORRECTIONS_CONFIG',
        'CORRECTION_ERROR_CODES',
        'CorrectionError',
      ].sort(),
    );
    const functions = Object.entries(publicApi).filter(
      ([, value]) => typeof value === 'function',
    );
    // The only callable export is the error class: nothing records a
    // correction, mutates state, learns, promotes, decides authority or
    // executes a tool.
    expect(functions.map(([name]) => name)).toEqual(['CorrectionError']);
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
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('AVEN-010 corrections static regression tripwires (not runtime security)', () => {
  it('keeps production modules in a known, reviewed set with no behavior modules yet', () => {
    expect(files.sort()).toEqual(['config.ts', 'errors.ts', 'index.ts']);
    expect(entries.filter((e) => !e.isFile()).map((e) => e.name)).toEqual([]);
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

  it('declares only the root entry and depends only on contracts and zod', () => {
    expect(manifest.name).toBe('@aven/corrections');
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

  it('resolves contracts and zod through its own workspace links, and links nothing else', () => {
    // Checks the package-local links pnpm installed for this manifest. A
    // runtime require.resolve is not used: pnpm's bin shims put the hoisted
    // node_modules/.pnpm/node_modules (holding every workspace package) on
    // NODE_PATH, so it would depend on how the test runner was launched.
    const local = new URL('../node_modules/', import.meta.url);
    const linked = (name: string) => realpathSync(new URL(name, local));
    expect(readdirSync(new URL('@aven/', local)).sort()).toEqual(['contracts']);
    expect(linked('@aven/contracts')).toBe(
      realpathSync(new URL('../../contracts/', import.meta.url)),
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
