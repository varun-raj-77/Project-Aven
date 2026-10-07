/**
 * AVEN-009 Typed Owner Model: package identity (patch 1 scaffold).
 *
 * This module holds identification constants only. It defines no ranking
 * weight, confidence mapping, lifecycle rule, scope rule, source-adapter
 * setting or any other owner-state semantics; later AVEN-009 patches add those
 * deliberately, each with its own review. The configuration object is deeply
 * frozen at runtime and pinned by a test.
 */
export const AVEN_009_OWNER_MODEL_VERSION = 'aven-009-owner-model-v1';

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

export const OWNER_MODEL_CONFIG = deepFreeze({
  version: AVEN_009_OWNER_MODEL_VERSION,
  /** The frozen milestone this package is built on; it changes none of it. */
  frozenBaseline: {
    tag: 'aven-008',
    commit: '4174080998d383fe78e8e4799e13103d42635151',
  },
  /** The only frozen AVEN-002 contract schema version this package reads. */
  contractSchemaVersion: 1,
} as const);
export type OwnerModelConfiguration = typeof OWNER_MODEL_CONFIG;
