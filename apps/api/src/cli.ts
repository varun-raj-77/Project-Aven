import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStorage } from '@aven/storage';
import { createApiService } from './service.ts';
import { assertMigrated, startServer } from './server.ts';

// Local development entry point. Loopback only; no credentials, telemetry or
// outbound network. Owner identity is declared by the operator, not authenticated.
// Package managers may forward a literal leading `--`; it carries no meaning here.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    db: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4317' },
    owner: { type: 'string', multiple: true, default: [] },
  },
  strict: true,
});

const defaultDatabase = fileURLToPath(
  new URL('../../../data/aven.sqlite', import.meta.url),
);
const databasePath = values.db
  ? isAbsolute(values.db)
    ? values.db
    : resolve(values.db)
  : defaultDatabase;
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  throw new Error('Invalid --port');

// Operator-level owner declaration happens before the HTTP listener exists; the
// HTTP API itself has no owner-creation route.
if (values.owner.length > 0) {
  const storage = openStorage(databasePath);
  try {
    assertMigrated(storage);
    const service = createApiService(storage);
    for (const owner of values.owner) {
      const result = service.provisionOwner(owner);
      process.stdout.write(
        `${result.created ? 'declared' : 'already declared'} owner ${result.ownerId}\n`,
      );
    }
  } finally {
    storage.close();
  }
}

const running = await startServer({
  databasePath,
  host: values.host,
  port,
  onError: (entry) => {
    const cause =
      entry.cause instanceof Error
        ? `${entry.cause.name}: ${entry.cause.message}`
        : '';
    process.stderr.write(
      `aven-api ${entry.status} ${entry.code} ${entry.method} ${entry.route} ${cause}\n`,
    );
  },
});
process.stdout.write(
  `Aven AVEN-005 API listening on ${running.url} (no model runtime)\n`,
);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`shutdown failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  });
