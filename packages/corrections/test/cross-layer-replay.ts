/*
 * AVEN-010 patch 7: FRESH-PROCESS replay for `cross-layer.test.ts` (not a
 * test file; Vitest collects only `*.test.ts`). The test runs it as a
 * separate Node process:
 *
 *   node packages/corrections/test/cross-layer-replay.ts <database>
 *
 * It opens the SYNTHETIC scenario database on a `query_only` connection, runs
 * the whole read pipeline for every scenario owner and binding with the same
 * synthetic sources and requests, and prints one JSON object: its process
 * ID, the connection's `query_only` state, SQLite's change counter and every
 * row of every table before and after, and each result in the comparable
 * form the test computes in-process. It writes nothing.
 */
import { openStorage } from '@aven/storage';
import {
  A,
  B,
  BINDINGS,
  comparable,
  logicalState,
  pipeline,
  totalChanges,
} from './cross-layer-fixtures.ts';

async function main(filename: string | undefined): Promise<void> {
  if (filename === undefined) throw new Error('database path required');
  const storage = openStorage(filename);
  try {
    storage.sqlite.pragma('query_only = ON');
    const changesBefore = totalChanges(storage);
    const stateBefore = JSON.stringify(logicalState(storage));
    const results: Record<string, string> = {};
    for (const owner of [A, B])
      for (const [sessionId, taskId] of BINDINGS)
        results[`${owner}|${sessionId}|${taskId}`] = comparable(
          await pipeline(storage, owner, sessionId, taskId),
        );
    process.stdout.write(
      JSON.stringify({
        pid: process.pid,
        queryOnly: storage.sqlite.pragma('query_only', { simple: true }),
        changesBefore,
        changesAfter: totalChanges(storage),
        stateBefore,
        stateAfter: JSON.stringify(logicalState(storage)),
        results,
      }),
    );
  } finally {
    storage.close();
  }
}

await main(process.argv[2]);
