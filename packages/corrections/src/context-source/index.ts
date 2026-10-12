/**
 * @aven/corrections/context-source: AVEN-010 patch 6, correction-aware
 * assembly through the frozen AVEN-008 Context Broker with exposure
 * verification. Read/compute-only: it takes a correction history the caller
 * already loaded (for example with `@aven/corrections/ledger`), never reads
 * or writes storage itself, and decides no authority.
 */
export {
  assembleWithCorrections,
  CORRECTION_INSTRUCTION_SOURCE_ID,
  type CorrectionAssemblyInput,
  type CorrectionAssemblyOutcome,
  type InstructionIdentity,
  type MissingInstruction,
  type NotExposedReason,
} from './integration.ts';
