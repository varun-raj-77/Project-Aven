import { compareCodeUnits } from './canonical-text.ts';

/**
 * Exact instant comparison of frozen AVEN-002 timestamps (internal; no
 * clock). Extracted unchanged from Patch-2 intake so that Patch-5 views use
 * the same rule: whole seconds and offset through Date.parse, then any
 * fractional digits compared at full precision (never rounded to
 * milliseconds), so offsets and long fractions compare as instants.
 * Returns `undefined` when either text is not of the frozen shape; callers
 * decide which fixed failure that is.
 */
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function compareInstants(a: string, b: string): number | undefined {
  const [x, y] = [a.match(TIMESTAMP), b.match(TIMESTAMP)];
  if (x === null || y === null) return undefined;
  const [msA, msB] = [
    Date.parse(`${x[1]}${x[3]}`),
    Date.parse(`${y[1]}${y[3]}`),
  ];
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) return undefined;
  if (msA !== msB) return msA < msB ? -1 : 1;
  const [fa, fb] = [x[2] ?? '', y[2] ?? ''];
  const width = Math.max(fa.length, fb.length);
  return compareCodeUnits(fa.padEnd(width, '0'), fb.padEnd(width, '0'));
}
