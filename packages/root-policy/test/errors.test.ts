import { describe, expect, it } from 'vitest';
import {
  ROOT_POLICY_ERROR_CODES,
  ROOT_POLICY_OUTCOMES,
  RootPolicyError,
} from '../src/index.ts';

describe('RootPolicyError: a fixed, inert failure surface', () => {
  it('has exactly the accepted codes and outcomes', () => {
    expect(ROOT_POLICY_ERROR_CODES).toEqual([
      'invalid_request',
      'invalid_policy',
      'untrusted_policy',
      'untrusted_capability',
      'invalid_proposal',
      'binding_mismatch',
      'unknown_binding',
      'unresolved_reference',
      'identifier_collision',
      'untrusted_evaluation',
      'stale_evaluation',
      'ledger_rejected',
      'storage_failure',
      'invalid_history',
      'internal_error',
    ]);
    expect(ROOT_POLICY_OUTCOMES).toEqual([
      'not_written',
      'rolled_back',
      'unknown',
    ]);
    expect(Object.isFrozen(ROOT_POLICY_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ROOT_POLICY_OUTCOMES)).toBe(true);
  });

  it.each(ROOT_POLICY_ERROR_CODES)(
    '%s carries a fixed message and serializes only fixed fields',
    (code) => {
      const error = new RootPolicyError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('RootPolicyError');
      expect(error.code).toBe(code);
      expect(error.outcome).toBe('not_written');
      expect(error.cause).toBeUndefined();
      expect(error.message.length).toBeGreaterThan(0);
      expect(Object.isFrozen(error)).toBe(true);
      const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual(['name', 'code', 'outcome', 'message']);
      expect(json).toEqual({
        name: 'RootPolicyError',
        code,
        outcome: 'not_written',
        message: error.message,
      });
    },
  );

  it('normalizes untyped codes and outcomes without coercion', () => {
    const forged = new RootPolicyError('ALLOW' as never, 'committed' as never);
    expect(forged.code).toBe('internal_error');
    expect(forged.outcome).toBe('unknown');
    expect(
      new RootPolicyError({ toString: () => 'invalid_policy' } as never).code,
    ).toBe('internal_error');
    expect(new RootPolicyError('storage_failure', 'rolled_back').outcome).toBe(
      'rolled_back',
    );
  });

  it('cannot be redefined after construction', () => {
    const error = new RootPolicyError('invalid_request');
    expect(() => {
      (error as { code: string }).code = 'internal_error';
    }).toThrow();
    expect(() =>
      Object.defineProperty(error, 'name', { value: 'Other' }),
    ).toThrow();
    expect(error.code).toBe('invalid_request');
  });

  it('never echoes caller text in its message', () => {
    const marker = 'CALLER-SECRET-TEXT';
    const error = new RootPolicyError(marker as never);
    expect(error.message).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
  });
});
