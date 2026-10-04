import { describe, expect, it } from 'vitest';
import * as c from '../src/index.ts';
import * as f from './fixtures.ts';

describe('typed state, corrections, and selected context', () => {
  it('rejects embedded owner provenance from a different owner', () => {
    const wrongOwner = { ...f.ownerProvenance, ownerId: 'owner_other' };
    const confirmedEvidence = {
      ...f.signals,
      ownerConfirmation: {
        status: 'confirmed',
        evidence: f.evidence,
        provenance: wrongOwner,
      },
    };
    expect(
      c.TrustedOwnerStateSchema.safeParse({
        ...f.trusted,
        provenance: wrongOwner,
      }).success,
    ).toBe(false);
    expect(
      c.TrustedOwnerStateSchema.safeParse({
        ...f.trusted,
        evidence: confirmedEvidence,
      }).success,
    ).toBe(false);
    expect(
      c.LearningCandidateSchema.safeParse({
        ...f.candidate,
        evidence: confirmedEvidence,
      }).success,
    ).toBe(false);
    expect(
      c.ActiveTaskStateSchema.safeParse({
        ...f.activeTask,
        provenance: wrongOwner,
      }).success,
    ).toBe(false);
    const selection = {
      source: {
        kind: 'current_instruction',
        evidence: f.evidence,
        task: f.task,
      },
      relevance: 'direct',
      scopeCompatibility: 'matches',
      freshness: { status: 'unknown' },
      use: 'task_instruction',
      inclusionReason: 'Synthetic instruction',
      provenance: wrongOwner,
    };
    expect(
      c.TaskContextSchema.safeParse({ ...f.context, selections: [selection] })
        .success,
    ).toBe(false);
    expect(
      c.EvaluationTestDefinitionSchema.safeParse({
        ...f.testDefinition,
        oracle: {
          kind: 'owner_supplied',
          expected: { kind: 'response', text: 'Synthetic answer' },
          evidence: f.evidence,
          provenance: wrongOwner,
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    {
      category: 'fact',
      subject: 'Synthetic document',
      assertion: 'Has three sections',
    },
    f.content,
    {
      category: 'episode',
      summary: 'Synthetic interaction',
      occurredAt: f.time,
      originalEvidence: [f.evidence],
    },
    {
      category: 'intent_pattern',
      cue: 'Synthetic shorthand',
      interpretedIntent: 'Prepare a draft',
    },
    {
      category: 'procedure',
      objective: 'Prepare a synthetic draft',
      steps: [{ instruction: 'Write numbered steps' }],
    },
  ])('preserves a distinct learned category %#', (content) => {
    expect(
      c.DurableOwnerStateSchema.parse({ ...f.trusted, content }).content,
    ).toEqual(content);
  });
  it('keeps active task state outside durable learning lifecycles', () => {
    expect(c.DurableOwnerStateSchema.safeParse(f.activeTask).success).toBe(
      false,
    );
    expect(
      c.ActiveTaskStateSchema.safeParse({
        ...f.activeTask,
        lifecycle: f.trusted.lifecycle,
      }).success,
    ).toBe(false);
    expect(
      c.ActiveTaskStateSchema.safeParse(f.omit(f.activeTask, 'task')).success,
    ).toBe(false);
  });
  it('cannot parse a candidate as trusted owner state or silently trust observed state', () => {
    expect(c.TrustedOwnerStateSchema.safeParse(f.candidate).success).toBe(
      false,
    );
    expect(c.LearningCandidateSchema.safeParse(f.trusted).success).toBe(false);
    expect(
      c.LearningCandidateSchema.safeParse({
        ...f.candidate,
        lifecycle: { status: 'trusted' },
      }).success,
    ).toBe(false);
    expect(
      c.DurableOwnerStateSchema.parse({
        ...f.trusted,
        lifecycle: { status: 'observed' },
      }).lifecycle.status,
    ).toBe('observed');
    expect(
      c.TrustedOwnerStateSchema.safeParse({
        ...f.trusted,
        lifecycle: { status: 'observed' },
      }).success,
    ).toBe(false);
    expect(
      c.TrustedOwnerStateSchema.safeParse({
        ...f.trusted,
        lifecycle: { status: 'trusted' },
      }).success,
    ).toBe(false);
  });
  it.each([
    {
      status: 'superseded',
      supersededAt: f.later,
      replacement: f.replacement,
      eventId: 'event_supersession',
    },
    {
      status: 'revoked',
      revokedAt: f.later,
      reason: 'Synthetic regression',
      eventId: 'event_revocation',
      fallback: f.replacement,
    },
  ])(
    'makes inactive state auditable and rejects its use as trusted state %#',
    (lifecycle) => {
      const state = c.DurableOwnerStateSchema.parse({
        ...f.trusted,
        lifecycle,
      });
      expect(state.lifecycle).toEqual(lifecycle);
      expect(c.TrustedOwnerStateSchema.safeParse(state).success).toBe(false);
    },
  );
  it.each(['superseded', 'revoked'])(
    'rejects incomplete %s lineage',
    (status) => {
      expect(
        c.DurableOwnerStateSchema.safeParse({
          ...f.trusted,
          lifecycle: { status },
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    'fact',
    'scope',
    'preference',
    'intent',
    'procedure',
    'communication',
    'permission',
  ])(
    'retains %s correction provenance and immediate applicability',
    (category) => {
      const result = c.OwnerCorrectionSchema.parse({
        ...f.correction,
        category,
      });
      expect(result.category).toBe(category);
      expect(result.provenance.kind).toBe('explicit_owner_correction');
      expect(result.immediateApplicability.kind).toBe('current_task');
      expect(result.durableScopeHint.kind).toBe('unknown');
      expect(c.TrustedOwnerStateSchema.safeParse(result).success).toBe(false);
      expect(c.OwnerApprovalSchema.safeParse(result).success).toBe(false);
    },
  );
  it('rejects mislabeled model corrections and source mismatches', () => {
    expect(
      c.OwnerCorrectionSchema.safeParse({
        ...f.correction,
        provenance: f.inference,
      }).success,
    ).toBe(false);
    expect(
      c.OwnerCorrectionSchema.safeParse({
        ...f.correction,
        evidence: { ...f.evidence, eventId: 'event_other' },
      }).success,
    ).toBe(false);
  });
  it('keeps context as references and prevents stale state becoming learned guidance', () => {
    const selection = f.context.selections[0];
    if (!selection) throw new Error('Missing synthetic selection');
    expect(
      c.TaskContextSchema.safeParse({ ...f.context, ownerModel: f.trusted })
        .success,
    ).toBe(false);
    expect(
      c.ContextSelectionSchema.safeParse({
        ...selection,
        source: {
          kind: 'owner_state',
          reference: f.learnedRef,
          lifecycle: 'revoked',
        },
      }).success,
    ).toBe(false);
    expect(
      c.ContextSelectionSchema.safeParse({
        ...selection,
        scopeCompatibility: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      c.ContextSelectionSchema.parse({
        ...selection,
        source: {
          kind: 'owner_state',
          reference: f.learnedRef,
          lifecycle: 'superseded',
        },
        use: 'counterevidence',
      }).use,
    ).toBe('counterevidence');
  });
  it('does not treat model or external content as a current instruction', () => {
    const selection = {
      source: {
        kind: 'current_instruction',
        evidence: f.evidence,
        task: f.task,
      },
      relevance: 'direct',
      scopeCompatibility: 'matches',
      freshness: { status: 'unknown' },
      use: 'task_instruction',
      inclusionReason: 'Current explicit instruction',
      provenance: f.ownerProvenance,
    };
    expect(c.ContextSelectionSchema.parse(selection).use).toBe(
      'task_instruction',
    );
    expect(
      c.ContextSelectionSchema.safeParse({
        ...selection,
        provenance: f.inference,
      }).success,
    ).toBe(false);
    expect(
      c.ContextSelectionSchema.safeParse({
        ...selection,
        provenance: f.external,
      }).success,
    ).toBe(false);
    expect(
      c.TaskContextSchema.safeParse({
        ...f.context,
        selections: [
          {
            ...selection,
            source: {
              ...selection.source,
              task: { ...f.task, taskId: 'task_other' },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('learning, evaluation, promotion, and rollback', () => {
  it('represents no useful lesson without manufacturing a candidate', () => {
    expect(c.LearningResultSchema.parse(f.noLesson).kind).toBe(
      'no_useful_lesson',
    );
    expect(
      c.LearningResultSchema.parse({
        kind: 'candidate_generated',
        candidate: f.candidate,
      }).kind,
    ).toBe('candidate_generated');
    expect(c.LearningCandidateSchema.safeParse(f.noLesson).success).toBe(false);
  });
  it.each([
    'candidate',
    'under_evaluation',
    'evaluated',
    'shadow',
    'rejected',
    'promoted',
  ] as const)(
    'represents candidate status %s without becoming trusted state',
    (status) => {
      const states = {
        candidate: { status },
        under_evaluation: { status, evaluations: [f.evalRef] },
        evaluated: { status, evaluations: [f.evalRef] },
        shadow: { status, evaluations: [f.evalRef] },
        rejected: {
          status,
          rejectionEventId: 'event_rejection',
          reason: 'Synthetic rejection',
          evaluations: [],
        },
        promoted: {
          status,
          promotionEventId: 'event_promotion',
          state: f.learnedRef,
          evaluations: [f.evalRef],
        },
      };
      const candidate = c.LearningCandidateSchema.parse({
        ...f.candidate,
        lifecycle: states[status],
      });
      expect(candidate.lifecycle.status).toBe(status);
      expect(c.TrustedOwnerStateSchema.safeParse(candidate).success).toBe(
        false,
      );
    },
  );
  it.each([
    'historical_replay',
    'counterexample',
    'held_out',
    'scope_application',
    'scope_non_application',
    'permission',
    'regression',
  ])('represents evaluation type %s', (testType) => {
    expect(
      c.EvaluationTestDefinitionSchema.parse({ ...f.testDefinition, testType })
        .testType,
    ).toBe(testType);
  });
  it.each([
    f.testDefinition.oracle,
    {
      kind: 'deterministic',
      expected: { kind: 'policy', decision: 'DENY' },
      specification: f.artifact,
      provenance: f.system,
    },
    {
      kind: 'externally_verified',
      expected: { kind: 'scope_application', applied: false },
      provenance: f.external,
      verificationEvidence: [f.evidence],
    },
    {
      kind: 'evaluator_model_judgment',
      expected: { kind: 'response', text: 'Synthetic expected answer' },
      provenance: f.inference,
      authority: 'advisory',
    },
    { kind: 'unresolved', reason: 'No accepted oracle' },
  ])('keeps oracle type, provenance, and expectation separate %#', (oracle) => {
    expect(c.EvaluationOracleSchema.parse(oracle)).toEqual(oracle);
  });
  it('does not upgrade a model oracle to authoritative ground truth', () => {
    const oracle = {
      kind: 'evaluator_model_judgment',
      expected: { kind: 'scope_application', applied: true },
      provenance: f.inference,
      authority: 'advisory',
    };
    const result = c.EvaluationResultSchema.parse({
      ...f.evaluation,
      test: { ...f.testDefinition, oracle },
      scorer: { kind: 'model', model: f.model, rubric: f.artifact },
      independence: {
        status: 'assessed',
        relationship: 'same_generator',
        evidence: f.evidence,
      },
    });
    expect(result.test.oracle.kind).toBe('evaluator_model_judgment');
    expect(result.conclusionBasis).toBe('relative_to_declared_oracle');
    expect(
      c.EvaluationOracleSchema.safeParse({
        ...oracle,
        authority: 'ground_truth',
      }).success,
    ).toBe(false);
    expect(
      c.EvaluationResultSchema.safeParse({
        ...result,
        authoritativeGroundTruth: true,
      }).success,
    ).toBe(false);
  });
  it('requires an indeterminate verdict when observations or oracle are missing', () => {
    const unresolved = {
      ...f.evaluation,
      test: {
        ...f.testDefinition,
        oracle: { kind: 'unresolved', reason: 'Unknown expected outcome' },
      },
    };
    expect(c.EvaluationResultSchema.safeParse(unresolved).success).toBe(false);
    expect(
      c.EvaluationResultSchema.parse({
        ...unresolved,
        verdict: 'INDETERMINATE',
      }).verdict,
    ).toBe('INDETERMINATE');
    expect(
      c.EvaluationResultSchema.safeParse({
        ...f.evaluation,
        actual: { status: 'unavailable', reason: 'No result' },
      }).success,
    ).toBe(false);
  });
  it.each(['candidate', 'evaluations', 'trustedState', 'authority'] as const)(
    'requires promotion %s reference',
    (key) => {
      expect(
        c.LearningPromotionSchema.safeParse(f.omit(f.promotion, key)).success,
      ).toBe(false);
    },
  );
  it('cannot promote without evaluation references and an ALLOW reference', () => {
    expect(
      c.LearningPromotionSchema.safeParse({ ...f.promotion, evaluations: [] })
        .success,
    ).toBe(false);
    expect(
      c.LearningPromotionSchema.safeParse({
        ...f.promotion,
        authority: { ...f.policyRef, decision: 'DENY' },
      }).success,
    ).toBe(false);
    expect(
      c.LearningPromotionSchema.safeParse({
        ...f.promotion,
        authority: f.inference,
      }).success,
    ).toBe(false);
  });
  it('rejects self-supersession, self-fallback, and vacuous rollback', () => {
    expect(
      c.LearningSupersessionSchema.safeParse({
        ...f.supersession,
        replacement: f.learnedRef,
      }).success,
    ).toBe(false);
    expect(
      c.LearningRevocationSchema.safeParse({
        ...f.revocation,
        fallback: f.replacement,
      }).success,
    ).toBe(false);
    expect(
      c.LearningRollbackSchema.safeParse({
        ...f.rollback,
        restore: f.replacement,
      }).success,
    ).toBe(false);
    expect(
      c.DurableOwnerStateSchema.safeParse({
        ...f.trusted,
        lifecycle: {
          status: 'superseded',
          supersededAt: f.later,
          replacement: f.learnedRef,
          eventId: 'event_supersession',
        },
      }).success,
    ).toBe(false);
    expect(
      c.DurableOwnerStateSchema.safeParse({
        ...f.trusted,
        lifecycle: {
          status: 'revoked',
          revokedAt: f.later,
          fallback: f.learnedRef,
          eventId: 'event_revocation',
          reason: 'Synthetic',
        },
      }).success,
    ).toBe(false);
  });
  it('does not label a development test held-out or accept another owner test', () => {
    expect(
      c.EvaluationTestDefinitionSchema.safeParse({
        ...f.testDefinition,
        testType: 'held_out',
        split: 'development',
      }).success,
    ).toBe(false);
    expect(
      c.EvaluationResultSchema.safeParse({
        ...f.evaluation,
        test: { ...f.testDefinition, ownerId: 'owner_other' },
      }).success,
    ).toBe(false);
  });
  it('rejects unknown discriminated variants across the domain', () => {
    expect(
      c.LearnedContentSchema.safeParse({ category: 'memory', text: 'Blob' })
        .success,
    ).toBe(false);
    expect(
      c.OwnerStateSchema.safeParse({ ...f.activeTask, kind: 'memory' }).success,
    ).toBe(false);
    expect(
      c.LearningCandidateSchema.safeParse({
        ...f.candidate,
        lifecycle: { status: 'auto_trusted' },
      }).success,
    ).toBe(false);
    expect(
      c.PolicyDecisionSchema.safeParse({ ...f.policy, decision: 'MAYBE' })
        .success,
    ).toBe(false);
    expect(
      c.VerificationResultSchema.safeParse({
        ...f.verification,
        status: 'SUCCESS',
      }).success,
    ).toBe(false);
  });
});
