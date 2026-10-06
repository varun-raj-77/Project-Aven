/**
 * Baseline input/editing failures. The public message is fixed per code; any
 * validation detail stays in `cause` for in-process diagnosis only. Runtime
 * failures are not wrapped here: they keep the AVEN-006 `ModelRuntimeError`
 * codes so A and B share identical runtime error semantics.
 */
export type BaselineErrorCode =
  | 'invalid_input'
  | 'invalid_profile'
  | 'duplicate_profile_entry'
  | 'unknown_profile_entry'
  | 'invalid_dataset'
  | 'invalid_case_selection'
  | 'invalid_harness_configuration';

const messages: Record<BaselineErrorCode, string> = {
  invalid_input:
    'The baseline input is malformed; no model runtime was invoked',
  invalid_profile: 'The owner profile is malformed',
  duplicate_profile_entry: 'A profile entry with this ID already exists',
  unknown_profile_entry: 'No profile entry has this ID',
  invalid_dataset: 'The baseline case dataset is malformed',
  invalid_case_selection: 'The case selection options are invalid',
  invalid_harness_configuration:
    'The baseline harness configuration is invalid',
};

export class BaselineError extends Error {
  readonly code: BaselineErrorCode;
  constructor(code: BaselineErrorCode, cause?: unknown) {
    super(messages[code], { cause });
    this.name = 'BaselineError';
    this.code = code;
  }
}
