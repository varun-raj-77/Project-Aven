/*
 * AVEN-010 Codex remediation R2: SYNTHETIC, non-production resolver
 * benchmark. Not part of `pnpm test` or `pnpm check` (Vitest collects only
 * `packages/<name>/test/<file>.test.ts`). Run from the repository root with
 * Node 24 (native type stripping):
 *
 *   node packages/corrections/bench/resolve.bench.ts [samples] [sizes...]
 *
 * Defaults: 5 timed samples after one warm-up, sizes 1000 5000 10000 20000
 * 40000, distributions A (no supersession: unique unidentified targets) and
 * B (long chains with branching explicit links); see `test/scale-fixtures.ts`.
 * For each size it reports, separately:
 *   - generate: building the synthetic history (fixture cost, not resolver);
 *   - schema:   parsing every event and evidence record with the frozen
 *               AVEN-002 schemas outside the resolver (an approximation of the
 *               resolver's own validation cost, which is not separately
 *               observable);
 *   - link:     the supersession step alone (`linkSupersessions`) over every
 *               correction as applicable;
 *   - resolve:  the whole `resolveImmediateCorrections` call (inert copy,
 *               schema validation, consistency checks, as-of, applicability,
 *               linkage, view construction and deep freeze).
 * Times are milliseconds: median [min-max] over the samples. Timings depend
 * on the machine; they are measurements of this environment, not claims
 * about any other.
 */
import { cpus, platform, arch, release } from 'node:os';
import { EvidenceRecordSchema, ExperienceEventSchema } from '@aven/contracts';
import { resolveImmediateCorrections } from '../src/index.ts';
import { linkSupersessions } from '../src/resolve.ts';
import {
  distributionA,
  distributionB,
  scaleAsOf,
  scaleHistory,
  scaleQuery,
  type ScaleEntry,
  type ScaleSpec,
} from '../test/scale-fixtures.ts';

type Applicable = Parameters<typeof linkSupersessions>[0][number];

const [samplesArg, ...sizeArgs] = process.argv.slice(2);
const samples = samplesArg === undefined ? 5 : Number(samplesArg);
const sizes =
  sizeArgs.length > 0
    ? sizeArgs.map(Number)
    : [1000, 5000, 10000, 20000, 40000];
if (!Number.isInteger(samples) || samples < 1)
  throw new Error('samples must be a positive integer');

const distributions: readonly [string, (n: number) => ScaleSpec[]][] = [
  ['A', distributionA],
  ['B', distributionB],
];

function time(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const f = (v: number) => v.toFixed(1);
  return `${f(median)} [${f(sorted[0]!)}-${f(sorted.at(-1)!)}]`;
}

const applicableOf = (entries: readonly ScaleEntry[]): Applicable[] =>
  entries.map(
    (entry) =>
      ({
        entry: { sequence: entry.sequence, event: entry.event },
        label: 'current_session',
        origin: { sessionId: 'session_scale', taskId: null },
      }) as unknown as Applicable,
  );

console.log(
  `environment: node ${process.version}, ${platform()} ${release()} ${arch()}, ` +
    `${cpus().length} x ${cpus()[0]?.model ?? 'unknown cpu'}`,
);
console.log(`samples: ${samples} timed (after 1 warm-up) per cell`);
console.log(
  '| dist | entries | generate ms | schema ms | link ms | resolve ms | active | inactive | supersessions |',
);
console.log('|---|---|---|---|---|---|---|---|---|');

for (const [name, distribution] of distributions)
  for (const n of sizes) {
    const generate: number[] = [];
    const schema: number[] = [];
    const link: number[] = [];
    const resolve: number[] = [];
    let counts = '';
    for (let sample = 0; sample <= samples; sample += 1) {
      let history = scaleHistory([]);
      const g = time(() => {
        history = scaleHistory(distribution(n));
      });
      const s = time(() => {
        for (const entry of history.entries) {
          ExperienceEventSchema.parse(entry.event);
          for (const record of entry.evidence)
            EvidenceRecordSchema.parse(record);
        }
      });
      const applicable = applicableOf(history.entries);
      const l = time(() => linkSupersessions(applicable));
      let view: ReturnType<typeof resolveImmediateCorrections> | undefined;
      const r = time(() => {
        view = resolveImmediateCorrections(history, scaleQuery(), scaleAsOf());
      });
      counts = `${view!.active.length} | ${view!.inactive.length} | ${view!.supersessions.length}`;
      if (sample === 0) continue; // warm-up
      generate.push(g);
      schema.push(s);
      link.push(l);
      resolve.push(r);
    }
    console.log(
      `| ${name} | ${n} | ${summary(generate)} | ${summary(schema)} | ${summary(link)} | ${summary(resolve)} | ${counts} |`,
    );
  }
