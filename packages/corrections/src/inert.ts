import { types } from 'node:util';

/**
 * Inert copying of caller-supplied data (shared by the patch 3 recorder and
 * the patch 4 resolver; moved here unchanged from the recorder so the pure
 * root can use it without the Ledger subpath).
 *
 * Copies into null-prototype objects and plain arrays WITHOUT running caller
 * code: Proxies are refused before any reflective read, only own enumerable
 * data properties are read (an accessor is refused unread), symbol keys,
 * non-plain prototypes, sparse or decorated arrays, functions, undefined,
 * bigint and non-finite numbers are refused, and the depth, node, array and
 * string bounds hold. Inherited fields are never read. The realm's own
 * intrinsics are trusted, as in AVEN-009. `node:util` is used only for its
 * side-effect-free Proxy check.
 */
export interface InertLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
}

/** Internal sentinel for a rejected raw value; it never leaves this module. */
const REJECT = Object.freeze({ rejected: true });

function inert(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  limits: InertLimits,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes) throw REJECT;
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) throw REJECT;
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw REJECT;
    return value;
  }
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'object') throw REJECT;
  if (depth >= limits.maxDepth || types.isProxy(value)) throw REJECT;
  const prototype = Object.getPrototypeOf(value) as unknown;
  const keys = Reflect.ownKeys(value);
  const read = (key: string): unknown => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw REJECT;
    return inert(descriptor.value, depth + 1, budget, limits);
  };
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw REJECT;
    const length = keys.length - 1;
    if (length > limits.maxArrayLength) throw REJECT;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor?.value !== length) throw REJECT;
    const copy: unknown[] = [];
    for (let i = 0; i < length; i += 1) copy.push(read(String(i)));
    return copy;
  }
  if (prototype !== Object.prototype && prototype !== null) throw REJECT;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw REJECT;
    Object.defineProperty(copy, key, {
      value: read(key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** An inert copy, or `undefined` when the value is refused for any reason. */
export function inertCopy(
  value: unknown,
  limits: InertLimits,
): { readonly copy: unknown } | undefined {
  try {
    return { copy: inert(value, 0, { nodes: 0 }, limits) };
  } catch {
    // Any failure to copy (the sentinel or otherwise) means "refused".
    return undefined;
  }
}
