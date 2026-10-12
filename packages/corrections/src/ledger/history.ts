import { OwnerIdSchema } from '@aven/contracts';
import { createLedger, LedgerError } from '@aven/ledger';
import type { Storage } from '@aven/storage';
import { CorrectionError, type CorrectionErrorCode } from '../errors.ts';
import {
  validateCorrectionHistory,
  type CorrectionHistory,
  type CorrectionHistoryEntry,
} from '../resolve.ts';

/**
 * AVEN-010 patch 5: the READ-ONLY bridge from the frozen Experience Ledger
 * to the pure immediate resolver (`@aven/corrections/ledger`).
 *
 * `readCorrectionHistory` loads ONE owner's complete recorded correction
 * history through the owner-bound frozen Ledger: a single
 * `replayEvents({ eventType: 'owner_correction' })`, which fixes a finite
 * sequence boundary when it is called and pages (100 events per page) until
 * that boundary is exhausted. A correction appended after the call is not in
 * this history; a later call sees it. Every entry keeps its real owner-local
 * sequence, the complete stored event and ALL evidence the Ledger holds for
 * it, exactly as stored: nothing is normalized, inferred, filtered by task or
 * session, or fabricated. Task, session, as-of, permission and supersession
 * rules stay with the resolver. The whole history must pass the resolver's
 * own consistency checks before anything is returned; any storage, Ledger or
 * consistency failure is a fixed `CorrectionError` and never an empty or
 * partial history.
 *
 * `buildCorrectionEvidenceIndex` derives an ephemeral identity index from a
 * history: which correction owns each evidence record, whether it is that
 * correction's own (instruction) evidence or supporting evidence, and each
 * correction's sequence. Exact identifiers only; no text is interpreted.
 *
 * Nothing here writes: no append, no SQL, no migration, no clock and no
 * identifier source. The Ledger stays authoritative; there is no second
 * persistent index. A declared owner ID is not authenticated identity, and a
 * loaded correction is recorded history, never an authenticated instruction,
 * a durable preference or Root approval.
 */

/** A frozen history ready for `resolveImmediateCorrections`. */
export type PersistedCorrectionHistory = CorrectionHistory;

export interface IndexedCorrection {
  readonly eventId: string;
  readonly sequence: number;
  /** The correction's own evidence: its recorded instruction. */
  readonly ownEvidenceId: string;
  /** Any other evidence the event names, in the event's own order. */
  readonly supportingEvidenceIds: readonly string[];
}
export interface IndexedEvidence {
  readonly evidenceId: string;
  /** The correction event that owns this evidence record. */
  readonly eventId: string;
  readonly sequence: number;
  readonly role: 'own' | 'supporting';
}
export interface CorrectionEvidenceIndex {
  readonly ownerId: string;
  /** Every indexed correction, in Ledger sequence order. */
  readonly corrections: readonly IndexedCorrection[];
  /** The correction with this exact event ID, if it is in the history. */
  correction(eventId: unknown): IndexedCorrection | undefined;
  /** The evidence with this exact evidence ID, if a correction owns it. */
  evidence(evidenceId: unknown): IndexedEvidence | undefined;
}

const fail = (code: CorrectionErrorCode): never => {
  throw new CorrectionError(code);
};

/** Frozen Ledger read failures, as fixed owner-local correction codes. */
function fromLedger(error: unknown): CorrectionErrorCode {
  if (!(error instanceof LedgerError)) return 'storage_failure';
  switch (error.code) {
    case 'unknown_owner':
      return 'unknown_binding';
    case 'integrity_failure':
      return 'invalid_correction_history';
    case 'transaction_active':
    case 'storage_failure':
      return 'storage_failure';
    default:
      // invalid_input cannot arise: the owner is prevalidated and the
      // filter is constant. Anything else is not a read outcome.
      return 'internal_error';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A detached, deeply frozen copy of stored contract data (JSON only). */
const detached = <T>(value: T): T =>
  deepFreeze(JSON.parse(JSON.stringify(value)) as T);

/**
 * Reads one owner's complete recorded correction history from the frozen
 * Ledger. Returns a deeply frozen `{ ownerId, entries }`; throws a fixed
 * `CorrectionError` (no cause, no identifiers) on any failure.
 */
export function readCorrectionHistory(
  storage: Storage,
  ownerId: unknown,
): PersistedCorrectionHistory {
  try {
    const owner = OwnerIdSchema.safeParse(ownerId);
    if (!owner.success) return fail('invalid_correction_history');
    const entries: CorrectionHistoryEntry[] = [];
    try {
      const ledger = createLedger(storage, owner.data);
      let previous = 0;
      for (const stored of ledger.replayEvents({
        eventType: 'owner_correction',
      })) {
        if (
          stored.event.eventType !== 'owner_correction' ||
          stored.event.ownerId !== owner.data ||
          stored.sequence <= previous
        )
          return fail('invalid_correction_history');
        previous = stored.sequence;
        entries.push({
          sequence: stored.sequence,
          event: stored.event,
          evidence: stored.evidence,
        });
      }
    } catch (error) {
      if (error instanceof CorrectionError) throw error;
      return fail(fromLedger(error));
    }
    const history = detached({ ownerId: owner.data, entries });
    // The resolver's own whole-history checks, before anything is returned.
    validateCorrectionHistory(history);
    return history;
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError('internal_error');
  }
}

/**
 * Derives the read-only correction-evidence identity index of one owner's
 * history (any `CorrectionHistory`, typically from `readCorrectionHistory`).
 * The history must pass the resolver's consistency checks, which already
 * reject duplicate or conflicting event and evidence identities, foreign
 * owners and mis-paired evidence; lookups return frozen records.
 */
export function buildCorrectionEvidenceIndex(
  history: unknown,
): CorrectionEvidenceIndex {
  try {
    const validated = validateCorrectionHistory(history);
    const byEvent = new Map<string, IndexedCorrection>();
    const byEvidence = new Map<string, IndexedEvidence>();
    const corrections: IndexedCorrection[] = [];
    for (const { sequence, event } of validated.entries) {
      const own = event.payload.evidence.evidenceId;
      const correction = deepFreeze({
        eventId: event.id,
        sequence,
        ownEvidenceId: own,
        supportingEvidenceIds: event.evidenceIds.filter((id) => id !== own),
      });
      corrections.push(correction);
      byEvent.set(event.id, correction);
      for (const evidenceId of event.evidenceIds)
        byEvidence.set(
          evidenceId,
          deepFreeze({
            evidenceId,
            eventId: event.id,
            sequence,
            role:
              evidenceId === own ? ('own' as const) : ('supporting' as const),
          }),
        );
    }
    const lookup = <T>(map: Map<string, T>, key: unknown) =>
      typeof key === 'string' ? map.get(key) : undefined;
    return Object.freeze({
      ownerId: validated.ownerId,
      corrections: Object.freeze(corrections),
      correction: (eventId: unknown) => lookup(byEvent, eventId),
      evidence: (evidenceId: unknown) => lookup(byEvidence, evidenceId),
    });
  } catch (error) {
    if (error instanceof CorrectionError) throw error;
    throw new CorrectionError('internal_error');
  }
}
