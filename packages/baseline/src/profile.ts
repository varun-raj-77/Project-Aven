import { MAX_PROFILE_CONTEXT_CHARS } from './config.ts';
import { BaselineError } from './errors.ts';
import {
  codePointLength,
  OwnerProfileSchema,
  ProfileEntrySchema,
  type OwnerProfile,
  type ProfileEntry,
} from './types.ts';

/**
 * Explicit, manual profile editing for the Naive Personalized baseline.
 *
 * Every function is pure: it validates its input and returns a new frozen
 * profile. Nothing here reads model output, history or any store, and nothing
 * is persisted. A profile changes only because a caller explicitly supplies a
 * different one; there is no automatic profile update anywhere in AVEN-007.
 */
function freezeProfile(profile: OwnerProfile): OwnerProfile {
  return Object.freeze({
    ownerId: profile.ownerId,
    entries: Object.freeze(
      profile.entries.map((e) => Object.freeze({ id: e.id, text: e.text })),
    ) as ProfileEntry[],
  });
}

function parseProfile(value: unknown): OwnerProfile {
  const parsed = OwnerProfileSchema.safeParse(value);
  if (!parsed.success) throw new BaselineError('invalid_profile', parsed.error);
  return freezeProfile(parsed.data);
}

export function createOwnerProfile(
  ownerId: string,
  entries: readonly ProfileEntry[] = [],
): OwnerProfile {
  return parseProfile({ ownerId, entries: [...entries] });
}

/** Appends one entry. The entry ID must not already exist. */
export function addProfileEntry(
  profile: OwnerProfile,
  entry: ProfileEntry,
): OwnerProfile {
  const current = parseProfile(profile);
  const parsedEntry = ProfileEntrySchema.safeParse(entry);
  if (!parsedEntry.success)
    throw new BaselineError('invalid_profile', parsedEntry.error);
  if (current.entries.some((e) => e.id === parsedEntry.data.id))
    throw new BaselineError('duplicate_profile_entry');
  return parseProfile({
    ownerId: current.ownerId,
    entries: [...current.entries, parsedEntry.data],
  });
}

/** Replaces the text of an existing entry, keeping its ID and position. */
export function editProfileEntry(
  profile: OwnerProfile,
  id: string,
  text: string,
): OwnerProfile {
  const current = parseProfile(profile);
  if (!current.entries.some((e) => e.id === id))
    throw new BaselineError('unknown_profile_entry');
  return parseProfile({
    ownerId: current.ownerId,
    entries: current.entries.map((e) => (e.id === id ? { id, text } : e)),
  });
}

/** Removes an existing entry. */
export function removeProfileEntry(
  profile: OwnerProfile,
  id: string,
): OwnerProfile {
  const current = parseProfile(profile);
  if (!current.entries.some((e) => e.id === id))
    throw new BaselineError('unknown_profile_entry');
  return parseProfile({
    ownerId: current.ownerId,
    entries: current.entries.filter((e) => e.id !== id),
  });
}

export interface ProfileContextSelection {
  readonly included: readonly ProfileEntry[];
  /** Entries left out because the budget was reached, in profile order. */
  readonly omittedEntryIds: readonly string[];
  readonly usedChars: number;
}

/**
 * Deterministic profile budget: entries are taken in the owner's order and
 * included whole while their cumulative text length stays within
 * `MAX_PROFILE_CONTEXT_CHARS`. At the first entry that would exceed it, that
 * entry and every later entry are omitted (entry-boundary truncation). There
 * is no relevance ranking, reordering or semantic selection of profile
 * entries; that would begin to resemble the AVEN-008 Context Broker.
 */
export function selectProfileContext(
  profile: OwnerProfile,
  maxChars: number = MAX_PROFILE_CONTEXT_CHARS,
): ProfileContextSelection {
  const current = parseProfile(profile);
  const included: ProfileEntry[] = [];
  const omittedEntryIds: string[] = [];
  let usedChars = 0;
  for (const entry of current.entries) {
    const size = codePointLength(entry.text);
    if (omittedEntryIds.length === 0 && usedChars + size <= maxChars) {
      included.push(Object.freeze({ id: entry.id, text: entry.text }));
      usedChars += size;
    } else {
      omittedEntryIds.push(entry.id);
    }
  }
  return Object.freeze({
    included: Object.freeze(included),
    omittedEntryIds: Object.freeze(omittedEntryIds),
    usedChars,
  });
}
