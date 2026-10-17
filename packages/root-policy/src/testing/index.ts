/**
 * @aven/root-policy/testing: SYNTHETIC TEST CAPABILITIES ONLY.
 *
 * AVEN-012 has no real owner authentication. This subpath provides the one
 * capability that lets a Root policy rely on an owner approval in tests: an
 * in-memory synthetic channel whose `attest` hook stands in for a future
 * authenticated owner interface. It authenticates nobody, it must never be
 * wired to a production path, and every decision that relies on it says so
 * (`approval_authenticated_by_synthetic_test_capability`). A policy using it
 * declares `approvalAuthentication: 'synthetic_test_only'` in its digested
 * definition.
 */
export {
  createSyntheticApprovalChannel,
  type ApprovalAuthenticator,
  type SyntheticApprovalChannel,
} from '../authentication.ts';
