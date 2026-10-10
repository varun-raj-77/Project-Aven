/**
 * AVEN-010 corrections: package identity (patch 2 scaffold).
 *
 * This module holds identification constants only. It defines no applicability
 * rule, ordering rule, target rule, rendering, ranking signal or any other
 * correction semantics; later AVEN-010 patches add those deliberately, each
 * with its own review (the context-source configuration belongs to patch 6).
 * The configuration object is deeply frozen at runtime and pinned by a test.
 */
export const AVEN_010_CORRECTIONS_VERSION = 'aven-010-corrections-v1';

/** Recursively freezes acyclic plain data (objects and arrays) and returns it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const CORRECTIONS_CONFIG = deepFreeze({
  version: AVEN_010_CORRECTIONS_VERSION,
  /** The frozen milestone this package is built on; it changes none of it. */
  frozenBaseline: {
    tag: 'aven-009',
    commit: '80057a217adb90132c5b6bc1c6a5c0f798db08c5',
  },
  /** The only frozen AVEN-002 contract schema version this package reads. */
  contractSchemaVersion: 1,
} as const);
export type CorrectionsConfiguration = typeof CORRECTIONS_CONFIG;
