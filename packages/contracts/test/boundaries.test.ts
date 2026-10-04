import { describe, expect, it } from 'vitest';
import * as c from '@aven/contracts';
import * as f from './fixtures.ts';

describe('serialization boundaries (synthetic data)', () => {
  const records = [
    [c.EvidenceRecordSchema, f.recordedEvidence],
    [c.ActionProposalSchema, f.proposal],
    [c.OwnerApprovalSchema, f.approval],
    [c.PolicyDecisionSchema, f.policy],
    [c.ExecutionResultSchema, f.execution],
    [c.VerificationResultSchema, f.verification],
    [c.OwnerStateSchema, f.trusted],
    [c.OwnerStateSchema, f.activeTask],
    [c.OwnerCorrectionSchema, f.correction],
    [c.TaskContextSchema, f.context],
    [c.LearningCandidateSchema, f.candidate],
    [c.LearningResultSchema, f.noLesson],
    [c.EvaluationTestDefinitionSchema, f.testDefinition],
    [c.EvaluationResultSchema, f.evaluation],
    [c.LearningTransitionSchema, f.promotion],
    [c.LearningTransitionSchema, f.rejection],
    [c.LearningTransitionSchema, f.supersession],
    [c.LearningTransitionSchema, f.revocation],
    [c.LearningTransitionSchema, f.rollback],
    [c.ModelRequestMetadataSchema, f.requestMetadata],
    [c.ModelResponseMetadataSchema, f.responseMetadata],
  ] as const;
  it.each(records)(
    'parses and round trips a contract without losing IDs or metadata %#',
    (schema, value) => {
      const wire: unknown = JSON.parse(JSON.stringify(value));
      expect(schema.parse(wire)).toEqual(value);
      expect(
        schema.safeParse({ ...value, inventedAuthority: true }).success,
      ).toBe(false);
    },
  );
  it.each([
    '',
    ' ',
    'plain',
    'owner_',
    'task_synthetic',
    'owner_has spaces',
    `owner_${'a'.repeat(129)}`,
  ])('rejects invalid owner ID %s', (value) => {
    expect(c.OwnerIdSchema.safeParse(value).success).toBe(false);
  });
  it.each(['ownerId', 'metadata', 'id'] as const)(
    'requires record %s',
    (key) => {
      expect(
        c.ActionProposalSchema.safeParse(f.omit(f.proposal, key)).success,
      ).toBe(false);
    },
  );
  it.each(['schemaVersion', 'recordVersion', 'createdAt', 'creation'] as const)(
    'requires metadata %s',
    (key) => {
      expect(
        c.RecordMetadataSchema.safeParse(f.omit(f.metadata, key)).success,
      ).toBe(false);
    },
  );
  it.each([
    { schemaVersion: 2 },
    { recordVersion: 0 },
    { recordVersion: 1.5 },
    { createdAt: '2026-10-04' },
    { createdAt: '2026-10-04T12:00:00' },
    { creation: { component: ' ', version: '1' } },
  ])('rejects malformed version/creation metadata %#', (change) => {
    expect(
      c.RecordMetadataSchema.safeParse({ ...f.metadata, ...change }).success,
    ).toBe(false);
  });
});

describe('provenance, evidence, and scope', () => {
  it.each([
    f.ownerProvenance,
    f.inference,
    f.tool,
    f.external,
    f.system,
    f.correction.provenance,
    f.approval.provenance,
  ])('preserves provenance %#', (origin) => {
    expect(c.ProvenanceSchema.parse(origin)).toEqual(origin);
  });
  it('does not turn an inference or external document into owner-originated evidence', () => {
    expect(
      c.OwnerStatementProvenanceSchema.safeParse(f.inference).success,
    ).toBe(false);
    expect(c.OwnerApprovalProvenanceSchema.safeParse(f.external).success).toBe(
      false,
    );
    expect(
      c.ProvenanceSchema.safeParse({ ...f.external, trust: 'trusted' }).success,
    ).toBe(false);
    expect(
      c.EvidenceRecordSchema.safeParse({
        ...f.recordedEvidence,
        objectivelyTrue: true,
      }).success,
    ).toBe(false);
  });
  it('keeps repeated summaries linked to the same source without inferring corroboration', () => {
    const second = c.ModelInferenceProvenanceSchema.parse({
      ...f.inference,
      model: { ...f.model, configurationId: 'synthetic-second-summary' },
    });
    expect(second.derivedFrom).toEqual(f.inference.derivedFrom);
    expect(
      c.EvidenceSignalsSchema.safeParse({
        ...f.signals,
        support: 'corroborated',
      }).success,
    ).toBe(false);
    expect(
      c.EvidenceSignalsSchema.safeParse({
        ...f.signals,
        support: 'corroborated',
        sourceIndependence: {
          status: 'assessed',
          rootSources: [f.evidence, f.evidence],
          assessmentEvidence: f.evidence,
        },
      }).success,
    ).toBe(false);
    expect(
      c.EvidenceSignalsSchema.parse({
        ...f.signals,
        support: 'corroborated',
        sourceIndependence: {
          status: 'assessed',
          rootSources: [
            f.evidence,
            {
              evidenceId: 'evidence_independent',
              eventId: 'event_independent',
            },
          ],
          assessmentEvidence: f.evidence,
        },
      }).support,
    ).toBe('corroborated');
  });
  it('requires counterevidence for contested support and rejects undefined confidence numbers', () => {
    expect(
      c.EvidenceSignalsSchema.safeParse({ ...f.signals, support: 'contested' })
        .success,
    ).toBe(false);
    expect(
      c.EvidenceSignalsSchema.parse({
        ...f.signals,
        support: 'contested',
        counterexamples: [f.evidence],
      }).support,
    ).toBe('contested');
    expect(
      c.EvidenceSignalsSchema.safeParse({ ...f.signals, confidence: 0.99 })
        .success,
    ).toBe(false);
  });
  it('requires explicit owner provenance for owner confirmation', () => {
    expect(
      c.EvidenceSignalsSchema.safeParse({
        ...f.signals,
        ownerConfirmation: {
          status: 'confirmed',
          evidence: f.evidence,
          provenance: f.inference,
        },
      }).success,
    ).toBe(false);
  });
  it('rejects evidence self-derivation, mismatched source owners, and historical record revisions', () => {
    expect(
      c.EvidenceRecordSchema.safeParse({
        ...f.recordedEvidence,
        provenance: f.inference,
      }).success,
    ).toBe(false);
    expect(
      c.EvidenceRecordSchema.safeParse({
        ...f.recordedEvidence,
        ownerId: 'owner_other',
      }).success,
    ).toBe(false);
    expect(
      c.EvidenceRecordSchema.safeParse({
        ...f.recordedEvidence,
        metadata: { ...f.metadata, recordVersion: 2 },
      }).success,
    ).toBe(false);
    expect(
      c.EvidenceSignalsSchema.safeParse({
        ...f.signals,
        ownerConfirmation: {
          status: 'confirmed',
          evidence: { ...f.evidence, eventId: 'event_other' },
          provenance: f.ownerProvenance,
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    { kind: 'unknown', reason: 'Insufficient evidence' },
    {
      kind: 'uncertain',
      possibilities: [f.scope],
      reason: 'Unclear task boundary',
    },
    f.scope,
    {
      kind: 'global',
      explicitDeclaration:
        'Proposed all-owner-task scope; evaluation still required.',
    },
  ])('represents an explicit scope variant %#', (scope) => {
    expect(c.ScopeSchema.parse(scope)).toEqual(scope);
  });
  it.each([
    undefined,
    null,
    {},
    'global',
    { kind: 'global' },
    { kind: 'bounded' },
    { kind: 'uncertain', possibilities: [], reason: 'No alternatives' },
    { kind: 'all' },
  ])('rejects absent/implicit/invalid scope %#', (scope) => {
    expect(c.ScopeSchema.safeParse(scope).success).toBe(false);
  });
  it('does not supply missing durable or proposed scope', () => {
    expect(
      c.DurableOwnerStateSchema.safeParse(f.omit(f.trusted, 'scope')).success,
    ).toBe(false);
    expect(
      c.LearningCandidateSchema.safeParse(f.omit(f.candidate, 'proposedScope'))
        .success,
    ).toBe(false);
  });
  it('rejects a backwards temporal qualifier', () => {
    expect(
      c.ScopeSchema.safeParse({
        kind: 'bounded',
        domain: 'synthetic',
        temporal: { from: f.later, until: f.time },
      }).success,
    ).toBe(false);
  });
});
