import { SCORE_DECIMALS } from './config.ts';

/** Number of Unicode code points (a surrogate pair counts once). */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** The first `max` code points of `text`; never splits a surrogate pair. */
export function truncateCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/** Locale-independent comparison by UTF-16 code unit; stable on every platform. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SCALE = 10 ** SCORE_DECIMALS;

/**
 * Rounds a score to `SCORE_DECIMALS` decimal places so that ordering and the
 * trace do not depend on the last bits of a floating-point computation.
 */
export function quantize(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

/** Recursively freezes acyclic plain data (objects and arrays) and returns it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
