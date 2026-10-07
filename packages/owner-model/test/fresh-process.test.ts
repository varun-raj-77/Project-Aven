import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { durable, T1 } from './fixtures.ts';

/**
 * AVEN-009 patch 2 (M2): PRE-IMPORT pollution, in a FRESH Node process.
 *
 * Each case starts a new process, installs prototype pollution BEFORE
 * @aven/owner-model is imported, imports it, and calls intake with a request
 * Proxy that counts every reflective read. If the ambient baseline were
 * captured from the realm at import time, the pollution would be adopted as
 * "safe": the polluted call would be accepted and/or the later clean call
 * would fail. Test code only: node:child_process never appears in src.
 * A case whose import itself fails is reported as `imported: false` and
 * FAILS this test; it is never counted as a passing intake result.
 */
const INDEX = new URL('../src/index.ts', import.meta.url).href;
const OWNER = 'owner_synthetic_a';

const valid = durable();
const unbounded = {
  ...durable(),
  scope: { kind: 'bounded', qualifiers: { recipient: 'synthetic' } },
};
const selfReplacing = {
  ...durable({ id: 'learned_x' }),
  lifecycle: {
    status: 'superseded',
    supersededAt: T1,
    replacement: { learnedItemId: 'learned_x', version: 1 },
    eventId: 'event_x',
  },
};

/** Runs in the child, as an ES module. `CASE` and data arrive via argv. */
const CHILD = `
const [caseName, indexUrl, owner, recordText, validText] = process.argv.slice(1);
const record = JSON.parse(recordText);
const validRecord = JSON.parse(validText);
let hookCalls = 0;
const installs = {
  'object-unrelated': [Object.prototype, 'syntheticUnrelated', { value: 'INHERITED', writable: true }],
  'object-domain': [Object.prototype, 'domain', { value: 'forged domain', writable: true }],
  'object-lifecycle-getter': [Object.prototype, 'lifecycle', { get() { hookCalls += 1; return { status: 'observed' }; } }],
  'array-unrelated': [Array.prototype, 'syntheticUnrelated', { value: 'INHERITED', writable: true }],
  'array-index': [Array.prototype, '7', { value: 'INHERITED', writable: true }],
  'array-some-native': [Array.prototype, 'some', { value: Uint8Array.prototype.some, writable: true }],
};
const [target, key, descriptor] = installs[caseName];
const before = Object.getOwnPropertyDescriptor(target, key);
const length = Array.isArray(target) ? target.length : undefined;
Object.defineProperty(target, key, { ...descriptor, configurable: true });
let mod;
try {
  mod = await import(indexUrl);
} catch {
  process.stdout.write(JSON.stringify({ imported: false }));
  process.exit(0);
}
let reads = 0;
const counted = (inner) => new Proxy(inner, {
  getPrototypeOf(t) { reads += 1; return Reflect.getPrototypeOf(t); },
  ownKeys(t) { reads += 1; return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, k) { reads += 1; return Reflect.getOwnPropertyDescriptor(t, k); },
});
const outcome = (call) => {
  try {
    const result = call();
    return 'accepted:' + result.durable.length;
  } catch (error) {
    return error instanceof mod.OwnerModelError ? JSON.stringify(error) : 'raw';
  }
};
const polluted = outcome(() => mod.intakeOwnerState(counted({ ownerId: owner, records: [record] })));
const readsWhilePolluted = reads;
if (before === undefined) Reflect.deleteProperty(target, key);
else Object.defineProperty(target, key, before);
if (length !== undefined) target.length = length;
const clean = outcome(() => mod.intakeOwnerState({ ownerId: owner, records: [validRecord] }));
process.stdout.write(JSON.stringify({ imported: true, polluted, readsWhilePolluted, hookCalls, clean }));
`;

function fresh(caseName: string, record: unknown) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--no-warnings',
      '-e',
      CHILD,
      caseName,
      INDEX,
      OWNER,
      JSON.stringify(record),
      JSON.stringify(valid),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as {
    imported: boolean;
    polluted?: string;
    readsWhilePolluted?: number;
    hookCalls?: number;
    clean?: string;
  };
}

const INVALID_INPUT = JSON.stringify({
  name: 'OwnerModelError',
  code: 'invalid_input',
  message: 'The owner-model input is malformed; no owner state was read',
});

describe('AVEN-009 intake: pollution installed before import (fresh process)', () => {
  it.each([
    ['object-unrelated', valid],
    ['object-domain', unbounded],
    ['object-lifecycle-getter', selfReplacing],
    ['array-unrelated', valid],
    ['array-index', valid],
    ['array-some-native', valid],
  ] as const)(
    'fails closed for %s and never adopts it as the trusted baseline',
    (caseName, record) => {
      const result = fresh(caseName, record);
      expect(result.imported, `${caseName}: module import must succeed`).toBe(
        true,
      );
      expect(result.polluted).toBe(INVALID_INPUT);
      expect(result.readsWhilePolluted).toBe(0);
      expect(result.hookCalls).toBe(0);
      // The same module instance accepts a valid record once the realm is
      // clean again, so the pre-import pollution was never its baseline.
      expect(result.clean).toBe('accepted:1');
    },
  );
});
