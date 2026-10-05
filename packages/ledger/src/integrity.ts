import { isDeepStrictEqual } from 'node:util';
import type { OwnerId } from '@aven/contracts';
import {
  deserializeContract,
  type ContractName,
  type Storage,
} from '@aven/storage';
import { projection } from './records.ts';

export interface IntegrityIssue {
  readonly code:
    | 'invalid_record'
    | 'references'
    | 'relationship'
    | 'catalog'
    | 'sequence'
    | 'protection'
    | 'payload_projection';
  readonly recordId?: string;
  readonly detail: string;
}
export interface IntegrityReport {
  readonly ok: boolean;
  readonly eventsChecked: number;
  readonly recordsChecked: number;
  readonly issues: readonly IntegrityIssue[];
}

export function inspect(s: Storage, ownerId: OwnerId): IntegrityReport {
  const db = s.sqlite;
  const issues: IntegrityIssue[] = [];
  const tables = [
    'experience_events',
    'evidence',
    'corrections',
    'action_proposals',
    'policy_decisions',
    'owner_approvals',
    'tool_executions',
    'verification_results',
    'learning_candidates',
    'evaluations',
    'lifecycle_records',
    'learned_owner_state',
    'active_task_state',
    'no_useful_lessons',
  ] as const;
  const rows = db
    .prepare(
      'SELECT * FROM record_snapshots WHERE owner_id = ? ORDER BY record_kind, record_id, record_version',
    )
    .all(ownerId) as {
    record_kind: ContractName;
    record_id: string;
    record_version: number;
    record_json: string;
  }[];
  for (const row of rows) {
    const target = [
      ownerId,
      row.record_kind,
      row.record_id,
      row.record_version,
    ];
    try {
      const value = deserializeContract(row.record_kind, row.record_json);
      if (value.ownerId !== ownerId)
        throw new Error('Owner projection mismatch');
      const expected = db
        .prepare('SELECT aven_references_v1(?, ?) AS refs')
        .get(row.record_kind, row.record_json) as { refs: string };
      const actual = db
        .prepare(
          `SELECT path, target_kind AS targetKind, target_id AS targetId,
        target_version AS targetVersion, evidence_event_id AS evidenceEventId, session_id AS sessionId,
        proposal_id AS proposalId, proposal_version AS proposalVersion, proposal_digest AS proposalDigest,
        parameters_digest AS parametersDigest, decision, event_type AS eventType, bound_task_id AS boundTaskId
        FROM record_references WHERE owner_id = ? AND source_kind = ? AND source_id = ? AND source_version = ?`,
        )
        .all(...target);
      const sort = (a: unknown[]) => a.map((v) => JSON.stringify(v)).sort();
      if (
        !isDeepStrictEqual(
          sort(actual),
          sort(JSON.parse(expected.refs) as unknown[]),
        )
      )
        issues.push({
          code: 'references',
          recordId: row.record_id,
          detail: 'Normalized references differ from v1 payload claims',
        });
      if (
        !db
          .prepare(
            'SELECT 1 FROM record_versions WHERE owner_id = ? AND record_kind = ? AND record_id = ? AND record_version = ?',
          )
          .get(...target) ||
        !db
          .prepare(
            'SELECT 1 FROM record_keys WHERE owner_id = ? AND record_kind = ? AND record_id = ?',
          )
          .get(...target.slice(0, 3))
      )
        issues.push({
          code: 'catalog',
          recordId: row.record_id,
          detail: 'Historical identity/version catalog is incomplete',
        });
      if (row.record_kind === 'experience_events') {
        const event = deserializeContract('experience_events', row.record_json);
        const evidenceIds = (
          db
            .prepare(
              'SELECT record_id FROM evidence WHERE owner_id = ? AND event_id = ? ORDER BY record_id',
            )
            .all(ownerId, event.id) as { record_id: string }[]
        ).map((e) => e.record_id);
        if (!isDeepStrictEqual(evidenceIds, [...event.evidenceIds].sort()))
          issues.push({
            code: 'references',
            recordId: event.id,
            detail: 'Recorded evidence does not match the event evidence list',
          });
        const p = projection(event);
        if (p) {
          const snapshot = db
            .prepare(
              `SELECT record_json FROM ${p.table} WHERE owner_id = ? AND record_id = ? AND record_version = ?`,
            )
            .get(ownerId, p.id, p.version) as
            { record_json: string } | undefined;
          if (
            !snapshot ||
            !isDeepStrictEqual(JSON.parse(snapshot.record_json), event.payload)
          )
            issues.push({
              code: 'payload_projection',
              recordId: event.id,
              detail: 'Historical payload snapshot is absent or differs',
            });
        }
      }
    } catch {
      issues.push({
        code: 'invalid_record',
        recordId: row.record_id,
        detail: 'Stored contract or v1 projection is invalid',
      });
    }
  }
  for (const table of [
    ...tables,
    'owners',
    'sessions',
    'tasks',
    'record_keys',
    'record_versions',
    'record_references',
  ]) {
    const broken = db
      .prepare(
        `SELECT f.fkid FROM pragma_foreign_key_check('${table}') f JOIN ${table} r ON r.rowid = f.rowid WHERE r.owner_id = ?`,
      )
      .all(ownerId);
    if (broken.length)
      issues.push({
        code: 'relationship',
        detail: `Unresolved owner-bound relationships in ${table}`,
      });
  }
  const events = db
    .prepare(
      'SELECT record_id, sequence FROM experience_events WHERE owner_id = ? ORDER BY sequence',
    )
    .all(ownerId) as { record_id: string; sequence: number }[];
  let previous = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous)
      issues.push({
        code: 'sequence',
        recordId: event.record_id,
        detail: 'Invalid canonical local sequence',
      });
    previous = event.sequence;
  }
  const highWater = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'experience_events'")
    .get() as { seq: number } | undefined;
  if (previous > (highWater?.seq ?? 0))
    issues.push({
      code: 'sequence',
      detail: 'Sequence high-water mark is behind history',
    });
  const required = [
    ...tables.flatMap((t) => [
      `${t}_no_update`,
      `${t}_no_delete`,
      `${t}_no_replace`,
      `${t}_index_references`,
    ]),
    ...['record_keys', 'record_versions', 'record_references'].flatMap((t) => [
      `${t}_no_update`,
      `${t}_no_delete`,
      `${t}_require_snapshot`,
    ]),
    'experience_events_monotonic_sequence',
  ];
  for (const name of required) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
        )
        .get(name)
    )
      issues.push({
        code: 'protection',
        detail: `Missing expected storage trigger: ${name}`,
      });
  }
  if (
    db.pragma('foreign_keys', { simple: true }) !== 1 ||
    db.pragma('recursive_triggers', { simple: true }) !== 1 ||
    db.pragma('ignore_check_constraints', { simple: true }) !== 0
  )
    issues.push({
      code: 'protection',
      detail: 'Required connection integrity checks are disabled',
    });
  return {
    ok: issues.length === 0,
    eventsChecked: events.length,
    recordsChecked: rows.length,
    issues,
  };
}
