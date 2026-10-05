import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import Database from 'better-sqlite3';
import {
  migrate,
  migrationDirectory,
  openStorage,
  schema,
} from '../src/index.ts';
import { event, f, fresh, graph, record } from './fixtures.ts';

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'aven003-synthetic-'));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const target = resolve(path);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('aven003-synthetic-')
    )
      throw new Error('Refusing cleanup outside the synthetic test directory');
    rmSync(target, { recursive: true, force: true });
  }
});

describe('authoritative SQL migrations and reopen', () => {
  it('keeps Drizzle query mappings consistent with migrated SQLite columns', () => {
    const s = fresh();
    try {
      for (const table of Object.values(schema)) {
        const columns = s.sqlite
          .prepare(`PRAGMA table_xinfo(${getTableName(table)})`)
          .all() as { name: string; hidden: number }[];
        for (const column of Object.values(getTableColumns(table))) {
          const actual = columns.find((c) => c.name === column.name);
          expect(actual, `${getTableName(table)}.${column.name}`).toBeDefined();
          expect(Boolean(actual?.hidden), column.name).toBe(
            Boolean(column.generated),
          );
        }
      }
    } finally {
      s.close();
    }
  });
  it('migrates from zero, stores history and is idempotent', () => {
    const s = openStorage(':memory:');
    try {
      expect(
        s.sqlite
          .prepare("SELECT * FROM sqlite_schema WHERE type='table'")
          .all(),
      ).toEqual([]);
      migrate(s.sqlite);
      const before = s.sqlite.prepare('SELECT * FROM schema_migrations').all();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ version: 1, name: '0001_storage.sql' });
      expect(s.sqlite.pragma('user_version', { simple: true })).toBe(1);
      migrate(s.sqlite);
      expect(s.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual(
        before,
      );
      expect(s.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      s.close();
    }
  });
  it('preserves records, references, constraints and sequence across close/reopen', () => {
    const filename = join(directory(), 'synthetic.sqlite');
    const first = fresh(filename);
    graph(first);
    const refs = first.sqlite
      .prepare(
        'SELECT * FROM record_references ORDER BY source_kind, source_id, path, target_kind',
      )
      .all();
    first.close();
    const second = openStorage(filename);
    try {
      migrate(second.sqlite);
      expect(second.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(
        second.db.select().from(schema.learnedOwnerState).get()?.recordJson,
      ).toEqual(f.trusted);
      expect(
        second.sqlite
          .prepare(
            'SELECT * FROM record_references ORDER BY source_kind, source_id, path, target_kind',
          )
          .all(),
      ).toEqual(refs);
      record(second, 'experience_events', event('event_reopened'));
      expect(
        second.sqlite
          .prepare('SELECT max(sequence) AS n FROM experience_events')
          .get(),
      ).toEqual({ n: 3 });
      expect(() =>
        second.sqlite.exec('DELETE FROM experience_events'),
      ).toThrow();
    } finally {
      second.close();
    }
  });
  it('rejects altered migration artifacts, unknown history and disabled foreign keys', () => {
    const path = directory();
    const sql = readFileSync(
      join(migrationDirectory, '0001_storage.sql'),
      'utf8',
    );
    writeFileSync(join(path, '0001_storage.sql'), sql + '\n-- altered\n');
    const s = fresh();
    try {
      expect(() => migrate(s.sqlite, path)).toThrow(/history/);
      s.sqlite
        .prepare('INSERT INTO schema_migrations VALUES (2, ?, ?, ?)')
        .run('0002_unknown.sql', 'a'.repeat(64), f.time);
      expect(() => migrate(s.sqlite)).toThrow(/history/);
      s.sqlite.pragma('foreign_keys = OFF');
      expect(() => migrate(s.sqlite)).toThrow(/foreign_keys/);
    } finally {
      s.close();
    }
  });
  it('rolls back a failed pending migration and leaves existing data intact', () => {
    const path = directory();
    writeFileSync(
      join(path, '0001_storage.sql'),
      readFileSync(join(migrationDirectory, '0001_storage.sql')),
    );
    writeFileSync(
      join(path, '0002_failure.sql'),
      'CREATE TABLE transient_test(id INTEGER); SELECT * FROM missing_table;',
    );
    const s = fresh();
    graph(s);
    try {
      expect(() => migrate(s.sqlite, path)).toThrow(/missing_table/);
      expect(
        s.sqlite
          .prepare("SELECT * FROM sqlite_schema WHERE name='transient_test'")
          .all(),
      ).toEqual([]);
      expect(s.sqlite.pragma('user_version', { simple: true })).toBe(1);
      expect(
        s.db.select().from(schema.learnedOwnerState).get()?.recordJson,
      ).toEqual(f.trusted);
    } finally {
      s.close();
    }
  });
  it('requires the configured connection for writes and allows raw read-only inspection', () => {
    const filename = join(directory(), 'synthetic.sqlite');
    const s = fresh(filename);
    graph(s);
    s.close();
    const raw = new Database(filename);
    try {
      expect(
        raw.prepare('SELECT count(*) AS n FROM experience_events').get(),
      ).toEqual({ n: 2 });
      expect(() =>
        raw
          .prepare('INSERT INTO experience_events(record_json) VALUES (?)')
          .run(JSON.stringify(event('event_raw'))),
      ).toThrow();
    } finally {
      raw.close();
    }
  });
});
