/*
 * AVEN-010 patch 7: SYNTHETIC reproduction of a resource observation in the
 * FROZEN storage and Ledger layers, found while characterizing the
 * cross-layer pipeline. Not part of `pnpm test` or `pnpm check`; it changes
 * no frozen code. Run from the repository root with Node 24:
 *
 *   node --expose-gc packages/corrections/bench/statement-retention.bench.ts [appends]
 *
 * It reports process RSS (after a forced GC) for, on one open in-memory
 * connection with the frozen AVEN-003 schema:
 *   1. repeated `prepare` of the trigger-guarded evidence INSERT (never run);
 *   2. one prepared INSERT statement reused, run inside a rolled-back
 *      transaction;
 *   3. closing that connection and repeating step 1 on a new one;
 *   4. ordinary frozen Ledger `appendEvent` calls (default 1000), which
 *      prepare their statements on every call.
 * Observed on the AVEN-010 builder (Linux, Node 24.21.0): native memory grows
 * with every preparation of a trigger-guarded statement while the
 * connection stays open (the JS heap does not), a reused statement does not
 * grow, and closing the connection makes the memory reusable. Figures are
 * coarse process observations of this machine, not a heap profile.
 */
import { world, A } from '../test/recorder-fixtures.ts';
import { ordinary } from '../test/cross-layer-fixtures.ts';

const appends = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(appends) || appends < 1)
  throw new Error('appends must be a positive integer');
const gc = (globalThis as { gc?: () => void }).gc;
const INSERT = 'INSERT INTO evidence(record_json) VALUES (?)';

function rss(label: string): number {
  gc?.();
  const { rss: bytes, heapUsed } = process.memoryUsage();
  console.log(
    `${label.padEnd(58)} rss ${(bytes / 1048576).toFixed(0).padStart(5)} MiB, heap ${(heapUsed / 1048576).toFixed(0)} MiB`,
  );
  return bytes;
}

console.log(
  `node ${process.version}; gc ${gc ? 'forced' : 'not exposed (pass --expose-gc)'}`,
);
const first = world(':memory:');
const start = rss('fresh connection with the frozen schema');
for (let i = 0; i < 300; i += 1) first.sqlite.prepare(INSERT);
const prepared = rss('300 prepares of the evidence INSERT (never run)');
const statement = first.sqlite.prepare(INSERT);
const sample = first.sqlite
  .prepare('SELECT record_json FROM evidence WHERE owner_id = ? LIMIT 1')
  .get(A) as { record_json: string };
first.sqlite.exec('BEGIN');
for (let i = 0; i < 300; i += 1) {
  const record = JSON.parse(sample.record_json) as Record<string, unknown>;
  record['id'] = `evidence_retention_${i}`;
  statement.run(JSON.stringify(record));
}
first.sqlite.exec('ROLLBACK');
const reused = rss('300 runs of ONE reused prepared INSERT (rolled back)');
first.close();
const second = world(':memory:');
for (let i = 0; i < 300; i += 1) second.sqlite.prepare(INSERT);
const again = rss('closed; 300 prepares again on a new connection');
second.close();
const third = world(':memory:');
const before = rss(`new connection before ${appends} frozen Ledger appends`);
for (let i = 1; i <= appends; i += 1) ordinary(third, A, `retention_${i}`);
const after = rss(`after ${appends} frozen Ledger appends (connection open)`);
third.close();
console.log(
  `\nper prepare (open connection): ${((prepared - start) / 300 / 1024).toFixed(1)} KiB; ` +
    `reused statement, 300 runs: ${((reused - prepared) / 1048576).toFixed(1)} MiB; ` +
    `prepares after close: ${((again - reused) / 1048576).toFixed(1)} MiB; ` +
    `per Ledger append: ${((after - before) / appends / 1024).toFixed(1)} KiB`,
);
