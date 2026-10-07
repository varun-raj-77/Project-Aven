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
 *     (a JavaScript, bound or proxied function fails). This native filter
 *     only guarantees that the probes below never invoke caller JavaScript;
 *     it is not treated as proof of identity;
 *   - every baseline method of BOTH prototypes passes a fixed semantic probe
 *     on fresh local values (see ARRAY_PROBES / OBJECT_PROBES), so a
 *     same-named native from another intrinsic (for example
 *     Uint8Array.prototype.some or String.prototype.at) fails, and the
 *     constructors are exactly Object and Array;
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
 * Per-call seal: after full verification, `sealAmbient` records the exact
 * verified keys and descriptors of both prototypes for THIS intake call (see
 * below), and intake re-checks that seal after every caller-controlled
 * reflective operation, because a caller-supplied Proxy can run code there.
 *
 * Trusted runtime (assumed untampered for the whole call; outside owner
 * input, which is passive data, but NOT verified here): Reflect,
 * Object.hasOwn / create / defineProperty / freeze / keys, Array.isArray,
 * the global Object and Array bindings, Function.prototype.toString,
 * String.prototype.match, RegExp, Symbol, Map, the array-iterator
 * prototype, Number/JSON primitives and the language operators. Actively
 * verified: every own property of Object.prototype and Array.prototype.
 * Tampering with a trusted intrinsic is tampering with the runtime itself,
 * which needs realm isolation, not an in-realm check.
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

/* ------------------------------------------------------------------------
 * Semantic probes (M1). A native function's name proves only that it is
 * SOME built-in with that initial name: `Uint8Array.prototype.some` is a
 * native `some` too. Each baseline method is therefore also exercised, via
 * Reflect.apply, on fresh local probe values with fixed expected results
 * that only the genuine Object.prototype / Array.prototype built-in
 * produces (a TypedArray method throws on an ordinary array; a String
 * method coerces it to text). The native-name check above runs first, so a
 * probe only ever invokes engine-native code, never caller JavaScript.
 * Probes touch only their own local values: no realm or owner state.
 * ---------------------------------------------------------------------- */

type Probe = (method: unknown) => boolean;

const call = (method: unknown, receiver: unknown, args: unknown[]): unknown =>
  Reflect.apply(method as (...values: unknown[]) => unknown, receiver, args);

/** An ordinary array equal element-wise (Object.is) to `expected`. */
function list(value: unknown, expected: readonly unknown[]): boolean {
  if (
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expected.length
  )
    return false;
  for (let i = 0; i < expected.length; i += 1)
    if (!Object.is(value[i], expected[i])) return false;
  return true;
}

/** The successive `value`s of a built-in iterator (at most `limit`). */
function drain(iterator: unknown, limit: number): unknown[] | undefined {
  if (iterator === null || typeof iterator !== 'object') return undefined;
  const next = (iterator as { next?: unknown }).next;
  const out: unknown[] = [];
  for (let i = 0; i <= limit; i += 1) {
    const step = call(next, iterator, []) as {
      done?: unknown;
      value?: unknown;
    };
    if (step.done === true) return out;
    out[out.length] = step.value;
  }
  return undefined;
}

/** Copies probes into a frozen null-prototype table (no inherited lookup). */
function probeTable(
  probes: Record<string, Probe>,
): Readonly<Record<string, Probe>> {
  const table = Object.create(null) as Record<string, Probe>;
  const names = Object.keys(probes);
  for (let i = 0; i < names.length; i += 1)
    table[names[i]!] = probes[names[i]!]!;
  return Object.freeze(table);
}

const even = (n: unknown) => typeof n === 'number' && n % 2 === 0;

const ARRAY_PROBES = probeTable({
  at: (m: unknown) => call(m, [10, 20, 30], [-1]) === 30,
  concat: (m: unknown) => list(call(m, [1], [[2], 3]), [1, 2, 3]),
  copyWithin: (m: unknown) =>
    list(call(m, [1, 2, 3, 4, 5], [0, 3]), [4, 5, 3, 4, 5]),
  fill: (m: unknown) => list(call(m, [1, 2, 3], [0, 1]), [1, 0, 0]),
  find: (m: unknown) => call(m, [1, 2, 3], [(n: number) => n > 1]) === 2,
  findIndex: (m: unknown) => call(m, [1, 2, 3], [(n: number) => n > 1]) === 1,
  findLast: (m: unknown) => call(m, [1, 2, 3], [(n: number) => n < 3]) === 2,
  findLastIndex: (m: unknown) =>
    call(m, [1, 2, 3], [(n: number) => n < 3]) === 1,
  lastIndexOf: (m: unknown) => call(m, [1, 2, 1], [1]) === 2,
  pop: (m: unknown) => {
    const a = [1, 2];
    return call(m, a, []) === 2 && list(a, [1]);
  },
  push: (m: unknown) => {
    const a = [1];
    return call(m, a, [2, 3]) === 3 && list(a, [1, 2, 3]);
  },
  reverse: (m: unknown) => {
    const a = [1, 2, 3];
    return call(m, a, []) === a && list(a, [3, 2, 1]);
  },
  shift: (m: unknown) => {
    const a = [1, 2];
    return call(m, a, []) === 1 && list(a, [2]);
  },
  unshift: (m: unknown) => {
    const a = [2];
    return call(m, a, [0, 1]) === 3 && list(a, [0, 1, 2]);
  },
  slice: (m: unknown) => list(call(m, [1, 2, 3, 4], [1, 3]), [2, 3]),
  sort: (m: unknown) => {
    const lexical = [10, 9, 1];
    const numeric = [10, 9, 1];
    const stable = [
      { k: 1, v: 'a' },
      { k: 0, v: 'b' },
      { k: 1, v: 'c' },
    ];
    call(m, stable, [(x: { k: number }, y: { k: number }) => x.k - y.k]);
    return (
      call(m, lexical, []) === lexical &&
      list(lexical, [1, 10, 9]) &&
      list(call(m, numeric, [(x: number, y: number) => x - y]), [1, 9, 10]) &&
      stable[0]!.v === 'b' &&
      stable[1]!.v === 'a' &&
      stable[2]!.v === 'c'
    );
  },
  splice: (m: unknown) => {
    const a = [1, 2, 3, 4];
    return list(call(m, a, [1, 2, 'x']), [2, 3]) && list(a, [1, 'x', 4]);
  },
  includes: (m: unknown) =>
    call(m, [1, Number.NaN], [Number.NaN]) === true &&
    call(m, ['a'], ['b']) === false &&
    call(m, [[1]], ['1']) === false,
  indexOf: (m: unknown) =>
    call(m, [1, 2, Number.NaN], [Number.NaN]) === -1 &&
    call(m, [1, 2], [2]) === 1,
  join: (m: unknown) => call(m, [1, null, 'a'], ['-']) === '1--a',
  keys: (m: unknown) => list(drain(call(m, ['a', 'b'], []), 2), [0, 1]),
  entries: (m: unknown) => {
    const pairs = drain(call(m, ['a'], []), 1);
    return (
      pairs !== undefined && pairs.length === 1 && list(pairs[0], [0, 'a'])
    );
  },
  values: (m: unknown) => list(drain(call(m, ['a', 'b'], []), 2), ['a', 'b']),
  forEach: (m: unknown) => {
    let sum = 0;
    return (
      call(m, [1, 2, 3], [(n: number) => (sum += n)]) === undefined && sum === 6
    );
  },
  filter: (m: unknown) => list(call(m, [1, 2, 3, 4], [even]), [2, 4]),
  flat: (m: unknown) => {
    const inner = [3];
    const out = call(m, [1, [2, inner]], []);
    return list(out, [1, 2, inner]);
  },
  flatMap: (m: unknown) =>
    list(call(m, [1, 2], [(n: number) => [n, n]]), [1, 1, 2, 2]),
  map: (m: unknown) =>
    list(call(m, [1, 2, 3], [(n: number) => n * 2]), [2, 4, 6]),
  every: (m: unknown) =>
    call(m, [2, 4], [even]) === true && call(m, [2, 3], [even]) === false,
  some: (m: unknown) =>
    call(m, [1, 3], [even]) === false && call(m, [1, 2], [even]) === true,
  reduce: (m: unknown) =>
    call(m, [1, 2, 3], [(a: string, n: number) => `${a}${n}`, '']) === '123',
  reduceRight: (m: unknown) =>
    call(m, [1, 2, 3], [(a: string, n: number) => `${a}${n}`, '']) === '321',
  toReversed: (m: unknown) => {
    const a = [1, 2, 3];
    return list(call(m, a, []), [3, 2, 1]) && list(a, [1, 2, 3]);
  },
  toSorted: (m: unknown) => {
    const a = ['b', 'a'];
    return list(call(m, a, []), ['a', 'b']) && list(a, ['b', 'a']);
  },
  toSpliced: (m: unknown) => list(call(m, [1, 2, 3], [1, 1]), [1, 3]),
  with: (m: unknown) => list(call(m, [1, 2, 3], [1, 9]), [1, 9, 3]),
  toLocaleString: (m: unknown) => call(m, [1, 'a'], []) === '1,a',
  toString: (m: unknown) => call(m, [1, [2, 3]], []) === '1,2,3',
});

const OBJECT_PROBES = probeTable({
  hasOwnProperty: (m: unknown) =>
    call(m, { a: 1 }, ['a']) === true && call(m, {}, ['toString']) === false,
  isPrototypeOf: (m: unknown) =>
    call(m, Array.prototype, [[]]) === true && call(m, {}, [[]]) === false,
  propertyIsEnumerable: (m: unknown) =>
    call(m, { a: 1 }, ['a']) === true && call(m, [], ['length']) === false,
  toString: (m: unknown) =>
    call(m, [], []) === '[object Array]' &&
    call(m, null, []) === '[object Null]',
  valueOf: (m: unknown) => {
    const o = {};
    return call(m, o, []) === o;
  },
  toLocaleString: (m: unknown) =>
    call(m, { toString: () => 'probe' }, []) === 'probe',
  __defineGetter__: (m: unknown) => {
    const o = {};
    const get = () => 1;
    call(m, o, ['k', get]);
    return Reflect.getOwnPropertyDescriptor(o, 'k')?.get === get;
  },
  __defineSetter__: (m: unknown) => {
    const o = {};
    const set = () => undefined;
    call(m, o, ['k', set]);
    return Reflect.getOwnPropertyDescriptor(o, 'k')?.set === set;
  },
  __lookupGetter__: (m: unknown) => {
    const get = () => 1;
    const o = Object.create(null) as object;
    Reflect.defineProperty(o, 'k', { get, configurable: true });
    return call(m, Object.create(o), ['k']) === get;
  },
  __lookupSetter__: (m: unknown) => {
    const set = () => undefined;
    const o = Object.create(null) as object;
    Reflect.defineProperty(o, 'k', { set, configurable: true });
    return call(m, Object.create(o), ['k']) === set;
  },
});

function probe(target: object, key: string, check: Probe | undefined): boolean {
  if (check === undefined) return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value'))
    return false;
  try {
    return check(descriptor.value) === true;
  } catch {
    return false;
  }
}

/** Every baseline method behaves as the genuine built-in (run after shape). */
function semanticsAreStandard(): boolean {
  const object = Object.prototype;
  const array = Array.prototype;
  for (let i = 0; i < OBJECT_PROTOTYPE_KEYS.length; i += 1) {
    const key = OBJECT_PROTOTYPE_KEYS[i]!;
    if (key === 'constructor' || key === '__proto__') continue;
    if (!probe(object, key, OBJECT_PROBES[key])) return false;
  }
  for (let i = 0; i < ARRAY_PROTOTYPE_KEYS.length; i += 1) {
    const key = ARRAY_PROTOTYPE_KEYS[i]!;
    if (key === 'constructor' || key === 'length') continue;
    if (!probe(array, key, ARRAY_PROBES[key])) return false;
  }
  const objectConstructor = Reflect.getOwnPropertyDescriptor(
    object,
    'constructor',
  );
  const arrayConstructor = Reflect.getOwnPropertyDescriptor(
    array,
    'constructor',
  );
  const proto = Reflect.getOwnPropertyDescriptor(object, '__proto__');
  if (
    objectConstructor?.value !== Object ||
    arrayConstructor?.value !== Array ||
    proto === undefined ||
    !Object.hasOwn(proto, 'get')
  )
    return false;
  try {
    const plain = {};
    Reflect.apply(proto.set as (v: unknown) => void, plain, [null]);
    return (
      Reflect.apply(proto.get as () => unknown, [], []) === Array.prototype &&
      Reflect.getPrototypeOf(plain) === null
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------
 * Per-call seal (H1). Caller-supplied Proxies run caller JavaScript during
 * intake's reflective reads, and that code could pollute the prototypes
 * AFTER the entry check. `sealAmbient` performs the full verification above
 * and then records the exact verified own keys and descriptors of both
 * prototypes FOR THIS CALL ONLY (never at import). `ambientIntact` compares
 * the current state with that seal by identity, reading descriptors only and
 * using no prototype method, so it is cheap enough to run after every
 * caller-controlled operation; any change at all reports false.
 * ---------------------------------------------------------------------- */

interface PrototypeSeal {
  readonly target: object;
  readonly prototype: object | null;
  readonly keys: readonly PropertyKey[];
  readonly descriptors: readonly PropertyDescriptor[];
}

/** Opaque proof that this call's ambient state was verified. */
export interface AmbientSeal {
  readonly object: PrototypeSeal;
  readonly array: PrototypeSeal;
}

const DESCRIPTOR_FIELDS = Object.freeze([
  'value',
  'get',
  'set',
  'writable',
  'enumerable',
  'configurable',
] as const);

function sealOf(target: object): PrototypeSeal {
  const keys = Reflect.ownKeys(target);
  const descriptors: PropertyDescriptor[] = [];
  for (let i = 0; i < keys.length; i += 1)
    descriptors[i] = Reflect.getOwnPropertyDescriptor(target, keys[i]!)!;
  return Object.freeze({
    target,
    prototype: Reflect.getPrototypeOf(target),
    keys: Object.freeze(keys),
    descriptors: Object.freeze(descriptors),
  });
}

function intact(seal: PrototypeSeal): boolean {
  if (Reflect.getPrototypeOf(seal.target) !== seal.prototype) return false;
  const keys = Reflect.ownKeys(seal.target);
  if (keys.length !== seal.keys.length) return false;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== seal.keys[i]) return false;
    const now = Reflect.getOwnPropertyDescriptor(seal.target, keys[i]!);
    const then = seal.descriptors[i]!;
    if (now === undefined) return false;
    for (let f = 0; f < DESCRIPTOR_FIELDS.length; f += 1) {
      const field = DESCRIPTOR_FIELDS[f]!;
      const has = Object.hasOwn(now, field);
      if (has !== Object.hasOwn(then, field)) return false;
      if (has && now[field] !== then[field]) return false;
    }
  }
  return true;
}

/**
 * Full verification (pinned key sets, attributes, native filter, semantic
 * probes) followed by this call's seal; undefined when unsafe. Reads
 * descriptors only on the prototypes; may throw only if an intrinsic it
 * trusts was replaced (callers treat a throw as unsafe).
 */
export function sealAmbient(): AmbientSeal | undefined {
  if (
    !objectPrototypeIsStandard() ||
    !arrayPrototypeIsStandard() ||
    !semanticsAreStandard()
  )
    return undefined;
  return Object.freeze({
    object: sealOf(Object.prototype),
    array: sealOf(Array.prototype),
  });
}

/** Whether both prototypes are exactly as sealed (descriptors only). */
export function ambientIntact(seal: AmbientSeal): boolean {
  return intact(seal.object) && intact(seal.array);
}

/** Whether the realm currently passes full verification. */
export function ambientPrototypesAreStandard(): boolean {
  return sealAmbient() !== undefined;
}
