import { describe, expect, it } from 'vitest';
import {
  ACTION_PROPOSAL_ERROR_CODES,
  ACTION_PROPOSAL_OUTCOMES,
  ActionProposalError,
  type ActionProposalErrorCode,
  type ActionProposalOutcome,
} from '../src/index.ts';

describe('ActionProposalError: a fixed, caller-proof error surface', () => {
  it('pins the accepted code set and the three outcomes', () => {
    expect(ACTION_PROPOSAL_ERROR_CODES).toEqual([
      'invalid_request',
      'binding_mismatch',
      'unsupported_proposal',
      'unsupported_origin',
      'operation_not_in_v1_format',
      'timestamp_order',
      'unknown_binding',
      'unresolved_reference',
      'identifier_collision',
      'ledger_rejected',
      'storage_failure',
      'invalid_history',
      'internal_error',
    ]);
    expect(ACTION_PROPOSAL_OUTCOMES).toEqual([
      'not_written',
      'rolled_back',
      'unknown',
    ]);
    expect(Object.isFrozen(ACTION_PROPOSAL_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ACTION_PROPOSAL_OUTCOMES)).toBe(true);
  });

  it.each(ACTION_PROPOSAL_ERROR_CODES)(
    'has one fixed message, no cause and a frozen instance for %s',
    (code) => {
      const a = new ActionProposalError(code);
      const b = new ActionProposalError(code, 'rolled_back');
      expect(a.message).toBe(b.message);
      expect(a.message.length).toBeGreaterThan(0);
      expect(a.cause).toBeUndefined();
      expect(a.name).toBe('ActionProposalError');
      expect(a.outcome).toBe('not_written');
      expect(b.outcome).toBe('rolled_back');
      expect(Object.isFrozen(a)).toBe(true);
      expect(a).toBeInstanceOf(Error);
    },
  );

  it('gives every code a distinct message without authority wording', () => {
    const messages = ACTION_PROPOSAL_ERROR_CODES.map(
      (code) => new ActionProposalError(code).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages)
      expect(message).not.toMatch(
        /\b(allow|allowed|approve|approved|grant|granted|permit)\b/i,
      );
  });

  it('normalizes untyped input conservatively', () => {
    const unknownCode = new ActionProposalError(
      'not_a_code' as ActionProposalErrorCode,
    );
    expect(unknownCode.code).toBe('internal_error');
    const unknownOutcome = new ActionProposalError(
      'invalid_request',
      'written' as ActionProposalOutcome,
    );
    // An unrecognized outcome is never reported as a confirmed non-write.
    expect(unknownOutcome.outcome).toBe('unknown');
  });

  it('serializes exactly name, code, outcome and message, in order', () => {
    const error = new ActionProposalError('binding_mismatch');
    const json = error.toJSON();
    expect(Object.getPrototypeOf(json)).toBeNull();
    expect(Object.isFrozen(json)).toBe(true);
    expect(Object.keys(json)).toEqual(['name', 'code', 'outcome', 'message']);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'ActionProposalError',
      code: 'binding_mismatch',
      outcome: 'not_written',
      message: error.message,
    });
  });

  it('cannot be relabeled', () => {
    const error = new ActionProposalError('invalid_request');
    expect(() => {
      (error as { code: string }).code = 'internal_error';
    }).toThrow(TypeError);
    expect(() => {
      (error as { name: string }).name = 'Other';
    }).toThrow(TypeError);
    expect(Object.getOwnPropertyDescriptor(error, 'name')).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    });
  });
});
