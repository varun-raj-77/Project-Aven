import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export const migrationDirectory = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

// SQL files are authoritative. No schema-push or ORM DDL generation path.
export function migrate(
  sqlite: Database.Database,
  directory = migrationDirectory,
): void {
  if (sqlite.inTransaction)
    throw new Error('Migrations require their own transaction');
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1)
    throw new Error('Migrations require foreign_keys = ON');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrations = files.map((name, i) => {
    if (!name.startsWith(`${String(i + 1).padStart(4, '0')}_`))
      throw new Error(
        'Migration filenames must be contiguous starting at 0001',
      );
    const sql = readFileSync(join(directory, name), 'utf8');
    return {
      version: i + 1,
      name,
      sql,
      hash: createHash('sha256').update(sql).digest('hex'),
    };
  });
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      applied_at TEXT NOT NULL
    ) STRICT`);
    const history = sqlite
      .prepare(
        'SELECT version, name, sha256 FROM schema_migrations ORDER BY version',
      )
      .all() as { version: number; name: string; sha256: string }[];
    history.forEach((row, i) => {
      const expected = migrations[i];
      if (
        !expected ||
        row.version !== expected.version ||
        row.name !== expected.name ||
        row.sha256 !== expected.hash
      )
        throw new Error('Migration history is unknown, incomplete or modified');
    });
    if (sqlite.pragma('user_version', { simple: true }) !== history.length)
      throw new Error('SQLite user_version disagrees with migration history');
    for (const migration of migrations.slice(history.length)) {
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
        .run(
          migration.version,
          migration.name,
          migration.hash,
          new Date().toISOString(),
        );
      sqlite.pragma(`user_version = ${migration.version}`);
    }
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length > 0)
      throw new Error('Foreign-key check failed');
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}
