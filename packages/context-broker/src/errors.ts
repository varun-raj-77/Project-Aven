/**
 * Context Broker failures (error policy v2).
 *
 * The public `code` and `message` are fixed per code. Source error text,
 * candidate content, validation detail and thrown adapter values never cross
 * this boundary: v2 keeps NO `cause` (v1 kept validation issues and source
 * errors there, which could carry secrets). `sourceId` (a caller-registered
 * identifier) locates the failing source; it is not guaranteed secret-free.
 *
 * `candidateIndex`, when present, is an OWNER-LOCAL zero-based position: the
 * failing record's position among the source's records whose `ownerId` read
 * as the requesting owner. It is never a raw source-array offset, which other
 * owners' records could shift (review H3). It is omitted when ownership could
 * not be established (unreadable element or `ownerId`, unrecognizable owner)
 * and for source-, quota- and duplicate-level failures.
 *
 * Owner isolation is not an error: recognizable foreign records are dropped
 * before validation and leave no count or trace (see `broker.ts`).
 */
export type ContextBrokerErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'source_failure'
  | 'source_timeout'
  | 'source_resource_limit_exceeded'
  | 'candidate_limit_exceeded'
  | 'invalid_candidate'
  | 'invalid_score_metadata'
  | 'conflicting_duplicate';

const messages: Readonly<Record<ContextBrokerErrorCode, string>> =
  Object.freeze({
    invalid_configuration: 'The Context Broker source configuration is invalid',
    invalid_request:
      'The context request is malformed; no context source was queried',
    source_failure:
      'A context source failed or returned a malformed collection; no context was assembled',
    source_timeout:
      'A context source did not finish before the collection deadline; no context was assembled',
    source_resource_limit_exceeded:
      'A context source exceeded the raw collection resource limit; no context was assembled',
    candidate_limit_exceeded:
      'A context source exceeded the owner-context candidate quota; no context was assembled',
    invalid_candidate:
      'A context candidate is malformed; no context was assembled',
    invalid_score_metadata:
      'A context candidate has invalid ranking signal metadata; no context was assembled',
    conflicting_duplicate:
      'Context candidates share an identity but disagree; no context was assembled',
  });

export const CONTEXT_BROKER_ERROR_CODES: readonly ContextBrokerErrorCode[] =
  Object.freeze(Object.keys(messages) as ContextBrokerErrorCode[]);

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
  ) {
    const safe = Object.hasOwn(messages, code) ? code : 'source_failure';
    super(messages[safe]);
    this.name = 'ContextBrokerError';
    this.code = safe;
    this.sourceId = location.sourceId;
    this.candidateIndex = location.candidateIndex;
  }
}
