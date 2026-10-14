import { createHash } from 'node:crypto';
import { ACTION_PROPOSAL_DIGEST_PROTOCOL } from './config.ts';

/**
 * AVEN-011 canonical proposal digest, protocol v1.
 *
 * Value domain: the JSON value of a strict-parsed AVEN-002 action proposal,
 * that is plain objects, arrays, well-formed strings and non-negative safe
 * integers. Anything else is outside the domain and has no canonical text.
 *
 * Canonical text (RFC 8785-compatible for this domain): object members sorted
 * by key as UTF-16 code units; array elements in their stored order; no
 * whitespace; strings escaped exactly as ECMAScript `JSON.stringify` escapes a
 * well-formed string (`"` `\` and U+0000-U+001F, with \b \t \n \f \r short
 * forms and lowercase \u00xx otherwise; every other code point literal);
 * integers in shortest decimal form. No Unicode normalization is applied.
 *
 * Digest input: the ASCII protocol tag, one 0x00 byte, then the UTF-8 bytes of
 * the canonical text. Strings containing an unpaired surrogate are rejected:
 * UTF-8 cannot encode them, and replacing them would let two different
 * strings share bytes. A matching digest shows only that a payload and a
 * declared value agree under this protocol; it says nothing about who wrote
 * the payload, what the referenced parameter content is, or any approval.
 */

/** True when the string has no unpaired UTF-16 surrogate. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Internal sentinel for a value outside the domain; never leaves the module. */
const OUTSIDE = Object.freeze({ outside: true });

function canonical(value: unknown): string {
  if (typeof value === 'string') {
    if (!isWellFormed(value)) throw OUTSIDE;
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
      throw OUTSIDE;
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value === null || typeof value !== 'object') throw OUTSIDE;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw OUTSIDE;
  const members = Object.keys(value)
    .sort()
    .map((key) => {
      if (!isWellFormed(key)) throw OUTSIDE;
      return (
        JSON.stringify(key) +
        ':' +
        canonical((value as Record<string, unknown>)[key])
      );
    });
  return '{' + members.join(',') + '}';
}

/** The canonical text, or `undefined` when the value is outside the domain. */
export function canonicalText(value: unknown): string | undefined {
  try {
    return canonical(value);
  } catch (error) {
    if (error === OUTSIDE) return undefined;
    throw error;
  }
}

/** Lowercase hex SHA-256 of tag, 0x00 and the UTF-8 canonical text. */
export function digestOfCanonicalText(text: string): string {
  return createHash('sha256')
    .update(Buffer.from(ACTION_PROPOSAL_DIGEST_PROTOCOL, 'ascii'))
    .update(Buffer.from([0]))
    .update(Buffer.from(text, 'utf8'))
    .digest('hex');
}
