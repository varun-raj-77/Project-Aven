import { describe, expect, it } from 'vitest';
import {
  compareTimestamps,
  instantOf,
  shiftSeconds,
  compareInstants,
} from '../src/timestamps.ts';

describe('exact instants for Root temporal checks', () => {
  it('orders sub-millisecond fractions that a Date would merge', () => {
    expect(
      compareTimestamps(
        '2026-10-14T09:00:00.0001Z',
        '2026-10-14T09:00:00.0002Z',
      ),
    ).toBe(-1);
    expect(Date.parse('2026-10-14T09:00:00.0001Z')).toBe(
      Date.parse('2026-10-14T09:00:00.0002Z'),
    );
    expect(
      compareTimestamps(
        '2026-10-14T09:00:00.123456789Z',
        '2026-10-14T09:00:00.12345678Z',
      ),
    ).toBe(1);
  });

  it('treats trailing zeros and equal instants in other offsets as equal', () => {
    expect(
      compareTimestamps('2026-10-14T09:00:00.500Z', '2026-10-14T09:00:00.5Z'),
    ).toBe(0);
    expect(
      compareTimestamps('2026-10-14T09:00:00Z', '2026-10-14T11:30:00+02:30'),
    ).toBe(0);
    expect(
      compareTimestamps('2026-10-14T09:00:00Z', '2026-10-14T08:59:59-00:00'),
    ).toBe(1);
  });

  it('crosses days, months, leap days and years exactly', () => {
    expect(
      compareTimestamps('2028-02-29T23:59:59Z', '2028-03-01T00:00:00Z'),
    ).toBe(-1);
    expect(
      compareTimestamps('2026-12-31T23:30:00-01:00', '2027-01-01T00:29:59Z'),
    ).toBe(1);
  });

  it('refuses anything outside the frozen timestamp form', () => {
    for (const value of [
      '2026-10-14',
      '2026-10-14T09:00Z',
      '2026-10-14 09:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-14T09:00:00',
      1792000000,
      null,
      undefined,
      { toString: () => '2026-10-14T09:00:00Z' },
    ]) {
      expect(instantOf(value)).toBeUndefined();
      expect(compareTimestamps(value, '2026-10-14T09:00:00Z')).toBeUndefined();
    }
  });

  it('shifts by whole seconds without touching the fraction', () => {
    const base = instantOf('2026-10-14T09:00:00.25Z')!;
    const later = shiftSeconds(base, 3600);
    expect(compareInstants(later, instantOf('2026-10-14T10:00:00.25Z')!)).toBe(
      0,
    );
    expect(compareInstants(shiftSeconds(base, -1), base)).toBe(-1);
  });

  it('agrees with Date on millisecond-aligned timestamps (synthetic sweep)', () => {
    const offsets = ['Z', '+05:30', '-08:00', '+14:00', '-12:00'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const sample = () =>
      `${1970 + (next() % 200)}-${pad(1 + (next() % 12))}-${pad(
        1 + (next() % 28),
      )}T${pad(next() % 24)}:${pad(next() % 60)}:${pad(next() % 60)}.${pad(
        next() % 1000,
        3,
      )}${offsets[next() % offsets.length]}`;
    for (let i = 0; i < 2000; i += 1) {
      const a = sample();
      const b = sample();
      const expected = Math.sign(Date.parse(a) - Date.parse(b));
      expect(compareTimestamps(a, b)).toBe(expected === 0 ? 0 : expected);
    }
  });
});
