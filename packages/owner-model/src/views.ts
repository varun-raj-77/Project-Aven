import {
  TimestampSchema,
  type DurableOwnerState,
  type LearnedItemId,
  type OwnerId,
} from '@aven/contracts';
import { ambientIntact, sealAmbient, type AmbientSeal } from './ambient.ts';
import { compareCodeUnits } from './canonical-text.ts';
import {
  isVerifiedDurableLineage,
  type VerifiedDurableLineage,
} from './claims.ts';
import { OwnerModelError, type OwnerModelErrorCode } from './errors.ts';
import type { DurableCategory, DurableHistory } from './lineage.ts';
import { compareInstants } from './timestamps.ts';

/**
 * AVEN-009 patch 5: deterministic, typed, READ-ONLY durable category views
 * (internal; not exported from the package index).
 *
 * NOT AUTHORITATIVE. These views answer only: "what durable state is
 * DECLARED for each stable learned-item identity, by typed category, at an
 * explicitly supplied reference time?" They never answer which version Root
 * selected, what is true, or what anything permits. Trusted-version
 * selection belongs to Root; as the frozen storage `latest_*` views already
 * say, a latest declared snapshot is not a Root decision.
 *
 *   - `latestDeclared`: for one stable ID, the snapshot with the highest
 *     `recordVersion` among those whose `metadata.createdAt` is at or before
 *     `referenceTime` (exact instants; see timestamps.ts). An ID with no
 *     snapshot by then is absent from the view. Later versions never leak
 *     backwards in time.
 *   - `currentDeclared`: that same snapshot, present only when its own
 *     lifecycle status is observed, validated or trusted AND its own bounded
 *     temporal qualifier (if any) covers `referenceTime`: `from` inclusive,
 *     `until` exclusive. A superseded or revoked head has no
 *     `currentDeclared`; it stays visible as `latestDeclared`.
 *
 * Deliberately NOT done: no older version is ever used instead of the head
 * (no fallback to an earlier trusted version, no rollback); a trusted older
 * version never outranks a newer observed or validated one; replacement and
 * fallback references are not followed (each identity has its own entry);
 * no domain, task, recipient, entity or context matching and no ranking (the
 * Context Broker's job); global, unknown and uncertain scopes and bounded
 * scopes without a temporal qualifier are not interpreted or widened; facts
 * are declared records, not truth; procedures are data, never executed;
 * active task state, persistence and transitions are not involved.
 *
 * Input: only a result produced by `verifyLifecycleClaims` (Patch 4,
 * recognized by identity), so every trusted, superseded or revoked claim in
 * it has already been checked against recorded transitions; and a request
 * `{ referenceTime }`, a plain object whose only own property is a data
 * property holding a frozen AVEN-002 timestamp (read through its descriptor,
 * never coerced). Anything else fails with `invalid_input`. The Patch-2
 * ambient gate is reused at entry and after reading the request. No clock.
 *
 * Consistency: every history routed to a category must hold only that
 * category (`internal_error` otherwise; Patch 2 already guarantees it), and
 * every episode's `content.occurredAt` must not be later than its
 * `metadata.createdAt` (`invalid_owner_state_view`). All histories are
 * checked in canonical order, whatever the reference time.
 *
 * Output: a deeply frozen null-prototype wrapper referencing the unchanged
 * verified input, with fixed category arrays ordered by learned-item ID
 * (UTF-16 code units). Item views reference the frozen records themselves.
 * Results are recognized only by this module instance (WeakSet identity).
 * Cost is one backward scan per history plus one sort per category.
 */

type Content = DurableOwnerState['content'];

/** A durable snapshot whose content is of category `C`. */
export type DurableRecordOf<C extends DurableCategory> = DurableOwnerState & {
  readonly content: Extract<Content, { category: C }>;
};

/** One stable identity's declared state at the reference time. */
export interface DurableItemView<C extends DurableCategory> {
  readonly learnedItemId: LearnedItemId;
  readonly latestDeclared: DurableRecordOf<C>;
  readonly currentDeclared?: DurableRecordOf<C>;
}

export interface DurableCategoryViewRequest {
  readonly referenceTime: string;
}

export interface DurableCategoryViews {
  readonly ownerId: OwnerId;
  readonly referenceTime: string;
  readonly verified: VerifiedDurableLineage;
  readonly facts: readonly DurableItemView<'fact'>[];
  readonly preferences: readonly DurableItemView<'preference'>[];
  readonly episodes: readonly DurableItemView<'episode'>[];
  readonly intentPatterns: readonly DurableItemView<'intent_pattern'>[];
  readonly procedures: readonly DurableItemView<'procedure'>[];
}

const PRODUCED = new WeakSet<object>();

/** Whether `value` was produced by `buildDurableCategoryViews` (internal). */
export function isDurableCategoryViews(
  value: unknown,
): value is DurableCategoryViews {
  return value !== null && typeof value === 'object' && PRODUCED.has(value);
}

/* Internal failure tokens, compared by identity only. */
const REJECT = Object.freeze({ token: 'reject' });
const VIEW = Object.freeze({ token: 'view' });
const INTERNAL = Object.freeze({ token: 'internal' });
const FAILURES: ReadonlyMap<object, OwnerModelErrorCode> = new Map<
  object,
  OwnerModelErrorCode
>([
  [REJECT, 'invalid_input'],
  [VIEW, 'invalid_owner_state_view'],
  [INTERNAL, 'internal_error'],
]);

/** Lifecycle statuses whose own snapshot can be currently declared. */
const LIVE: ReadonlySet<string> = new Set(['observed', 'validated', 'trusted']);

function instantOrder(a: string, b: string): number {
  const order = compareInstants(a, b);
  if (order === undefined) throw INTERNAL;
  return order;
}

/** The reference time of a `{ referenceTime }` request, read inertly. */
function requestedTime(request: unknown): string {
  if (request === null || typeof request !== 'object') throw REJECT;
  if (Array.isArray(request)) throw REJECT;
  const prototype = Reflect.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) throw REJECT;
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 1 || keys[0] !== 'referenceTime') throw REJECT;
  const descriptor = Reflect.getOwnPropertyDescriptor(request, 'referenceTime');
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  )
    throw REJECT;
  const value: unknown = descriptor.value;
  if (
    typeof value !== 'string' ||
    !TimestampSchema.safeParse(value).success ||
    compareInstants(value, value) === undefined
  )
    throw REJECT;
  return value;
}

/** Category and episode-time consistency of one whole history. */
function checkHistory(history: DurableHistory): void {
  for (const record of history.versions) {
    if (
      record.id !== history.learnedItemId ||
      record.content.category !== history.category
    )
      throw INTERNAL;
    if (
      record.content.category === 'episode' &&
      instantOrder(record.content.occurredAt, record.metadata.createdAt) > 0
    )
      throw VIEW;
  }
}

/** Highest version created at or before `referenceTime` (backward scan). */
function declaredAsOf(
  versions: readonly DurableOwnerState[],
  referenceTime: string,
): DurableOwnerState | undefined {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const record = versions[i]!;
    if (instantOrder(record.metadata.createdAt, referenceTime) <= 0)
      return record;
  }
  return undefined;
}

/** Whether the snapshot's own lifecycle and temporal scope cover the time. */
function inEffectAsDeclared(
  record: DurableOwnerState,
  referenceTime: string,
): boolean {
  if (!LIVE.has(record.lifecycle.status)) return false;
  const scope = record.scope;
  if (scope.kind !== 'bounded' || scope.temporal === undefined) return true;
  if (instantOrder(scope.temporal.from, referenceTime) > 0) return false;
  const until = scope.temporal.until;
  return until === undefined || instantOrder(referenceTime, until) < 0;
}

type AnyItemView = DurableItemView<DurableCategory>;

function itemView(
  history: DurableHistory,
  referenceTime: string,
): AnyItemView | undefined {
  const latest = declaredAsOf(history.versions, referenceTime);
  if (latest === undefined) return undefined;
  const view = Object.create(null) as {
    learnedItemId: LearnedItemId;
    latestDeclared: DurableOwnerState;
    currentDeclared?: DurableOwnerState;
  };
  view.learnedItemId = history.learnedItemId;
  view.latestDeclared = latest;
  if (inEffectAsDeclared(latest, referenceTime)) view.currentDeclared = latest;
  return Object.freeze(view) as AnyItemView;
}

function byLearnedItemId(a: AnyItemView, b: AnyItemView): number {
  return compareCodeUnits(a.learnedItemId, b.learnedItemId);
}

/**
 * Typed durable category views of a Patch-4 verified lineage at an explicit
 * reference time. Throws `OwnerModelError` with a fixed code and message.
 */
export function buildDurableCategoryViews(
  verified: VerifiedDurableLineage,
  request: DurableCategoryViewRequest,
): DurableCategoryViews {
  try {
    if (!isVerifiedDurableLineage(verified)) throw REJECT;
    let seal: AmbientSeal | undefined;
    try {
      seal = sealAmbient();
    } catch {
      seal = undefined;
    }
    if (seal === undefined) throw REJECT;
    let referenceTime: string;
    try {
      referenceTime = requestedTime(request);
    } catch {
      throw REJECT;
    }
    if (!ambientIntact(seal)) throw REJECT;

    const histories = verified.lineage.histories;
    for (const history of histories) checkHistory(history);

    const facts: AnyItemView[] = [];
    const preferences: AnyItemView[] = [];
    const episodes: AnyItemView[] = [];
    const intentPatterns: AnyItemView[] = [];
    const procedures: AnyItemView[] = [];
    for (const history of histories) {
      const item = itemView(history, referenceTime);
      if (item === undefined) continue;
      if (history.category === 'fact') facts.push(item);
      else if (history.category === 'preference') preferences.push(item);
      else if (history.category === 'episode') episodes.push(item);
      else if (history.category === 'intent_pattern') intentPatterns.push(item);
      else if (history.category === 'procedure') procedures.push(item);
      else throw INTERNAL;
    }

    const views = Object.create(null) as {
      -readonly [K in keyof DurableCategoryViews]: DurableCategoryViews[K];
    };
    views.ownerId = verified.ownerId;
    views.referenceTime = referenceTime;
    views.verified = verified;
    views.facts = Object.freeze(facts.sort(byLearnedItemId)) as never;
    views.preferences = Object.freeze(
      preferences.sort(byLearnedItemId),
    ) as never;
    views.episodes = Object.freeze(episodes.sort(byLearnedItemId)) as never;
    views.intentPatterns = Object.freeze(
      intentPatterns.sort(byLearnedItemId),
    ) as never;
    views.procedures = Object.freeze(procedures.sort(byLearnedItemId)) as never;
    PRODUCED.add(Object.freeze(views));
    return views;
  } catch (thrown) {
    throw new OwnerModelError(
      thrown !== null && typeof thrown === 'object'
        ? (FAILURES.get(thrown) ?? 'internal_error')
        : 'internal_error',
    );
  }
}
