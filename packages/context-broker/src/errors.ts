/**
 * Context Broker failures. The public message is fixed per code, so source
 * error text, candidate content and validation detail never cross this
 * boundary through it. Validation issues or a source's original error are kept
 * only in `cause` for in-process diagnosis; callers must never serialize
 * `cause`. `sourceId` (a caller-registered identifier) and `candidateIndex`
 * locate the failing input without exposing it.
 *
 * Owner isolation is not an error: candidates of another owner are excluded
 * before any statistic and only counted in the trace (see `broker.ts`).
 */
export type ContextBrokerErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'source_failure'
  | 'candidate_limit_exceeded'
  | 'invalid_candidate'
  | 'invalid_score_metadata';

const messages: Record<ContextBrokerErrorCode, string> = {
  invalid_configuration: 'The Context Broker source configuration is invalid',
  invalid_request:
    'The context request is malformed; no context source was queried',
  source_failure:
    'A context source failed or returned a malformed collection; no context was assembled',
  candidate_limit_exceeded:
    'A context source exceeded the candidate collection limit; no context was assembled',
  invalid_candidate:
    'A context candidate is malformed; no context was assembled',
  invalid_score_metadata:
    'A context candidate has invalid ranking signal metadata; no context was assembled',
};

export const CONTEXT_BROKER_ERROR_CODES = Object.freeze(
  Object.keys(messages) as ContextBrokerErrorCode[],
);

export interface ContextBrokerErrorLocation {
  readonly sourceId?: string;
  readonly candidateIndex?: number;
}

export class ContextBrokerError extends Error {
  readonly code: ContextBrokerErrorCode;
  readonly sourceId: string | undefined;
  readonly candidateIndex: number | undefined;
  constructor(
    code: ContextBrokerErrorCode,
    location: ContextBrokerErrorLocation = {},
    cause?: unknown,
  ) {
    super(messages[code], { cause });
    this.name = 'ContextBrokerError';
    this.code = code;
    this.sourceId = location.sourceId;
    this.candidateIndex = location.candidateIndex;
  }
}
