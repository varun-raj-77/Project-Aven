export type LedgerErrorCode =
  | 'invalid_input'
  | 'invalid_event'
  | 'unknown_owner'
  | 'unknown_session'
  | 'unknown_task'
  | 'cross_owner_reference'
  | 'invalid_reference'
  | 'duplicate_event'
  | 'transaction_active'
  | 'storage_failure'
  | 'integrity_failure';

export type RollbackStatus = 'not_started' | 'rolled_back' | 'failed';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly rollback: RollbackStatus;
  constructor(
    code: LedgerErrorCode,
    message: string,
    rollback: RollbackStatus = 'not_started',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'LedgerError';
    this.code = code;
    this.rollback = rollback;
  }
}

export function failure(
  error: unknown,
  rollback: RollbackStatus = 'not_started',
): LedgerError {
  if (error instanceof LedgerError)
    return new LedgerError(error.code, error.message, rollback, error);
  const foreignKey =
    error instanceof Error &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
  return new LedgerError(
    foreignKey ? 'invalid_reference' : 'storage_failure',
    foreignKey
      ? 'A reference or exact binding does not resolve for this owner'
      : 'Ledger storage operation failed',
    rollback,
    error,
  );
}
