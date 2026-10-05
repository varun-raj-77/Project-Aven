import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage } from './connection.ts';
import { migrate } from './migrate.ts';

const filename = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../../../data/aven.sqlite', import.meta.url));
mkdirSync(dirname(filename), { recursive: true });
const storage = openStorage(filename);
try {
  migrate(storage.sqlite);
  console.log(`Schema migrated: ${filename}`);
} finally {
  storage.close();
}
