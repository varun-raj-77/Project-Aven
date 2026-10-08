import type {
  DurableOwnerState,
  LearnedItemId,
  OwnerId,
} from '@aven/contracts';
import { sealAmbient } from './ambient.ts';
import { compareCodeUnits } from './canonical-text.ts';
import { OwnerModelError, type OwnerModelErrorCode } from './errors.ts';
import { isOwnerStateIntake, type OwnerStateIntake } from './intake.ts';

/**
 * AVEN-009 patch 3: deterministic STRUCTURAL lineage of durable owner state
 * (internal; not exported from the package index).
 *
 * Input: only a result produced by `intakeOwnerState` (Patch 2), which is the
 * single boundary for caller-supplied values; anything else fails closed with
 * `invalid_input`. Only `intake.durable` is used: active task state never
 * enters durable lineage and no reference resolves against it. The Patch-2
 * ambient-prototype gate is re-run at entry (reused, not duplicated); after
 * it passes, lineage only reads own fields of frozen null-prototype records
 * and runs no caller code. It relies on the same trusted runtime that
 * `ambient.ts` documents for intake, plus the WeakSet that records which
 * results intake produced; a genuine result is recognized by identity only,
 * so a copy, clone, Proxy or look-alike is never read.
 *
 * Output (deeply frozen; null-prototype objects, frozen arrays, no Map/Set):
 *   - `histories`: one per stable learned-item ID, ordered by ID (UTF-16 code
 *     units), each with its category and EVERY version in numeric order. The
 *     version entries are the frozen Patch-2 records themselves (no copy, no
 *     substitution);
 *   - `edges`: the structural references declared by the frozen lifecycle:
 *     a `superseded` snapshot's `replacement` and a `revoked` snapshot's
 *     optional `fallback`, ordered by (kind, source ID, source version,
 *     target ID, target version).
 *
 * A lineage node is the exact frozen reference identity (learnedItemId,
 * recordVersion). A reference resolves only to that exact version inside
 * this owner-bound durable set: no latest-version or nearest-version
 * fallback, no other owner, no storage or Ledger lookup. Because the set is
 * already owner-bound, an unresolved reference is indistinguishable from one
 * that might exist elsewhere. A target must have the SAME content category as
 * its source; a different stable ID, or a different version of the same ID,
 * is otherwise allowed. The target's own lifecycle status never matters; its
 * own edge, if any, takes part in the graph like any other.
 *
 * Validation and error precedence (deterministic, independent of input
 * order): every reference is resolved in canonical edge order first, and any
 * unresolved or cross-category reference fails with
 * `invalid_lineage_reference`; only when all references resolve is the
 * combined replacement + fallback graph checked, and any directed cycle
 * fails with `lineage_cycle`. Neither error carries an ID, version,
 * category, path or count. The frozen schema already rejects a snapshot that
 * references itself (same ID and version); lineage adds indirect cycles.
 *
 * Cycle detection is iterative (no recursion, so a long chain cannot
 * overflow the stack) and linear: each snapshot has at most one lifecycle
 * reference, so every node has out-degree at most one and a single
 * three-state walk visits each node and edge once.
 *
 * Deliberately NOT here (later patches): agreement of lifecycle claims with
 * recorded transitions, authority or Ledger events, any notion of which
 * version applies or is in force, per-category views, active task views and
 * persistence. Lifecycle status is read only to find the structural
 * reference field.
 */

export type DurableCategory = DurableOwnerState['content']['category'];

/** Exact frozen reference identity of one durable snapshot. */
export interface LineageNode {
  readonly learnedItemId: LearnedItemId;
  readonly version: number;
}

/** Every version of one stable learned-item ID, in numeric order. */
export interface DurableHistory {
  readonly learnedItemId: LearnedItemId;
  readonly category: DurableCategory;
  readonly versions: readonly DurableOwnerState[];
}

export type LineageEdgeKind = 'fallback' | 'replacement';

/** One structural reference declared by a snapshot's frozen lifecycle. */
export interface LineageEdge {
  readonly kind: LineageEdgeKind;
  readonly source: LineageNode;
  readonly target: LineageNode;
}

export interface DurableLineage {
  readonly ownerId: OwnerId;
  readonly histories: readonly DurableHistory[];
  readonly edges: readonly LineageEdge[];
}

/* Internal failure tokens, compared by identity only. */
const REJECT = Object.freeze({ token: 'reject' });
const REFERENCE = Object.freeze({ token: 'reference' });
const CYCLE = Object.freeze({ token: 'cycle' });
const FAILURES: ReadonlyMap<object, OwnerModelErrorCode> = new Map<
  object,
  OwnerModelErrorCode
>([
  [REJECT, 'invalid_input'],
  [REFERENCE, 'invalid_lineage_reference'],
  [CYCLE, 'lineage_cycle'],
]);

interface Declared {
  readonly kind: LineageEdgeKind;
  readonly source: DurableOwnerState;
  readonly targetId: LearnedItemId;
  readonly targetVersion: number;
}

function bySnapshot(a: DurableOwnerState, b: DurableOwnerState): number {
  return (
    compareCodeUnits(a.id, b.id) ||
    a.metadata.recordVersion - b.metadata.recordVersion
  );
}

function byDeclared(a: Declared, b: Declared): number {
  return (
    compareCodeUnits(a.kind, b.kind) ||
    bySnapshot(a.source, b.source) ||
    compareCodeUnits(a.targetId, b.targetId) ||
    a.targetVersion - b.targetVersion
  );
}

function node(learnedItemId: LearnedItemId, version: number): LineageNode {
  const value = Object.create(null) as {
    learnedItemId: LearnedItemId;
    version: number;
  };
  value.learnedItemId = learnedItemId;
  value.version = version;
  return Object.freeze(value);
}

/** The structural reference a snapshot's frozen lifecycle declares, if any. */
function declared(source: DurableOwnerState): Declared | undefined {
  const lifecycle = source.lifecycle;
  const reference =
    lifecycle.status === 'superseded'
      ? lifecycle.replacement
      : lifecycle.status === 'revoked'
        ? lifecycle.fallback
        : undefined;
  if (reference === undefined) return undefined;
  return {
    kind: lifecycle.status === 'superseded' ? 'replacement' : 'fallback',
    source,
    targetId: reference.learnedItemId,
    targetVersion: reference.version,
  };
}

/**
 * Whether the out-degree-at-most-one graph `next` has a directed cycle.
 * Iterative three-state walk: unvisited, on the current path, finished.
 */
function hasCycle(
  nodes: readonly DurableOwnerState[],
  next: ReadonlyMap<DurableOwnerState, DurableOwnerState>,
): boolean {
  const ON_PATH = 1;
  const FINISHED = 2;
  const state = new Map<DurableOwnerState, number>();
  for (const start of nodes) {
    if (state.has(start)) continue;
    const path: DurableOwnerState[] = [];
    let at: DurableOwnerState | undefined = start;
    while (at !== undefined && !state.has(at)) {
      state.set(at, ON_PATH);
      path.push(at);
      at = next.get(at);
    }
    if (at !== undefined && state.get(at) === ON_PATH) return true;
    for (const visited of path) state.set(visited, FINISHED);
  }
  return false;
}

/**
 * Deterministic structural lineage of the durable records of one Patch-2
 * intake result. Throws `OwnerModelError` with a fixed code and message.
 */
export function buildDurableLineage(intake: OwnerStateIntake): DurableLineage {
  try {
    if (!isOwnerStateIntake(intake)) throw REJECT;
    let standard: boolean;
    try {
      standard = sealAmbient() !== undefined;
    } catch {
      standard = false;
    }
    if (!standard) throw REJECT;

    const records = [...intake.durable].sort(bySnapshot);

    // Exact-identity index: stable ID -> recordVersion -> snapshot.
    const index = new Map<string, Map<number, DurableOwnerState>>();
    for (const record of records) {
      let versions = index.get(record.id);
      if (versions === undefined) {
        versions = new Map();
        index.set(record.id, versions);
      }
      versions.set(record.metadata.recordVersion, record);
    }

    const histories: DurableHistory[] = [];
    for (let start = 0; start < records.length;) {
      let end = start;
      while (end < records.length && records[end]!.id === records[start]!.id)
        end += 1;
      const first = records[start]!;
      const history = Object.create(null) as {
        learnedItemId: LearnedItemId;
        category: DurableCategory;
        versions: readonly DurableOwnerState[];
      };
      history.learnedItemId = first.id;
      history.category = first.content.category;
      history.versions = Object.freeze(records.slice(start, end));
      histories.push(Object.freeze(history));
      start = end;
    }

    const references: Declared[] = [];
    for (const record of records) {
      const reference = declared(record);
      if (reference !== undefined) references.push(reference);
    }
    references.sort(byDeclared);

    // 1. Every reference must resolve exactly, to the same category.
    const next = new Map<DurableOwnerState, DurableOwnerState>();
    const edges: LineageEdge[] = [];
    for (const reference of references) {
      const target = index
        .get(reference.targetId)
        ?.get(reference.targetVersion);
      if (
        target === undefined ||
        target.content.category !== reference.source.content.category
      )
        throw REFERENCE;
      next.set(reference.source, target);
      const edge = Object.create(null) as {
        kind: LineageEdgeKind;
        source: LineageNode;
        target: LineageNode;
      };
      edge.kind = reference.kind;
      edge.source = node(
        reference.source.id,
        reference.source.metadata.recordVersion,
      );
      edge.target = node(target.id, target.metadata.recordVersion);
      edges.push(Object.freeze(edge));
    }

    // 2. Only then: the combined replacement + fallback graph is acyclic.
    if (hasCycle(records, next)) throw CYCLE;

    const lineage = Object.create(null) as {
      ownerId: OwnerId;
      histories: readonly DurableHistory[];
      edges: readonly LineageEdge[];
    };
    lineage.ownerId = intake.ownerId;
    lineage.histories = Object.freeze(histories);
    lineage.edges = Object.freeze(edges);
    return Object.freeze(lineage);
  } catch (thrown) {
    throw new OwnerModelError(
      thrown !== null && typeof thrown === 'object'
        ? (FAILURES.get(thrown) ?? 'internal_error')
        : 'internal_error',
    );
  }
}
