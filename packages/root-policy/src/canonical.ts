import { createHash } from 'node:crypto';

/**
 * Canonical JSON and domain-tagged SHA-256 for Root (AVEN-012).
 *
 * Root recomputes the AVEN-011 proposal digest (protocol v1) itself instead
 * of importing the proposing package, and uses the same canonical form for
 * its own policy digest under a different domain tag. The canonical text is
 * RFC 8785-compatible for this value domain only: plain objects (members
 * sorted by key as UTF-16 code units), arrays (stored order), well-formed
 * strings (escaped exactly as ECMAScript `JSON.stringify` escapes a
 * well-formed string) and non-negative safe integers (shortest decimal).
 * Anything else (booleans, null, negative or fractional numbers, unpaired
 * surrogates, non-plain prototypes) is outside the domain and has no
 * canonical text. No Unicode normalization is applied.
 *
 * Digest input: the ASCII domain tag, one 0x00 byte, then the UTF-8 bytes of
 * the canonical text. A matching digest shows that a payload and a declared
 * value agree under the protocol; it says nothing about who wrote either.
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

/** Every string, keys included, of plain data is well-formed UTF-16. */
export function wellFormedThroughout(value: unknown): boolean {
  if (typeof value === 'string') return isWellFormed(value);
  if (Array.isArray(value)) return value.every(wellFormedThroughout);
  if (value !== null && typeof value === 'object')
    return Object.keys(value).every(
      (key) =>
        isWellFormed(key) &&
        wellFormedThroughout((value as Record<string, unknown>)[key]),
    );
  return true;
}

/** Internal sentinel for a value outside the domain; never leaves the module. */
const OUTSIDE = Object.freeze({ outside: true });

function encode(value: unknown): string {
  switch (typeof value) {
    case 'string':
      if (!isWellFormed(value)) throw OUTSIDE;
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
        throw OUTSIDE;
      return String(value);
    case 'object': {
      if (value === null) throw OUTSIDE;
      if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) throw OUTSIDE;
      const record = value as Record<string, unknown>;
      return (
        '{' +
        Object.keys(record)
          .sort()
          .map((key) => {
            if (!isWellFormed(key)) throw OUTSIDE;
            return JSON.stringify(key) + ':' + encode(record[key]);
          })
          .join(',') +
        '}'
      );
    }
    default:
      throw OUTSIDE;
  }
}

/** The canonical text, or `undefined` when the value is outside the domain. */
export function canonicalText(value: unknown): string | undefined {
  try {
    return encode(value);
  } catch (error) {
    if (error === OUTSIDE) return undefined;
    throw error;
  }
}

/** Lowercase hex SHA-256 of the ASCII tag, 0x00 and the UTF-8 text. */
export function taggedSha256(tag: string, text: string): string {
  return createHash('sha256')
    .update(Buffer.from(tag, 'ascii'))
    .update(Buffer.from([0]))
    .update(Buffer.from(text, 'utf8'))
    .digest('hex');
}

/** True when both values have the same canonical text (and both have one). */
export function canonicallyEqual(a: unknown, b: unknown): boolean {
  const x = canonicalText(a);
  return x !== undefined && x === canonicalText(b);
}
