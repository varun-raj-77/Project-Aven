import {
  ActionProposalIdSchema,
  EventIdSchema,
  OwnerIdSchema,
  type ActionProposal,
} from '@aven/contracts';
import { createLedger, LedgerError, type StoredEvent } from '@aven/ledger';
import { deserializeContract, type Storage } from '@aven/storage';
import { canonicalText } from '../canonical.ts';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
} from '../errors.ts';

/**
 * AVEN-011 Patch 3: read-only, owner-local access to one stored proposal
 * event (shared by reconciliation and, later, the history reader).
 *
 * Reads go through the frozen Ledger (`getEvent`, which revalidates the
 * stored event) plus one pinned owner-scoped `SELECT` of the frozen
 * `action_proposals` projection. Nothing here writes, starts a transaction
 * of its own or interprets text. Failures are fixed `ActionProposalError`s
 * with outcome `not_written`.
 */

/** Pinned owner-scoped, read-only statements. */
export const READ_SQL = Object.freeze({
  owner: 'SELECT 1 AS found FROM owners WHERE owner_id = ?',
  projection:
    'SELECT record_json, proposal_digest FROM action_proposals WHERE owner_id = ? AND record_id = ? AND record_version = ?',
  proposalInUse:
    'SELECT 1 AS found FROM action_proposals WHERE owner_id = ? AND record_id = ?',
});

const fail = (code: ActionProposalErrorCode): never => {
  throw new ActionProposalError(code);
};

/** Runs one pinned read; any storage error is a fixed `storage_failure`. */
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

/** Frozen-Ledger read failures, mapped without guessing. */
function fromLedgerRead(error: unknown): never {
  if (error instanceof LedgerError) {
    if (error.code === 'unknown_owner') fail('unknown_binding');
    if (error.code === 'integrity_failure') fail('invalid_history');
    fail('storage_failure');
  }
  return fail('internal_error');
}

export type StoredProposalLookup =
  | { readonly status: 'absent' }
  | { readonly status: 'other_event_type' }
  | {
      readonly status: 'proposal';
      readonly stored: StoredEvent;
      readonly projection: ActionProposal;
      readonly declaredDigest: string;
    };

/**
 * The stored event with this identifier for this owner, its frozen proposal
 * projection and the declared digest. A missing projection, a projection that
 * differs from the event payload, or a stored record that fails frozen
 * validation is `invalid_history`; an absent owner is `unknown_binding`.
 */
export function readStoredProposalEvent(
  storage: Storage,
  owner: string,
  event: string,
): StoredProposalLookup {
  const ownerId = OwnerIdSchema.safeParse(owner);
  const eventId = EventIdSchema.safeParse(event);
  if (!ownerId.success || !eventId.success) return fail('invalid_request');
  let stored: StoredEvent | undefined;
  try {
    stored = createLedger(storage, ownerId.data).getEvent(eventId.data);
  } catch (error) {
    return fromLedgerRead(error);
  }
  if (stored === undefined) return { status: 'absent' };
  if (stored.event.eventType !== 'action_proposed')
    return { status: 'other_event_type' };
  const payload = stored.event.payload;
  const row = readRow(
    storage,
    READ_SQL.projection,
    ownerId.data,
    payload.id,
    payload.metadata.recordVersion,
  ) as { record_json?: unknown; proposal_digest?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.record_json !== 'string' ||
    typeof row.proposal_digest !== 'string'
  )
    return fail('invalid_history');
  let projection: ActionProposal;
  try {
    projection = deserializeContract('action_proposals', row.record_json);
  } catch {
    return fail('invalid_history');
  }
  const text = canonicalText(projection);
  if (text === undefined || text !== canonicalText(payload))
    return fail('invalid_history');
  return {
    status: 'proposal',
    stored,
    projection,
    declaredDigest: row.proposal_digest,
  };
}

/** Whether any stored proposal of this owner uses the identifier. */
export function proposalIdInUse(
  storage: Storage,
  owner: string,
  proposal: string,
): boolean {
  const ownerId = OwnerIdSchema.safeParse(owner);
  const proposalId = ActionProposalIdSchema.safeParse(proposal);
  if (!ownerId.success || !proposalId.success) return fail('invalid_request');
  return (
    readRow(storage, READ_SQL.proposalInUse, ownerId.data, proposalId.data) !==
    undefined
  );
}

/** Whether the owner exists (the Ledger's own reads also require it). */
export function ownerExists(storage: Storage, owner: string): boolean {
  return readRow(storage, READ_SQL.owner, owner) !== undefined;
}
