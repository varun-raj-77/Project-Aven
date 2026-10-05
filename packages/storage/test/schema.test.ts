import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as c from '@aven/contracts';
import {
  deserializeContract,
  schema,
  type ContractName,
  type Storage,
} from '../src/index.ts';
import {
  base,
  event,
  f,
  fresh,
  graph,
  identities,
  record,
  transitionEvent,
} from './fixtures.ts';

const opened: Storage[] = [];
function db() {
  const s = fresh();
  opened.push(s);
  return s;
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
function count(s: Storage, table: string) {
  return (
    s.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
function raw(s: Storage, table: ContractName, input: unknown) {
  return s.sqlite
    .prepare(`INSERT INTO ${table} (record_json) VALUES (?)`)
    .run(JSON.stringify(input));
}

describe('identity and owner isolation', () => {
  it('persists owners, sessions and tasks through Drizzle', () => {
    const s = db();
    identities(s);
    expect(s.db.select().from(schema.owners).all()).toEqual([
      { ownerId: f.owner, createdAt: f.time },
    ]);
    expect(s.db.select().from(schema.sessions).get()?.sessionId).toBe(
      f.task.sessionId,
    );
    expect(s.db.select().from(schema.tasks).get()?.taskId).toBe(f.task.taskId);
    expect(s.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(s.sqlite.pragma('recursive_triggers', { simple: true })).toBe(1);
  });
  it('rejects cross-owner session/task and missing owner links', () => {
    const s = db();
    identities(s);
    identities(s, 'owner_other', 'other');
    expect(() =>
      s.sqlite
        .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
        .run('owner_other', 'task_cross', f.task.sessionId, f.time),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      s.sqlite
        .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
        .run('owner_missing', 'session_new', f.time),
    ).toThrow(/FOREIGN KEY/);
  });
  it('rejects cross-owner references buried in provenance and proposed scope', () => {
    const s = db();
    base(s);
    identities(s, 'owner_other', 'other');
    expect(() =>
      record(s, 'learning_candidates', {
        ...f.candidate,
        ownerId: 'owner_other',
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      record(s, 'learning_candidates', {
        ...f.candidate,
        id: 'candidate_cross',
        proposedScope: { kind: 'bounded', taskId: 'task_other' },
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(count(s, 'learning_candidates')).toBe(0);
  });
  it.each([
    ['experience_events', event()],
    ['evidence', f.recordedEvidence],
    ['learned_owner_state', f.trusted],
    ['active_task_state', f.activeTask],
    ['learning_candidates', f.candidate],
    ['no_useful_lessons', f.noLesson],
    ['corrections', f.correction],
    ['action_proposals', f.proposal],
    ['policy_decisions', f.policy],
    ['owner_approvals', f.approval],
    ['tool_executions', f.execution],
    ['verification_results', f.verification],
    ['evaluations', f.evaluation],
    ['lifecycle_records', f.promotion],
  ] as const)('rejects cross-owner references from %s', (table, input) => {
    const s = db();
    graph(s);
    identities(s, 'owner_other', 'other');
    const other: unknown = JSON.parse(
      JSON.stringify(input).replaceAll(f.owner, 'owner_other'),
    );
    expect(() => record(s, table, other)).toThrow(/FOREIGN KEY/);
  });
  it('rejects another session paired with an existing task even inside event payload', () => {
    const s = db();
    base(s);
    s.sqlite
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(f.owner, 'session_second', f.time);
    const { task: _task, ...envelope } = event('event_wrongtask');
    expect(() =>
      record(s, 'experience_events', {
        ...envelope,
        payload: {
          instruction: 'Synthetic',
          task: { ...f.task, sessionId: 'session_second' },
        },
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('rejects duplicate owner IDs, immutable record IDs and duplicate versions', () => {
    const s = db();
    base(s);
    record(s, 'learning_candidates', f.candidate);
    expect(() => identities(s)).toThrow();
    expect(() => record(s, 'evidence', f.recordedEvidence)).toThrow(/replaced/);
    expect(() => record(s, 'experience_events', event())).toThrow(/replaced/);
    expect(() => record(s, 'learning_candidates', f.candidate)).toThrow(
      /replaced/,
    );
    record(s, 'learning_candidates', {
      ...f.candidate,
      metadata: { ...f.metadata, recordVersion: 2 },
    });
    expect(count(s, 'learning_candidates')).toBe(2);
  });
  it('does not permit phantom catalog identities or fabricated projection edges', () => {
    const s = db();
    base(s);
    expect(() =>
      s.sqlite
        .prepare('INSERT INTO record_keys VALUES (?, ?, ?)')
        .run(f.owner, 'evidence', 'evidence_fake'),
    ).toThrow(/snapshot/);
    expect(() =>
      s.sqlite
        .prepare(
          `INSERT INTO record_references (owner_id,source_kind,source_id,source_version,path,target_kind,target_id,target_version)
      VALUES (?, 'evidence', ?, 1, '$.invented', 'experience_events', ?, 1)`,
        )
        .run(f.owner, f.recordedEvidence.id, f.evidence.eventId),
    ).toThrow(/snapshot/);
  });
});

describe('scope, lifecycle and contract serialization', () => {
  it.each(['trusted', 'auto_trusted', '', null])(
    'rejects invalid candidate status %s at the SQL boundary',
    (status) => {
      const s = db();
      base(s);
      expect(() =>
        raw(s, 'learning_candidates', {
          ...f.candidate,
          lifecycle: { status },
        }),
      ).toThrow();
    },
  );
  it.each([0, -1, 1.5, 9007199254740992])(
    'rejects invalid version %s at the SQL boundary',
    (version) => {
      const s = db();
      base(s);
      expect(() =>
        raw(s, 'learning_candidates', {
          ...f.candidate,
          metadata: { ...f.metadata, recordVersion: version },
        }),
      ).toThrow();
    },
  );
  it.each([undefined, null, {}, { kind: 'global' }])(
    'never defaults missing or incomplete scope to global %#',
    (proposedScope) => {
      const s = db();
      base(s);
      expect(() =>
        raw(s, 'learning_candidates', { ...f.candidate, proposedScope }),
      ).toThrow();
    },
  );
  it.each([
    { kind: 'unknown', reason: 'Synthetic uncertainty' },
    {
      kind: 'uncertain',
      possibilities: [f.scope],
      reason: 'Synthetic alternatives',
    },
    f.scope,
    {
      kind: 'global',
      explicitDeclaration: 'Explicit synthetic all-task declaration',
    },
  ])(
    'round trips scope variant %# through Zod and Drizzle',
    (proposedScope) => {
      const s = db();
      base(s);
      const input = c.LearningCandidateSchema.parse({
        ...f.candidate,
        proposedScope,
      });
      s.db
        .insert(schema.learningCandidates)
        .values({ recordJson: input })
        .run();
      const row = s.db.select().from(schema.learningCandidates).get();
      expect(row?.recordJson).toEqual(input);
      expect(row?.scopeKind).toBe(proposedScope.kind);
    },
  );
  it('keeps candidate, no-useful-lesson and active task state outside durable trusted state', () => {
    const s = db();
    base(s);
    record(s, 'learning_candidates', f.candidate);
    record(s, 'no_useful_lessons', f.noLesson);
    record(s, 'active_task_state', f.activeTask);
    expect(count(s, 'learned_owner_state')).toBe(0);
    expect(
      s.sqlite
        .prepare(
          "SELECT * FROM latest_learned_owner_state WHERE status = 'trusted'",
        )
        .all(),
    ).toEqual([]);
    expect(() => raw(s, 'learned_owner_state', f.candidate)).toThrow();
    expect(() => raw(s, 'learned_owner_state', f.activeTask)).toThrow();
    expect(count(s, 'no_useful_lessons')).toBe(1);
    expect(
      s.db.select().from(schema.noUsefulLessons).get()?.recordJson,
    ).toEqual(f.noLesson);
    expect(
      s.db.select().from(schema.activeTaskState).get()?.recordJson,
    ).toEqual(f.activeTask);
  });
  it('rejects tampering with generated query columns and malformed JSON', () => {
    const s = db();
    base(s);
    expect(() =>
      s.sqlite
        .prepare(
          'INSERT INTO learning_candidates(record_json, scope_kind) VALUES (?, ?)',
        )
        .run(JSON.stringify(f.candidate), 'global'),
    ).toThrow(/generated/);
    expect(() =>
      s.sqlite
        .prepare('INSERT INTO learning_candidates(record_json) VALUES (?)')
        .run('{broken'),
    ).toThrow();
  });
  it('stores every learned category distinctly', () => {
    const s = db();
    base(s);
    const contents = [
      {
        category: 'fact',
        subject: 'Synthetic',
        assertion: 'A declared assertion',
      },
      f.content,
      {
        category: 'episode',
        summary: 'Synthetic',
        occurredAt: f.time,
        originalEvidence: [f.evidence],
      },
      {
        category: 'intent_pattern',
        cue: 'Synthetic',
        interpretedIntent: 'Synthetic interpretation',
      },
      {
        category: 'procedure',
        objective: 'Synthetic',
        steps: [{ instruction: 'Synthetic step' }],
      },
    ];
    for (const [i, content] of contents.entries())
      record(s, 'learned_owner_state', {
        ...f.trusted,
        id: `learned_category${i}`,
        content,
        lifecycle: { status: 'observed' },
      });
    expect(
      s.db
        .select({ category: schema.learnedOwnerState.category })
        .from(schema.learnedOwnerState)
        .all()
        .map((x) => x.category)
        .sort(),
    ).toEqual(['episode', 'fact', 'intent_pattern', 'preference', 'procedure']);
  });
});

describe('history, provenance and relational evidence', () => {
  it('allows a correction target to reference task state without treating it as durable learning', () => {
    const s = db();
    base(s);
    record(s, 'active_task_state', f.activeTask);
    record(s, 'corrections', {
      ...f.correction,
      target: {
        kind: 'owner_state',
        reference: { learnedItemId: f.activeTask.id, version: 1 },
      },
    });
    expect(count(s, 'learned_owner_state')).toBe(0);
    expect(
      s.sqlite
        .prepare(
          "SELECT target_kind, target_id FROM record_references WHERE source_kind = 'corrections' AND path = '$.target.reference'",
        )
        .get(),
    ).toEqual({ target_kind: 'owner_state', target_id: f.activeTask.id });
  });
  it('records a correction without mutating original evidence', () => {
    const s = db();
    base(s);
    const old = s.db.select().from(schema.experienceEvents).get();
    const evidence = {
      evidenceId: 'evidence_correction',
      eventId: 'event_correction',
    };
    const correction = c.OwnerCorrectionSchema.parse({
      ...f.correction,
      evidence,
      provenance: {
        ...f.correction.provenance,
        sourceEventId: evidence.eventId,
      },
      target: { kind: 'evidence', reference: f.evidence },
    });
    s.sqlite.transaction(() => {
      record(s, 'corrections', correction);
      record(s, 'evidence', {
        ...f.recordedEvidence,
        id: evidence.evidenceId,
        eventId: evidence.eventId,
        provenance: correction.provenance,
      });
      record(s, 'experience_events', {
        ...event(evidence.eventId),
        eventType: 'owner_correction',
        evidenceIds: [evidence.evidenceId],
        payload: correction,
        provenance: correction.provenance,
      });
    })();
    expect(
      s.db
        .select()
        .from(schema.experienceEvents)
        .where(eq(schema.experienceEvents.recordId, f.evidence.eventId))
        .get(),
    ).toEqual(old);
    expect(s.db.select().from(schema.corrections).get()?.recordJson).toEqual(
      correction,
    );
    expect(count(s, 'learned_owner_state')).toBe(0);
  });
  it.each(['experience_events', 'evidence'] as const)(
    'rejects UPDATE, DELETE, replacement and UPSERT of %s',
    (table) => {
      const s = db();
      base(s);
      const value = table === 'evidence' ? f.recordedEvidence : event();
      for (const statement of [
        `UPDATE ${table} SET record_json = record_json`,
        `DELETE FROM ${table}`,
      ])
        expect(() => s.sqlite.exec(statement)).toThrow(/Immutable/);
      expect(() =>
        s.sqlite
          .prepare(`INSERT OR REPLACE INTO ${table}(record_json) VALUES (?)`)
          .run(JSON.stringify(value)),
      ).toThrow(/replaced/);
      expect(() =>
        s.sqlite
          .prepare(
            `INSERT INTO ${table}(record_json) VALUES (?) ON CONFLICT DO UPDATE SET record_json = excluded.record_json`,
          )
          .run(JSON.stringify(value)),
      ).toThrow();
    },
  );
  it('preserves derivation paths and assessed roots without counting summaries as corroboration', () => {
    const s = db();
    base(s);
    for (const i of [1, 2])
      record(s, 'evidence', {
        ...f.recordedEvidence,
        id: `evidence_summary${i}`,
        provenance: f.inference,
      });
    const input = c.LearningCandidateSchema.parse({
      ...f.candidate,
      evidence: {
        ...f.signals,
        supportingEvidence: [
          { evidenceId: 'evidence_summary1', eventId: f.evidence.eventId },
          { evidenceId: 'evidence_summary2', eventId: f.evidence.eventId },
        ],
        sourceIndependence: {
          status: 'assessed',
          rootSources: [f.evidence],
          assessmentEvidence: f.evidence,
        },
      },
    });
    record(s, 'learning_candidates', input);
    const row = s.db.select().from(schema.learningCandidates).get();
    expect(row?.recordJson.evidence).toEqual(input.evidence);
    expect(row?.support).toBe('limited');
    const links = s.sqlite
      .prepare(
        "SELECT path, target_id FROM record_references WHERE source_kind = 'learning_candidates' AND path LIKE '$.evidence.sourceIndependence%'",
      )
      .all();
    expect(links).toContainEqual({
      path: '$.evidence.sourceIndependence.rootSources[0]',
      target_id: f.evidence.evidenceId,
    });
    expect(() =>
      raw(s, 'learning_candidates', {
        ...input,
        id: 'candidate_false',
        evidence: { ...input.evidence, support: 'corroborated' },
      }),
    ).toThrow();
  });
  it('retains seven provenance origins and declared tool/external trust', () => {
    const s = db();
    base(s);
    const origins = [
      f.ownerProvenance,
      f.correction.provenance,
      f.approval.provenance,
      f.inference,
      f.tool,
      f.external,
      f.system,
    ];
    for (const [i, provenance] of origins.entries()) {
      const input = c.EvidenceRecordSchema.parse({
        ...f.recordedEvidence,
        id: `evidence_origin${i}`,
        provenance,
      });
      record(s, 'evidence', input);
      const row = s.db
        .select()
        .from(schema.evidence)
        .where(eq(schema.evidence.recordId, input.id))
        .get();
      expect(row?.recordJson).toEqual(input);
      expect(row?.sourceKind).toBe(provenance.kind);
      expect(row?.declaredTrust).toBe(
        'trust' in provenance ? provenance.trust : null,
      );
    }
    expect(() =>
      raw(s, 'evidence', {
        ...f.recordedEvidence,
        id: 'evidence_fake',
        provenance: { ...f.external, trust: 'trusted' },
      }),
    ).toThrow();
  });
  it('requires evidence/event pair agreement and rejects missing or self-derived evidence', () => {
    const s = db();
    base(s);
    record(s, 'experience_events', event('event_other'));
    expect(() =>
      record(s, 'learning_candidates', {
        ...f.candidate,
        evidence: {
          ...f.signals,
          supportingEvidence: [{ ...f.evidence, eventId: 'event_other' }],
        },
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      record(s, 'evidence', { ...f.recordedEvidence, provenance: f.inference }),
    ).toThrow();
    expect(() =>
      record(s, 'learning_candidates', {
        ...f.candidate,
        generation: {
          ...f.generation,
          generator: {
            ...f.inference,
            derivedFrom: [
              { evidenceId: 'evidence_missing', eventId: f.evidence.eventId },
            ],
          },
        },
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('restricts deletion of referenced owners, sessions, tasks and historical lineage', () => {
    const s = db();
    graph(s);
    for (const table of [
      'owners',
      'sessions',
      'tasks',
      'experience_events',
      'evidence',
      'learned_owner_state',
      'lifecycle_records',
      'record_references',
    ])
      expect(() => s.sqlite.exec(`DELETE FROM ${table}`)).toThrow();
    for (const row of s.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[]) {
      const foreignKeys = s.sqlite
        .prepare(`PRAGMA foreign_key_list(${row.name})`)
        .all() as { on_delete: string }[];
      expect(foreignKeys.every((fk) => fk.on_delete === 'RESTRICT')).toBe(true);
    }
    expect(s.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('authority and lifecycle snapshots', () => {
  it('keeps proposal, decision, approval, execution and verification separate', () => {
    const s = db();
    base(s);
    record(s, 'action_proposals', f.proposal);
    record(s, 'policy_decisions', f.policy);
    expect(count(s, 'tool_executions')).toBe(0);
    expect(count(s, 'owner_approvals')).toBe(0);
    record(s, 'owner_approvals', f.approval);
    record(s, 'tool_executions', f.execution);
    expect(count(s, 'verification_results')).toBe(0);
    record(s, 'verification_results', f.verification);
    for (const [table, value] of [
      ['action_proposals', f.proposal],
      ['policy_decisions', f.policy],
      ['owner_approvals', f.approval],
      ['tool_executions', f.execution],
      ['verification_results', f.verification],
    ] as const) {
      const row = s.sqlite
        .prepare(`SELECT record_json FROM ${table}`)
        .get() as { record_json: string };
      expect(deserializeContract(table, row.record_json)).toEqual(value);
    }
    const approval = s.db.select().from(schema.ownerApprovals).get();
    expect(approval).toMatchObject({
      proposalId: f.proposal.id,
      proposalVersion: 1,
      proposalDigest: f.digest.value,
      parametersDigest: f.digest.value,
      sessionId: f.task.sessionId,
      taskId: f.task.taskId,
      expiresAt: f.later,
    });
  });
  it.each([
    'proposalId',
    'proposalVersion',
    'proposalDigest',
    'parametersDigest',
  ] as const)('rejects mismatched authority binding %s in SQL', (field) => {
    const s = db();
    base(s);
    record(s, 'action_proposals', f.proposal);
    const changed =
      field === 'proposalId'
        ? 'proposal_missing'
        : field === 'proposalVersion'
          ? 2
          : { ...f.digest, value: 'b'.repeat(64) };
    expect(() =>
      record(s, 'owner_approvals', {
        ...f.approval,
        proposal: { ...f.binding, [field]: changed },
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      record(s, 'policy_decisions', {
        ...f.policy,
        proposal: { ...f.binding, [field]: changed },
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('enforces bindings inside raw historical event payloads too', () => {
    const s = db();
    base(s);
    record(s, 'action_proposals', f.proposal);
    expect(() =>
      record(s, 'experience_events', {
        ...event('event_policy'),
        provenance: f.system,
        eventType: 'policy_decision',
        payload: {
          ...f.policy,
          proposal: {
            ...f.binding,
            proposalDigest: { ...f.digest, value: 'b'.repeat(64) },
          },
        },
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('enforces approval task bounds inside historical event payloads', () => {
    const s = db();
    graph(s);
    s.sqlite
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
      .run(f.owner, 'task_second', f.task.sessionId, f.time);
    expect(() =>
      s.sqlite.transaction(() => {
        const provenance = {
          ...f.approval.provenance,
          sourceEventId: 'event_badapproval',
        };
        const evidence = {
          evidenceId: 'evidence_badapproval',
          eventId: 'event_badapproval',
        };
        record(s, 'evidence', {
          ...f.recordedEvidence,
          id: evidence.evidenceId,
          eventId: evidence.eventId,
          provenance,
        });
        record(s, 'experience_events', {
          ...event(evidence.eventId),
          eventType: 'owner_approval',
          provenance,
          payload: {
            ...f.approval,
            evidence,
            provenance,
            bounds: { ...f.task, taskId: 'task_second' },
          },
        });
      })(),
    ).toThrow(/FOREIGN KEY/);
  });
  it('rejects an ordinary event masquerading as a promotion reference', () => {
    const s = db();
    graph(s);
    expect(() =>
      record(s, 'learned_owner_state', {
        ...f.trusted,
        id: 'learned_badpromotion',
        lifecycle: {
          ...f.trusted.lifecycle,
          promotionEventId: f.evidence.eventId,
        },
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      record(s, 'lifecycle_records', {
        ...f.promotion,
        eventId: f.evidence.eventId,
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('rejects mismatched approval bounds and execution decision claims', () => {
    const s = db();
    base(s);
    record(s, 'action_proposals', f.proposal);
    record(s, 'policy_decisions', f.policy);
    s.sqlite
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
      .run(f.owner, 'task_second', f.task.sessionId, f.time);
    expect(() =>
      record(s, 'owner_approvals', {
        ...f.approval,
        bounds: { ...f.task, taskId: 'task_second' },
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      record(s, 'tool_executions', {
        ...f.execution,
        policy: { ...f.policyRef, decision: 'DENY' },
      }),
    ).toThrow(/FOREIGN KEY/);
  });
  it('can record execution after DENY without changing it to ALLOW', () => {
    const s = db();
    base(s);
    record(s, 'action_proposals', f.proposal);
    const { basis: _basis, ...denied } = f.policy as c.PolicyDecision & {
      basis: unknown;
    };
    record(s, 'policy_decisions', { ...denied, decision: 'DENY' });
    record(s, 'tool_executions', {
      ...f.execution,
      policy: { ...f.policyRef, decision: 'DENY' },
    });
    expect(s.db.select().from(schema.toolExecutions).get()).toMatchObject({
      attempted: 1,
      decision: 'DENY',
      outcome: 'succeeded',
    });
    expect(count(s, 'verification_results')).toBe(0);
  });
  it('preserves issued and revoked approval snapshots without rewriting either', () => {
    const s = db();
    graph(s);
    record(s, 'owner_approvals', f.approval);
    record(s, 'experience_events', event('event_withdrawal'));
    record(s, 'owner_approvals', {
      ...f.approval,
      metadata: { ...f.metadata, recordVersion: 2 },
      lifecycle: {
        status: 'revoked',
        revokedAt: f.later,
        revocationEventId: 'event_withdrawal',
        reason: 'Synthetic withdrawal',
      },
    });
    expect(count(s, 'owner_approvals')).toBe(2);
    expect(
      s.sqlite
        .prepare(
          'SELECT status, revocation_event_id FROM latest_owner_approvals',
        )
        .get(),
    ).toEqual({ status: 'revoked', revocation_event_id: 'event_withdrawal' });
  });
  it('persists promotion, supersession, revocation and rollback lineage without a controller', () => {
    const s = db();
    graph(s);
    s.sqlite.transaction(() => {
      record(s, 'learned_owner_state', {
        ...f.trusted,
        metadata: { ...f.metadata, recordVersion: 2 },
        lifecycle: { status: 'observed' },
      });
      for (const transition of [f.supersession, f.revocation, f.rollback]) {
        record(s, 'experience_events', transitionEvent(transition));
        record(s, 'lifecycle_records', transition);
      }
      record(s, 'learned_owner_state', {
        ...f.trusted,
        metadata: { ...f.metadata, recordVersion: 3 },
        lifecycle: {
          status: 'superseded',
          supersededAt: f.later,
          eventId: f.supersession.eventId,
          replacement: f.replacement,
        },
      });
      record(s, 'learned_owner_state', {
        ...f.trusted,
        metadata: { ...f.metadata, recordVersion: 4 },
        lifecycle: {
          status: 'revoked',
          revokedAt: f.later,
          reason: 'Synthetic',
          eventId: f.revocation.eventId,
          fallback: f.learnedRef,
        },
      });
    })();
    expect(count(s, 'lifecycle_records')).toBe(4);
    expect(
      s.sqlite
        .prepare(
          "SELECT * FROM latest_learned_owner_state WHERE status='trusted'",
        )
        .all(),
    ).toEqual([]);
    expect(
      s.db
        .select()
        .from(schema.learnedOwnerState)
        .where(eq(schema.learnedOwnerState.recordVersion, 1))
        .get()?.status,
    ).toBe('trusted');
    expect(
      s.db
        .select()
        .from(schema.learnedOwnerState)
        .where(eq(schema.learnedOwnerState.recordVersion, 3))
        .get(),
    ).toMatchObject({
      status: 'superseded',
      replacementId: f.replacement.learnedItemId,
      replacementVersion: 2,
    });
    expect(
      s.db
        .select()
        .from(schema.lifecycleRecords)
        .where(eq(schema.lifecycleRecords.recordId, f.rollback.eventId))
        .get()?.recordJson,
    ).toEqual(f.rollback);
    expect(() =>
      raw(s, 'lifecycle_records', { ...f.rollback, restore: f.rollback.from }),
    ).toThrow();
  });
  it.each([
    'owner_supplied',
    'deterministic',
    'externally_verified',
    'evaluator_model_judgment',
    'unresolved',
  ] as const)('preserves evaluation oracle %s distinctly', (kind) => {
    const s = db();
    base(s);
    record(s, 'learning_candidates', f.candidate);
    const oracles = {
      owner_supplied: f.testDefinition.oracle,
      deterministic: {
        kind,
        expected: { kind: 'response', text: 'Synthetic' },
        specification: f.artifact,
        provenance: f.system,
      },
      externally_verified: {
        kind,
        expected: { kind: 'response', text: 'Synthetic' },
        provenance: f.external,
        verificationEvidence: [f.evidence],
      },
      evaluator_model_judgment: {
        kind,
        expected: { kind: 'response', text: 'Synthetic' },
        provenance: f.inference,
        authority: 'advisory',
      },
      unresolved: { kind, reason: 'Synthetic unresolved oracle' },
    };
    const input = c.EvaluationResultSchema.parse({
      ...f.evaluation,
      test: { ...f.testDefinition, oracle: oracles[kind] },
      verdict: kind === 'unresolved' ? 'INDETERMINATE' : 'PASS',
    });
    record(s, 'evaluations', input);
    const result = s.db.select().from(schema.evaluations).get();
    expect(result?.oracleKind).toBe(kind);
    expect(result?.recordJson).toEqual(input);
    expect(count(s, 'learned_owner_state')).toBe(0);
  });
});

describe('local deterministic ordering', () => {
  it('rejects backwards explicit sequences even within one multi-row INSERT', () => {
    const s = db();
    base(s);
    expect(() =>
      s.sqlite
        .prepare(
          'INSERT INTO experience_events(sequence, record_json) VALUES (?, ?), (?, ?)',
        )
        .run(
          10,
          JSON.stringify(event('event_ten')),
          5,
          JSON.stringify(event('event_five')),
        ),
    ).toThrow(/high-water/);
    expect(count(s, 'experience_events')).toBe(1);
  });
  it('orders committed events by increasing sequence despite equal or reversed timestamps', () => {
    const s = db();
    identities(s);
    record(s, 'experience_events', event('event_z', f.later));
    record(s, 'experience_events', event('event_a', f.time));
    record(s, 'experience_events', event('event_b', f.time));
    expect(
      s.sqlite
        .prepare(
          'SELECT record_id, sequence FROM experience_events WHERE owner_id = ? ORDER BY sequence',
        )
        .all(f.owner),
    ).toEqual([
      { record_id: 'event_z', sequence: 1 },
      { record_id: 'event_a', sequence: 2 },
      { record_id: 'event_b', sequence: 3 },
    ]);
    expect(() =>
      s.sqlite
        .prepare(
          'INSERT INTO experience_events(sequence,record_json) VALUES (?,?)',
        )
        .run(0, JSON.stringify(event('event_bad'))),
    ).toThrow();
    expect(() =>
      s.sqlite
        .prepare(
          'INSERT INTO experience_events(sequence,record_json) VALUES (?,?)',
        )
        .run(2, JSON.stringify(event('event_backdated'))),
    ).toThrow();
  });
  it('rolls back failed cyclic batches and permits reuse of uncommitted sequence values', () => {
    const s = db();
    base(s);
    expect(() =>
      s.sqlite.transaction(() => {
        record(s, 'experience_events', event('event_rolledback'));
        record(s, 'learning_candidates', {
          ...f.candidate,
          proposedScope: { kind: 'bounded', taskId: 'task_missing' },
        });
      })(),
    ).toThrow(/FOREIGN KEY/);
    record(s, 'experience_events', event('event_next'));
    expect(
      s.sqlite
        .prepare(
          'SELECT record_id, sequence FROM experience_events ORDER BY sequence',
        )
        .all(),
    ).toEqual([
      { record_id: f.evidence.eventId, sequence: 1 },
      { record_id: 'event_next', sequence: 2 },
    ]);
    expect(count(s, 'learning_candidates')).toBe(0);
    expect(
      s.sqlite
        .prepare(
          "SELECT * FROM record_keys WHERE record_id = 'event_rolledback'",
        )
        .all(),
    ).toEqual([]);
  });
});
