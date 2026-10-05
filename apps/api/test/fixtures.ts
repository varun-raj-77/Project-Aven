// Synthetic owners, sessions and text only. No real owner data.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openStorage, type Storage } from '@aven/storage';
import {
  createApiService,
  createRequestHandler,
  type ApiService,
  type ErrorLogEntry,
  type ServiceOptions,
} from '../src/index.ts';

export const OWNER_A = 'owner_synthetic_a';
export const OWNER_B = 'owner_synthetic_b';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aven-api-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function migratedStorage(filename = ':memory:'): Storage {
  const storage = openStorage(filename);
  migrate(storage.sqlite);
  return storage;
}

export function setup(options: ServiceOptions = {}, filename = ':memory:') {
  const storage = migratedStorage(filename);
  const service = createApiService(storage, options);
  service.provisionOwner(OWNER_A);
  service.provisionOwner(OWNER_B);
  return { storage, service };
}

/** Creates a session with one task for an owner. */
export function conversation(service: ApiService, owner = OWNER_A) {
  const session = service.createSession(owner);
  const task = service.createTask(owner, session.sessionId);
  return { sessionId: session.sessionId, taskId: task.taskId };
}

/** Every application table plus SQLite's AUTOINCREMENT high-water mark. */
export const ALL_TABLES = [
  'owners',
  'sessions',
  'tasks',
  'experience_events',
  'evidence',
  'learned_owner_state',
  'active_task_state',
  'learning_candidates',
  'no_useful_lessons',
  'corrections',
  'action_proposals',
  'policy_decisions',
  'owner_approvals',
  'tool_executions',
  'verification_results',
  'evaluations',
  'lifecycle_records',
  'record_keys',
  'record_versions',
  'record_references',
  'schema_migrations',
] as const;

export const DERIVED_AND_AUTHORITY_TABLES = [
  'learned_owner_state',
  'active_task_state',
  'learning_candidates',
  'no_useful_lessons',
  'corrections',
  'action_proposals',
  'policy_decisions',
  'owner_approvals',
  'tool_executions',
  'verification_results',
  'evaluations',
  'lifecycle_records',
] as const;

/** Exact snapshot of all rows, for byte-level before/after comparisons. */
export function snapshot(storage: Storage): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const table of ALL_TABLES)
    result[table] = storage.sqlite
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all();
  result['sqlite_sequence'] = storage.sqlite
    .prepare('SELECT * FROM sqlite_sequence ORDER BY name')
    .all();
  return result;
}

export function count(storage: Storage, table: string): number {
  return (
    storage.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

/** A real loopback HTTP listener around the request handler. */
export async function httpHarness(service: ApiService) {
  const errors: ErrorLogEntry[] = [];
  const handler = createRequestHandler(service, {
    onError: (e) => errors.push(e),
  });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${String(port)}`;
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any; headers: Headers; text: string }> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] ??=
        'application/json';
    }
    const response = await fetch(base + path, init);
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return {
      status: response.status,
      body: parsed,
      headers: response.headers,
      text,
    };
  }
  return {
    base,
    port,
    errors,
    call,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
