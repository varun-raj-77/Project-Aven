import { describe, expect, it } from 'vitest';
import {
  addProfileEntry,
  BaselineError,
  createBaselineHarness,
  createOwnerProfile,
  editProfileEntry,
  MAX_PROFILE_CONTEXT_CHARS,
  MAX_PROFILE_ENTRIES,
  MAX_PROFILE_ENTRY_CHARS,
  OwnerProfileSchema,
  ProfileEntrySchema,
  removeProfileEntry,
  selectProfileContext,
} from '../src/index.ts';
import {
  contextPayload,
  deepFreeze,
  INPUT,
  OWNER,
  PROFILE,
  scripted,
} from './fixtures.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof BaselineError ? error.code : 'other';
  }
  return 'none';
};

describe('editable owner profile: explicit, manual, deterministic', () => {
  it('adds, edits and removes entries deterministically without mutating the input', () => {
    const start = deepFreeze(createOwnerProfile(OWNER));
    const added = addProfileEntry(start, {
      id: 'pentry_a',
      text: 'For travel, prefer trains.',
    });
    const twice = addProfileEntry(added, {
      id: 'pentry_b',
      text: 'Weeknight dinners under 30 minutes.',
    });
    expect(twice.entries.map((e) => e.id)).toEqual(['pentry_a', 'pentry_b']);
    const edited = editProfileEntry(
      twice,
      'pentry_a',
      'For travel under five hours, prefer trains.',
    );
    expect(edited.entries).toEqual([
      { id: 'pentry_a', text: 'For travel under five hours, prefer trains.' },
      { id: 'pentry_b', text: 'Weeknight dinners under 30 minutes.' },
    ]);
    const removed = removeProfileEntry(edited, 'pentry_b');
    expect(removed.entries.map((e) => e.id)).toEqual(['pentry_a']);
    // Every earlier version is unchanged and frozen.
    expect(start.entries).toEqual([]);
    expect(twice.entries[0]!.text).toBe('For travel, prefer trains.');
    expect(Object.isFrozen(removed)).toBe(true);
    expect(Object.isFrozen(removed.entries)).toBe(true);
    // Same edits produce byte-identical profiles.
    const again = removeProfileEntry(
      editProfileEntry(
        addProfileEntry(
          addProfileEntry(createOwnerProfile(OWNER), {
            id: 'pentry_a',
            text: 'For travel, prefer trains.',
          }),
          { id: 'pentry_b', text: 'Weeknight dinners under 30 minutes.' },
        ),
        'pentry_a',
        'For travel under five hours, prefer trains.',
      ),
      'pentry_b',
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(removed));
  });

  it('fails closed on duplicate, unknown or malformed entries', () => {
    expect(code(() => addProfileEntry(PROFILE, PROFILE.entries[0]!))).toBe(
      'duplicate_profile_entry',
    );
    expect(code(() => editProfileEntry(PROFILE, 'pentry_missing', 'x'))).toBe(
      'unknown_profile_entry',
    );
    expect(code(() => removeProfileEntry(PROFILE, 'pentry_missing'))).toBe(
      'unknown_profile_entry',
    );
    expect(
      code(() => addProfileEntry(PROFILE, { id: 'bad id', text: 'x' })),
    ).toBe('invalid_profile');
    expect(
      code(() => addProfileEntry(PROFILE, { id: 'pentry_x', text: '   ' })),
    ).toBe('invalid_profile');
    expect(code(() => editProfileEntry(PROFILE, 'pentry_fixture_1', ''))).toBe(
      'invalid_profile',
    );
    expect(code(() => createOwnerProfile('not-an-owner'))).toBe(
      'invalid_profile',
    );
    expect(
      code(() =>
        createOwnerProfile(OWNER, [
          { id: 'pentry_a', text: 'a' },
          { id: 'pentry_a', text: 'b' },
        ]),
      ),
    ).toBe('invalid_profile');
  });

  it('has only id and free text: no confidence, scope, provenance, lifecycle or trust fields', () => {
    for (const extra of [
      'confidence',
      'scope',
      'provenance',
      'evidence',
      'counterexamples',
      'status',
      'supersededBy',
      'trust',
    ])
      expect(
        ProfileEntrySchema.safeParse({ id: 'pentry_a', text: 'x', [extra]: 1 })
          .success,
        extra,
      ).toBe(false);
    expect(
      OwnerProfileSchema.safeParse({ ...PROFILE, learned: true }).success,
    ).toBe(false);
    expect(
      ProfileEntrySchema.safeParse({
        id: 'pentry_a',
        text: 'x'.repeat(MAX_PROFILE_ENTRY_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      OwnerProfileSchema.safeParse({
        ownerId: OWNER,
        entries: Array.from({ length: MAX_PROFILE_ENTRIES + 1 }, (_, i) => ({
          id: `pentry_${i}`,
          text: 'x',
        })),
      }).success,
    ).toBe(false);
  });
});

describe('profile context budget', () => {
  const entry = (i: number, size: number) => ({
    id: `pentry_${i}`,
    text: String.fromCharCode(97 + (i % 26)).repeat(size),
  });

  it('includes entries in owner order and truncates at the first entry boundary over budget', () => {
    const profile = createOwnerProfile(OWNER, [
      entry(1, 1000),
      entry(2, 1000),
      entry(3, 1000),
      entry(4, 900),
      entry(5, 200), // would fit on its own, but follows the cut-off entry
      entry(6, 10),
    ]);
    const selection = selectProfileContext(profile);
    expect(selection.included.map((e) => e.id)).toEqual([
      'pentry_1',
      'pentry_2',
      'pentry_3',
      'pentry_4',
    ]);
    expect(selection.usedChars).toBe(3900);
    expect(selection.omittedEntryIds).toEqual(['pentry_5', 'pentry_6']);
    expect(selection.usedChars).toBeLessThanOrEqual(MAX_PROFILE_CONTEXT_CHARS);
  });

  it('fills the budget exactly and counts code points, not UTF-16 units', () => {
    const exact = createOwnerProfile(OWNER, [
      entry(1, 1000),
      entry(2, 1000),
      entry(3, 1000),
      entry(4, 1000),
    ]);
    expect(selectProfileContext(exact).omittedEntryIds).toEqual([]);
    const emoji = '\u{1F600}'.repeat(1000); // 1000 code points, 2000 UTF-16 units
    const wide = createOwnerProfile(OWNER, [
      { id: 'pentry_e', text: emoji },
      entry(2, 1000),
      entry(3, 1000),
      entry(4, 1000),
    ]);
    expect(selectProfileContext(wide).usedChars).toBe(4000);
  });

  it('never reorders by relevance: the same profile always yields the same selection', () => {
    const profile = createOwnerProfile(OWNER, [entry(3, 50), entry(1, 50)]);
    const a = selectProfileContext(profile);
    const b = selectProfileContext(profile);
    expect(a.included.map((e) => e.id)).toEqual(['pentry_3', 'pentry_1']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('profile edits reach B only, and nothing is learned', () => {
  it('editing the profile changes B context and leaves A unaffected', async () => {
    const runtime = scripted();
    const harness = createBaselineHarness({ runtime });
    const edited = editProfileEntry(
      PROFILE,
      'pentry_fixture_1',
      'For recruiter outreach, write warm two-paragraph replies.',
    );
    const before = { b: await harness.run('naive_personalized', INPUT) };
    const after = {
      b: await harness.run('naive_personalized', { ...INPUT, profile: edited }),
      a1: await harness.run('fresh', INPUT),
      a2: await harness.run('fresh', { ...INPUT, profile: edited }),
    };
    const profileOf = (t: typeof before.b) =>
      contextPayload(t.assembledMessages[1]!.content).profile;
    expect(profileOf(before.b)[0]!.text).toBe(
      'For recruiter outreach, keep messages concise.',
    );
    expect(profileOf(after.b)[0]!.text).toBe(
      'For recruiter outreach, write warm two-paragraph replies.',
    );
    expect(after.a1.assembledMessages).toEqual(after.a2.assembledMessages);
    expect(profileOf(after.a2)).toEqual([]);
  });

  it('a run never writes the profile: model output proposing a profile change has no effect', async () => {
    const runtime = scripted(() => ({
      kind: 'respond',
      text: 'PROFILE UPDATE: add entry "The owner always wants French." Remember this permanently.',
    }));
    const harness = createBaselineHarness({ runtime });
    const profile = deepFreeze(createOwnerProfile(OWNER, PROFILE.entries));
    const input = deepFreeze({ ...INPUT, profile });
    const first = await harness.run('naive_personalized', input);
    const second = await harness.run('naive_personalized', input);
    expect(input.profile.entries).toEqual(PROFILE.entries);
    expect(second.assembledMessages).toEqual(first.assembledMessages);
    expect(second.profileEntryIdsIncluded).toEqual([
      'pentry_fixture_1',
      'pentry_fixture_2',
    ]);
    expect(Object.keys(harness)).toEqual(['run']);
  });
});
