import { TimestampSchema } from '@aven/contracts';

/**
 * Exact instants for Root's temporal checks (AVEN-012).
 *
 * Root compares proposal creation, approval issuance, expiry and age, grant
 * windows and its own evaluation time. A `Date` would round every timestamp
 * to milliseconds, while the frozen AVEN-002 `TimestampSchema` accepts any
 * fraction length, so two different instants could compare as equal. Instants
 * here are exact: integer (BigInt) arithmetic for the proleptic Gregorian
 * date, the time and the UTC offset, and a digit-exact fraction with trailing
 * zeros removed (they carry no precision). Strings are never rewritten.
 */
export interface Instant {
  /** Whole UTC seconds since 1970-01-01T00:00:00Z. */
  readonly seconds: bigint;
  /** Significant fraction digits (no trailing zeros). */
  readonly fraction: string;
}

/**
 * The fields of an RFC 3339 timestamp in exactly the form the frozen
 * `TimestampSchema` (`z.iso.datetime({ offset: true })`) accepts: seconds
 * always present, a fraction of any length, `Z` or a `+hh:mm`/`-hh:mm`
 * offset. Calendar validity is the schema's; it is checked first.
 */
const FIELDS =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Days from 1970-01-01 to a proleptic Gregorian date (exact integers). */
function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  const y = month <= 2n ? year - 1n : year;
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yearOfEra = y - era * 400n;
  const dayOfYear = (153n * (month > 2n ? month - 3n : month + 9n) + 2n) / 5n;
  const dayOfEra =
    yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear + day - 1n;
  return era * 146097n + dayOfEra - 719468n;
}

/** The exact instant of a frozen-schema timestamp, or `undefined`. */
export function instantOf(timestamp: unknown): Instant | undefined {
  if (!TimestampSchema.safeParse(timestamp).success) return undefined;
  const m = (timestamp as string).match(FIELDS);
  if (m === null) return undefined;
  const [, year, month, day, hour, minute, second] = m;
  const fraction = m[7] ?? '';
  let significant = fraction.length;
  while (significant > 0 && fraction[significant - 1] === '0') significant -= 1;
  const offsetMinutes =
    m[8] === undefined
      ? 0n
      : (m[8] === '-' ? -1n : 1n) *
        (BigInt(m[9] ?? '0') * 60n + BigInt(m[10] ?? '0'));
  const local =
    daysFromCivil(BigInt(year!), BigInt(month!), BigInt(day!)) * 86400n +
    BigInt(hour!) * 3600n +
    BigInt(minute!) * 60n +
    BigInt(second!);
  return {
    seconds: local - offsetMinutes * 60n,
    fraction: fraction.slice(0, significant),
  };
}

/** Orders two instants exactly: -1, 0 or 1. */
export function compareInstants(a: Instant, b: Instant): -1 | 0 | 1 {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  // Without trailing zeros, the order of the digit strings is the numeric
  // order of the fractions: the first differing digit decides, and a proper
  // prefix is smaller because the longer fraction ends in a non-zero digit.
  if (a.fraction === b.fraction) return 0;
  return a.fraction < b.fraction ? -1 : 1;
}

/** The instant a whole number of seconds later (or earlier, if negative). */
export function shiftSeconds(instant: Instant, seconds: number): Instant {
  return {
    seconds: instant.seconds + BigInt(seconds),
    fraction: instant.fraction,
  };
}

/**
 * Orders two timestamps by the instants they denote, or `undefined` when
 * either is not a frozen-schema timestamp.
 */
export function compareTimestamps(
  a: unknown,
  b: unknown,
): -1 | 0 | 1 | undefined {
  const x = instantOf(a);
  const y = instantOf(b);
  if (x === undefined || y === undefined) return undefined;
  return compareInstants(x, y);
}
