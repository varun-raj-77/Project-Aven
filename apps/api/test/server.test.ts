import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLedger } from '@aven/ledger';
import { OwnerIdSchema } from '@aven/contracts';
import { migrate, openStorage } from '@aven/storage';
import { createApiService, startServer } from '../src/index.ts';
import { OWNER_A, tempDir } from './fixtures.ts';

function migratedFile(dir: string, owners: string[] = [OWNER_A]): string {
  const file = join(dir, 'server.sqlite');
  const storage = openStorage(file);
  try {
    migrate(storage.sqlite);
    const service = createApiService(storage);
    for (const owner of owners) service.provisionOwner(owner);
  } finally {
    storage.close();
  }
  return file;
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe('server lifecycle against a temporary migrated database', () => {
  it('starts on loopback, serves the full flow and shuts down without corrupting data', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const databasePath = migratedFile(dir);
      const running = await startServer({ databasePath });
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const base = `${running.url}/v1/owners/${OWNER_A}`;
      const session = await post(`${base}/sessions`, {});
      const sessionId: string = session.body.session.sessionId;
      const task = await post(`${base}/sessions/${sessionId}/tasks`, {});
      const taskId: string = task.body.task.taskId;
      const receipts = [];
      for (let i = 0; i < 3; i += 1)
        receipts.push(
          await post(`${base}/sessions/${sessionId}/tasks/${taskId}/messages`, {
            text: `Synthetic ${String(i)}`,
          }),
        );
      expect(receipts.map((r) => r.status)).toEqual([201, 201, 201]);
      await running.close();
      await running.close(); // idempotent

      // The listener is gone.
      await expect(fetch(`${running.url}/v1/health`)).rejects.toThrow();

      const storage = openStorage(databasePath);
      try {
        expect(storage.sqlite.pragma('integrity_check', { simple: true })).toBe(
          'ok',
        );
        expect(
          storage.sqlite.prepare('PRAGMA foreign_key_check').all(),
        ).toEqual([]);
        const ledger = createLedger(storage, OwnerIdSchema.parse(OWNER_A));
        expect(ledger.inspectIntegrity().ok).toBe(true);
        expect(ledger.listEvents().events.map((e) => e.event.id)).toEqual(
          receipts.map((r) => r.body.eventId),
        );
      } finally {
        storage.close();
      }
    } finally {
      cleanup();
    }
  });

  it('acknowledges exactly the messages it durably recorded when closed under load', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const databasePath = migratedFile(dir);
      const running = await startServer({ databasePath });
      const base = `${running.url}/v1/owners/${OWNER_A}`;
      const sessionId: string = (await post(`${base}/sessions`, {})).body
        .session.sessionId;
      const taskId: string = (
        await post(`${base}/sessions/${sessionId}/tasks`, {})
      ).body.task.taskId;
      const url = `${base}/sessions/${sessionId}/tasks/${taskId}/messages`;
      const inflight = Array.from({ length: 25 }, (_, i) =>
        post(url, { text: `Synthetic burst ${String(i)}` }).then(
          (r) => r,
          () => ({ status: 0, body: undefined }),
        ),
      );
      const closing = running.close();
      const results = await Promise.all(inflight);
      await closing;
      const acknowledged = results
        .filter((r) => r.status === 201)
        .map((r) => r.body.eventId as string);
      const storage = openStorage(databasePath);
      try {
        expect(storage.sqlite.pragma('integrity_check', { simple: true })).toBe(
          'ok',
        );
        const ledger = createLedger(storage, OwnerIdSchema.parse(OWNER_A));
        expect(ledger.inspectIntegrity().ok).toBe(true);
        const recorded = ledger
          .listEvents({ limit: 1000 })
          .events.map((e) => e.event.id);
        // No acknowledged message is missing; nothing unacknowledged slipped in
        // except responses whose connection was refused before reaching storage.
        expect(new Set(recorded)).toEqual(new Set(acknowledged));
      } finally {
        storage.close();
      }
    } finally {
      cleanup();
    }
  });

  it('refuses an unmigrated database and leaves no listener', async () => {
    const { dir, cleanup } = tempDir();
    try {
      await expect(
        startServer({ databasePath: join(dir, 'empty.sqlite') }),
      ).rejects.toThrow(/migrate it first/);
    } finally {
      cleanup();
    }
  });

  it('refuses to bind to a non-loopback interface', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const databasePath = migratedFile(dir);
      for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com'])
        await expect(startServer({ databasePath, host })).rejects.toThrow(
          /loopback only/,
        );
    } finally {
      cleanup();
    }
  });
});
