import { z } from 'zod';
import {
  EventIdSchema,
  NonEmptyTextSchema,
  OwnerIdSchema,
  TimestampSchema,
} from '@aven/contracts';
import {
  MAX_HISTORY_RECORD_CHARS,
  MAX_HISTORY_RECORDS,
  MAX_PROFILE_ENTRIES,
  MAX_PROFILE_ENTRY_CHARS,
  MAX_REQUEST_CHARS,
} from './config.ts';

/** Number of Unicode code points (never splits a surrogate pair). */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

const boundedText = (max: number) =>
  NonEmptyTextSchema.refine(
    (s) => codePointLength(s) <= max,
    `Must be at most ${max} characters`,
  );

/**
 * Profile entry identifier. Baseline-local; not an AVEN-002 learned-item or
 * evidence identifier, because a profile entry is neither.
 */
export const ProfileEntryIdSchema = z
  .string()
  .regex(/^pentry_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

/**
 * One owner-written profile note. Deliberately only `id` and free `text`: no
 * confidence, scope, provenance, evidence, lifecycle, supersession or trust
 * fields. Scope, if any, is expressed in the text itself.
 */
export const ProfileEntrySchema = z.strictObject({
  id: ProfileEntryIdSchema,
  text: boundedText(MAX_PROFILE_ENTRY_CHARS),
});

/**
 * The B-condition editable owner profile: an ordered list of free-text
 * entries supplied or edited explicitly by the owner or the experiment. Order
 * is owner-controlled and is the only priority signal used for the context
 * budget.
 */
export const OwnerProfileSchema = z
  .strictObject({
    ownerId: OwnerIdSchema,
    entries: z.array(ProfileEntrySchema).max(MAX_PROFILE_ENTRIES),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.entries.forEach((entry, index) => {
      if (seen.has(entry.id))
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'id'],
          message: 'Profile entry IDs must be unique',
        });
      seen.add(entry.id);
    });
  });

/**
 * A normalized, searchable interaction-history record. The baseline consumes
 * these as plain input; it does not own Ledger persistence and never writes,
 * tags or rewrites the source records.
 */
export const HistoryRecordSchema = z.strictObject({
  ownerId: OwnerIdSchema,
  eventId: EventIdSchema,
  role: z.enum(['owner', 'assistant']),
  text: boundedText(MAX_HISTORY_RECORD_CHARS),
  occurredAt: TimestampSchema,
});

export const HistorySchema = z
  .array(HistoryRecordSchema)
  .max(MAX_HISTORY_RECORDS)
  .superRefine((records, ctx) => {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (seen.has(record.eventId))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'eventId'],
          message: 'History event IDs must be unique',
        });
      seen.add(record.eventId);
    });
  });

export const OwnerRequestTextSchema = boundedText(MAX_REQUEST_CHARS);

/**
 * Everything that may reach baseline prompt assembly, and nothing else. Strict:
 * an evaluation label, oracle field or split annotation is rejected rather than
 * silently carried along. History may include other owners' records; naive
 * search filters them out before scoring.
 */
export const BaselineInputSchema = z
  .strictObject({
    ownerId: OwnerIdSchema,
    request: OwnerRequestTextSchema,
    profile: OwnerProfileSchema,
    history: HistorySchema,
  })
  .refine((input) => input.profile.ownerId === input.ownerId, {
    path: ['profile', 'ownerId'],
    message: 'Profile owner must match the request owner',
  });

/*
 * Public types are the schemas' INPUT types (plain strings, no ID brands):
 * every entry point re-validates with the schema, so callers need not
 * pre-brand identifiers.
 */
export type ProfileEntry = z.input<typeof ProfileEntrySchema>;
export type OwnerProfile = z.input<typeof OwnerProfileSchema>;
export type HistoryRecord = z.input<typeof HistoryRecordSchema>;
export type BaselineInput = z.input<typeof BaselineInputSchema>;
