import type { ParsedContextCandidate, ParsedContextRequest } from './types.ts';

/**
 * Declarative scope matching, scope rules v2 (`aven-008-scope-v2`).
 * Deterministic label comparison only: no semantic scope inference, no
 * ontology, no synonym or hierarchy resolution. Labels are compared after NFKC
 * normalization, locale-independent lowercasing, trimming and whitespace
 * collapsing, by exact equality.
 *
 * Each dimension DECLARED by a frozen AVEN-002 bounded scope is a restriction:
 *   - `taskId`          vs the request's task ID (always comparable);
 *   - `domain`, `taskType`, `recipient`, `entity`, `context`
 *                       vs the request's task descriptor; a label the request
 *                       does not declare is UNRESOLVED, never a match;
 *   - `temporal`        `[from, until)` vs the request's reference time.
 *
 * Conservative rule (v2): a bounded scope applies only when EVERY declared
 * restriction is satisfied. Any explicit mismatch -> `mismatch`; otherwise any
 * unresolved restriction -> `unresolved`. Both are eligibility exclusions:
 * lexical relevance cannot rescue them and an exact task binding does not
 * clear an unresolved restriction. (v1 accepted a partial match, e.g. a
 * domain + recipient preference when only the domain was declared.)
 *
 * An uncertain scope applies only when every possibility is satisfied; if all
 * possibilities mismatch it is a `mismatch`, otherwise `unresolved`.
 *
 * Session-wide scope ("any task in this session") has no frozen AVEN-002
 * representation and is deliberately not invented here; task-bound references
 * must match the exact session AND task.
 */
export type ScopeStatus =
  | 'task_match'
  | 'label_match'
  | 'global'
  | 'unknown'
  | 'uncertain'
  | 'unresolved'
  | 'mismatch';

export type ScopeDimension =
  | 'task_binding'
  | 'taskId'
  | 'domain'
  | 'taskType'
  | 'recipient'
  | 'entity'
  | 'context'
  | 'temporal';

export interface ScopeAssessment {
  readonly status: ScopeStatus;
  readonly matched: readonly ScopeDimension[];
  readonly mismatched: readonly ScopeDimension[];
  readonly unresolved: readonly ScopeDimension[];
}

type BoundedScope = Extract<
  ParsedContextCandidate['scope'],
  { kind: 'bounded' }
>;
type Outcome = 'matched' | 'mismatched' | 'unresolved';

export function normalizeLabel(label: string): string {
  return label.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function compareLabel(
  candidate: string | undefined,
  requested: string | undefined,
): Outcome | undefined {
  if (candidate === undefined) return undefined;
  if (requested === undefined) return 'unresolved';
  return normalizeLabel(candidate) === normalizeLabel(requested)
    ? 'matched'
    : 'mismatched';
}

function assessBounded(
  scope: BoundedScope,
  request: ParsedContextRequest,
): ScopeAssessment {
  const descriptor = request.taskDescriptor;
  const reference = Date.parse(request.referenceTime);
  const outcomes: [ScopeDimension, Outcome | undefined][] = [
    [
      'taskId',
      scope.taskId === undefined
        ? undefined
        : scope.taskId === request.task.taskId
          ? 'matched'
          : 'mismatched',
    ],
    ['domain', compareLabel(scope.domain, descriptor.domain)],
    ['taskType', compareLabel(scope.taskType, descriptor.taskType)],
    [
      'recipient',
      compareLabel(
        scope.qualifiers?.recipient,
        descriptor.qualifiers?.recipient,
      ),
    ],
    [
      'entity',
      compareLabel(scope.qualifiers?.entity, descriptor.qualifiers?.entity),
    ],
    [
      'context',
      compareLabel(scope.qualifiers?.context, descriptor.qualifiers?.context),
    ],
    [
      'temporal',
      scope.temporal === undefined
        ? undefined
        : reference >= Date.parse(scope.temporal.from) &&
            (scope.temporal.until === undefined ||
              reference < Date.parse(scope.temporal.until))
          ? 'matched'
          : 'mismatched',
    ],
  ];
  const pick = (o: Outcome) =>
    Object.freeze(outcomes.filter(([, v]) => v === o).map(([d]) => d));
  const matched = pick('matched');
  const mismatched = pick('mismatched');
  const unresolved = pick('unresolved');
  const status: ScopeStatus =
    mismatched.length > 0
      ? 'mismatch'
      : unresolved.length > 0
        ? 'unresolved'
        : matched.includes('taskId')
          ? 'task_match'
          : 'label_match';
  return Object.freeze({ status, matched, mismatched, unresolved });
}

const none: readonly ScopeDimension[] = Object.freeze([]);
const plain = (status: ScopeStatus): ScopeAssessment =>
  Object.freeze({ status, matched: none, mismatched: none, unresolved: none });

const union = (lists: readonly (readonly ScopeDimension[])[]) =>
  Object.freeze([...new Set(lists.flat())].sort());

/** Assesses the candidate's declared scope against the request (not task binding). */
export function assessScope(
  candidate: ParsedContextCandidate,
  request: ParsedContextRequest,
): ScopeAssessment {
  const scope = candidate.scope;
  switch (scope.kind) {
    case 'global':
      return plain('global');
    case 'unknown':
      return plain('unknown');
    case 'uncertain': {
      const possibilities = scope.possibilities.map((p) =>
        assessBounded(p, request),
      );
      const satisfied = (p: ScopeAssessment) =>
        p.status === 'task_match' || p.status === 'label_match';
      if (possibilities.every(satisfied)) return plain('uncertain');
      if (possibilities.every((p) => p.status === 'mismatch'))
        return Object.freeze({
          status: 'mismatch',
          matched: none,
          mismatched: union(possibilities.map((p) => p.mismatched)),
          unresolved: none,
        });
      return Object.freeze({
        status: 'unresolved',
        matched: none,
        mismatched: none,
        unresolved: union(possibilities.map((p) => p.unresolved)),
      });
    }
    case 'bounded':
      return assessBounded(scope, request);
  }
}

/**
 * Task-bound references (active task state, current instruction) belong to
 * exactly one session and task. They are usable only for that exact binding.
 */
export function taskBindingMatches(
  candidate: ParsedContextCandidate,
  request: ParsedContextRequest,
): boolean | undefined {
  const reference = candidate.reference;
  if (
    reference.kind !== 'active_task_state' &&
    reference.kind !== 'current_instruction'
  )
    return undefined;
  return (
    reference.task.sessionId === request.task.sessionId &&
    reference.task.taskId === request.task.taskId
  );
}

/**
 * A matching task binding makes an otherwise APPLICABLE scope (global,
 * unknown, uncertain-satisfied or fully matched labels) an exact task match.
 * It never clears `unresolved` or `mismatch`.
 */
export function withTaskBinding(assessment: ScopeAssessment): ScopeAssessment {
  if (assessment.status === 'unresolved' || assessment.status === 'mismatch')
    return assessment;
  return Object.freeze({
    status: 'task_match',
    matched: Object.freeze<ScopeDimension[]>([
      'task_binding',
      ...assessment.matched,
    ]),
    mismatched: assessment.mismatched,
    unresolved: assessment.unresolved,
  });
}
