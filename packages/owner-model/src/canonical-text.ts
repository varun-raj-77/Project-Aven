/**
 * AVEN-009 canonical own-data text (internal; not part of the public API).
 *
 * Deterministic text of canonical intake data, used for duplicate identity
 * and ordering. It walks OWN enumerable keys (in UTF-16 code-unit order) and
 * dense array indices itself and serializes primitives only, so no `toJSON`,
 * accessor or other inherited hook can take part, independently of the
 * ambient-prototype gate: a primitive string or number given to
 * JSON.stringify is never asked for `toJSON`, and no object or array is ever
 * given to it. This is the ONLY module that may call JSON.stringify (a static
 * test enforces that).
 */

/** Thrown for a value canonical data can never contain (never inspected). */
const UNSERIALIZABLE = Object.freeze({ token: 'unserializable' });

/** Locale-independent comparison by UTF-16 code unit. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw UNSERIALIZABLE;
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    let text = '[';
    for (let i = 0; i < value.length; i += 1)
      text += `${i === 0 ? '' : ','}${canonicalText(value[i])}`;
    return `${text}]`;
  }
  if (value === undefined || typeof value !== 'object') throw UNSERIALIZABLE;
  const record = value as Record<string, unknown>;
  let text = '{';
  let first = true;
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    text += `${first ? '' : ','}${JSON.stringify(key)}:${canonicalText(record[key])}`;
    first = false;
  }
  return `${text}}`;
}
