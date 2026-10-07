/**
 * AVEN-009 ambient-prototype gate (internal; not part of the public API).
 *
 * Why: the frozen AVEN-002 owner-state schema (Zod) builds its parse output
 * from ORDINARY objects and arrays and its refinements then read fields from
 * them. A property inherited from Object.prototype or Array.prototype (data,
 * getter or setter) at a field the record does not own, or at a field whose
 * assignment it intercepts, is therefore visible to that frozen code and can
 * change its verdict: reproduced, for example, an inherited `domain` value
 * makes a bounded scope with no boundary pass, and an inherited `lifecycle`
 * getter makes a self-replacing superseded record pass. Owner-model cannot
 * change how the frozen schema allocates its objects, so it refuses to run it
 * at all unless both prototypes are exactly standard.
 *
 * Baseline (explicit, pinned, never captured at import time, so pollution
 * installed before this module loads is still refused): the ECMAScript 2023
 * own properties of Object.prototype and Array.prototype as implemented by
 * the repository's pinned Node 24 engine, listed below with each built-in's
 * [[InitialName]]. "Exactly standard" means:
 *   - the prototype chain is unchanged (Object.prototype -> null,
 *     Array.prototype -> Object.prototype);
 *   - the own key set is exactly the baseline (no added, missing or symbol
 *     key, no array index, Array.prototype.length still 0);
 *   - every baseline method is a non-enumerable, writable, configurable data
 *     property whose value is a native built-in whose spec-mandated
 *     Function.prototype.toString form carries the expected initial name
 *     (a JavaScript, bound, proxied or swapped function fails);
 *   - `__proto__` is the native get/set accessor pair; Array.prototype's
 *     Symbol.iterator is its native `values`, and Symbol.unscopables is a
 *     non-writable data object.
 *
 * Only property DESCRIPTORS are read: no getter or setter on either
 * prototype is ever invoked, and no ordinary property read reaches them.
 * Any deviation (or any throw while inspecting) makes intake fail closed with
 * the fixed `invalid_input` error; the key, value or descriptor is never
 * reported. A runtime that adds a standard method this baseline does not list
 * also fails closed until the baseline is reviewed.
 *
 * Scope boundary: this protects against ambient state on the two prototypes
 * the frozen schema's own objects and arrays inherit from. It trusts the
 * other intrinsics it uses (Function.prototype.toString, Reflect, Object,
 * Array.isArray, String.prototype.match, RegExp), and it cannot tell a
 * native built-in from a DIFFERENT native built-in of the same initial name
 * installed in its place; replacing intrinsics is tampering with the runtime
 * itself, which needs realm isolation, not an in-realm check.
 */

const OBJECT_PROTOTYPE_KEYS: readonly string[] = Object.freeze([
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  'hasOwnProperty',
  '__lookupGetter__',
  '__lookupSetter__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'valueOf',
  '__proto__',
  'toLocaleString',
]);

const ARRAY_PROTOTYPE_KEYS: readonly string[] = Object.freeze([
  'length',
  'constructor',
  'at',
  'concat',
  'copyWithin',
  'fill',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'lastIndexOf',
  'pop',
  'push',
  'reverse',
  'shift',
  'unshift',
  'slice',
  'sort',
  'splice',
  'includes',
  'indexOf',
  'join',
  'keys',
  'entries',
  'values',
  'forEach',
  'filter',
  'flat',
  'flatMap',
  'map',
  'every',
  'some',
  'reduce',
  'reduceRight',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with',
  'toLocaleString',
  'toString',
]);

/** Null-prototype membership table: lookups never reach a prototype. */
function membership(keys: readonly string[]): Record<string, true> {
  const table = Object.create(null) as Record<string, true>;
  for (let i = 0; i < keys.length; i += 1) table[keys[i]!] = true;
  return Object.freeze(table);
}
const OBJECT_KEYS = membership(OBJECT_PROTOTYPE_KEYS);
const ARRAY_KEYS = membership(ARRAY_PROTOTYPE_KEYS);

/* ES2019+ Function.prototype.toString form of a built-in (NativeFunction). */
const NATIVE_FUNCTION =
  /^function\s+(?:([gs]et)\s+)?([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/;

/** The initial name of a native built-in function, or undefined. */
function nativeName(value: unknown): string | undefined {
  if (typeof value !== 'function') return undefined;
  const toText = Reflect.getOwnPropertyDescriptor(
    Function.prototype,
    'toString',
  );
  if (
    toText === undefined ||
    !Object.hasOwn(toText, 'value') ||
    typeof toText.value !== 'function'
  )
    return undefined;
  const text: unknown = Reflect.apply(toText.value, value, []);
  if (typeof text !== 'string') return undefined;
  const parts = text.match(NATIVE_FUNCTION);
  if (parts === null) return undefined;
  return parts[1] === undefined ? parts[2] : `${parts[1]} ${parts[2]}`;
}

/** A standard method: native, named as expected, standard attributes. */
function standardMethod(
  target: object,
  key: PropertyKey,
  name: string,
): boolean {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    descriptor.writable === true &&
    descriptor.enumerable === false &&
    descriptor.configurable === true &&
    nativeName(descriptor.value) === name
  );
}

function objectPrototypeIsStandard(): boolean {
  const target = Object.prototype;
  if (Reflect.getPrototypeOf(target) !== null) return false;
  const keys = Reflect.ownKeys(target);
  if (keys.length !== OBJECT_PROTOTYPE_KEYS.length) return false;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (typeof key !== 'string' || OBJECT_KEYS[key] !== true) return false;
    if (key === '__proto__') {
      const accessor = Reflect.getOwnPropertyDescriptor(target, key);
      if (
        accessor === undefined ||
        !Object.hasOwn(accessor, 'get') ||
        accessor.enumerable !== false ||
        accessor.configurable !== true ||
        nativeName(accessor.get) !== 'get __proto__' ||
        nativeName(accessor.set) !== 'set __proto__'
      )
        return false;
    } else if (
      !standardMethod(target, key, key === 'constructor' ? 'Object' : key)
    )
      return false;
  }
  return true;
}

function arrayPrototypeIsStandard(): boolean {
  const target = Array.prototype;
  if (
    !Array.isArray(target) ||
    Reflect.getPrototypeOf(target) !== Object.prototype
  )
    return false;
  const keys = Reflect.ownKeys(target);
  if (keys.length !== ARRAY_PROTOTYPE_KEYS.length + 2) return false;
  let iterator = false;
  let unscopables = false;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === Symbol.iterator) {
      const values = Reflect.getOwnPropertyDescriptor(target, 'values');
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (
        !standardMethod(target, key, 'values') ||
        values === undefined ||
        own === undefined ||
        own.value !== values.value
      )
        return false;
      iterator = true;
    } else if (key === Symbol.unscopables) {
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (
        own === undefined ||
        !Object.hasOwn(own, 'value') ||
        typeof own.value !== 'object' ||
        own.value === null ||
        own.writable !== false ||
        own.enumerable !== false ||
        own.configurable !== true
      )
        return false;
      unscopables = true;
    } else if (typeof key !== 'string' || ARRAY_KEYS[key] !== true) {
      return false;
    } else if (key === 'length') {
      const length = Reflect.getOwnPropertyDescriptor(target, key);
      if (
        length === undefined ||
        !Object.hasOwn(length, 'value') ||
        length.value !== 0 ||
        length.writable !== true ||
        length.enumerable !== false ||
        length.configurable !== false
      )
        return false;
    } else if (
      !standardMethod(target, key, key === 'constructor' ? 'Array' : key)
    ) {
      return false;
    }
  }
  return iterator && unscopables;
}

/**
 * Whether Object.prototype and Array.prototype are exactly the pinned
 * standard baseline. Reads descriptors only; may throw only if an intrinsic
 * it trusts was replaced (the caller treats a throw as unsafe).
 */
export function ambientPrototypesAreStandard(): boolean {
  return objectPrototypeIsStandard() && arrayPrototypeIsStandard();
}
