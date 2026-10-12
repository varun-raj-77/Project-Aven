/*
 * AVEN-010 patch 7: SYNTHETIC, diagnostic cross-layer characterization. Not
 * part of `pnpm test` or `pnpm check`. Run from the repository root with
 * Node 24 (native type stripping):
 *
 *   node --expose-gc packages/corrections/bench/cross-layer.bench.ts [repeats] [sizes...]
 *
 * Defaults: 5 timed repeats after one warm-up, sizes 0 100 1000 1205. For
 * each size and distribution it builds ONE file-backed SQLite database
 * through the real recorder and frozen Ledger (an unrelated event after
 * every 7th correction, so sequences have gaps), then times SEPARATELY:
 *   - fixture:  recording every correction (once; not repeated);
 *   - replay:   `readCorrectionHistory` (frozen Ledger paging, 100 per page);
 *   - index:    `buildCorrectionEvidenceIndex`;
 *   - resolve:  `resolveImmediateCorrections` for one task binding;
 *   - broker:   the frozen Broker alone over the same base sources plus the
 *               same instruction candidates `assembleWithCorrections` offers
 *               (rebuilt here in the accepted D7/D8 shape);
 *   - verify:   exposure verification alone over that Broker result;
 *   - assemble: the whole `assembleWithCorrections` call (its own
 *               resolution, wrapping, Broker assembly and verification).
 * Distributions: `chained` (every correction explicitly supersedes the
 * previous one in its own scope, so one task sees two active corrections)
 * and `flat` (every correction is a distinct active current_task instruction
 * for one task, which exercises the Broker's item and candidate limits).
 * Times are milliseconds, median [min-max]. Memory figures are
 * `process.memoryUsage()` observations after a forced GC when `--expose-gc`
 * is given; they are coarse and not a heap profile. These are measurements
 * of this machine only: no SLA is implied, and no result here is an
 * experiment result.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  createContextBroker,
  type ContextCandidate,
  type ContextSource,
} from '@aven/context-broker';
import { createHash } from 'node:crypto';
import {
  CORRECTION_INSTRUCTION_SOURCE_ID,
  assembleWithCorrections,
} from '../src/context-source/index.ts';
import {
  verifyExposure,
  type RequiredInstruction,
} from '../src/context-source/integration.ts';
import { resolveImmediateCorrections } from '../src/index.ts';
import {
  buildCorrectionEvidenceIndex,
  readCorrectionHistory,
  recordOwnerCorrection,
  type CorrectionReceipt,
} from '../src/ledger/index.ts';
import {
  A,
  ordinary,
  OTHER_TASK,
  scenarioRequest,
  scenarioSources,
  SESSION,
  TASK,
} from '../test/cross-layer-fixtures.ts';
import { observed, submission, world } from '../test/recorder-fixtures.ts';

const [repeatsArg, ...sizeArgs] = process.argv.slice(2);
const repeats = repeatsArg === undefined ? 5 : Number(repeatsArg);
const sizes = sizeArgs.length > 0 ? sizeArgs.map(Number) : [0, 100, 1000, 1205];
if (!Number.isInteger(repeats) || repeats < 1)
  throw new Error('repeats must be a positive integer');

const REFERENCE = '2099-01-01T00:00:00Z';
const gc = (globalThis as { gc?: () => void }).gc;
const scratch = mkdtempSync(join(tmpdir(), 'aven-p7-bench-'));

type Kind = 'chained' | 'flat';

function build(kind: Kind, n: number, filename: string) {
  const storage = world(filename);
  const last = new Map<string, CorrectionReceipt>();
  const started = performance.now();
  for (let i = 1; i <= n; i += 1) {
    const scope =
      kind === 'flat'
        ? 'task'
        : i % 3 === 0
          ? 'session'
          : i % 2 === 0
            ? 'task'
            : 'other';
    const previous = last.get(scope);
    const target =
      kind === 'flat' || previous === undefined
        ? { kind: 'unidentified', description: `Synthetic ${i}` }
        : i % 2 === 0
          ? { kind: 'event', eventId: previous.eventId }
          : {
              kind: 'evidence',
              reference: {
                evidenceId: previous.evidenceId,
                eventId: previous.eventId,
              },
            };
    const receipt = recordOwnerCorrection(
      storage,
      submission({
        taskId: scope === 'other' ? OTHER_TASK : TASK,
        immediateApplicability:
          scope === 'session' ? 'current_session' : 'current_task',
        target,
        correctedInstruction: `Synthetic ${i}: quarterly report rule ${i}.`,
      }),
      {
        now: () => new Date('2026-01-01T00:00:00Z'),
        generateId: (prefix) => `${prefix}_bench_${i}`,
      },
    );
    last.set(scope, receipt);
    if (i % 7 === 0) ordinary(storage, A, `bench_unrelated_${i}`);
  }
  return { storage, fixtureMs: performance.now() - started };
}

/** The accepted D7/D8 instruction candidate, rebuilt for the Broker phase. */
function instruction(
  correction: ReturnType<typeof resolveImmediateCorrections>['active'][number],
): RequiredInstruction {
  const candidateId = `correction:${createHash('sha256')
    .update(
      JSON.stringify([
        'aven-010-correction-instruction-id-v1',
        A,
        SESSION,
        TASK,
        correction.eventId,
        correction.evidence.evidenceId,
      ]),
      'utf8',
    )
    .digest('hex')}`;
  const candidate: ContextCandidate = {
    candidateId,
    ownerId: A,
    reference: {
      kind: 'current_instruction',
      evidence: { ...correction.evidence },
      task: { sessionId: SESSION, taskId: TASK },
    },
    provenance: {
      kind: 'explicit_owner_correction',
      ownerId: A,
      sourceEventId: correction.eventId,
    },
    scope: { kind: 'bounded', taskId: TASK },
    text: correction.correctedInstruction,
    timestamps: { recordedAt: correction.recordedAt },
    signals: { confidence: 1, salience: 1, negativeRetrieval: 0 },
  };
  return {
    identity: {
      correctionEventId: correction.eventId,
      evidenceId: correction.evidence.evidenceId,
      candidateId,
    },
    candidate,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const fmt = (xs: number[]) =>
  `${median(xs).toFixed(2)} [${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}]`;
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

async function measure(phase: () => unknown | Promise<unknown>) {
  await phase(); // warm-up
  const times: number[] = [];
  for (let r = 0; r < repeats; r += 1) {
    const start = performance.now();
    await phase();
    times.push(performance.now() - start);
  }
  return times;
}

function memory() {
  gc?.();
  const m = process.memoryUsage();
  return `rss ${mb(m.rss)} MiB, heap ${mb(m.heapUsed)} MiB`;
}

console.log('AVEN-010 patch 7 cross-layer characterization (SYNTHETIC)');
console.log(
  `node ${process.version}; ${platform()} ${release()} ${arch()}; ${cpus().length}x ${cpus()[0]?.model ?? 'unknown cpu'}; ${mb(totalmem())} MiB RAM; gc ${gc ? 'forced' : 'not exposed'}; repeats ${repeats}`,
);
try {
  for (const kind of ['chained', 'flat'] as const)
    for (const n of sizes) {
      const filename = join(scratch, `${kind}-${n}.sqlite`);
      const { storage, fixtureMs } = build(kind, n, filename);
      try {
        const { storage: watched, calls } = observed(storage);
        readCorrectionHistory(watched, A);
        const pages = calls.filter((c) =>
          /^SELECT sequence, record_json FROM experience_events WHERE/.test(
            c.sql,
          ),
        ).length;
        const history = readCorrectionHistory(storage, A);
        const binding = { ownerId: A, sessionId: SESSION, taskId: TASK };
        const asOf = { referenceTime: REFERENCE, throughSequence: null };
        const view = resolveImmediateCorrections(history, binding, asOf);
        const required = view.active.map(instruction);
        const sources = (): ContextSource[] => [
          ...scenarioSources(),
          Object.freeze({
            sourceId: CORRECTION_INSTRUCTION_SOURCE_ID,
            kind: 'active_task' as const,
            collect: () => required.map((r) => structuredClone(r.candidate)),
          }),
        ];
        const request = scenarioRequest(A, SESSION, TASK, REFERENCE);
        let brokerStatus = 'ok';
        let assembly: Awaited<
          ReturnType<ReturnType<typeof createContextBroker>['assemble']>
        > | null = null;
        const broker = await measure(async () => {
          try {
            assembly = await createContextBroker({
              sources: sources(),
            }).assemble(request);
          } catch (error) {
            brokerStatus = (error as { code?: string }).code ?? 'error';
          }
        });
        const verify =
          assembly === null
            ? null
            : await measure(() => verifyExposure(required, assembly!, binding));
        const outcome = await assembleWithCorrections({
          history,
          request,
          sources: scenarioSources(),
          throughSequence: null,
        });
        const status =
          outcome.status === 'exposed'
            ? `exposed (${outcome.exposed.length})`
            : `not_exposed: ${outcome.reason}${outcome.brokerErrorCode ? `/${outcome.brokerErrorCode}` : ''} (missing ${outcome.missing.length})`;
        const rows: [string, string][] = [
          ['fixture', `${fixtureMs.toFixed(2)} (once)`],
          [
            'replay',
            fmt(await measure(() => readCorrectionHistory(storage, A))),
          ],
          [
            'index',
            fmt(await measure(() => buildCorrectionEvidenceIndex(history))),
          ],
          [
            'resolve',
            fmt(
              await measure(() =>
                resolveImmediateCorrections(history, binding, asOf),
              ),
            ),
          ],
          ['broker', `${fmt(broker)} (${brokerStatus})`],
          ['verify', verify === null ? 'n/a (Broker refused)' : fmt(verify)],
          [
            'assemble',
            fmt(
              await measure(() =>
                assembleWithCorrections({
                  history,
                  request,
                  sources: scenarioSources(),
                  throughSequence: null,
                }),
              ),
            ),
          ],
        ];
        console.log(
          `\n${kind} n=${n}: corrections ${history.entries.length}, replay pages ${pages}, active for task ${view.active.length}, outcome ${status}; ${memory()}`,
        );
        for (const [phase, value] of rows)
          console.log(`  ${phase.padEnd(8)} ${value}`);
      } finally {
        storage.close();
      }
    }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
