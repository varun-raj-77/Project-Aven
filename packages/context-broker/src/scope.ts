import type { ParsedContextCandidate, ParsedContextRequest } from './types.ts';

/**
 * Declarative scope matching v1. Deterministic label comparison only: no
 * semantic scope inference, no ontology, no synonym or hierarchy resolution.
 * Labels are compared after NFKC normalization, locale-independent
 * lowercasing, trimming and whitespace collapsing, by exact equality.
 *
 * Dimensions of a frozen AVEN-002 bounded scope are compared with the request:
 *   - `taskId`          against the request's task ID (always comparable);
 *   - `domain`, `taskType`, `recipient`, `entity`, `context`
 *                       against the request's task descriptor; a label the
 *                       request does not declare is INDETERMINATE, never a
 *                       wildcard match;
 *   - `temporal`        `[from, until)` against the request's reference time;
 *                       it can only exclude, never establish a match.
 * Any explicit mismatch makes the whole candidate ineligible: high lexical
 * relevance can never rescue it.
 */
export type ScopeStatus =
  | 'task_match'
  | 'label_match'
  | 'partial_label_match'
  | 'global'
  | 'indeterminate'
  | 'unknown'
  | 'uncertain'
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
  readonly indeterminate: readonly ScopeDimension[];
}

type BoundedScope = Extract<
  ParsedContextCandidate['scope'],
  { kind: 'bounded' }
>;
type Outcome = 'matched' | 'mismatched' | 'indeterminate';

export function normalizeLabel(label: string): string {
  return label.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function compareLabel(
  candidate: string | undefined,
  requested: string | undefined,
): Outcome | undefined {
  if (candidate === undefined) return undefined;
  if (requested === undefined) return 'indeterminate';
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
  const indeterminate = pick('indeterminate');
  // Temporal can only exclude; it never counts as a positive scope match.
  const positive = matched.filter((d) => d !== 'temporal');
  const status: ScopeStatus =
    mismatched.length > 0
      ? 'mismatch'
      : positive.includes('taskId')
        ? 'task_match'
        : positive.length > 0 && indeterminate.length === 0
          ? 'label_match'
          : positive.length > 0
            ? 'partial_label_match'
            : 'indeterminate';
  return Object.freeze({ status, matched, mismatched, indeterminate });
}

const none: readonly ScopeDimension[] = Object.freeze([]);

/** Assesses the candidate's declared scope against the request (not task binding). */
export function assessScope(
  candidate: ParsedContextCandidate,
  request: ParsedContextRequest,
): ScopeAssessment {
  const scope = candidate.scope;
  switch (scope.kind) {
    case 'global':
      return Object.freeze({
        status: 'global',
        matched: none,
        mismatched: none,
        indeterminate: none,
      });
    case 'unknown':
      return Object.freeze({
        status: 'unknown',
        matched: none,
        mismatched: none,
        indeterminate: none,
      });
    case 'uncertain': {
      // Uncertain scope is excluded only if EVERY possibility explicitly
      // mismatches; otherwise it stays undetermined (never a positive match).
      const possibilities = scope.possibilities.map((p) =>
        assessBounded(p, request),
      );
      const allMismatch = possibilities.every((p) => p.status === 'mismatch');
      return Object.freeze({
        status: allMismatch ? 'mismatch' : 'uncertain',
        matched: none,
        mismatched: allMismatch
          ? Object.freeze(
              [...new Set(possibilities.flatMap((p) => p.mismatched))].sort(),
            )
          : none,
        indeterminate: none,
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
export function taskBinding(
  candidate: ParsedContextCandidate,
): { sessionId: string; taskId: string } | undefined {
  const reference = candidate.reference;
  return reference.kind === 'active_task_state' ||
    reference.kind === 'current_instruction'
    ? reference.task
    : undefined;
}

export function taskBindingMatches(
  candidate: ParsedContextCandidate,
  request: ParsedContextRequest,
): boolean | undefined {
  const binding = taskBinding(candidate);
  if (binding === undefined) return undefined;
  return (
    binding.sessionId === request.task.sessionId &&
    binding.taskId === request.task.taskId
  );
}

/** A matching task binding upgrades any non-mismatch scope to an exact task match. */
export function withTaskBinding(assessment: ScopeAssessment): ScopeAssessment {
  return Object.freeze({
    status: 'task_match',
    matched: Object.freeze<ScopeDimension[]>([
      'task_binding',
      ...assessment.matched,
    ]),
    mismatched: assessment.mismatched,
    indeterminate: assessment.indeterminate,
  });
}
