import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  OwnerIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
} from '@aven/contracts';
import {
  contracts,
  deserializeContract,
  isContractName,
} from './serialization.ts';
import { referencesV1 } from './references.ts';
import * as schema from './schema.ts';

// Connection setup only: no migration, append, write, replay or Ledger service.
export function openStorage(filename: string) {
  const sqlite = new Database(filename);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('recursive_triggers = ON');
    sqlite.pragma('busy_timeout = 5000');
    if (sqlite.pragma('foreign_keys', { simple: true }) !== 1)
      throw new Error('SQLite foreign-key enforcement is required');
    sqlite.function(
      'aven_scalar_v1',
      { deterministic: true },
      (kind, value) => {
        const validators = {
          owner: OwnerIdSchema,
          session: SessionIdSchema,
          task: TaskIdSchema,
          timestamp: TimestampSchema,
        };
        if (typeof kind !== 'string' || !Object.hasOwn(validators, kind))
          return 0;
        return validators[kind as keyof typeof validators].safeParse(value)
          .success
          ? 1
          : 0;
      },
    );
    sqlite.function('aven_valid_v1', { deterministic: true }, (name, json) => {
      if (
        typeof name !== 'string' ||
        !isContractName(name) ||
        typeof json !== 'string'
      )
        return 0;
      try {
        const input: unknown = JSON.parse(json);
        const parsed = contracts[name].parse(input);
        referencesV1(parsed); // Enforce nested owner consistency too.
        return 1;
      } catch {
        return 0;
      }
    });
    sqlite.function(
      'aven_references_v1',
      { deterministic: true },
      (name, json) => {
        if (
          typeof name !== 'string' ||
          !isContractName(name) ||
          typeof json !== 'string'
        )
          throw new Error('Invalid reference projection input');
        return JSON.stringify(referencesV1(deserializeContract(name, json)));
      },
    );
    return {
      sqlite,
      db: drizzle(sqlite, { schema }),
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
export type Storage = ReturnType<typeof openStorage>;
