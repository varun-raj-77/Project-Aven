// All owners, identifiers, texts and records in this file are SYNTHETIC.
//
// AVEN-011 Patch 5: the cross-layer adversarial campaign. Every scenario
// runs the real constructor, inspection, recorder, reconciliation and
// reader against the frozen Ledger and storage, mostly on file-backed
// SQLite, and one replay runs the read pipeline in a separate Node process
// on a `query_only` connection. Root, approvals and execution are outside
// AVEN-011: the nonauthority section shows that recording never becomes
// permission, using only labelled synthetic records.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AllowDecisionReferenceSchema,
  ExecutionResultSchema,
  OwnerApprovalSchema,
  PolicyDecisionSchema,
  VerificationResultSchema,
} from '@aven/contracts';
import { createLedger } from '@aven/ledger';
import { openStorage, type Storage } from '@aven/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as rootApi from '../src/index.ts';
import {
  ActionProposalError,
  computeActionProposalDigest,
  constructActionProposal,
  type ActionProposalErrorCode,
  type ActionProposalOutcome,
} from '../src/index.ts';
import * as ledgerApi from '../src/ledger/index.ts';
import {
  readProposalEvents,
  reconcileActionProposalRecording,
  recordActionProposal,
} from '../src/ledger/index.ts';
import { PRECHECK_SQL } from '../src/ledger/record.ts';
import * as X from './cross-layer-fixtures.ts';
import { draft } from './fixtures.ts';

const { L, A, B } = X;
type Json = Record<string, unknown>;

const directories: string[] = [];
const open: Storage[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven011-cross-'));
  directories.push(dir);
  return join(dir, 'aven.sqlite');
}
function track(storage: Storage): Storage {
  open.push(storage);
  return storage;
}
/** A fresh file-backed synthetic world on its own connection. */
function fileWorld(): { path: string; storage: Storage } {
  const path = file();
  return { path, storage: track(L.world(path)) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of open.splice(0))
    if (storage.sqlite.open) storage.sqlite.close();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}
function expectFailure(
  run: () => unknown,
  code: ActionProposalErrorCode,
  outcome: ActionProposalOutcome = 'not_written',
): ActionProposalError {
  const error = caught(run);
  expect(error).toBeInstanceOf(ActionProposalError);
  expect(error).toMatchObject({ code, outcome });
  expect((error as Error).cause).toBeUndefined();
  return error as ActionProposalError;
}
/** `run` fails as specified and leaves every table byte-identical. */
function expectRejectedUnchanged(
  storage: Storage,
  run: () => unknown,
  code: ActionProposalErrorCode,
  outcome: ActionProposalOutcome = 'not_written',
) {
  const before = X.logicalState(storage);
  expectFailure(run, code, outcome);
  vi.restoreAllMocks();
  expect(X.logicalState(storage)).toBe(before);
}
const tableCount = (storage: Storage, table: string) =>
  (
    storage.sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;
const AUTHORITY_TABLES = [
  'policy_decisions',
  'owner_approvals',
  'tool_executions',
  'verification_results',
];
const authorityRows = (storage: Storage) =>
  AUTHORITY_TABLES.map((t) => tableCount(storage, t));

describe('deterministic records and a fresh-process query_only replay', () => {
  it('builds byte-identical histories from identical inputs', () => {
    const strip = (storage: Storage) =>
      X.logicalState(storage).replace(
        /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g,
        '<recordedAt>',
      );
    const first = track(X.buildScenario(file()));
    const second = track(X.buildScenario(file()));
    // Only the Ledger's own recording clock may differ.
    expect(strip(first)).toBe(strip(second));
    const records = (s: Storage) =>
      X.allRecords(s, A).map(({ recordedAt: _r, ...rest }) => rest);
    expect(records(first)).toEqual(records(second));
  });

  it('replays the read pipeline in a separate process without writing', () => {
    const path = file();
    const storage = track(X.buildScenario(path));
    const inProcess = X.comparable(X.readPipeline(storage));
    const before = X.logicalState(storage);
    storage.sqlite.close();

    const fixtures = new URL('./cross-layer-fixtures.ts', import.meta.url);
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { replayInFreshProcess } from ${JSON.stringify(fixtures.href)};
         replayInFreshProcess(process.argv[1]);`,
        path,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    const replay = JSON.parse(output) as {
      pid: number;
      queryOnly: number;
      changesBefore: number;
      changesAfter: number;
      stateUnchanged: boolean;
      pipeline: string;
    };
    expect(replay.pid).not.toBe(process.pid);
    expect(replay.queryOnly).toBe(1);
    expect(replay.changesAfter).toBe(replay.changesBefore);
    expect(replay.stateUnchanged).toBe(true);
    expect(replay.pipeline).toBe(inProcess);

    const reopened = track(openStorage(path));
    expect(X.logicalState(reopened)).toBe(before);
  });

  it('reports the whole scenario as expected', () => {
    const storage = track(X.buildScenario(file()));
    const pipeline = X.readPipeline(storage);
    const recordsA = pipeline.records[A] as ReturnType<typeof X.allRecords>;
    expect(recordsA.map((r) => [r.eventId, r.protocol, r.digest])).toEqual([
      ['event_x1', 'v1', 'agrees'],
      ['event_x2', 'v1', 'agrees'],
      ['event_x3', 'v1', 'agrees'],
      ['event_x4', 'v1', 'agrees'],
      ['event_x1_again', 'v1', 'agrees'],
      ['event_x20', 'unsupported', 'not_evaluated'],
      ['event_x21', 'v1', 'disagrees'],
      ['event_x22', 'v1', 'not_evaluated'],
      ['event_x23', 'v1', 'agrees'],
    ]);
    expect(recordsA.at(-1)!.eventFormat.reasons).toEqual([
      'event_origin_kind_unsupported',
    ]);
    expect(
      (pipeline.records[B] as ReturnType<typeof X.allRecords>).map(
        (r) => r.eventId,
      ),
    ).toEqual(['event_x5', 'event_x6']);
    expect(
      (pipeline.reconciliations as { status: string }[]).map((r) => r.status),
    ).toEqual([
      'recorded',
      'recorded',
      'recorded',
      'recorded',
      'recorded',
      'recorded',
      'not_recorded',
      'not_recorded',
    ]);
  });

  it('constructs, inspects, records, reconciles and reads one consistent binding', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    const result = X.endToEnd(storage, request);
    expect(result.constructed.proposal).toEqual(request.proposal);
    expect(result.inspection.binding).toEqual(result.receipt.binding);
    expect(result.reconciliation).toMatchObject({
      status: 'recorded',
      binding: result.receipt.binding,
    });
    expect(result.record?.declaredDigest).toEqual(
      result.receipt.binding.proposalDigest,
    );
    expect(computeActionProposalDigest(request.proposal)).toEqual(
      result.receipt.binding.proposalDigest,
    );
    expect(result.record?.digest).toBe('agrees');
  });
});

describe('Root nonauthority: recording never becomes permission', () => {
  it('exports nothing that decides, approves or executes', () => {
    const names = [...Object.keys(rootApi), ...Object.keys(ledgerApi)];
    for (const name of names)
      expect(name).not.toMatch(
        /execut|authori[sz]|approv|grant|allow|permit|decide|promot|learn/i,
      );
  });

  it('writes no decision, approval, execution or verification row', () => {
    const { storage } = fileWorld();
    const before = authorityRows(storage);
    const result = X.endToEnd(storage, X.requestFor(1));
    readProposalEvents(storage, A);
    expect(authorityRows(storage)).toEqual(before);
    expect(result.inspection).toMatchObject({
      confersAuthority: false,
      rootDecision: 'not_evaluated_here',
    });
  });

  it('cannot turn a recorded proposal into an execution record', () => {
    const { storage } = fileWorld();
    const receipt = recordActionProposal(storage, X.requestFor(1));
    const before = X.logicalState(storage);
    // No decision exists; the proposal event and its digest are not one.
    for (const decisionId of [
      'decision_fabricated',
      'decision_x1',
      `decision_${receipt.binding.proposalDigest.value.slice(0, 8)}`,
    ]) {
      const error = X.tryExecution(
        storage,
        receipt.binding,
        decisionId,
        `event_exec_${decisionId.slice(9)}`,
      );
      expect(error?.code).toBe('invalid_reference');
      expect(X.logicalState(storage)).toBe(before);
    }
    expect(tableCount(storage, 'tool_executions')).toBe(0);
  });

  it('a cited approval or a recorded DENY is not an ALLOW either (synthetic setup)', () => {
    const { storage } = fileWorld();
    const receipt = recordActionProposal(storage, X.requestFor(1));
    L.syntheticApproval(
      storage,
      receipt.binding,
      'approval_synthetic',
      'event_approval',
    );
    L.syntheticPolicyDecision(storage, receipt.binding, 'event_decision');
    const before = X.logicalState(storage);
    // An approval is not even a decision identifier: the contract refuses it.
    expect(
      X.tryExecution(
        storage,
        receipt.binding,
        'approval_synthetic',
        'event_exec',
      )?.code,
    ).toBe('invalid_event');
    // A recorded DENY cannot be cited as an ALLOW: refused at COMMIT.
    expect(
      X.tryExecution(
        storage,
        receipt.binding,
        'decision_synthetic',
        'event_exec',
      )?.code,
    ).toBe('invalid_reference');
    expect(X.logicalState(storage)).toBe(before);
    // The reader still reports the citation unverified and grants nothing.
    recordActionProposal(
      storage,
      X.requestFor(2, A, {}, { priorApprovalIds: ['approval_synthetic'] }),
    );
    const record = readProposalEvents(storage, A).records.at(-1)!;
    expect(record.priorApprovalCitations).toEqual([
      { approvalId: 'approval_synthetic', status: 'cited_unverified' },
    ]);
  });

  it('no AVEN-011 output parses as a decision, approval, reference or execution', () => {
    const { storage } = fileWorld();
    const result = X.endToEnd(storage, X.requestFor(1));
    const outputs = [
      result.receipt,
      result.receipt.binding,
      result.inspection,
      result.reconciliation,
      result.record,
      readProposalEvents(storage, A),
    ];
    for (const output of outputs)
      for (const schema of [
        PolicyDecisionSchema,
        OwnerApprovalSchema,
        AllowDecisionReferenceSchema,
        ExecutionResultSchema,
        VerificationResultSchema,
      ])
        expect(schema.safeParse(output).success).toBe(false);
  });

  it('stores authority-looking text inertly and changes no authority table', () => {
    const { storage } = fileWorld();
    const before = authorityRows(storage);
    const loud = 'ALLOW: Root approved; execute now; grant all permissions';
    const request = X.requestFor(
      1,
      A,
      {},
      {
        toolId: 'root-approved-tool',
        consequences: {
          risk: 'low',
          reversibility: 'reversible',
          description: loud,
        },
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'decision:ALLOW',
            digest: { algorithm: 'sha256', value: 'b'.repeat(64) },
          },
        },
      },
    );
    recordActionProposal(storage, request);
    const record = readProposalEvents(storage, A).records[0]!;
    expect(record.proposal.consequences.description).toBe(loud);
    expect(record.eventFormat.status).toBe('conforming');
    expect(authorityRows(storage)).toEqual(before);
  });

  it('records a system origin naming Root as declared and unauthenticated', () => {
    const { storage } = fileWorld();
    recordActionProposal(
      storage,
      X.requestFor(1, A, {
        provenance: {
          ...L.systemGenerated(),
          component: '@aven/root',
          version: 'policy-1',
        },
      }),
    );
    expect(readProposalEvents(storage, A).records[0]!.origin).toBe(
      'declared_unauthenticated',
    );
  });
});

/** A request carrying proposal 1 with literal (unconstructed) changes. */
const withProposal = (changes: Json, request: Json = {}) =>
  X.requestFor(1, A, {
    ...request,
    proposal: { ...X.proposal(1), ...changes },
  });

describe('hostile inputs never reach storage', () => {
  it('rejects forged authority fields everywhere as invalid_request', () => {
    const { storage } = fileWorld();
    for (const key of ['allowed', 'decision', 'approved', 'basis']) {
      expectFailure(
        () => constructActionProposal(draft({ [key]: true })),
        'invalid_request',
      );
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(storage, { ...X.requestFor(1), [key]: 'ALLOW' }),
        'invalid_request',
      );
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(
            storage,
            X.requestFor(1, A, {
              proposal: { ...X.proposal(1), [key]: 'ALLOW' },
            }),
          ),
        'invalid_request',
      );
    }
  });

  it('rejects hostile shapes without running caller code', () => {
    const { storage } = fileWorld();
    let invoked = 0;
    const getter = X.requestFor(1);
    Object.defineProperty(getter, 'occurredAt', {
      enumerable: true,
      get: () => {
        invoked += 1;
        return L.occurredAt;
      },
    });
    const sparse = X.proposal(1);
    // eslint-disable-next-line no-sparse-arrays
    sparse.priorApprovalIds = [, 'approval_x'];
    const symbol = X.requestFor(1);
    (symbol as Record<symbol, unknown>)[Symbol('hidden')] = 1;
    let deep: Json = { kind: 'model_inference' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    const hostile: unknown[] = [
      new Proxy(X.requestFor(1), {}),
      getter,
      X.requestFor(1, A, { proposal: sparse }),
      symbol,
      X.requestFor(1, A, { occurredAt: 10n }),
      X.requestFor(1, A, {
        proposal: { ...X.proposal(1), metadata: { recordVersion: Number.NaN } },
      }),
      X.requestFor(1, A, { provenance: deep }),
      // Literal proposals: the constructor would already refuse these.
      withProposal({ toolId: 't'.repeat(20_001) }),
      withProposal({
        consequences: {
          risk: 'low',
          reversibility: 'reversible',
          description: '',
        },
      }),
      withProposal({
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'synthetic:p',
            digest: { algorithm: 'sha256', value: 'XYZ' },
          },
        },
      }),
      withProposal({
        priorApprovalIds: Array.from(
          { length: 257 },
          (_, i) => `approval_${i}`,
        ),
      }),
      X.requestFor(1, A, { eventId: 'event id with spaces' }),
      X.requestFor(1, A, {
        proposal: { ...X.proposal(1), id: 'proposal bad' },
      }),
    ];
    for (const request of hostile)
      expectRejectedUnchanged(
        storage,
        () => recordActionProposal(storage, request),
        'invalid_request',
      );
    expect(invoked).toBe(0);
  });

  it('records only the v1 creation stamp and refuses lifecycle operations on any resource', () => {
    const { storage } = fileWorld();
    for (const creation of [
      { component: 'synthetic-direct-writer', version: '1' },
      {
        component: '@aven/action-proposals',
        version: 'aven-011-action-proposals-v1',
        runtime: { identifier: 'synthetic-runtime', version: '1' },
      },
    ])
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(
            storage,
            withProposal({
              metadata: { ...(X.proposal(1).metadata as Json), creation },
            }),
          ),
        'unsupported_proposal',
      );
    for (const operation of [
      'promote_learning',
      'revoke_learning',
      'rollback_learning',
    ])
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(
            storage,
            withProposal({
              requestedAuthority: [
                {
                  operation,
                  resource: { kind: 'document', identifier: 'synthetic-doc' },
                },
              ],
            }),
          ),
        'operation_not_in_v1_format',
      );
  });

  it('accepts reads of learned state and defers every other learned-state operation', () => {
    const { storage } = fileWorld();
    for (const operation of [
      'promote_learning',
      'revoke_learning',
      'rollback_learning',
      'modify',
      'delete',
    ]) {
      const authority = [
        {
          operation,
          resource: { kind: 'learned_state', identifier: 'learned_x' },
        },
      ];
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(
            storage,
            withProposal({ requestedAuthority: authority }),
          ),
        'operation_not_in_v1_format',
      );
      expectFailure(
        () => constructActionProposal(draft({ requestedAuthority: authority })),
        'operation_not_in_v1_format',
      );
    }
    recordActionProposal(
      storage,
      X.requestFor(
        1,
        A,
        {},
        {
          requestedAuthority: [
            {
              operation: 'read',
              resource: { kind: 'learned_state', identifier: 'learned_x' },
            },
          ],
        },
      ),
    );
    expect(
      readProposalEvents(storage, A).records[0]!.proposalFormat.status,
    ).toBe('conforming');
  });

  it('rejects owner-origin and external origins, which the reader also flags', () => {
    const { storage } = fileWorld();
    const origins = [
      { kind: 'owner_approval', ownerId: A, sourceEventId: 'event_x1' },
      {
        kind: 'explicit_owner_statement',
        ownerId: A,
        sourceEventId: 'event_x1',
      },
      {
        kind: 'explicit_owner_correction',
        ownerId: A,
        sourceEventId: 'event_x1',
      },
      {
        kind: 'tool_result',
        toolId: 'synthetic-tool',
        sourceEventId: L.source.eventId,
        trust: 'potentially_untrusted',
      },
      {
        kind: 'external_content',
        source: 'synthetic-source',
        capturedAt: '2026-10-14T08:30:00Z',
        trust: 'untrusted',
      },
    ];
    for (const provenance of origins)
      expectRejectedUnchanged(
        storage,
        () => recordActionProposal(storage, X.requestFor(1, A, { provenance })),
        'unsupported_origin',
      );
    // Appended directly through the frozen Ledger, they are flagged on read.
    for (const [i, provenance] of origins.slice(1).entries())
      X.appendDirect(storage, X.requestFor(30 + i), (e) => {
        e.provenance =
          'sourceEventId' in provenance && provenance.kind !== 'tool_result'
            ? { ...provenance, sourceEventId: e.id }
            : provenance;
      });
    const records = readProposalEvents(storage, A).records;
    expect(records).toHaveLength(4);
    for (const record of records)
      expect(record.eventFormat.reasons).toContain(
        'event_origin_kind_unsupported',
      );
  });
});

describe('owners and bindings', () => {
  it('rejects a request whose binding differs from its proposal', () => {
    const { storage } = fileWorld();
    for (const overrides of [
      { taskId: L.otherTask },
      { sessionId: L.secondSession, taskId: L.secondTask },
      { ownerId: B },
    ])
      expectRejectedUnchanged(
        storage,
        () => recordActionProposal(storage, X.requestFor(1, A, overrides)),
        'binding_mismatch',
      );
  });

  it('gives missing and foreign references the same code and message', () => {
    const { storage } = fileWorld();
    // Owner B's own records, which A must never resolve.
    const foreign = recordActionProposal(storage, X.requestFor(1, B));
    L.syntheticApproval(
      storage,
      foreign.binding,
      'approval_foreign',
      'event_foreign',
      B,
    );
    const pairs: [Json, Json, ActionProposalErrorCode][] = [
      [
        X.requestFor(2, A, {}, { taskId: 'task_missing' }),
        X.requestFor(
          2,
          A,
          {},
          { sessionId: L.secondSession, taskId: L.taskId },
        ),
        'unknown_binding',
      ],
      [
        X.requestFor(2, A, {}, { priorApprovalIds: ['approval_missing'] }),
        X.requestFor(2, A, {}, { priorApprovalIds: ['approval_foreign'] }),
        'unresolved_reference',
      ],
      [
        X.requestFor(2, A, {
          provenance: {
            ...L.inference(),
            derivedFrom: [
              { evidenceId: 'evidence_missing', eventId: 'event_missing' },
            ],
          },
        }),
        X.requestFor(2, A, {
          provenance: {
            ...L.inference(),
            derivedFrom: [
              { evidenceId: 'evidence_foreign', eventId: 'event_foreign' },
            ],
          },
        }),
        'unresolved_reference',
      ],
    ];
    for (const [missing, foreignRequest, code] of pairs) {
      const a = expectFailure(
        () => recordActionProposal(storage, missing),
        code,
      );
      const b = expectFailure(
        () => recordActionProposal(storage, foreignRequest),
        code,
      );
      expect(a.message).toBe(b.message);
    }
    expect(readProposalEvents(storage, A).records).toEqual([]);
  });

  it("keeps each owner's identical identifiers and histories apart", () => {
    const { storage } = fileWorld();
    recordActionProposal(storage, X.requestFor(1, A));
    recordActionProposal(storage, X.requestFor(1, B));
    const [a] = readProposalEvents(storage, A).records;
    const [b] = readProposalEvents(storage, B).records;
    expect(a!.eventId).toBe(b!.eventId);
    expect(a!.proposal.ownerId).toBe(A);
    expect(b!.proposal.ownerId).toBe(B);
    expect(a!.declaredDigest).not.toEqual(b!.declaredDigest);
  });
});

describe('Unicode and digest mutations through the whole pipeline', () => {
  it('rejects lone surrogates at construction; directly appended ones are flagged', () => {
    const { storage } = fileWorld();
    for (const bad of ['\uD800', '\uDC00', 'x\uDBFFy'])
      expectFailure(
        () =>
          constructActionProposal(
            draft({
              consequences: {
                risk: 'low',
                reversibility: 'reversible',
                description: bad,
              },
            }),
          ),
        'invalid_request',
      );
    X.appendDirect(storage, X.requestFor(1), (e) => {
      ((e.payload as Json).consequences as Json).description = 'x\uDBFFy';
    });
    const record = readProposalEvents(storage, A).records[0]!;
    expect(record.digest).toBe('not_evaluated');
    expect(record.proposalFormat.reasons).toEqual([
      'proposal_ill_formed_unicode',
    ]);
  });

  it('never normalizes: composed and decomposed text record different digests', () => {
    const text = (description: string) => ({
      risk: 'low',
      reversibility: 'reversible',
      description,
    });
    // The same identifiers in two databases; only the text form differs.
    const [composed, decomposed] = ['caf\u00e9', 'cafe\u0301'].map(
      (description) => {
        const storage = track(L.world());
        const receipt = recordActionProposal(
          storage,
          X.requestFor(1, A, {}, { consequences: text(description) }),
        );
        const record = readProposalEvents(storage, A).records[0]!;
        expect(record.digest).toBe('agrees');
        expect(record.proposal.consequences.description).toBe(description);
        return receipt.binding.proposalDigest;
      },
    );
    expect(composed).not.toEqual(decomposed);
  });

  it('records a distinct agreeing digest for every single-field change', () => {
    const changes: Json[] = [
      {},
      { toolId: 'synthetic-other-tool' },
      { action: 'summarize' },
      { target: { kind: 'sandbox_resource', identifier: 'synthetic-other' } },
      {
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'synthetic:other-locator',
            digest: { algorithm: 'sha256', value: 'b'.repeat(64) },
          },
        },
      },
      {
        parameters: {
          kind: 'immutable_reference',
          artifact: {
            locator: 'synthetic:parameters',
            digest: { algorithm: 'sha256', value: 'c'.repeat(64) },
          },
        },
      },
      {
        consequences: {
          risk: 'high',
          reversibility: 'reversible',
          description: 'Prepare a synthetic draft.',
        },
      },
      { createdAt: '2026-10-14T09:00:00.5Z' },
      {
        requestedAuthority: [
          {
            operation: 'read',
            resource: {
              kind: 'sandbox_resource',
              identifier: 'synthetic-draft',
            },
          },
        ],
      },
    ];
    const bindings = changes.map((change) => {
      const storage = track(L.world());
      const receipt = recordActionProposal(
        storage,
        X.requestFor(1, A, {}, change),
      );
      const record = readProposalEvents(storage, A).records[0]!;
      expect(record.digest).toBe('agrees');
      expect(record.declaredDigest).toEqual(receipt.binding.proposalDigest);
      return receipt.binding;
    });
    const digests = bindings.map((b) => b.proposalDigest.value);
    expect(new Set(digests).size).toBe(changes.length);
    // Locator only: proposal digest changes, parameters digest does not.
    expect(bindings[4]!.parametersDigest).toEqual(
      bindings[0]!.parametersDigest,
    );
    // Declared content digest: both change.
    expect(bindings[5]!.parametersDigest).not.toEqual(
      bindings[0]!.parametersDigest,
    );
  });

  it('is independent of key order and JSON round trips', () => {
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value as Json)
                .reverse()
                .map(([k, v]) => [k, reverse(v)]),
            )
          : value;
    const base = recordActionProposal(
      track(L.world()),
      X.requestFor(1),
    ).binding;
    const reordered = recordActionProposal(
      track(L.world()),
      X.requestFor(1, A, { proposal: reverse(X.proposal(1)) }),
    ).binding;
    const roundTrip = recordActionProposal(
      track(L.world()),
      JSON.parse(JSON.stringify(X.requestFor(1))) as Json,
    ).binding;
    expect(reordered).toEqual(base);
    expect(roundTrip).toEqual(base);
  });

  it('flags each declared-digest mutation on read', () => {
    const real = computeActionProposalDigest(X.proposal(1)).value;
    for (const position of [0, 31, 63]) {
      const storage = track(L.world());
      const flipped =
        real.slice(0, position) +
        (real[position] === 'a' ? 'b' : 'a') +
        real.slice(position + 1);
      X.appendDirect(storage, X.requestFor(1), () => {}, flipped);
      const record = readProposalEvents(storage, A).records[0]!;
      expect(record.digest).toBe('disagrees');
      expect(record.declaredDigest.value).toBe(flipped);
    }
  });
});

describe('independent golden vectors through the whole pipeline', () => {
  it('records, reconciles and reads each vector with its independent digest', () => {
    const storage = track(X.vectorWorld(file()));
    const recordable = X.vectors.vectors.filter(
      (v) => (v.proposal.priorApprovalIds as unknown[]).length === 0,
    );
    expect(recordable.map((v) => v.name)).toEqual([
      'v1-minimal-ascii',
      'v2-unicode-and-escapes',
      'v4-locator-only-change',
    ]);
    // v1 and v4 share a proposal identifier, so each gets its own database.
    for (const [i, vector] of recordable.entries()) {
      const db = i === 0 ? storage : track(X.vectorWorld());
      const request = X.vectorRequest(vector.proposal, `event_vector_${i}`);
      const receipt = recordActionProposal(db, request);
      expect(receipt.binding.proposalDigest).toEqual({
        algorithm: 'sha256',
        value: vector.digest,
      });
      expect(reconcileActionProposalRecording(db, request)).toMatchObject({
        status: 'recorded',
      });
      const record = readProposalEvents(db, X.VECTOR.owner).records.at(-1)!;
      expect(record.declaredDigest.value).toBe(vector.digest);
      expect(record.digest).toBe('agrees');
      expect(record.proposal).toEqual(vector.proposal);
    }
  });

  it('matches the array-order vectors and refuses the rejected vectors', () => {
    const [a, b] = X.vectors.vectors.filter((v) => v.name.startsWith('v3'));
    expect(computeActionProposalDigest(a!.proposal).value).toBe(a!.digest);
    expect(computeActionProposalDigest(b!.proposal).value).toBe(b!.digest);
    expect(a!.digest).not.toBe(b!.digest);
    const storage = track(X.vectorWorld());
    for (const rejected of X.vectors.rejected) {
      expectFailure(
        () => computeActionProposalDigest(rejected.proposal),
        'invalid_request',
      );
      expectRejectedUnchanged(
        storage,
        () =>
          recordActionProposal(
            storage,
            X.vectorRequest(rejected.proposal, 'event_rejected'),
          ),
        'invalid_request',
      );
    }
  });
});

describe('uncertain COMMIT outcomes and rollback integrity (file-backed)', () => {
  /** Replaces `exec` for the given statements; everything else runs. */
  function failExec(
    storage: Storage,
    failing: Record<string, 'throw' | 'run_then_throw'>,
  ) {
    const db = storage.sqlite;
    const original = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      const mode = failing[sql];
      if (mode === 'run_then_throw') original(sql);
      if (mode !== undefined)
        throw Object.assign(new Error('synthetic I/O failure'), {
          code: 'SQLITE_IOERR',
        });
      return original(sql);
    });
  }

  it('a rejection before the Ledger transaction leaves everything unchanged', () => {
    const { storage } = fileWorld();
    expectRejectedUnchanged(
      storage,
      () =>
        recordActionProposal(
          storage,
          X.requestFor(1, A, { occurredAt: '2099-01-01T00:00:00Z' }),
        ),
      'ledger_rejected',
    );
  });

  it('a deferred foreign-key failure at COMMIT is a confirmed rollback', () => {
    const { storage } = fileWorld();
    const db = storage.sqlite;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) =>
      sql === PRECHECK_SQL.evidence
        ? { get: () => ({ found: 1 }) }
        : prepare(sql)) as never);
    expectRejectedUnchanged(
      storage,
      () =>
        recordActionProposal(
          storage,
          X.requestFor(1, A, {
            provenance: {
              ...L.inference(),
              derivedFrom: [
                { evidenceId: 'evidence_missing', eventId: 'event_source' },
              ],
            },
          }),
        ),
      'ledger_rejected',
      'rolled_back',
    );
    expect(readProposalEvents(storage, A).records).toEqual([]);
  });

  it('a COMMIT that fails is unknown, reconciles not_recorded and records once on retry', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    failExec(storage, { COMMIT: 'throw' });
    expectRejectedUnchanged(
      storage,
      () => recordActionProposal(storage, request),
      'storage_failure',
      'unknown',
    );
    expect(reconcileActionProposalRecording(storage, request)).toEqual({
      status: 'not_recorded',
    });
    recordActionProposal(storage, request);
    expect(readProposalEvents(storage, A).records).toHaveLength(1);
  });

  it('a COMMIT that took effect but raised is unknown and reconciles recorded', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    failExec(storage, { COMMIT: 'run_then_throw' });
    expectFailure(
      () => recordActionProposal(storage, request),
      'storage_failure',
      'unknown',
    );
    vi.restoreAllMocks();
    expect(reconcileActionProposalRecording(storage, request)).toMatchObject({
      status: 'recorded',
    });
    expectRejectedUnchanged(
      storage,
      () => recordActionProposal(storage, request),
      'identifier_collision',
    );
    expect(readProposalEvents(storage, A).records).toHaveLength(1);
  });

  it('a failed rollback strands the connection; close, reopen, reconcile, resubmit', () => {
    const { path, storage } = fileWorld();
    const request = X.requestFor(1);
    failExec(storage, { COMMIT: 'throw', ROLLBACK: 'throw' });
    expectFailure(
      () => recordActionProposal(storage, request),
      'storage_failure',
      'unknown',
    );
    vi.restoreAllMocks();
    expect(storage.sqlite.inTransaction).toBe(true);
    expect(reconcileActionProposalRecording(storage, request)).toEqual({
      status: 'unresolved',
      code: 'storage_failure',
    });
    expectFailure(() => readProposalEvents(storage, A), 'storage_failure');
    storage.sqlite.close();

    const fresh = track(openStorage(path));
    expect(reconcileActionProposalRecording(fresh, request)).toEqual({
      status: 'not_recorded',
    });
    const receipt = recordActionProposal(fresh, request);
    expect(reconcileActionProposalRecording(fresh, request)).toMatchObject({
      status: 'recorded',
      sequence: receipt.sequence,
    });
    expect(readProposalEvents(fresh, A).records).toHaveLength(1);
    expect(createLedger(fresh, A as never).inspectIntegrity().ok).toBe(true);
  });
});

describe('concurrent recordings on two connections', () => {
  /** Runs `first` on connection A between B's prechecks and its write lock. */
  function race(first: Json, second: Json) {
    const { path, storage: a } = fileWorld();
    const b = track(openStorage(path));
    const exec = b.sqlite.exec.bind(b.sqlite);
    let interleaved = false;
    vi.spyOn(b.sqlite, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !interleaved) {
        interleaved = true;
        recordActionProposal(a, first);
      }
      return exec(sql);
    });
    let outcome: unknown;
    try {
      outcome = recordActionProposal(b, second);
    } catch (error) {
      outcome = error;
    }
    vi.restoreAllMocks();
    expect(interleaved).toBe(true);
    return { a, b, outcome };
  }

  it('interleaved recordings from two connections all land, in order', () => {
    const { path, storage: a } = fileWorld();
    const b = track(openStorage(path));
    const sequences: number[] = [];
    for (let n = 1; n <= 40; n += 1)
      sequences.push(
        recordActionProposal(n % 2 === 0 ? a : b, X.requestFor(n)).sequence,
      );
    expect(sequences.every((s, i) => i === 0 || s > sequences[i - 1]!)).toBe(
      true,
    );
    const records = X.allRecords(b, A, 7);
    expect(records.map((r) => r.sequence)).toEqual(sequences);
    expect(records.every((r) => r.digest === 'agrees')).toBe(true);
  });

  it('the same request racing on two connections records exactly once', () => {
    const request = X.requestFor(1);
    const { b, outcome } = race(request, request);
    expect(outcome).toMatchObject({
      code: 'identifier_collision',
      outcome: 'rolled_back',
    });
    expect(reconcileActionProposalRecording(b, request)).toMatchObject({
      status: 'recorded',
    });
    expect(readProposalEvents(b, A).records).toHaveLength(1);
  });

  it('a different payload under a proposal identifier taken meanwhile rolls back', () => {
    const { b, outcome } = race(
      X.requestFor(1),
      X.requestFor(1, A, { eventId: 'event_late' }, { action: 'summarize' }),
    );
    expect(outcome).toMatchObject({
      code: 'ledger_rejected',
      outcome: 'rolled_back',
    });
    expect(readProposalEvents(b, A).records.map((r) => r.eventId)).toEqual([
      'event_x1',
    ]);
  });

  it('an identical payload under a new event identifier is a second, separate record', () => {
    const { b, outcome } = race(
      X.requestFor(1),
      X.requestFor(1, A, {
        eventId: 'event_late',
        provenance: L.systemGenerated(),
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'recorded' });
    const records = readProposalEvents(b, A).records;
    expect(records.map((r) => [r.eventId, r.provenance.kind])).toEqual([
      ['event_x1', 'model_inference'],
      ['event_late', 'system_generated'],
    ]);
    expect(records[0]!.proposal).toEqual(records[1]!.proposal);
  });
});

describe('retries, stale and conflicting requests', () => {
  it('records once after a not_written failure and refuses a replay', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    storage.sqlite.exec('BEGIN');
    expectFailure(
      () => recordActionProposal(storage, request),
      'storage_failure',
    );
    storage.sqlite.exec('ROLLBACK');
    recordActionProposal(storage, request);
    expectRejectedUnchanged(
      storage,
      () => recordActionProposal(storage, request),
      'identifier_collision',
    );
    expect(readProposalEvents(storage, A).records).toHaveLength(1);
  });

  it('reports a matching event with another declared digest as conflict', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    // Test setup: exactly the recorder's event, declared with another digest.
    X.appendDirect(storage, request, () => {}, 'd'.repeat(64));
    expect(reconcileActionProposalRecording(storage, request)).toEqual({
      status: 'conflict',
    });
    expect(readProposalEvents(storage, A).records[0]!.digest).toBe('disagrees');
  });

  it('reports stale or conflicting requests as conflict and never records them', () => {
    const { storage } = fileWorld();
    recordActionProposal(storage, X.requestFor(1));
    const stale = [
      X.requestFor(1, A, { occurredAt: '2026-10-14T09:00:06Z' }),
      X.requestFor(1, A, { provenance: L.systemGenerated() }),
      X.requestFor(1, A, {}, { action: 'summarize' }),
      X.requestFor(1, A, { eventId: 'event_other' }),
    ];
    for (const request of stale) {
      expect(reconcileActionProposalRecording(storage, request)).toEqual({
        status: 'conflict',
      });
      expectRejectedUnchanged(
        storage,
        () => recordActionProposal(storage, request),
        'identifier_collision',
      );
    }
    expect(readProposalEvents(storage, A).records).toHaveLength(1);
  });
});

describe('malformed events and corrupted projections', () => {
  it('frozen triggers block direct UPDATE and DELETE of history', () => {
    const { storage } = fileWorld();
    recordActionProposal(storage, X.requestFor(1));
    const before = X.logicalState(storage);
    for (const sql of [
      "UPDATE experience_events SET record_json = record_json WHERE record_id = 'event_x1'",
      "DELETE FROM experience_events WHERE record_id = 'event_x1'",
      "UPDATE action_proposals SET proposal_digest = proposal_digest WHERE record_id = 'proposal_x1'",
      "DELETE FROM action_proposals WHERE record_id = 'proposal_x1'",
    ])
      expect(() => storage.sqlite.prepare(sql).run()).toThrow();
    expect(X.logicalState(storage)).toBe(before);
  });

  it('a corrupted projection fails the reader and leaves reconciliation unresolved', () => {
    const { storage } = fileWorld();
    const request = X.requestFor(1);
    recordActionProposal(storage, request);
    // Test-only corruption: the frozen trigger is lifted to simulate it.
    storage.sqlite.exec('DROP TRIGGER action_proposals_no_update');
    const row = storage.sqlite
      .prepare(
        "SELECT record_json FROM action_proposals WHERE record_id = 'proposal_x1'",
      )
      .get() as { record_json: string };
    const tampered = JSON.parse(row.record_json) as Json;
    tampered.action = 'summarize';
    storage.sqlite
      .prepare(
        "UPDATE action_proposals SET record_json = ? WHERE record_id = 'proposal_x1'",
      )
      .run(JSON.stringify(tampered));
    expectFailure(() => readProposalEvents(storage, A), 'invalid_history');
    expect(reconcileActionProposalRecording(storage, request)).toEqual({
      status: 'unresolved',
      code: 'invalid_history',
    });
  });

  it('a version-2 payload appended directly is reported, not trusted', () => {
    const { storage } = fileWorld();
    X.appendDirect(storage, X.requestFor(1), (e) => {
      ((e.payload as Json).metadata as Json).recordVersion = 2;
    });
    const record = readProposalEvents(storage, A).records[0]!;
    expect(record.proposalFormat.reasons).toEqual([
      'proposal_record_version_not_1',
    ]);
    // Same identifier and version with another payload is refused by the Ledger.
    expect(() =>
      X.appendDirect(storage, X.requestFor(1), (e) => {
        e.id = 'event_conflicting';
        ((e.payload as Json).metadata as Json).recordVersion = 2;
        (e.payload as Json).action = 'summarize';
      }),
    ).toThrow();
  });
});

describe('provenance boundaries', () => {
  it('provenance is per event, preserved verbatim and outside the digest', () => {
    const { storage } = fileWorld();
    const first = recordActionProposal(storage, X.requestFor(1));
    const origin = {
      ...L.systemGenerated(),
      component: 'synthetic-orchestrator-2',
    };
    X.appendDirect(storage, X.requestFor(1), (e) => {
      e.id = 'event_again';
      e.provenance = origin;
    });
    const [a, b] = readProposalEvents(storage, A).records;
    expect(a!.provenance).toEqual(L.inference());
    expect(b!.provenance).toEqual(origin);
    expect(a!.declaredDigest).toEqual(first.binding.proposalDigest);
    expect(b!.declaredDigest).toEqual(first.binding.proposalDigest);
    expect(a!.digest).toBe('agrees');
    expect(b!.digest).toBe('agrees');
  });
});

describe('pagination at scale', () => {
  it('pages hundreds of mixed events exactly as the Ledger does', () => {
    const { storage } = fileWorld();
    const tasks: [string, string][] = [
      [L.sessionId, L.taskId],
      [L.sessionId, L.otherTask],
      [L.secondSession, L.secondTask],
    ];
    for (let n = 1; n <= 150; n += 1) {
      const [sessionId, taskId] = tasks[n % 3]!;
      recordActionProposal(
        storage,
        X.requestFor(n, n % 5 === 0 ? B : A, {}, { sessionId, taskId }),
      );
      if (n % 4 === 0) X.ownerRequest(storage, A, `event_req${n}`);
    }
    const ledger = createLedger(storage, A as never);
    for (const filter of [
      {},
      { taskId: L.otherTask },
      { sessionId: L.secondSession },
      { sessionId: L.sessionId, taskId: L.taskId },
    ])
      for (const limit of [1, 7, 100, 1000]) {
        const expected: number[] = [];
        let cursor: { afterSequence: number; throughSequence: number } | null =
          null;
        do {
          const page = ledger.listEvents(<never>{
            ...(filter as Json),
            eventType: 'action_proposed',
            limit,
            ...(cursor ?? {}),
          });
          expected.push(...page.events.map((e) => e.sequence));
          const mine = readProposalEvents(storage, A, {
            ...filter,
            limit,
            ...(cursor ?? {}),
          });
          expect(mine.records.map((r) => r.sequence)).toEqual(
            page.events.map((e) => e.sequence),
          );
          expect(mine.nextCursor).toEqual(page.nextCursor);
          expect(mine.throughSequence).toBe(page.throughSequence);
          cursor = page.nextCursor;
        } while (cursor !== null);
        expect(new Set(expected).size).toBe(expected.length);
      }
    expect(X.allRecords(storage, A, 1000)).toHaveLength(120);
  });
});

describe('read-only behavior', () => {
  it('reconciliation and the reader never write, even across many calls', () => {
    const path = file();
    const storage = track(X.buildScenario(path));
    storage.sqlite.close();
    const reader = track(openStorage(path));
    reader.sqlite.pragma('query_only = ON');
    const before = X.logicalState(reader);
    const changes = X.totalChanges(reader);
    for (let i = 0; i < 5; i += 1) X.readPipeline(reader);
    expect(X.totalChanges(reader)).toBe(changes);
    expect(X.logicalState(reader)).toBe(before);
    // Recording on that connection is refused before any transaction
    // begins (SQLite refuses BEGIN IMMEDIATE), so nothing was written.
    expectFailure(
      () => recordActionProposal(reader, X.requestFor(70)),
      'storage_failure',
      'not_written',
    );
    expect(X.logicalState(reader)).toBe(before);
  });
});

describe('transaction-guard precedence under multiple faults (Patch 3 audit)', () => {
  it('an open transaction outranks every other recorder fault', () => {
    const { storage } = fileWorld();
    const faults: Json[] = [
      X.requestFor(1),
      X.requestFor(1, A, {}, { taskId: 'task_missing' }),
      L.request({
        ownerId: 'owner_missing',
        proposal: L.proposalFor({}, 'owner_missing'),
      }),
      X.requestFor(1, A, {}, { priorApprovalIds: ['approval_missing'] }),
      X.requestFor(1, A, { eventId: L.source.eventId }),
    ];
    storage.sqlite.exec('BEGIN');
    const before = X.logicalState(storage);
    for (const request of faults)
      expectFailure(
        () => recordActionProposal(storage, request),
        'storage_failure',
      );
    expect(storage.sqlite.inTransaction).toBe(true);
    expect(X.logicalState(storage)).toBe(before);
    storage.sqlite.exec('ROLLBACK');
    // Without the transaction, each fault reports its own code.
    expect(
      faults.slice(1).map((request) => {
        const error = caught(() => recordActionProposal(storage, request));
        return (error as ActionProposalError).code;
      }),
    ).toEqual([
      'unknown_binding',
      'unknown_binding',
      'unresolved_reference',
      'identifier_collision',
    ]);
  });

  it('an open transaction outranks a missing owner in reconciliation and reading', () => {
    const { storage } = fileWorld();
    const missingOwner = L.request({
      ownerId: 'owner_missing',
      proposal: L.proposalFor({}, 'owner_missing'),
    });
    storage.sqlite.exec('BEGIN');
    expect(reconcileActionProposalRecording(storage, missingOwner)).toEqual({
      status: 'unresolved',
      code: 'storage_failure',
    });
    expectFailure(
      () => readProposalEvents(storage, 'owner_missing'),
      'storage_failure',
    );
    storage.sqlite.exec('ROLLBACK');
    expect(reconcileActionProposalRecording(storage, missingOwner)).toEqual({
      status: 'unresolved',
      code: 'unknown_binding',
    });
    expectFailure(
      () => readProposalEvents(storage, 'owner_missing'),
      'unknown_binding',
    );
  });
});

describe('timestamps across the layers', () => {
  it('orders event and proposal exactly at record, reconcile and read time', () => {
    const { storage } = fileWorld();
    const proposal = X.proposal(1, A, {
      createdAt: '2026-01-14T09:00:00.0009Z',
    });
    const early = X.requestFor(1, A, {
      proposal,
      occurredAt: '2026-01-14T09:00:00.0001Z',
    });
    expectRejectedUnchanged(
      storage,
      () => recordActionProposal(storage, early),
      'timestamp_order',
    );
    expectFailure(
      () => reconcileActionProposalRecording(storage, early),
      'timestamp_order',
    );
    // Appended directly, the frozen Ledger accepts it; the reader flags it.
    X.appendDirect(
      storage,
      X.requestFor(1, A, { proposal, occurredAt: '2026-01-14T09:00:00.0009Z' }),
      (e) => {
        e.occurredAt = '2026-01-14T09:00:00.0001Z';
        (e.metadata as Json).createdAt = e.occurredAt;
      },
    );
    expect(
      readProposalEvents(storage, A).records[0]!.eventFormat.reasons,
    ).toEqual(['event_occurs_before_proposal_creation']);
    // Equal instants in different forms are conforming end to end.
    const equal = X.requestFor(2, A, {
      proposal: X.proposal(2, A, { createdAt: '2026-01-14T09:00:00.5Z' }),
      occurredAt: '2026-01-14T14:30:00.500+05:30',
    });
    recordActionProposal(storage, equal);
    expect(reconcileActionProposalRecording(storage, equal)).toMatchObject({
      status: 'recorded',
    });
    expect(readProposalEvents(storage, A).records[1]!.eventFormat.status).toBe(
      'conforming',
    );
  });
});
