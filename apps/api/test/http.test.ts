import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  conversation,
  count,
  httpHarness,
  OWNER_A,
  OWNER_B,
  setup,
  snapshot,
} from './fixtures.ts';

type Harness = Awaited<ReturnType<typeof httpHarness>>;
const open: Harness[] = [];
async function start() {
  const env = setup();
  const http = await httpHarness(env.service);
  open.push(http);
  return { ...env, http };
}
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

const sessions = (owner: string) => `/v1/owners/${owner}/sessions`;
const messages = (owner: string, s: string, t: string) =>
  `/v1/owners/${owner}/sessions/${s}/tasks/${t}/messages`;
const history = (owner: string, s: string, qs = '') =>
  `/v1/owners/${owner}/sessions/${s}/history${qs}`;

/** Raw request with full control over Host and body framing. */
function raw(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('HTTP happy path and response shapes', () => {
  it('creates, gets and lists sessions; creates tasks; records and reads messages', async () => {
    const { http } = await start();
    const created = await http.call('POST', sessions(OWNER_A), {});
    expect(created.status).toBe(201);
    const sessionId: string = created.body.session.sessionId;
    expect(created.body.session).toMatchObject({ ownerId: OWNER_A });

    const got = await http.call('GET', `${sessions(OWNER_A)}/${sessionId}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(created.body);

    const listed = await http.call('GET', sessions(OWNER_A));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      sessions: [created.body.session],
      nextCursor: null,
    });

    const task = await http.call(
      'POST',
      `${sessions(OWNER_A)}/${sessionId}/tasks`,
      {},
    );
    expect(task.status).toBe(201);
    const taskId: string = task.body.task.taskId;
    const tasks = await http.call(
      'GET',
      `${sessions(OWNER_A)}/${sessionId}/tasks`,
    );
    expect(tasks.body).toEqual({ tasks: [task.body.task], nextCursor: null });

    const msg = await http.call('POST', messages(OWNER_A, sessionId, taskId), {
      text: 'Synthetic hello',
    });
    expect(msg.status).toBe(201);
    expect(msg.body).toEqual({
      accepted: true,
      ownerId: OWNER_A,
      sessionId,
      taskId,
      eventId: expect.stringMatching(/^event_/),
      evidenceId: expect.stringMatching(/^evidence_/),
      eventType: 'owner_request',
      sequence: 1,
      occurredAt: expect.any(String),
      recordedAt: expect.any(String),
    });
    expect(Object.keys(msg.body).sort()).toEqual(
      [
        'accepted',
        'eventId',
        'eventType',
        'evidenceId',
        'occurredAt',
        'ownerId',
        'recordedAt',
        'sequence',
        'sessionId',
        'taskId',
      ].sort(),
    );
    const read = await http.call('GET', history(OWNER_A, sessionId));
    expect(read.status).toBe(200);
    expect(read.body.events).toHaveLength(1);
    expect(read.body.events[0]).toMatchObject({
      sequence: 1,
      event: {
        id: msg.body.eventId,
        eventType: 'owner_request',
        payload: { instruction: 'Synthetic hello' },
      },
    });
    expect(read.body.nextCursor).toBeNull();
    expect(read.headers.get('cache-control')).toBe('no-store');
  });

  it('health is static system metadata stating that no model runtime exists', async () => {
    const { http } = await start();
    const health = await http.call('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: 'ok',
      milestone: 'AVEN-005',
      modelRuntime: 'not_implemented',
    });
  });

  it('exposes no chat-completion or assistant-output route', async () => {
    const { http, storage } = await start();
    const before = snapshot(storage);
    for (const path of [
      '/chat',
      '/v1/chat',
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/messages',
      '/v1/owners/owner_synthetic_a/respond',
    ])
      for (const method of ['GET', 'POST']) {
        const r = await http.call(
          method,
          path,
          method === 'POST' ? { text: 'hi' } : undefined,
        );
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('route_not_found');
      }
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('HTTP owner isolation', () => {
  it('another owner gets the same 404 for a foreign session as for a missing one', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service, OWNER_A);
    service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'Synthetic private A',
    });
    const before = snapshot(storage);
    const foreign = await Promise.all([
      http.call('GET', `${sessions(OWNER_B)}/${sessionId}`),
      http.call('GET', history(OWNER_B, sessionId)),
      http.call('GET', `${sessions(OWNER_B)}/${sessionId}/tasks`),
      http.call('POST', `${sessions(OWNER_B)}/${sessionId}/tasks`, {}),
      http.call('POST', messages(OWNER_B, sessionId, taskId), {
        text: 'Intrusion',
      }),
    ]);
    const missing = await Promise.all([
      http.call('GET', `${sessions(OWNER_B)}/session_missing`),
      http.call('GET', history(OWNER_B, 'session_missing')),
      http.call('GET', `${sessions(OWNER_B)}/session_missing/tasks`),
      http.call('POST', `${sessions(OWNER_B)}/session_missing/tasks`, {}),
      http.call('POST', messages(OWNER_B, 'session_missing', taskId), {
        text: 'Intrusion',
      }),
    ]);
    for (const [i, r] of foreign.entries()) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(missing[i]?.text);
      expect(r.text).not.toContain('Synthetic private A');
      expect(r.text).not.toContain(OWNER_A);
    }
    expect(snapshot(storage)).toEqual(before);
  });

  it('session listing is owner bounded', async () => {
    const { http, service } = await start();
    service.createSession(OWNER_A);
    service.createSession(OWNER_A);
    const b = service.createSession(OWNER_B);
    const r = await http.call('GET', sessions(OWNER_B));
    expect(r.body.sessions).toEqual([b]);
  });

  it('pagination through HTTP never crosses owners even with a replayed cursor', async () => {
    const { http, service } = await start();
    const a = conversation(service, OWNER_A);
    for (let i = 0; i < 5; i += 1)
      service.submitOwnerMessage(OWNER_A, a.sessionId, a.taskId, {
        text: `A ${String(i)}`,
      });
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await http.call('GET', history(OWNER_A, a.sessionId, qs));
      expect(page.status).toBe(200);
      seen.push(
        ...page.body.events.map((e: { sequence: number }) => e.sequence),
      );
      cursor = page.body.nextCursor;
      if (cursor) {
        const replay = await http.call(
          'GET',
          history(OWNER_B, a.sessionId, `?limit=2&cursor=${cursor}`),
        );
        expect([400, 404]).toContain(replay.status);
        expect(replay.text).not.toContain('A ');
      }
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('HTTP request strictness', () => {
  it('rejects malformed JSON, non-object bodies and wrong types with invalid_request', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const body of [
      '{',
      '{"text":',
      'null',
      '[]',
      '"text"',
      '42',
      '{"text":"a","text":1}x',
    ])
      expect(
        (await http.call('POST', messages(OWNER_A, sessionId, taskId), body))
          .body.error.code,
      ).toBe('invalid_request');
    // An empty JSON-typed body is `{}` and lacks `text`.
    const empty = await http.call(
      'POST',
      messages(OWNER_A, sessionId, taskId),
      '',
    );
    expect(empty.status).toBe(400);
    expect(snapshot(storage)).toEqual(before);
  });

  it('rejects a body that is not valid UTF-8 and records nothing', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    const invalid = Buffer.concat([
      Buffer.from('{"text":"'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('"}'),
    ]);
    const r = await raw(http.port, {
      method: 'POST',
      path: messages(OWNER_A, sessionId, taskId),
      headers: {
        host: `127.0.0.1:${String(http.port)}`,
        'content-type': 'application/json',
      },
      body: invalid,
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({
      error: { code: 'invalid_request' },
    });
    expect(snapshot(storage)).toEqual(before);
  });

  it('rejects unknown and authority-like body fields on every write route', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    const attempts: [string, unknown][] = [
      [messages(OWNER_A, sessionId, taskId), { text: 'x', role: 'assistant' }],
      [
        messages(OWNER_A, sessionId, taskId),
        { text: 'x', provenance: { kind: 'explicit_owner_statement' } },
      ],
      [
        messages(OWNER_A, sessionId, taskId),
        { text: 'x', approved: true, permissions: ['*'] },
      ],
      [messages(OWNER_A, sessionId, taskId), { text: 'x', ownerId: OWNER_B }],
      [
        messages(OWNER_A, sessionId, taskId),
        { text: 'x', __proto__: { admin: true }, constructor: {} },
      ],
      [
        messages(OWNER_A, sessionId, taskId),
        '{"text":"x","__proto__":{"role":"assistant"}}',
      ],
      [
        messages(OWNER_A, sessionId, taskId),
        '{"text":"x","eventType":"assistant_response"}',
      ],
      [sessions(OWNER_A), { sessionId: 'session_chosen' }],
      [sessions(OWNER_A), { ownerId: OWNER_B }],
      [
        `${sessions(OWNER_A)}/${sessionId}/tasks`,
        { taskId: 'task_chosen', objective: 'x' },
      ],
    ];
    for (const [path, body] of attempts) {
      const r = await http.call(
        'POST',
        path,
        typeof body === 'string' ? body : JSON.stringify(body),
      );
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    expect(snapshot(storage)).toEqual(before);
  });

  it('requires application/json for bodies (no simple cross-site form posts)', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ])
      expect(
        (
          await http.call(
            'POST',
            messages(OWNER_A, sessionId, taskId),
            '{"text":"x"}',
            { 'content-type': type },
          )
        ).status,
      ).toBe(415);
    expect(snapshot(storage)).toEqual(before);
    const ok = await http.call(
      'POST',
      messages(OWNER_A, sessionId, taskId),
      '{"text":"x"}',
      {
        'content-type': 'Application/JSON; charset=utf-8',
      },
    );
    expect(ok.status).toBe(201);
  });

  it('rejects oversized bodies before parsing and records nothing', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    const big = JSON.stringify({ text: 'x'.repeat(300 * 1024) });
    const r = await http.call(
      'POST',
      messages(OWNER_A, sessionId, taskId),
      big,
    );
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('payload_too_large');
    // Chunked bodies without Content-Length are bounded too.
    const chunked = await raw(http.port, {
      method: 'POST',
      path: messages(OWNER_A, sessionId, taskId),
      headers: {
        host: `127.0.0.1:${String(http.port)}`,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
      body: big,
    });
    expect(chunked.status).toBe(413);
    expect(snapshot(storage)).toEqual(before);
  });

  it('rejects invalid path identifiers, unknown/repeated query parameters and bad limits', async () => {
    const { http, service, storage } = await start();
    const { sessionId } = conversation(service);
    const before = snapshot(storage);
    for (const path of [
      '/v1/owners/not_owner/sessions',
      '/v1/owners/owner_%ZZ/sessions',
      '/v1/owners/owner_a%2Fb/sessions',
      `/v1/owners/${OWNER_A}/sessions/task_wrong`,
      `/v1/owners/${OWNER_A}/sessions/session_%00x`,
    ]) {
      const r = await http.call('GET', path);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_identifier');
    }
    for (const qs of [
      '?limit=0',
      '?limit=201',
      '?limit=-1',
      '?limit=1.5',
      '?limit=abc',
      '?limit=1&limit=2',
      '?owner=owner_synthetic_b',
      '?ownerId=x',
    ])
      expect(
        (await http.call('GET', `${sessions(OWNER_A)}${qs}`)).body.error.code,
      ).toBe('invalid_request');
    for (const qs of [
      '?limit=201',
      '?sessionId=session_x',
      '?afterSequence=0',
      '?taskId=session_x',
    ])
      expect(
        (await http.call('GET', history(OWNER_A, sessionId, qs))).status,
      ).toBe(400);
    expect(
      (await http.call('GET', `${sessions(OWNER_A)}/${sessionId}?x=1`)).status,
    ).toBe(400);
    expect(snapshot(storage)).toEqual(before);
  });

  it('refuses non-canonical paths and prototype-named query keys instead of reinterpreting them', async () => {
    const { http, service, storage } = await start();
    const { sessionId } = conversation(service, OWNER_A);
    const before = snapshot(storage);
    for (const path of [
      `/v1/owners/${OWNER_B}/../${OWNER_A}/sessions`,
      `/v1/owners/${OWNER_B}/%2e%2e/${OWNER_A}/sessions`,
      `/v1/owners/${OWNER_A}/./sessions`,
      `/v1/owners/${OWNER_A}/sessions/${sessionId}/tasks/..`,
    ]) {
      const r = await raw(http.port, {
        method: 'GET',
        path,
        headers: { host: `127.0.0.1:${String(http.port)}` },
      });
      expect(r.status).toBe(400);
      expect(r.body).not.toContain(sessionId);
    }
    const absolute = await raw(http.port, {
      method: 'GET',
      path: `http://127.0.0.1:${String(http.port)}/v1/health`,
      headers: { host: `127.0.0.1:${String(http.port)}` },
    });
    expect(absolute.status).toBe(400);
    for (const qs of ['?__proto__=x', '?constructor=x', '?toString=x'])
      expect((await http.call('GET', `${sessions(OWNER_A)}${qs}`)).status).toBe(
        400,
      );
    expect(snapshot(storage)).toEqual(before);
  });

  it('write routes accept no query parameters at all', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const [path, body] of [
      [`${sessions(OWNER_A)}?sessionId=session_chosen`, {}],
      [`${sessions(OWNER_A)}/${sessionId}/tasks?taskId=task_chosen`, {}],
      [`${messages(OWNER_A, sessionId, taskId)}?role=assistant`, { text: 'x' }],
    ] as const) {
      const r = await http.call('POST', path, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_request');
    }
    expect(snapshot(storage)).toEqual(before);
    const ok = await http.call('POST', messages(OWNER_A, sessionId, taskId), {
      text: 'x',
    });
    expect(ok.status).toBe(201);
  });
});

describe('HTTP cannot rewrite or delete history', () => {
  it('PUT, PATCH and DELETE are not allowed on any resource and change nothing', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const receipt = service.submitOwnerMessage(OWNER_A, sessionId, taskId, {
      text: 'Original text',
    });
    const before = snapshot(storage);
    const paths = [
      sessions(OWNER_A),
      `${sessions(OWNER_A)}/${sessionId}`,
      `${sessions(OWNER_A)}/${sessionId}/tasks`,
      messages(OWNER_A, sessionId, taskId),
      history(OWNER_A, sessionId),
    ];
    for (const path of paths)
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const r = await http.call(method, path, {
          text: 'Rewritten',
          eventId: receipt.eventId,
        });
        expect(r.status).toBe(405);
        expect(r.body.error.code).toBe('method_not_allowed');
        expect(r.headers.get('allow')).toMatch(/^(GET|POST)(, (GET|POST))?$/);
      }
    for (const path of [
      `${messages(OWNER_A, sessionId, taskId)}/${receipt.eventId}`,
      `${history(OWNER_A, sessionId)}/${receipt.eventId}`,
    ])
      for (const method of ['PUT', 'DELETE'])
        expect(
          (await http.call(method, path, { text: 'Rewritten' })).status,
        ).toBe(404);
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('HTTP error hygiene and local-only posture', () => {
  it('maps storage failures to typed responses without leaking driver details', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    storage.close();
    const r = await http.call('POST', messages(OWNER_A, sessionId, taskId), {
      text: 'x',
    });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      error: {
        code: 'storage_failure',
        message: 'Local storage is unavailable; nothing was acknowledged',
      },
    });
    expect(r.text).not.toMatch(/sqlite|stack|TypeError|at \w+ \(/i);
    // The internal cause is available to the operator log only.
    expect(http.errors.at(-1)).toMatchObject({
      code: 'storage_failure',
      route: 'messages',
    });
    expect(http.errors.at(-1)?.cause).toBeInstanceOf(Error);
  });

  it('maps a mid-append storage fault to a typed 503 with nothing recorded', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    storage.sqlite.exec(
      "CREATE TEMP TRIGGER inject_fault BEFORE INSERT ON evidence BEGIN SELECT RAISE(ABORT, 'secret internal detail'); END",
    );
    const r = await http.call('POST', messages(OWNER_A, sessionId, taskId), {
      text: 'x',
    });
    expect(r.status).toBe(503);
    expect(r.text).not.toContain('secret internal detail');
    expect(snapshot(storage)).toEqual(before);
  });

  it('rejects non-loopback Host headers (DNS-rebinding guard) and records nothing', async () => {
    const { http, storage } = await start();
    const before = snapshot(storage);
    for (const host of [
      'evil.example',
      'evil.example:80',
      '127.0.0.1.evil.example',
      '10.0.0.5:8080',
    ]) {
      const r = await raw(http.port, {
        method: 'POST',
        path: sessions(OWNER_A),
        headers: { host, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({
        error: { code: 'host_not_allowed' },
      });
    }
    expect(snapshot(storage)).toEqual(before);
    for (const host of [
      'localhost',
      `localhost:${String(http.port)}`,
      `[::1]:${String(http.port)}`,
    ])
      expect(
        (
          await raw(http.port, {
            method: 'GET',
            path: '/v1/health',
            headers: { host },
          })
        ).status,
      ).toBe(200);
  });

  it('unknown owners are reported as owner_not_found without creating anything', async () => {
    const { http, storage } = await start();
    const before = snapshot(storage);
    const r = await http.call('POST', sessions('owner_undeclared'), {});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('owner_not_found');
    expect(snapshot(storage)).toEqual(before);
  });
});

describe('HTTP cross-site simple requests cannot write (review fix M1)', () => {
  // A browser sends these without a CORS preflight: no body, or a
  // CORS-safelisted content type (also what an HTML form can submit).
  const crossSite = {
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  };
  const simple: {
    label: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [
    { label: 'no content type, no body', headers: crossSite },
    {
      label: 'text/plain, empty',
      headers: { ...crossSite, 'content-type': 'text/plain' },
      body: '',
    },
    {
      label: 'text/plain, {}',
      headers: { ...crossSite, 'content-type': 'text/plain' },
      body: '{}',
    },
    {
      label: 'urlencoded form, empty',
      headers: {
        ...crossSite,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: '',
    },
    {
      label: 'multipart form, empty',
      headers: {
        ...crossSite,
        'content-type': 'multipart/form-data; boundary=x',
      },
      body: '',
    },
  ];

  it('cannot create sessions or tasks, and leaves storage unchanged', async () => {
    const { http, service, storage } = await start();
    const { sessionId } = conversation(service);
    const before = snapshot(storage);
    for (const path of [
      sessions(OWNER_A),
      `${sessions(OWNER_A)}/${sessionId}/tasks`,
    ])
      for (const attempt of simple) {
        const r = await raw(http.port, {
          method: 'POST',
          path,
          headers: {
            host: `127.0.0.1:${String(http.port)}`,
            ...attempt.headers,
          },
          ...(attempt.body === undefined ? {} : { body: attempt.body }),
        });
        expect(r.status, `${path} ${attempt.label}`).toBe(415);
        expect(JSON.parse(r.body)).toEqual({
          error: {
            code: 'unsupported_media_type',
            message: 'Request bodies must be application/json',
          },
        });
      }
    expect(snapshot(storage)).toEqual(before);
  });

  it('cannot submit owner messages either', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    for (const attempt of simple) {
      const r = await raw(http.port, {
        method: 'POST',
        path: messages(OWNER_A, sessionId, taskId),
        headers: { host: `127.0.0.1:${String(http.port)}`, ...attempt.headers },
        body: attempt.body ? '{"text":"forged"}' : '',
      });
      expect(r.status, attempt.label).toBe(415);
    }
    expect(snapshot(storage)).toEqual(before);
  });

  it('a CORS preflight is refused and grants no cross-origin access', async () => {
    const { http } = await start();
    const r = await http.call('OPTIONS', sessions(OWNER_A), undefined, {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    });
    expect(r.status).toBe(405);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('JSON-typed creation with {} or an empty body still succeeds, and messages still record', async () => {
    const { http, storage } = await start();
    const viaObject = await http.call('POST', sessions(OWNER_A), {});
    expect(viaObject.status).toBe(201);
    const viaEmpty = await raw(http.port, {
      method: 'POST',
      path: sessions(OWNER_A),
      headers: { host: 'localhost', 'content-type': 'application/json' },
    });
    expect(viaEmpty.status).toBe(201);
    const sessionId: string = viaObject.body.session.sessionId;
    const task = await http.call(
      'POST',
      `${sessions(OWNER_A)}/${sessionId}/tasks`,
      {},
    );
    expect(task.status).toBe(201);
    const msg = await http.call(
      'POST',
      messages(OWNER_A, sessionId, task.body.task.taskId as string),
      { text: 'Synthetic owner text' },
    );
    expect(msg.status).toBe(201);
    expect(msg.body.eventType).toBe('owner_request');
    expect(count(storage, 'experience_events')).toBe(1);
    expect(count(storage, 'evidence')).toBe(1);
  });
});

describe('HTTP aborted or truncated bodies record nothing (review fix L5)', () => {
  /** Sends `payload`, then resets (`destroy`) or half-closes (`end`) the socket. */
  function partial(
    port: number,
    payload: string,
    finish: 'destroy' | 'end',
  ): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => (received += d));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(received));
      socket.write(payload, () =>
        setTimeout(
          () => (finish === 'destroy' ? socket.destroy() : socket.end()),
          50,
        ),
      );
    });
  }
  async function settle(http: Harness, ms = 1000) {
    const until = Date.now() + ms;
    while (http.errors.length === 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
  }

  it('a fixed-length body cut off after a complete JSON prefix creates no event, evidence or acknowledgement', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    // The bytes sent so far are valid JSON; the declared length is not reached.
    const prefix = '{"text":"truncated synthetic message"}';
    const received = await partial(
      http.port,
      `POST ${messages(OWNER_A, sessionId, taskId)} HTTP/1.1\r\nHost: localhost\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${String(prefix.length + 20)}\r\n\r\n${prefix}`,
      'destroy',
    );
    await settle(http);
    expect(received).toBe('');
    expect(snapshot(storage)).toEqual(before);
    // Positive control: the same message, sent completely, is recorded.
    const ok = await http.call('POST', messages(OWNER_A, sessionId, taskId), {
      text: 'truncated synthetic message',
    });
    expect(ok.status).toBe(201);
    expect(count(storage, 'experience_events')).toBe(1);
  });

  it('a chunked body without its terminating chunk creates nothing and is not acknowledged', async () => {
    const { http, service, storage } = await start();
    const { sessionId, taskId } = conversation(service);
    const before = snapshot(storage);
    const chunk = '{"text":"unterminated synthetic chunk"}';
    const received = await partial(
      http.port,
      `POST ${messages(OWNER_A, sessionId, taskId)} HTTP/1.1\r\nHost: localhost\r\n` +
        `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n` +
        `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
      'end',
    );
    expect(received).not.toMatch(/^HTTP\/1\.1 201/);
    expect(received).not.toContain('"accepted"');
    expect(snapshot(storage)).toEqual(before);
  });
});
