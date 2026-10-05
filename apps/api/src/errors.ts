import { LedgerError, type LedgerErrorCode } from '@aven/ledger';

/**
 * Stable public failure codes. A response carries only `code` and a fixed,
 * code-specific message; internal causes stay in `cause` for logs and tests.
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'invalid_identifier'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'host_not_allowed'
  | 'route_not_found'
  | 'method_not_allowed'
  | 'owner_not_found'
  | 'session_not_found'
  | 'task_not_found'
  | 'owner_mismatch'
  | 'invalid_reference'
  | 'conflict'
  | 'storage_failure'
  | 'ledger_failure'
  | 'internal_error';

const catalog: Record<ApiErrorCode, { status: number; message: string }> = {
  invalid_request: {
    status: 400,
    message: 'The request is malformed or not permitted by the API schema',
  },
  invalid_identifier: { status: 400, message: 'An identifier is malformed' },
  unsupported_media_type: {
    status: 415,
    message: 'Request bodies must be application/json',
  },
  payload_too_large: { status: 413, message: 'The request body is too large' },
  host_not_allowed: {
    status: 403,
    message: 'The Host header must name a loopback address',
  },
  route_not_found: { status: 404, message: 'No such route' },
  method_not_allowed: {
    status: 405,
    message: 'Method not allowed for this route',
  },
  owner_not_found: { status: 404, message: 'Owner not found' },
  session_not_found: {
    status: 404,
    message: 'Session not found for this owner',
  },
  task_not_found: { status: 404, message: 'Task not found in this session' },
  owner_mismatch: {
    status: 403,
    message: 'The request names a different owner than the addressed owner',
  },
  invalid_reference: {
    status: 422,
    message: 'A reference or binding does not resolve for this owner',
  },
  conflict: {
    status: 409,
    message: 'An identifier already exists; nothing was changed',
  },
  storage_failure: {
    status: 503,
    message: 'Local storage is unavailable; nothing was acknowledged',
  },
  ledger_failure: {
    status: 500,
    message:
      'The Experience Ledger rejected or could not complete the operation; nothing was acknowledged',
  },
  internal_error: { status: 500, message: 'Internal error' },
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  constructor(code: ApiErrorCode, cause?: unknown) {
    super(catalog[code].message, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = catalog[code].status;
  }
}

export function publicBody(error: ApiError) {
  return { error: { code: error.code, message: error.message } } as const;
}

const ledgerCodes: Record<LedgerErrorCode, ApiErrorCode> = {
  invalid_input: 'invalid_request',
  // The API builds every event itself; a contract rejection is an internal defect
  // or a transient clock anomaly, never something a client may retry into success.
  invalid_event: 'ledger_failure',
  unknown_owner: 'owner_not_found',
  unknown_session: 'session_not_found',
  unknown_task: 'task_not_found',
  cross_owner_reference: 'owner_mismatch',
  invalid_reference: 'invalid_reference',
  duplicate_event: 'conflict',
  transaction_active: 'storage_failure',
  storage_failure: 'storage_failure',
  integrity_failure: 'ledger_failure',
};

/** Maps anything thrown below the HTTP layer to a typed public failure. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof LedgerError) {
    // A failed rollback means the connection must not be trusted further.
    if (error.rollback === 'failed')
      return new ApiError('ledger_failure', error);
    return new ApiError(ledgerCodes[error.code], error);
  }
  if (isSqliteError(error)) {
    const code = String(error.code);
    if (
      code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE'
    )
      return new ApiError('conflict', error);
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
      return new ApiError('invalid_reference', error);
    return new ApiError('storage_failure', error);
  }
  // better-sqlite3 reports a closed connection as a TypeError, not a SqliteError.
  if (
    error instanceof TypeError &&
    /database connection is not open/i.test(error.message)
  )
    return new ApiError('storage_failure', error);
  return new ApiError('internal_error', error);
}

function isSqliteError(error: unknown): error is Error & { code: unknown } {
  return (
    error instanceof Error &&
    error.name === 'SqliteError' &&
    'code' in error &&
    typeof error.code === 'string'
  );
}
