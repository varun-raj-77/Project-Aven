import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DigestSchema,
  EvidenceRecordSchema,
  ExperienceEventSchema,
  type EvidenceRecord,
  type ExperienceEvent,
} from '@aven/contracts';
import {
  serializeContract,
  type ContractName,
  type Storage,
} from '@aven/storage';
import { LedgerError } from './errors.ts';

type WithoutRecording<T> = T extends unknown
  ? Omit<T, 'recordedAt'> & {
      recordedAt?: never;
      sequence?: never;
    }
  : never;
export type EventInput = WithoutRecording<ExperienceEvent>;
export type EvidenceInput = WithoutRecording<EvidenceRecord>;
export interface AppendOptions {
  evidence?: readonly EvidenceInput[];
  /** Required only for action_proposed; preserved claim, not a computed hash. */
  proposalDigest?: z.infer<typeof DigestSchema>;
}
export interface StoredEvent {
  readonly sequence: number;
  readonly event: ExperienceEvent;
  readonly evidence: readonly EvidenceRecord[];
}

function unrecorded(input: unknown): { [key: string]: unknown } {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.hasOwn(input, 'recordedAt') ||
    Object.hasOwn(input, 'sequence')
  )
    throw new LedgerError(
      'invalid_event',
      'Supply an event/evidence input without recordedAt or sequence',
    );
  return input as { [key: string]: unknown };
}

/**
 * Every declared `ownerId`, at any depth of the event or its new evidence, must
 * name the bound Ledger owner. This is the same rule the frozen v1 reference
 * projection enforces, applied before validation so the failure is typed as a
 * cross-owner reference. IDs that merely do not resolve in this owner's
 * namespace are not probed in other owners and remain unknown/unresolved.
 */
export function assertOwnerClaims(
  owner: string,
  input: unknown,
  options: unknown,
) {
  const seen = new WeakSet<object>();
  function scan(value: unknown) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (Object.hasOwn(value, 'ownerId')) {
      const claimed = (value as { ownerId: unknown }).ownerId;
      if (typeof claimed === 'string' && claimed !== owner)
        throw new LedgerError(
          'cross_owner_reference',
          'Event, payload, provenance and evidence owner claims must name this Ledger owner',
        );
    }
    for (const entry of Object.values(value)) scan(entry);
  }
  scan(input);
  if (options && typeof options === 'object' && 'evidence' in options)
    scan(options.evidence);
}

export function prepareAppend(
  input: EventInput,
  options: AppendOptions,
  recordedAt: string,
) {
  try {
    const settings = z
      .strictObject({
        evidence: z.array(z.unknown()).optional(),
        proposalDigest: DigestSchema.optional(),
      })
      .parse(options);
    const event = ExperienceEventSchema.parse({
      ...unrecorded(input),
      recordedAt,
    });
    const evidence = (settings.evidence ?? []).map((value) =>
      EvidenceRecordSchema.parse({ ...unrecorded(value), recordedAt }),
    );
    if (
      new Set(event.evidenceIds).size !== event.evidenceIds.length ||
      new Set(evidence.map((e) => e.id)).size !== evidence.length ||
      event.evidenceIds.length !== evidence.length ||
      evidence.some(
        (e) =>
          e.ownerId !== event.ownerId ||
          e.eventId !== event.id ||
          !event.evidenceIds.includes(e.id),
      )
    )
      throw new LedgerError(
        'invalid_reference',
        'Supply exactly the new evidence named by this event, with matching owner and event',
      );
    // New owner-origin evidence always names this event as its source (AVEN-002).
    // Accept it only when the event itself declares that same owner origin at this
    // event; an event deriving from an earlier owner statement cannot mint new
    // owner-origin evidence for content recorded here.
    const origin = event.provenance;
    if (
      evidence.some(
        (e) =>
          'ownerId' in e.provenance &&
          (e.provenance.kind !== origin.kind ||
            !('sourceEventId' in origin) ||
            origin.sourceEventId !== event.id),
      )
    )
      throw new LedgerError(
        'invalid_reference',
        'Owner-origin evidence requires the same explicit origin declared at its recording event',
      );
    if (
      (event.eventType === 'action_proposed') !==
      (settings.proposalDigest !== undefined)
    )
      throw new LedgerError(
        'invalid_input',
        'proposalDigest is required exactly for action_proposed',
      );
    return { event, evidence, proposalDigest: settings.proposalDigest };
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError(
      'invalid_event',
      'Event, evidence or append options failed contract validation',
      'not_started',
      error,
    );
  }
}

// Exact historical payload projections only. Never writes owner state or generates learning.
export function projection(
  event: ExperienceEvent,
): { table: ContractName; id: string; version: number } | undefined {
  const p = event.payload;
  const version = 'metadata' in p ? p.metadata.recordVersion : 1;
  switch (event.eventType) {
    case 'owner_request':
    case 'assistant_response':
      return undefined;
    case 'owner_correction':
      return {
        table: 'corrections',
        id: event.payload.evidence.evidenceId,
        version,
      };
    case 'action_proposed':
      return { table: 'action_proposals', id: event.payload.id, version };
    case 'policy_decision':
      return { table: 'policy_decisions', id: event.payload.id, version };
    case 'owner_approval':
      return { table: 'owner_approvals', id: event.payload.id, version };
    case 'tool_execution':
      return { table: 'tool_executions', id: event.payload.id, version };
    case 'verification':
      return { table: 'verification_results', id: event.payload.id, version };
    case 'learning_candidate_created':
      return { table: 'learning_candidates', id: event.payload.id, version };
    case 'learning_candidate_evaluated':
      return { table: 'evaluations', id: event.payload.id, version };
    default:
      return { table: 'lifecycle_records', id: event.payload.eventId, version };
  }
}

export function insertProjection(
  s: Storage,
  event: ExperienceEvent,
  digest: string | undefined,
) {
  const target = projection(event);
  if (!target) return;
  const existing = s.sqlite
    .prepare(
      `SELECT record_json FROM ${target.table}
    WHERE owner_id = ? AND record_id = ? AND record_version = ?`,
    )
    .get(event.ownerId, target.id, target.version) as
    { record_json: string } | undefined;
  if (existing) {
    if (!isDeepStrictEqual(JSON.parse(existing.record_json), event.payload))
      throw new LedgerError(
        'invalid_reference',
        'Historical payload conflicts with its existing snapshot',
      );
    if (
      target.table === 'action_proposals' &&
      !s.sqlite
        .prepare(
          `SELECT 1 FROM action_proposals
      WHERE owner_id = ? AND record_id = ? AND record_version = ? AND proposal_digest = ?`,
        )
        .get(event.ownerId, target.id, target.version, digest)
    )
      throw new LedgerError(
        'invalid_reference',
        'Proposal digest conflicts with its existing snapshot',
      );
    return;
  }
  const json = serializeContract(target.table, event.payload);
  if (target.table === 'action_proposals')
    s.sqlite
      .prepare(
        'INSERT INTO action_proposals(record_json, proposal_digest) VALUES (?, ?)',
      )
      .run(json, digest);
  else
    s.sqlite
      .prepare(`INSERT INTO ${target.table}(record_json) VALUES (?)`)
      .run(json);
}
