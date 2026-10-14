import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalText,
  digestOfCanonicalText,
  isWellFormed,
} from '../src/canonical.ts';
import {
  ACTION_PROPOSAL_DIGEST_PROTOCOL,
  computeActionProposalDigest,
  constructActionProposal,
  validateActionProposal,
} from '../src/index.ts';
import {
  clone,
  context,
  draft,
  expectError,
  leafPaths,
  mutateLeaf,
  reverseKeys,
  vectorFile,
} from './fixtures.ts';

/**
 * Digest protocol v1. The golden vectors were produced by an independent
 * Python standard-library procedure recorded in digest-vectors.json, never by
 * the code under test. Claims here are finite: they cover these vectors and
 * these enumerated mutations; distinct canonical texts give distinct digests
 * only with overwhelming probability, under SHA-256 collision resistance.
 */
const byName = Object.fromEntries(vectorFile.vectors.map((v) => [v.name, v]));
const ctxOf = (p: Record<string, unknown>) => {
  const task = p.task as { sessionId: string; taskId: string };
  return {
    ownerId: p.ownerId as string,
    sessionId: task.sessionId,
    taskId: task.taskId,
  };
};

describe('golden vectors (independent reference)', () => {
  it('pins the protocol tag and the vector inventory', () => {
    expect(vectorFile.protocol).toBe(ACTION_PROPOSAL_DIGEST_PROTOCOL);
    expect(ACTION_PROPOSAL_DIGEST_PROTOCOL).toBe(
      'AVEN-011-ACTION-PROPOSAL-DIGEST-V1',
    );
    expect(vectorFile.vectors.map((v) => v.name)).toEqual([
      'v1-minimal-ascii',
      'v2-unicode-and-escapes',
      'v3a-arrays',
      'v3b-arrays-reversed',
      'v4-locator-only-change',
    ]);
    expect(vectorFile.rejected.map((v) => v.name)).toEqual([
      'lone-high-surrogate',
      'lone-low-surrogate',
    ]);
  });

  it.each(vectorFile.vectors)(
    'reproduces the exact canonical text and digest of $name',
    (vector) => {
      expect(canonicalText(vector.proposal)).toBe(vector.canonical);
      expect(computeActionProposalDigest(vector.proposal)).toEqual({
        algorithm: 'sha256',
        value: vector.digest,
      });
      const validated = validateActionProposal(
        vector.proposal,
        ctxOf(vector.proposal),
      );
      expect(validated.binding.proposalDigest.value).toBe(vector.digest);
      expect(validated.proposal).toEqual(vector.proposal);
    },
  );

  it.each(vectorFile.vectors)(
    'separates the proposal digest from the plain hash of $name',
    (vector) => {
      const plain = createHash('sha256')
        .update(vector.canonical, 'utf8')
        .digest('hex');
      expect(plain).toBe(vector.plainSha256OfCanonical);
      expect(vector.digest).not.toBe(plain);
      // The digest input is exactly tag, one NUL byte and the UTF-8 text.
      expect(
        createHash('sha256')
          .update(
            Buffer.concat([
              Buffer.from('AVEN-011-ACTION-PROPOSAL-DIGEST-V1', 'ascii'),
              Buffer.from([0]),
              Buffer.from(vector.canonical, 'utf8'),
            ]),
          )
          .digest('hex'),
      ).toBe(vector.digest);
    },
  );

  it('derives the same digest when the v1 vector is constructed from a draft', () => {
    const v1 = byName['v1-minimal-ascii']!.proposal as ReturnType<
      typeof JSON.parse
    >;
    const built = constructActionProposal({
      ownerId: v1.ownerId,
      sessionId: v1.task.sessionId,
      taskId: v1.task.taskId,
      proposalId: v1.id,
      createdAt: v1.metadata.createdAt,
      toolId: v1.toolId,
      action: v1.action,
      target: v1.target,
      parameters: v1.parameters,
      consequences: v1.consequences,
      requestedAuthority: v1.requestedAuthority,
      priorApprovalIds: v1.priorApprovalIds,
    });
    expect(built.binding.proposalDigest.value).toBe(
      byName['v1-minimal-ascii']!.digest,
    );
  });

  it.each(vectorFile.rejected)(
    'rejects the ill-formed Unicode of $name',
    (vector) => {
      expect(canonicalText(vector.proposal)).toBeUndefined();
      expectError(
        () => computeActionProposalDigest(vector.proposal),
        'invalid_request',
      );
      expectError(
        () => validateActionProposal(vector.proposal, ctxOf(vector.proposal)),
        'invalid_request',
      );
    },
  );
});

describe('canonical form', () => {
  it.each(vectorFile.vectors)(
    'ignores key insertion order and JSON round trips for $name',
    (vector) => {
      const reordered = reverseKeys(vector.proposal);
      expect(JSON.stringify(reordered)).not.toBe(
        JSON.stringify(vector.proposal),
      );
      expect(canonicalText(reordered)).toBe(vector.canonical);
      expect(canonicalText(JSON.parse(JSON.stringify(reordered)))).toBe(
        vector.canonical,
      );
      expect(computeActionProposalDigest(reordered).value).toBe(vector.digest);
    },
  );

  it('keeps array order significant', () => {
    const a = byName['v3a-arrays']!;
    const b = byName['v3b-arrays-reversed']!;
    expect(a.canonical).not.toBe(b.canonical);
    expect(a.digest).not.toBe(b.digest);
  });

  it('changes the proposal digest but not the parameters digest when only the locator moves', () => {
    const v1 = byName['v1-minimal-ascii']!;
    const v4 = byName['v4-locator-only-change']!;
    const one = validateActionProposal(v1.proposal, ctxOf(v1.proposal));
    const four = validateActionProposal(v4.proposal, ctxOf(v4.proposal));
    expect(one.binding.proposalDigest).not.toEqual(four.binding.proposalDigest);
    expect(one.binding.parametersDigest).toEqual(four.binding.parametersDigest);
  });

  // The finite mutation set: every string and number leaf of every vector.
  it.each([
    ['v1-minimal-ascii', 24],
    ['v2-unicode-and-escapes', 24],
    ['v3a-arrays', 32],
    ['v3b-arrays-reversed', 32],
    ['v4-locator-only-change', 24],
  ] as const)(
    'changes the canonical text and digest for each of the single-leaf mutations of %s (%i leaves)',
    (name, count) => {
      const vector = byName[name]!;
      const paths = leafPaths(vector.proposal);
      expect(paths.length).toBe(count);
      const digests = new Set([vector.digest]);
      for (const path of paths) {
        const text = canonicalText(mutateLeaf(vector.proposal, path));
        expect(text).toBeDefined();
        expect(text).not.toBe(vector.canonical);
        digests.add(digestOfCanonicalText(text!));
      }
      expect(digests.size).toBe(paths.length + 1);
    },
  );

  it('applies no Unicode normalization', () => {
    const composed = canonicalText({ text: 'é' });
    const decomposed = canonicalText({ text: 'é' });
    expect(composed).not.toBe(decomposed);
  });

  it('escapes exactly as specified', () => {
    const cases: [string, string][] = [
      ['\u0000', '"\\u0000"'],
      ['\u001f', '"\\u001f"'],
      ['\b\t\n\f\r', '"\\b\\t\\n\\f\\r"'],
      ['"\\', '"\\"\\\\"'],
      ['\u007f', '"\u007f"'],
      ['  ', '"  "'],
      ['/', '"/"'],
      ['\u{1f600}', '"\u{1f600}"'],
    ];
    for (const [input, expected] of cases)
      expect(canonicalText(input)).toBe(expected);
  });

  it('sorts members by UTF-16 code units and emits no whitespace', () => {
    expect(canonicalText({ b: 1, a: [2, { d: 3, c: 4 }], A: 'x' })).toBe(
      '{"A":"x","a":[2,{"c":4,"d":3}],"b":1}',
    );
  });

  it('has no canonical text outside the v1 value domain', () => {
    for (const value of [
      true,
      null,
      1.5,
      -1,
      -0,
      2 ** 53,
      Number.NaN,
      undefined,
      () => 1,
      new Date(0),
      new Map(),
      { nested: [false] },
      { lone: '\ud800' },
      { ['\udc00']: 1 },
    ])
      expect(canonicalText(value)).toBeUndefined();
    expect(canonicalText(Object.assign(Object.create(null), { a: 0 }))).toBe(
      '{"a":0}',
    );
  });

  it('recognizes unpaired surrogates', () => {
    expect(isWellFormed('plain')).toBe(true);
    expect(isWellFormed('\u{1f600}')).toBe(true);
    expect(isWellFormed('😀')).toBe(true);
    expect(isWellFormed('\ud83d')).toBe(false);
    expect(isWellFormed('\ude00')).toBe(false);
    expect(isWellFormed('a\ud83db')).toBe(false);
    expect(isWellFormed('\ude00\ud83d')).toBe(false);
  });

  it('is the digest of exactly the parsed payload, independent of provenance', () => {
    const built = constructActionProposal(draft());
    const again = constructActionProposal(clone(draft()));
    expect(again).toEqual(built);
    expect(digestOfCanonicalText(canonicalText(built.proposal)!)).toBe(
      built.binding.proposalDigest.value,
    );
    expect(validateActionProposal(built.proposal, context)).toEqual(built);
    expect(JSON.stringify(built)).not.toMatch(
      /provenance|model_inference|system_generated/,
    );
  });
});
