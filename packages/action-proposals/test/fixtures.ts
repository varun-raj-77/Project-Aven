// All identifiers, texts, locators and digests in this file are SYNTHETIC.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import {
  ActionProposalError,
  type ActionProposalErrorCode,
} from '../src/index.ts';

export const ownerId = 'owner_synthetic';
export const sessionId = 'session_synthetic';
export const taskId = 'task_synthetic';
export const createdAt = '2026-10-14T09:00:00Z';
export const context = Object.freeze({ ownerId, sessionId, taskId });

/** A valid draft; every field is caller-supplied. */
export function draft(overrides: Record<string, unknown> = {}) {
  return {
    ownerId,
    sessionId,
    taskId,
    proposalId: 'proposal_synthetic',
    createdAt,
    toolId: 'synthetic-sandbox-tool',
    action: 'draft',
    target: { kind: 'sandbox_resource', identifier: 'synthetic-draft' },
    parameters: {
      kind: 'immutable_reference',
      artifact: {
        locator: 'synthetic:parameters',
        digest: { algorithm: 'sha256', value: 'b'.repeat(64) },
      },
    },
    consequences: {
      risk: 'low',
      reversibility: 'reversible',
      description: 'Prepare a synthetic draft.',
    },
    requestedAuthority: [
      {
        operation: 'draft',
        resource: { kind: 'sandbox_resource', identifier: 'synthetic-draft' },
      },
    ],
    priorApprovalIds: [],
    ...overrides,
  };
}

/** The complete v1 proposal `draft()` constructs, written out literally. */
export function proposal(overrides: Record<string, unknown> = {}) {
  const d = draft();
  return {
    kind: 'action_proposal',
    ownerId,
    metadata: {
      schemaVersion: 1,
      recordVersion: 1,
      createdAt,
      creation: {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
      },
    },
    id: d.proposalId,
    task: { sessionId, taskId },
    toolId: d.toolId,
    action: d.action,
    parameters: d.parameters,
    target: d.target,
    consequences: d.consequences,
    requestedAuthority: d.requestedAuthority,
    priorApprovalIds: d.priorApprovalIds,
    ...overrides,
  };
}

export function expectError(
  run: () => unknown,
  code: ActionProposalErrorCode,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ActionProposalError);
  expect((thrown as ActionProposalError).code).toBe(code);
  expect((thrown as ActionProposalError).outcome).toBe('not_written');
  expect((thrown as Error).cause).toBeUndefined();
}

export interface DigestVector {
  readonly name: string;
  readonly proposal: Record<string, unknown>;
  readonly canonical: string;
  readonly digest: string;
  readonly plainSha256OfCanonical: string;
}
export interface DigestVectorFile {
  readonly protocol: string;
  readonly vectors: readonly DigestVector[];
  readonly rejected: readonly {
    readonly name: string;
    readonly proposal: Record<string, unknown>;
  }[];
}
export const vectorFile = JSON.parse(
  readFileSync(new URL('./digest-vectors.json', import.meta.url), 'utf8'),
) as DigestVectorFile;

/** Fresh deep copy of plain JSON data. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Paths of every string and number leaf of plain JSON data. */
export function leafPaths(
  value: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[][] {
  if (typeof value === 'string' || typeof value === 'number')
    return [[...path]];
  if (Array.isArray(value))
    return value.flatMap((entry, i) => leafPaths(entry, [...path, i]));
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, [...path, key]),
    );
  return [];
}

/** Returns a copy with the leaf at `path` changed (strings gain a suffix). */
export function mutateLeaf<T>(value: T, path: readonly (string | number)[]): T {
  const copy = clone(value);
  let parent = copy as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    parent = parent[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  const leaf = parent[last];
  parent[last] = typeof leaf === 'number' ? leaf + 1 : `${String(leaf)}x`;
  return copy;
}

/** Returns a copy whose object keys are inserted in reverse order. */
export function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  return value;
}
