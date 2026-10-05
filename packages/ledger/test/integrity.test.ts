import { afterEach, describe, expect, it } from 'vitest';
import { type Storage } from '@aven/storage';
import { createLedger, LedgerError } from '../src/index.ts';
import {
  authority,
  f,
  fresh,
  identities,
  request,
  source,
} from './fixtures.ts';
import { OwnerIdSchema } from '@aven/contracts';

const opened: Storage[] = [];
function setup() {
  const result = fresh();
  opened.push(result.storage);
  return result;
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('observational integrity inspection', () => {
  it('accepts an empty and populated valid ledger without writing', () => {
    const { ledger, storage } = setup();
    expect(ledger.inspectIntegrity()).toEqual({
      ok: true,
      eventsChecked: 0,
      recordsChecked: 0,
      issues: [],
    });
    source(ledger);
    authority(ledger);
    const before = storage.sqlite.prepare('SELECT total_changes() AS n').get();
    storage.sqlite.pragma('query_only = ON');
    expect(ledger.inspectIntegrity()).toMatchObject({
      ok: true,
      eventsChecked: 5,
      issues: [],
    });
    expect(storage.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(
      before,
    );
  });
  it('detects a missing normalized reference even when ordinary foreign keys still pass', () => {
    const { ledger, storage } = setup();
    source(ledger);
    storage.sqlite.exec(`DROP TRIGGER record_references_no_delete;
      DELETE FROM record_references WHERE source_kind = 'experience_events' AND path = '$.payload.task.sessionId';`);
    expect(storage.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
    const report = ledger.inspectIntegrity();
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual({
      code: 'references',
      recordId: f.evidence.eventId,
      detail: 'Normalized references differ from v1 payload claims',
    });
    expect(report.issues.some((i) => i.code === 'protection')).toBe(true);
  });
  it('detects a changed normalized reference and a broken owner relationship', () => {
    const { ledger, storage } = setup();
    source(ledger);
    storage.sqlite.pragma('foreign_keys = OFF');
    storage.sqlite.exec(`DROP TRIGGER record_references_no_update;
      UPDATE record_references SET target_id = 'session_missing' WHERE target_kind = 'sessions';`);
    storage.sqlite.pragma('foreign_keys = ON');
    const report = ledger.inspectIntegrity();
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'references')).toBe(true);
    expect(report.issues.some((i) => i.code === 'relationship')).toBe(true);
  });
  it('detects malformed stored contract data and exposes typed read failure', () => {
    const { ledger, storage } = setup();
    ledger.appendEvent(request());
    storage.sqlite.pragma('ignore_check_constraints = ON');
    storage.sqlite.exec(`DROP TRIGGER experience_events_no_update;
      UPDATE experience_events SET record_json = json_set(record_json, '$.payload.instruction', '');`);
    storage.sqlite.pragma('ignore_check_constraints = OFF');
    const report = ledger.inspectIntegrity();
    expect(report.issues.some((i) => i.code === 'invalid_record')).toBe(true);
    try {
      ledger.getEvent(f.evidence.eventId);
      throw new Error('Expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      expect(e).toMatchObject({ code: 'integrity_failure' });
    }
  });
  it('detects missing catalogs and a regressed high-water mark', () => {
    const { ledger, storage } = setup();
    ledger.appendEvent(request());
    storage.sqlite.pragma('foreign_keys = OFF');
    storage.sqlite.exec(`DROP TRIGGER record_versions_no_delete;
      DELETE FROM record_versions WHERE record_kind = 'experience_events';
      UPDATE sqlite_sequence SET seq = 0 WHERE name = 'experience_events';`);
    storage.sqlite.pragma('foreign_keys = ON');
    const report = ledger.inspectIntegrity();
    expect(report.issues.some((i) => i.code === 'catalog')).toBe(true);
    expect(report.issues.some((i) => i.code === 'sequence')).toBe(true);
  });
  it('detects a contract-valid conflicting historical payload projection', () => {
    const { ledger, storage } = setup();
    source(ledger);
    authority(ledger);
    storage.sqlite.exec(`DROP TRIGGER action_proposals_no_update;
      UPDATE action_proposals SET record_json = json_set(record_json, '$.action', 'altered');`);
    expect(
      ledger
        .inspectIntegrity()
        .issues.some((i) => i.code === 'payload_projection'),
    ).toBe(true);
  });
  it('limits record details to this owner when another owner has corrupted history', () => {
    const { ledger, storage } = setup();
    ledger.appendEvent(request());
    identities(storage, 'other');
    createLedger(storage, OwnerIdSchema.parse('owner_other')).appendEvent(
      request('event_private', 'other'),
    );
    storage.sqlite.pragma('foreign_keys = OFF');
    storage.sqlite.exec(`DROP TRIGGER record_references_no_update;
      UPDATE record_references SET target_version = 99 WHERE owner_id = 'owner_other' AND target_kind = 'experience_events';`);
    storage.sqlite.pragma('foreign_keys = ON');
    const report = ledger.inspectIntegrity();
    expect(report.eventsChecked).toBe(1);
    expect(report.issues.every((i) => i.code === 'protection')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('event_private');
  });
});
