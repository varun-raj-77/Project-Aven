import type { ExperienceEvent, OwnerApproval } from '@aven/contracts';
import { deserializeContract, type Storage } from '@aven/storage';
import { canonicallyEqual } from '../canonical.ts';
import { ROOT_POLICY_CONFIG } from '../config.ts';
import { RootPolicyError, fail } from '../errors.ts';

/**
 * AVEN-012 Patch 3: Root's read-only, owner-local access to recorded
 * proposals and approvals.
 *
 * Every statement is pinned, owner-scoped and read-only. An evaluation's
 * reads run inside ONE deferred SQLite read transaction (`readSnapshot`), so
 * Root sees one consistent state: an approval and its revocation are either
 * both visible or both absent. Stored records are decoded with the frozen
 * AVEN-002 contracts through the frozen storage serializer; anything that
 * fails, or that disagrees with the Ledger history it should come from, is
 * `invalid_history`. Nothing here writes, repairs or interprets text.
 */

/** Pinned owner-scoped, read-only statements. */
export const READ_SQL = Object.freeze({
  owner: 'SELECT 1 AS found FROM owners WHERE owner_id = ?',
  task: 'SELECT session_id FROM tasks WHERE owner_id = ? AND task_id = ?',
  event:
    'SELECT sequence, record_json FROM experience_events WHERE owner_id = ? AND record_id = ?',
  eventInUse:
    'SELECT 1 AS found FROM experience_events WHERE owner_id = ? AND record_id = ?',
  proposalProjection:
    'SELECT record_json, proposal_digest FROM action_proposals WHERE owner_id = ? AND record_id = ? AND record_version = ?',
  approvalIds:
    'SELECT DISTINCT record_id FROM owner_approvals WHERE owner_id = ? AND proposal_id = ? AND proposal_version = ? ORDER BY record_id LIMIT 65',
  approvalVersions:
    'SELECT record_json FROM owner_approvals WHERE owner_id = ? AND record_id = ? ORDER BY record_version LIMIT 65',
  evidence:
    'SELECT 1 AS found FROM evidence WHERE owner_id = ? AND record_id = ? AND event_id = ?',
  decisionInUse:
    'SELECT 1 AS found FROM policy_decisions WHERE owner_id = ? AND record_id = ?',
});

/** Runs one pinned single-row read; any storage error is `storage_failure`. */
export function readRow(
  storage: Storage,
  sql: string,
  ...values: (string | number)[]
): unknown {
  try {
    return storage.sqlite.prepare(sql).get(...values);
  } catch {
    return fail('storage_failure');
  }
}

/** Runs one pinned multi-row read; any storage error is `storage_failure`. */
export function readRows(
  storage: Storage,
  sql: string,
  ...values: (string | number)[]
): unknown[] {
  try {
    return storage.sqlite.prepare(sql).all(...values);
  } catch {
    return fail('storage_failure');
  }
}

/** True when the connection has no open transaction. */
export function notInTransaction(storage: Storage): boolean {
  try {
    return storage.sqlite.inTransaction === false;
  } catch {
    return false;
  }
}

/**
 * Runs `read` inside one deferred read transaction. A caller's open
 * transaction is refused (`storage_failure`), as the frozen Ledger refuses
 * one. A `RootPolicyError` from `read` is passed on unchanged.
 */
export function readSnapshot<T>(storage: Storage, read: () => T): T {
  if (!notInTransaction(storage)) return fail('storage_failure');
  try {
    return storage.sqlite.transaction(read).deferred();
  } catch (error) {
    if (error instanceof RootPolicyError) throw error;
    return fail('storage_failure');
  }
}

export function ownerExists(storage: Storage, owner: string): boolean {
  return readRow(storage, READ_SQL.owner, owner) !== undefined;
}

/** The session of an owner's task, or `undefined`. */
export function taskSession(
  storage: Storage,
  owner: string,
  task: string,
): string | undefined {
  const row = readRow(storage, READ_SQL.task, owner, task) as
    { session_id?: unknown } | undefined;
  return typeof row?.session_id === 'string' ? row.session_id : undefined;
}

/** One stored event of this owner, decoded with the frozen contract. */
export function readEvent(
  storage: Storage,
  owner: string,
  eventId: string,
): { readonly sequence: number; readonly event: ExperienceEvent } | undefined {
  const row = readRow(storage, READ_SQL.event, owner, eventId) as
    { sequence?: unknown; record_json?: unknown } | undefined;
  if (row === undefined) return undefined;
  if (
    typeof row.record_json !== 'string' ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence <= 0
  )
    return fail('invalid_history');
  let event: ExperienceEvent;
  try {
    event = deserializeContract('experience_events', row.record_json);
  } catch {
    return fail('invalid_history');
  }
  if (event.ownerId !== owner || event.id !== eventId)
    return fail('invalid_history');
  return { sequence: row.sequence, event };
}

/**
 * A recorded proposal: its `action_proposed` event, the frozen projection
 * (which must equal the event payload) and the declared digest stored with
 * it. An absent event, or an event of another type, is `unknown_binding`.
 */
export function readRecordedProposal(
  storage: Storage,
  owner: string,
  eventId: string,
): {
  readonly event: ExperienceEvent & { readonly eventType: 'action_proposed' };
  readonly declaredDigest: string;
} {
  const stored = readEvent(storage, owner, eventId);
  if (stored === undefined || stored.event.eventType !== 'action_proposed')
    return fail('unknown_binding');
  const event = stored.event;
  const payload = event.payload;
  const row = readRow(
    storage,
    READ_SQL.proposalProjection,
    owner,
    payload.id,
    payload.metadata.recordVersion,
  ) as { record_json?: unknown; proposal_digest?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.record_json !== 'string' ||
    typeof row.proposal_digest !== 'string'
  )
    return fail('invalid_history');
  let projection: unknown;
  try {
    projection = deserializeContract('action_proposals', row.record_json);
  } catch {
    return fail('invalid_history');
  }
  if (
    !canonicallyEqual(projection, payload) ||
    event.task === undefined ||
    !canonicallyEqual(event.task, payload.task)
  )
    return fail('invalid_history');
  return { event, declaredDigest: row.proposal_digest };
}

/**
 * Every stored version of every approval of this owner bound to the
 * proposal's identifier and version, plus every other version of those
 * approvals (a revocation recorded with another binding is still found).
 * Each version must come from its own recorded `owner_approval` event with
 * an identical payload. More than the v1 limit of records is
 * `invalid_history`: Root never evaluates a truncated set.
 */
export function readApprovalVersions(
  storage: Storage,
  owner: string,
  proposalId: string,
  proposalVersion: number,
): OwnerApproval[] {
  const limit = ROOT_POLICY_CONFIG.limits.maxApprovalRecords;
  const ids = readRows(
    storage,
    READ_SQL.approvalIds,
    owner,
    proposalId,
    proposalVersion,
  ) as { record_id?: unknown }[];
  if (ids.length > limit) return fail('invalid_history');
  const records: OwnerApproval[] = [];
  for (const { record_id: id } of ids) {
    if (typeof id !== 'string') return fail('invalid_history');
    const rows = readRows(storage, READ_SQL.approvalVersions, owner, id) as {
      record_json?: unknown;
    }[];
    // The statement reads at most one row beyond the v1 bound: an overflow
    // is refused, never truncated.
    if (rows.length > limit) return fail('invalid_history');
    for (const row of rows) {
      if (typeof row.record_json !== 'string') return fail('invalid_history');
      let approval: OwnerApproval;
      try {
        approval = deserializeContract('owner_approvals', row.record_json);
      } catch {
        return fail('invalid_history');
      }
      if (approval.ownerId !== owner || approval.id !== id)
        return fail('invalid_history');
      const source = readEvent(storage, owner, approval.evidence.eventId);
      if (
        source === undefined ||
        source.event.eventType !== 'owner_approval' ||
        !canonicallyEqual(source.event.payload, approval)
      )
        return fail('invalid_history');
      records.push(approval);
      if (records.length > limit) return fail('invalid_history');
    }
  }
  return records;
}

/** Whether evidence with this identifier exists for this owner and event. */
export function evidenceExists(
  storage: Storage,
  owner: string,
  evidenceId: string,
  eventId: string,
): boolean {
  return (
    readRow(storage, READ_SQL.evidence, owner, evidenceId, eventId) !==
    undefined
  );
}

/**
 * The complete version history of one approval of this owner, decoded with
 * the frozen contract, as `{ version, status }` in ascending version order.
 * Used to recheck an approval just before a decision that relies on it is
 * recorded. The statement reads at most one row beyond the v1 bound
 * (`maxApprovalRecords`, 64): more versions than that are refused with
 * `invalid_history`, so an incomplete history is never taken as proof that
 * no later version revokes the approval. Resource use stays bounded.
 */
export function approvalVersionStates(
  storage: Storage,
  owner: string,
  approvalId: string,
): { readonly version: number; readonly status: string }[] {
  const rows = readRows(
    storage,
    READ_SQL.approvalVersions,
    owner,
    approvalId,
  ) as {
    record_json?: unknown;
  }[];
  if (rows.length > ROOT_POLICY_CONFIG.limits.maxApprovalRecords)
    return fail('invalid_history');
  return rows.map((row) => {
    if (typeof row.record_json !== 'string') return fail('invalid_history');
    let approval: OwnerApproval;
    try {
      approval = deserializeContract('owner_approvals', row.record_json);
    } catch {
      return fail('invalid_history');
    }
    if (approval.ownerId !== owner || approval.id !== approvalId)
      return fail('invalid_history');
    return {
      version: approval.metadata.recordVersion,
      status: approval.lifecycle.status,
    };
  });
}
