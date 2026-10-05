import { readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrationDirectory, openStorage, type Storage } from '@aven/storage';
import { createRequestHandler, type HandlerOptions } from './http.ts';
import { createApiService, type ServiceOptions } from './service.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface ServerOptions extends ServiceOptions, HandlerOptions {
  /** Absolute path to an already-migrated AVEN-003 SQLite database. */
  readonly databasePath: string;
  /** Loopback only. Defaults to 127.0.0.1. */
  readonly host?: string;
  /** Defaults to 0 (an ephemeral port). */
  readonly port?: number;
}
export interface RunningServer {
  readonly url: string;
  readonly storage: Storage;
  readonly server: Server;
  /** Stops accepting requests, waits for in-flight requests, then closes storage. */
  close(): Promise<void>;
}

/**
 * Requires the database to be at exactly the migration level this code ships
 * with. The server never migrates implicitly; run `pnpm db:migrate` (or the
 * storage `migrate`) first.
 */
export function assertMigrated(storage: Storage): void {
  const expected = readdirSync(migrationDirectory).filter((n) =>
    n.endsWith('.sql'),
  ).length;
  const actual = storage.sqlite.pragma('user_version', { simple: true });
  if (actual !== expected)
    throw new Error(
      `Database schema version ${String(actual)} does not match expected ${String(expected)}; migrate it first`,
    );
}

export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host))
    throw new Error(
      'AVEN-005 binds to loopback only (127.0.0.1, ::1 or localhost)',
    );
  const storage = openStorage(options.databasePath);
  let server: Server;
  try {
    assertMigrated(storage);
    const service = createApiService(storage, options);
    const handler = createRequestHandler(service, options);
    server = createServer((req, res) => void handler(req, res));
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    storage.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const hostname =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${hostname}:${String(address.port)}`,
    storage,
    server,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          // Storage closes only after the listener and every connection are done,
          // so no request can observe a half-closed database.
          try {
            storage.close();
          } catch (closeError) {
            reject(
              closeError instanceof Error
                ? closeError
                : new Error(String(closeError)),
            );
            return;
          }
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
        // Keep-alive sockets that finish a request after close() would otherwise
        // hold the listener open until their idle timeout.
        setTimeout(() => server.closeAllConnections(), 5_000).unref();
      });
      return closing;
    },
  };
}
