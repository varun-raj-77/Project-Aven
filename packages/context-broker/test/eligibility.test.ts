import { describe, expect, it } from 'vitest';
import {
  activeTask,
  assemble,
  evidence,
  GLOBAL_SCOPE,
  instruction,
  memorySource,
  OTHER_SESSION,
  OTHER_TASK,
  ownerState,
  PROVENANCE,
  REFERENCE_TIME,
  request,
  selectedIds,
  SESSION,
  TASK,
  traceOf,
} from './fixtures.ts';

// SYNTHETIC tasks, labels and text only.

const MAX = { confidence: 1, salience: 1, negativeRetrieval: 0 };

describe('AVEN-008 eligibility: task binding and declarative scope', () => {
  it('lets an exact task binding beat an unrelated lexical coincidence (F)', async () => {
    const taskItem = activeTask(
      'open-loop',
      'Open loop: confirm catering headcount',
    );
    const coincidence = evidence('coincidence', 'Monday is laundry day', {
      provenance: PROVENANCE.systemGenerated(),
    });
    const otherTaskExact = ownerState(
      'other-task',
      'Prepare the agenda slides for Monday review',
      'trusted',
      { scope: { kind: 'bounded', taskId: OTHER_TASK }, signals: MAX },
    );
    const result = await assemble(
      [
        memorySource('active', 'active_task', [taskItem]),
        memorySource('episodes', 'episode_history', [coincidence]),
        memorySource('store', 'owner_state', [otherTaskExact]),
      ],
      request('Prepare the agenda slides for Monday review'),
    );
    expect(selectedIds(result)).toEqual(['open-loop', 'coincidence']);
    const task = traceOf(result, 'open-loop');
    expect(task.taskBinding).toBe('matches');
    expect(task.scope.status).toBe('task_match');
    expect(task.relevance.score).toBe(0);
    expect(task.channels).toEqual(['task']);
    expect(task.score!.final).toBe(0.445);
    expect(traceOf(result, 'coincidence').score!.final).toBe(0.375);
    // An exact lexical match scoped to a different task is ineligible.
    const other = traceOf(result, 'other-task');
    expect(other.exclusionReason).toBe('scope_mismatch');
    expect(other.scope.mismatched).toEqual(['taskId']);
    expect(other.relevance.score).toBe(1);
  });

  it('requires both the session and the task of a task-bound reference to match', async () => {
    const result = await assemble(
      [
        memorySource('active', 'active_task', [
          activeTask('same', 'Agenda draft open loop'),
          activeTask('other-session', 'Agenda draft open loop', {
            sessionId: OTHER_SESSION,
            taskId: TASK,
          }),
          activeTask('other-task', 'Agenda draft open loop', {
            sessionId: SESSION,
            taskId: OTHER_TASK,
          }),
          instruction('instruction', 'Keep the agenda to one page'),
        ]),
      ],
      request('Prepare the agenda'),
    );
    expect(selectedIds(result)).toEqual(['instruction', 'same']);
    for (const id of ['other-session', 'other-task']) {
      expect(traceOf(result, id).exclusionReason).toBe('task_binding_mismatch');
      expect(traceOf(result, id).taskBinding).toBe('does_not_match');
    }
    expect(traceOf(result, 'instruction').trustBasis).toBe(
      'current_instruction',
    );
  });

  it('excludes an explicit scope mismatch whatever its lexical relevance (G)', async () => {
    const terse = ownerState(
      'interview-terse',
      'Use terse answers for live interview questions.',
      'trusted',
      {
        scope: {
          kind: 'bounded',
          domain: 'Interviews',
          taskType: 'live answer',
        },
        signals: MAX,
      },
    );
    const reportStyle = evidence(
      'report-style',
      'Reports should include a methods section',
      { scope: { kind: 'bounded', domain: 'research' } },
    );
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [terse]),
        memorySource('episodes', 'episode_history', [reportStyle]),
      ],
      request('Write a detailed research report on live interview questions', {
        taskDescriptor: { domain: 'research', taskType: 'report' },
      }),
    );
    expect(selectedIds(result)).toEqual(['report-style']);
    const excluded = traceOf(result, 'interview-terse');
    expect(excluded.exclusionReason).toBe('scope_mismatch');
    expect(excluded.scope.mismatched).toEqual(['domain', 'taskType']);
    // interview, live, question: three matched terms, counted not echoed.
    expect(excluded.relevance.matchedTermCount).toBe(3);
    expect(excluded.score).toBeNull();
    expect(traceOf(result, 'report-style').scope.status).toBe('label_match');
  });

  it('excludes qualifier and temporal mismatches; matches normalized labels exactly', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('recruiter', 'Outreach messages stay short', 'trusted', {
            scope: {
              kind: 'bounded',
              domain: 'Professional  Outreach',
              qualifiers: { recipient: 'recruiter' },
            },
          }),
          ownerState('normalized', 'Outreach greeting style', 'trusted', {
            scope: {
              kind: 'bounded',
              domain: 'ＰＲＯＦＥＳＳＩＯＮＡＬ outreach',
            },
          }),
          ownerState(
            'expired',
            'Outreach during the spring campaign',
            'trusted',
            {
              scope: {
                kind: 'bounded',
                domain: 'professional outreach',
                temporal: {
                  from: '2026-01-01T00:00:00Z',
                  until: '2026-06-01T00:00:00Z',
                },
              },
            },
          ),
          ownerState('current-window', 'Outreach this autumn', 'trusted', {
            scope: {
              kind: 'bounded',
              domain: 'professional outreach',
              temporal: { from: '2026-09-01T00:00:00Z' },
            },
          }),
        ]),
      ],
      request('Write the outreach note', {
        taskDescriptor: {
          domain: 'professional outreach',
          qualifiers: { recipient: 'hiring manager' },
        },
      }),
    );
    expect(traceOf(result, 'recruiter').scope.mismatched).toEqual([
      'recipient',
    ]);
    expect(traceOf(result, 'recruiter').exclusionReason).toBe('scope_mismatch');
    expect(traceOf(result, 'expired').scope.mismatched).toEqual(['temporal']);
    expect(traceOf(result, 'normalized').scope.status).toBe('label_match');
    expect(traceOf(result, 'current-window').scope).toEqual({
      status: 'label_match',
      matched: ['domain', 'temporal'],
      mismatched: [],
      unresolved: [],
    });
    expect(selectedIds(result).sort()).toEqual([
      'current-window',
      'normalized',
    ]);
  });

  it('applies uncertain scope only when every possibility is satisfied (scope rules v2)', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('all-mismatch', 'Travel packing list', 'trusted', {
            scope: {
              kind: 'uncertain',
              reason: 'Synthetic: two candidate scopes',
              possibilities: [
                { kind: 'bounded', domain: 'cooking' },
                { kind: 'bounded', domain: 'gardening' },
              ],
            },
          }),
          ownerState('some-match', 'Travel packing list', 'trusted', {
            scope: {
              kind: 'uncertain',
              reason: 'Synthetic: two candidate scopes',
              possibilities: [
                { kind: 'bounded', domain: 'travel' },
                { kind: 'bounded', domain: 'cooking' },
              ],
            },
          }),
          ownerState('all-satisfied', 'Travel packing list', 'trusted', {
            scope: {
              kind: 'uncertain',
              reason: 'Synthetic: two candidate scopes',
              possibilities: [
                { kind: 'bounded', domain: 'travel' },
                { kind: 'bounded', taskId: TASK },
              ],
            },
          }),
        ]),
      ],
      request('Update the travel packing list', {
        taskDescriptor: { domain: 'travel' },
      }),
    );
    expect(traceOf(result, 'all-mismatch').exclusionReason).toBe(
      'scope_mismatch',
    );
    // One possibility mismatching (cooking) leaves applicability unresolved.
    expect(traceOf(result, 'some-match').exclusionReason).toBe(
      'scope_unresolved',
    );
    const uncertain = traceOf(result, 'all-satisfied');
    expect(uncertain.scope.status).toBe('uncertain');
    expect(uncertain.score!.factors.scope).toBe(0.25);
    expect(uncertain.channels).toEqual(['lexical_content_term']);
  });

  it('handles global, unknown and unresolved bounded scope deterministically (H, H4)', async () => {
    const text = 'Itinerary notes for the coastal trip';
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('global', text, 'trusted', { scope: GLOBAL_SCOPE }),
          ownerState('unknown', text, 'trusted'),
          ownerState('partial', 'Prefer window seats', 'trusted', {
            scope: { kind: 'bounded', domain: 'travel', taskType: 'booking' },
          }),
          ownerState('indeterminate', text, 'trusted', {
            scope: { kind: 'bounded', taskType: 'itinerary planning' },
          }),
          ownerState('global-unrelated', 'Prefer metric units', 'trusted', {
            scope: GLOBAL_SCOPE,
          }),
          ownerState('unknown-unrelated', 'Prefer metric units', 'trusted'),
        ]),
      ],
      request('Plan the coastal trip itinerary', {
        taskDescriptor: { domain: 'travel' },
      }),
    );
    const scope = (id: string) => traceOf(result, id).scope;
    expect(scope('global').status).toBe('global');
    expect(scope('unknown').status).toBe('unknown');
    // v2: a declared restriction the request does not resolve (taskType) is
    // never evidence of applicability, even with the domain matching.
    expect(scope('partial')).toEqual({
      status: 'unresolved',
      matched: ['domain'],
      mismatched: [],
      unresolved: ['taskType'],
    });
    expect(traceOf(result, 'partial').exclusionReason).toBe('scope_unresolved');
    // Lexical overlap does not rescue an unresolved bounded scope.
    expect(scope('indeterminate').status).toBe('unresolved');
    expect(traceOf(result, 'indeterminate').relevance.score).toBeGreaterThan(0);
    expect(traceOf(result, 'indeterminate').exclusionReason).toBe(
      'scope_unresolved',
    );
    expect(traceOf(result, 'global').score!.factors.scope).toBe(0.5);
    expect(traceOf(result, 'unknown').score!.factors.scope).toBe(0.25);
    // Global and unknown scope never qualify without task relevance.
    for (const id of ['global-unrelated', 'unknown-unrelated'])
      expect(traceOf(result, id).exclusionReason).toBe('no_relevance_channel');
    const order = selectedIds(result);
    expect(order.indexOf('global')).toBeLessThan(order.indexOf('unknown'));
  });
});

describe('AVEN-008 eligibility: supersession, revocation, negative signals, relevance floor', () => {
  it('excludes revoked and superseded state and shows it only as trace exclusions (O, P, AK)', async () => {
    const text = 'Recruiter outreach should be short';
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('revoked', text, 'revoked', { signals: MAX }),
          ownerState('superseded', text, 'superseded', { signals: MAX }),
          ownerState('observed', text, 'observed'),
        ]),
      ],
      request('Write recruiter outreach that is short'),
    );
    expect(selectedIds(result)).toEqual(['observed']);
    for (const id of ['revoked', 'superseded']) {
      const entry = traceOf(result, id);
      expect(entry.exclusionReason).toBe(id);
      expect(entry.selection).toBe('excluded');
      expect(entry.lifecycle).toBe(id);
      expect(entry.score).toBeNull();
      expect(entry.eligibleRank).toBeNull();
      expect(entry.relevance.score).toBe(0.75);
    }
    expect(result.trace.ranking.map((r) => r.candidateId)).toEqual([
      'observed',
    ]);
    expect(result.trace.selected.map((s) => s.candidateId)).toEqual([
      'observed',
    ]);
    expect(result.trace.totals.excludedByReason).toMatchObject({
      revoked: 1,
      superseded: 1,
    });
    expect(JSON.stringify(result.bundle)).not.toMatch(/superseded|revoked/);
  });

  it('reports the first failing eligibility rule in fixed precedence', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState('many-failures', 'Unrelated', 'superseded', {
            scope: { kind: 'bounded', taskId: OTHER_TASK },
            timestamps: { recordedAt: '2027-01-01T00:00:00Z' },
            signals: { confidence: 1, salience: 1, negativeRetrieval: 1 },
          }),
        ]),
      ],
      request('Plan the trip'),
    );
    expect(traceOf(result, 'many-failures').exclusionReason).toBe('superseded');
  });

  it('lowers rank with a negative signal and exposes the penalty (Q)', async () => {
    const text = 'Summaries should start with the decision';
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('penalized', text, {
            signals: { confidence: 0.5, salience: 0.5, negativeRetrieval: 0.5 },
          }),
          evidence('plain', text),
        ]),
      ],
      request('Write the decision summary'),
    );
    expect(selectedIds(result)).toEqual(['plain', 'penalized']);
    const plain = traceOf(result, 'plain').score!;
    const penalized = traceOf(result, 'penalized').score!;
    expect(penalized.composite).toBe(plain.composite);
    expect(penalized.negativeRetrieval).toBe(0.5);
    expect(penalized.final).toBeCloseTo(plain.composite * 0.5, 8);
    expect(penalized.final + penalized.negativePenalty).toBeCloseTo(
      penalized.composite,
      9,
    );
    expect(plain.negativePenalty).toBe(0);
    expect(plain.final).toBe(plain.composite);
  });

  it('suppresses a maximal negative signal as an eligibility decision (R)', async () => {
    const text = 'Summaries should start with the decision';
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('suppressed', text, {
            signals: { confidence: 1, salience: 1, negativeRetrieval: 1 },
          }),
          evidence('almost', text, {
            signals: { confidence: 1, salience: 1, negativeRetrieval: 0.999 },
          }),
        ]),
      ],
      request('Write the decision summary'),
    );
    expect(selectedIds(result)).toEqual(['almost']);
    const suppressed = traceOf(result, 'suppressed');
    expect(suppressed.exclusionReason).toBe('negative_signal_suppressed');
    expect(suppressed.score).toBeNull();
    expect(traceOf(result, 'almost').score!.final).toBeLessThan(0.001);
  });

  it('never admits irrelevant content through high trust or salience alone (S)', async () => {
    const result = await assemble(
      [
        memorySource('store', 'owner_state', [
          ownerState(
            'trusted-unrelated',
            'Prefers oat milk in coffee',
            'trusted',
            {
              scope: GLOBAL_SCOPE,
              signals: MAX,
            },
          ),
          ownerState('qualifier-only', 'I do not eat mushrooms', 'trusted', {
            scope: GLOBAL_SCOPE,
            signals: MAX,
          }),
        ]),
        memorySource('episodes', 'episode_history', [
          evidence('relevant', 'Appendix tables were too long last time', {
            provenance: PROVENANCE.modelInference(),
            signals: { confidence: 0.05, salience: 0.05, negativeRetrieval: 0 },
            timestamps: { recordedAt: '2025-01-01T00:00:00Z' },
          }),
        ]),
      ],
      request('Do not include the appendix'),
    );
    expect(selectedIds(result)).toEqual(['relevant']);
    for (const id of ['trusted-unrelated', 'qualifier-only'])
      expect(traceOf(result, id).exclusionReason).toBe('no_relevance_channel');
    expect(traceOf(result, 'qualifier-only').relevance).toMatchObject({
      matchedTermCount: 1,
      matchedContentTermCount: 0,
    });
  });

  it('excludes items timestamped after the reference time; an equal time is age zero', async () => {
    const result = await assemble(
      [
        memorySource('episodes', 'episode_history', [
          evidence('future', 'Garden plan for spring', {
            timestamps: { recordedAt: '2026-10-01T12:00:00.001Z' },
          }),
          evidence('validated-later', 'Garden plan for spring', {
            timestamps: {
              recordedAt: '2026-09-01T00:00:00Z',
              lastValidatedAt: '2026-10-02T00:00:00Z',
            },
          }),
          evidence('now', 'Garden plan for spring', {
            timestamps: { recordedAt: REFERENCE_TIME },
          }),
        ]),
      ],
      request('Update the garden plan'),
    );
    expect(selectedIds(result)).toEqual(['now']);
    for (const id of ['future', 'validated-later']) {
      expect(traceOf(result, id).exclusionReason).toBe(
        'recorded_after_reference_time',
      );
      expect(traceOf(result, id).freshness).toBeNull();
    }
    expect(traceOf(result, 'now').freshness).toEqual({
      anchor: 'recordedAt',
      ageMilliseconds: 0,
      factor: 1,
    });
  });
});
