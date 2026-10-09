import {
  SessionIdSchema,
  TaskIdSchema,
  type ActiveTaskState,
  type OwnerId,
  type SessionId,
  type TaskId,
} from '@aven/contracts';
import { ambientIntact, sealAmbient, type AmbientSeal } from './ambient.ts';
import { OwnerModelError, type OwnerModelErrorCode } from './errors.ts';
import { isOwnerStateIntake, type OwnerStateIntake } from './intake.ts';

/**
 * AVEN-009 patch 6: task-bound ACTIVE task state view (internal; not
 * exported from the package index).
 *
 * Answers only: "what is the latest declared ACTIVE task-state snapshot for
 * this exact task binding?" It never says which durable state applies, what
 * the Context Broker should rank, whether a task has expired or should run,
 * or what Root permits.
 *
 * Input: only a result produced by `intakeOwnerState` (Patch 2, recognized
 * by identity), whose `activeTasks` partition is the only data read; durable
 * state never participates. The request is `{ sessionId, taskId }`: a plain
 * or null-prototype object whose ONLY own properties are those two data
 * properties (read through their descriptors, never invoked or coerced),
 * each valid under the frozen ID schema. Anything else fails with
 * `invalid_input`. The Patch-2 ambient gate is reused at entry and after
 * reading the request.
 *
 * Rule, in this order:
 *   1. for every stable active-task-state ID, its head is the snapshot with
 *      the highest numeric `recordVersion` (versions are compared only
 *      within one ID, never across IDs);
 *   2. only then is each head tested: its `task.sessionId` AND `task.taskId`
 *      must equal the request exactly, and its lifecycle must be `active`.
 * So an older version never resurrects: a head that was closed (completed
 * or cancelled alike) or that now declares another binding yields nothing
 * from that ID. Frozen contracts do not require an ID to keep one binding,
 * and none is assumed.
 *   - no matching active head: `undefined`;
 *   - exactly one: that frozen intake snapshot itself, by identity;
 *   - two or more distinct IDs: no frozen rule picks one, so the call fails
 *     closed with `active_task_conflict`; nothing wins by position, ID,
 *     version or time.
 *
 * Deliberately absent: any clock, reference time, expiry, age or freshness
 * (an old active head is still active); any ranking, Context Broker
 * candidate, execution, tool or proposal; any copy of task fields. The view
 * is a deeply frozen null-prototype wrapper recognized only by this module
 * instance (WeakSet identity). Cost is one pass over the active-task
 * snapshots.
 */

/** The exact task binding of the view. */
export interface ActiveTaskBinding {
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
}

export interface ActiveTaskView {
  readonly ownerId: OwnerId;
  readonly task: ActiveTaskBinding;
  readonly state: ActiveTaskState;
}

export interface ActiveTaskViewRequest {
  readonly sessionId: string;
  readonly taskId: string;
}

const PRODUCED = new WeakSet<object>();

/** Whether `value` was produced by `buildActiveTaskView` (internal). */
export function isActiveTaskView(value: unknown): value is ActiveTaskView {
  return value !== null && typeof value === 'object' && PRODUCED.has(value);
}

/* Internal failure tokens, compared by identity only. */
const REJECT = Object.freeze({ token: 'reject' });
const CONFLICT = Object.freeze({ token: 'conflict' });
const FAILURES: ReadonlyMap<object, OwnerModelErrorCode> = new Map<
  object,
  OwnerModelErrorCode
>([
  [REJECT, 'invalid_input'],
  [CONFLICT, 'active_task_conflict'],
]);

/** An own data property's value, read through its descriptor. */
function dataValue(target: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  )
    throw REJECT;
  return descriptor.value;
}

/** The exact `{ sessionId, taskId }` of a request, read inertly. */
function requestedBinding(request: unknown): ActiveTaskBinding {
  if (request === null || typeof request !== 'object') throw REJECT;
  if (Array.isArray(request)) throw REJECT;
  const prototype = Reflect.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) throw REJECT;
  const keys = Reflect.ownKeys(request);
  if (
    keys.length !== 2 ||
    !keys.includes('sessionId') ||
    !keys.includes('taskId')
  )
    throw REJECT;
  const sessionId = dataValue(request, 'sessionId');
  const taskId = dataValue(request, 'taskId');
  if (typeof sessionId !== 'string' || typeof taskId !== 'string') throw REJECT;
  const session = SessionIdSchema.safeParse(sessionId);
  const task = TaskIdSchema.safeParse(taskId);
  if (!session.success || !task.success) throw REJECT;
  const binding = Object.create(null) as {
    sessionId: SessionId;
    taskId: TaskId;
  };
  binding.sessionId = session.data;
  binding.taskId = task.data;
  return Object.freeze(binding);
}

/**
 * The latest declared active task state for an exact task binding, or
 * `undefined`. Throws `OwnerModelError` with a fixed code and message.
 */
export function buildActiveTaskView(
  intake: OwnerStateIntake,
  request: ActiveTaskViewRequest,
): ActiveTaskView | undefined {
  try {
    if (!isOwnerStateIntake(intake)) throw REJECT;
    let seal: AmbientSeal | undefined;
    try {
      seal = sealAmbient();
    } catch {
      seal = undefined;
    }
    if (seal === undefined) throw REJECT;
    let binding: ActiveTaskBinding;
    try {
      binding = requestedBinding(request);
    } catch {
      throw REJECT;
    }
    if (!ambientIntact(seal)) throw REJECT;

    // 1. Each stable ID's head: its highest numeric recordVersion.
    const heads = new Map<string, ActiveTaskState>();
    for (const state of intake.activeTasks) {
      const head = heads.get(state.id);
      if (
        head === undefined ||
        state.metadata.recordVersion > head.metadata.recordVersion
      )
        heads.set(state.id, state);
    }

    // 2. Only heads are tested: exact binding and an active lifecycle.
    let match: ActiveTaskState | undefined;
    let conflict = false;
    for (const head of heads.values()) {
      if (
        head.task.sessionId !== binding.sessionId ||
        head.task.taskId !== binding.taskId ||
        head.lifecycle.status !== 'active'
      )
        continue;
      if (match === undefined) match = head;
      else conflict = true;
    }
    if (conflict) throw CONFLICT;
    if (match === undefined) return undefined;

    const view = Object.create(null) as {
      ownerId: OwnerId;
      task: ActiveTaskBinding;
      state: ActiveTaskState;
    };
    view.ownerId = intake.ownerId;
    view.task = binding;
    view.state = match;
    PRODUCED.add(Object.freeze(view));
    return view;
  } catch (thrown) {
    throw new OwnerModelError(
      thrown !== null && typeof thrown === 'object'
        ? (FAILURES.get(thrown) ?? 'internal_error')
        : 'internal_error',
    );
  }
}
