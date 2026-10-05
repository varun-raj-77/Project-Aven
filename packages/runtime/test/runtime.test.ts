// Synthetic runtimes and text only. No network, credential or provider SDK.
import { describe, expect, it } from 'vitest';
import {
  invokeModelRuntime,
  isModelRuntimeErrorCode,
  MAX_MODEL_INPUT_MESSAGES,
  MODEL_RUNTIME_ERROR_CODES,
  ModelRuntimeError,
  ModelRuntimeRequestSchema,
  type ModelRuntime,
  type ModelRuntimeErrorCode,
  type ModelRuntimeOutput,
  type ModelRuntimeRequest,
} from '../src/index.ts';
import {
  createScriptedModelRuntime,
  SCRIPTED_RUNTIME_IDENTIFIER,
  type ScriptedStep,
} from '../src/scripted.ts';
import {
  MODEL_A,
  MODEL_B,
  REQUEST,
  RUNTIME_A,
  RUNTIME_B,
  tick,
} from './fixtures.ts';

const scripted = (...script: ScriptedStep[]) =>
  createScriptedModelRuntime({ runtime: RUNTIME_A, model: MODEL_A, script });

async function rejection(
  promise: Promise<unknown>,
): Promise<ModelRuntimeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelRuntimeError);
    return error as ModelRuntimeError;
  }
  throw new Error('Expected a ModelRuntimeError');
}
async function expectCode(
  promise: Promise<unknown>,
  code: ModelRuntimeErrorCode,
): Promise<ModelRuntimeError> {
  const error = await rejection(promise);
  expect(error.code).toBe(code);
  return error;
}

describe('provider-neutral runtime invocation', () => {
  it('returns the exact configured output as a normalized, frozen result', async () => {
    const runtime = scripted({ kind: 'respond', text: 'Synthetic answer.' });
    const result = await invokeModelRuntime(runtime, REQUEST);
    expect(result).toEqual({
      status: 'completed',
      text: 'Synthetic answer.',
      runtime: RUNTIME_A,
      model: MODEL_A,
    });
    // Optional metadata the runtime did not supply is absent, not fabricated.
    expect(Object.keys(result).sort()).toEqual(
      ['model', 'runtime', 'status', 'text'].sort(),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.model)).toBe(true);
    expect(Object.isFrozen(result.runtime)).toBe(true);
  });

  it('passes through provider-reported usage and finish status only when supplied', async () => {
    const runtime = scripted({
      kind: 'respond',
      text: 'Synthetic truncated answer',
      finishReason: 'output_limit',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const result = await invokeModelRuntime(runtime, REQUEST);
    expect(result.finishReason).toBe('output_limit');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.usage).not.toHaveProperty('elapsedMilliseconds');
  });

  it('hands the implementation a frozen copy carrying only model input', async () => {
    const runtime = scripted({ kind: 'respond', text: 'ok' });
    const request = structuredClone(REQUEST);
    await invokeModelRuntime(runtime, request);
    const received = runtime.requests[0]!;
    expect(received).toEqual(REQUEST);
    expect(received).not.toBe(request);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.messages[0])).toBe(true);
    expect(Object.keys(received)).toEqual(['messages']);
    for (const message of received.messages)
      expect(Object.keys(message).sort()).toEqual(['content', 'role']);
    request.messages[1]!.content = 'Mutated after the call';
    expect(received.messages[1]!.content).toBe('Synthetic question?');
  });

  it('accepts any implementation of the interface, not only the scripted runtime', async () => {
    let seen: ModelRuntimeRequest | undefined;
    class EchoRuntime implements ModelRuntime {
      async invoke(request: ModelRuntimeRequest): Promise<ModelRuntimeOutput> {
        seen = request;
        // A provider adapter would translate here; the shape stays inside it.
        const providerShape = {
          input: request.messages.map((m) => `${m.role}:${m.content}`),
        };
        return {
          text: `echo ${String(providerShape.input.length)}`,
          runtime: RUNTIME_B,
          model: MODEL_B,
        };
      }
    }
    const result = await invokeModelRuntime(new EchoRuntime(), REQUEST);
    expect(result).toEqual({
      status: 'completed',
      text: 'echo 2',
      runtime: RUNTIME_B,
      model: MODEL_B,
    });
    expect(seen).toEqual(REQUEST);
  });

  it('rejects malformed or authority-bearing requests before invoking anything', async () => {
    const message = { role: 'user', content: 'x' };
    const bad: unknown[] = [
      undefined,
      null,
      'text',
      {},
      { messages: [] },
      { messages: [{ role: 'owner', content: 'x' }] },
      { messages: [{ role: 'tool', content: 'x' }] },
      { messages: [{ role: 'user', content: '   ' }] },
      { messages: [{ role: 'user', content: 'x', name: 'n' }] },
      {
        messages: Array.from(
          { length: MAX_MODEL_INPUT_MESSAGES + 1 },
          () => message,
        ),
      },
      // Fields that would carry identity, authority, state or provider shape.
      ...[
        'ownerId',
        'sessionId',
        'taskId',
        'permissions',
        'approval',
        'root',
        'policy',
        'tools',
        'learnedState',
        'temperature',
        'model',
        'provider',
        'apiKey',
      ].map((key) => ({ messages: [message], [key]: 'x' })),
    ];
    for (const request of bad) {
      const runtime = scripted({ kind: 'respond', text: 'never' });
      await expectCode(invokeModelRuntime(runtime, request), 'invalid_request');
      expect(runtime.requests).toHaveLength(0);
    }
    expect(Object.keys(ModelRuntimeRequestSchema.shape)).toEqual(['messages']);
  });

  it('rejects invalid invocation options before invoking anything', async () => {
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { timeoutMs: 2 ** 31 },
      { signal: {} },
      { retries: 3 },
    ]) {
      const runtime = scripted({ kind: 'respond', text: 'never' });
      await expectCode(
        invokeModelRuntime(runtime, REQUEST, options as never),
        'invalid_request',
      );
      expect(runtime.requests).toHaveLength(0);
    }
  });

  it('reports a missing implementation as unavailable', async () => {
    for (const runtime of [undefined, null, {}, { invoke: 'x' }])
      await expectCode(
        invokeModelRuntime(runtime as never, REQUEST),
        'runtime_unavailable',
      );
  });
});

describe('normalized runtime errors', () => {
  it('preserves every normalized code with a fixed public message', async () => {
    expect([...MODEL_RUNTIME_ERROR_CODES].sort()).toEqual(
      [
        'invalid_request',
        'malformed_runtime_result',
        'runtime_aborted',
        'runtime_failure',
        'runtime_timeout',
        'runtime_unavailable',
      ].sort(),
    );
    for (const code of MODEL_RUNTIME_ERROR_CODES) {
      const error = await expectCode(
        invokeModelRuntime(scripted({ kind: 'fail', code }), REQUEST),
        code,
      );
      expect(error.message).toBe(new ModelRuntimeError(code).message);
      expect(isModelRuntimeErrorCode(code)).toBe(true);
    }
    expect(isModelRuntimeErrorCode('recording_failure')).toBe(false);
  });

  it('maps foreign failures to runtime_failure without leaking provider detail', async () => {
    const secret = 'sk-synthetic-not-a-real-key';
    for (const thrown of [
      new Error(`401 Unauthorized; Authorization: Bearer ${secret}`),
      `raw provider body ${secret}`,
      { status: 500, headers: { 'x-api-key': secret } },
      undefined,
    ]) {
      const error = await expectCode(
        invokeModelRuntime(scripted({ kind: 'throw', error: thrown }), REQUEST),
        'runtime_failure',
      );
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
      expect(error.cause).toBe(thrown); // Internal only.
    }
  });

  it('rejects malformed or provider-shaped output', async () => {
    const valid = { text: 'ok', runtime: RUNTIME_A, model: MODEL_A };
    const malformed: unknown[] = [
      undefined,
      null,
      'ok',
      {},
      { ...valid, text: '' },
      { ...valid, text: ' \n ' },
      { ...valid, text: 42 },
      { text: 'ok', model: MODEL_A },
      { text: 'ok', runtime: RUNTIME_A },
      { ...valid, model: { ...MODEL_A, modelVersion: undefined } },
      { ...valid, model: { ...MODEL_A, extra: 'x' } },
      { ...valid, runtime: { identifier: 'r' } },
      { ...valid, status: 'completed' },
      { ...valid, finishReason: 'stop_sequence' },
      { ...valid, usage: {} },
      { ...valid, usage: { inputTokens: -1 } },
      { ...valid, usage: { outputTokens: 1.5 } },
      { ...valid, usage: { costUsd: 1 } },
      // Provider internals, hidden reasoning and tool calls never pass through.
      { ...valid, reasoning: 'hidden chain of thought' },
      { ...valid, thinking: 'hidden' },
      { ...valid, raw: { id: 'resp_1' } },
      { ...valid, headers: { authorization: 'x' } },
      { ...valid, toolCalls: [{ name: 'send_email' }] },
      { ...valid, apiKey: 'x' },
      { ...valid, permission: 'granted' },
    ];
    for (const value of malformed)
      await expectCode(
        invokeModelRuntime(scripted({ kind: 'malformed', value }), REQUEST),
        'malformed_runtime_result',
      );
  });

  it('rejects secret-like or non-identifier runtime/model identity', async () => {
    const bad = [
      { modelId: 'Bearer abc' },
      { configurationId: 'sk-live-123' },
      { configurationId: 'cfg/sk-123' },
      { providerId: 'api_key=abc' },
      { providerId: 'provider-secret' },
      { modelVersion: 'password1' },
      { modelId: 'authorization' },
      { modelId: 'credential-x' },
      { modelId: 'has space' },
      { modelId: 'line\nbreak' },
      { modelId: '-leading-dash' },
      { modelId: 'x'.repeat(129) },
    ];
    for (const patch of bad)
      await expectCode(
        invokeModelRuntime(
          scripted({
            kind: 'malformed',
            value: {
              text: 'ok',
              runtime: RUNTIME_A,
              model: { ...MODEL_A, ...patch },
            },
          }),
          REQUEST,
        ),
        'malformed_runtime_result',
      );
    await expectCode(
      invokeModelRuntime(
        scripted({
          kind: 'malformed',
          value: {
            text: 'ok',
            runtime: { identifier: 'runtime token=sk-abc', version: '1' },
            model: MODEL_A,
          },
        }),
        REQUEST,
      ),
      'malformed_runtime_result',
    );
    // Ordinary identifiers, including slashes, colons and "task" substrings, pass.
    const ok = await invokeModelRuntime(
      createScriptedModelRuntime({
        runtime: { identifier: 'local-runtime', version: '0.1.0+build.7' },
        model: {
          providerId: 'synthetic.provider',
          modelId: 'org/multitask-model:8b',
          modelVersion: '2026-09-30@rev2',
          configurationId: 'deterministic-v1',
        },
        script: [{ kind: 'respond', text: 'ok' }],
      }),
      REQUEST,
    );
    expect(ok.model.modelId).toBe('org/multitask-model:8b');
  });
});

describe('cancellation and timeout', () => {
  it('does not invoke when already aborted', async () => {
    const runtime = scripted({ kind: 'respond', text: 'never' });
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      invokeModelRuntime(runtime, REQUEST, { signal: controller.signal }),
      'runtime_aborted',
    );
    expect(runtime.requests).toHaveLength(0);
  });

  it('aborts a pending invocation and signals the implementation', async () => {
    let implementationSignal: AbortSignal | undefined;
    const runtime: ModelRuntime = {
      invoke: (request, invocation) => {
        implementationSignal = invocation.signal;
        return scripted({ kind: 'pending' }).invoke(request, invocation);
      },
    };
    const controller = new AbortController();
    const pending = invokeModelRuntime(runtime, REQUEST, {
      signal: controller.signal,
    });
    await tick();
    expect(implementationSignal?.aborted).toBe(false);
    controller.abort();
    await expectCode(pending, 'runtime_aborted');
    expect(implementationSignal?.aborted).toBe(true);
  });

  it('times out a pending invocation', async () => {
    let implementationSignal: AbortSignal | undefined;
    const runtime: ModelRuntime = {
      invoke: (request, invocation) => {
        implementationSignal = invocation.signal;
        return scripted({ kind: 'pending' }).invoke(request, invocation);
      },
    };
    await expectCode(
      invokeModelRuntime(runtime, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
    expect(implementationSignal?.aborted).toBe(true);
  });

  it('discards a late result or rejection from an implementation that ignores cancellation', async () => {
    for (const late of ['resolve', 'reject'] as const) {
      let settled = false;
      const runtime: ModelRuntime = {
        invoke: () =>
          new Promise((resolve, reject) =>
            setTimeout(() => {
              settled = true;
              if (late === 'resolve')
                resolve({ text: 'late', runtime: RUNTIME_A, model: MODEL_A });
              else reject(new Error('late failure'));
            }, 20),
          ),
      };
      const controller = new AbortController();
      const pending = invokeModelRuntime(runtime, REQUEST, {
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      setTimeout(() => controller.abort(), 2);
      await expectCode(pending, 'runtime_aborted');
      // Cancellation returns promptly, without waiting for the runtime.
      expect(settled).toBe(false);
      await tick(30);
      expect(settled).toBe(true); // The late outcome happened and was ignored.
    }
  });

  it('times out promptly even when the implementation ignores its signal', async () => {
    let settled = false;
    const runtime: ModelRuntime = {
      invoke: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve({ text: 'late', runtime: RUNTIME_A, model: MODEL_A });
          }, 50),
        ),
    };
    await expectCode(
      invokeModelRuntime(runtime, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
    expect(settled).toBe(false);
    await tick(60);
    expect(settled).toBe(true);
  });

  it('completes normally when neither abort nor timeout fires', async () => {
    const controller = new AbortController();
    const result = await invokeModelRuntime(
      scripted({ kind: 'respond', text: 'in time' }),
      REQUEST,
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    expect(result.text).toBe('in time');
    controller.abort(); // After acceptance: no effect on the returned result.
    expect(result.status).toBe('completed');
  });
});

describe('deterministic scripted test runtime', () => {
  it('replays identical outputs for identical scripts', async () => {
    const steps: ScriptedStep[] = [
      { kind: 'respond', text: 'first' },
      { kind: 'respond', text: 'second', usage: { outputTokens: 1 } },
    ];
    const outputs = async () => {
      const runtime = scripted(...steps);
      return [
        await invokeModelRuntime(runtime, REQUEST),
        await invokeModelRuntime(runtime, REQUEST),
      ];
    };
    expect(await outputs()).toEqual(await outputs());
  });

  it('fails deterministically when the script is exhausted', async () => {
    const runtime = scripted({ kind: 'respond', text: 'only' });
    await invokeModelRuntime(runtime, REQUEST);
    await expectCode(invokeModelRuntime(runtime, REQUEST), 'runtime_failure');
    expect(runtime.requests).toHaveLength(2);
  });

  it('supports per-call scripts and reports a default test-only identity', async () => {
    const runtime = createScriptedModelRuntime({
      model: MODEL_B,
      script: (request, call) => ({
        kind: 'respond',
        text: `call ${String(call)}: ${request.messages.at(-1)!.content}`,
      }),
    });
    const first = await invokeModelRuntime(runtime, REQUEST);
    const second = await invokeModelRuntime(runtime, REQUEST);
    expect([first.text, second.text]).toEqual([
      'call 0: Synthetic question?',
      'call 1: Synthetic question?',
    ]);
    expect(first.runtime.identifier).toBe(SCRIPTED_RUNTIME_IDENTIFIER);
    expect(first.model).toEqual(MODEL_B);
  });
});

/** Busy-waits, blocking the event loop like long synchronous runtime work. */
function block(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Deliberately synchronous.
  }
}

describe('external review M1: monotonic timeout deadline', () => {
  it('rejects a valid result produced by synchronous work that outlasts the deadline', async () => {
    let implementationSignal: AbortSignal | undefined;
    const runtime: ModelRuntime = {
      // The reproduced review case: ~40 ms of blocking work, timeoutMs 5.
      invoke: async (_request, invocation) => {
        implementationSignal = invocation.signal;
        block(40);
        return { text: 'too late', runtime: RUNTIME_A, model: MODEL_A };
      },
    };
    const error = await expectCode(
      invokeModelRuntime(runtime, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
    expect(error.message).toBe(
      new ModelRuntimeError('runtime_timeout').message,
    );
    expect(implementationSignal?.aborted).toBe(true);
  });

  it('also times out a non-async implementation that blocks before returning or throwing', async () => {
    const resolving: ModelRuntime = {
      invoke: () => {
        block(30);
        return Promise.resolve({
          text: 'too late',
          runtime: RUNTIME_A,
          model: MODEL_A,
        });
      },
    };
    await expectCode(
      invokeModelRuntime(resolving, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
    // Late output is a timeout even if it is also malformed.
    const lateMalformed: ModelRuntime = {
      invoke: () => {
        block(30);
        return Promise.resolve({ text: '' } as never);
      },
    };
    await expectCode(
      invokeModelRuntime(lateMalformed, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
    const throwing: ModelRuntime = {
      invoke: () => {
        block(30);
        throw new ModelRuntimeError('runtime_unavailable');
      },
    };
    await expectCode(
      invokeModelRuntime(throwing, REQUEST, { timeoutMs: 5 }),
      'runtime_timeout',
    );
  });

  it('still accepts synchronous work that finishes within the deadline', async () => {
    const runtime: ModelRuntime = {
      invoke: async () => {
        block(5);
        return { text: 'in time', runtime: RUNTIME_A, model: MODEL_A };
      },
    };
    const result = await invokeModelRuntime(runtime, REQUEST, {
      timeoutMs: 10_000,
    });
    expect(result.text).toBe('in time');
  });
});

describe('external review M2: runtime validation of error codes', () => {
  const SECRET = 'sk-synthetic-not-a-real-key';
  function assertSanitized(error: ModelRuntimeError) {
    expect(error.code).toBe('runtime_failure');
    expect(error.message).toBe(
      new ModelRuntimeError('runtime_failure').message,
    );
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(JSON.stringify(Object.values(error))).not.toContain(SECRET);
    expect(String(error)).not.toContain(SECRET);
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  }

  it('sanitizes an invalid code passed to the constructor at runtime', async () => {
    const constructed = new ModelRuntimeError(SECRET as never);
    assertSanitized(constructed);
    const runtime = createScriptedModelRuntime({
      model: MODEL_A,
      script: [
        { kind: 'throw', error: new ModelRuntimeError(SECRET as never) },
      ],
    });
    assertSanitized(await rejection(invokeModelRuntime(runtime, REQUEST)));
  });

  it('sanitizes a valid error whose code was mutated before it was thrown', async () => {
    const mutated = new ModelRuntimeError('runtime_unavailable');
    (mutated as { code: string }).code = SECRET;
    const forged = Object.assign(Object.create(ModelRuntimeError.prototype), {
      code: SECRET,
      message: SECRET,
    }) as ModelRuntimeError;
    for (const thrown of [mutated, forged]) {
      expect(thrown).toBeInstanceOf(ModelRuntimeError);
      const runtime = createScriptedModelRuntime({
        model: MODEL_A,
        script: [{ kind: 'throw', error: thrown }],
      });
      const error = await rejection(invokeModelRuntime(runtime, REQUEST));
      assertSanitized(error);
      expect(error.cause).toBe(thrown); // Internal only (non-enumerable).
    }
  });
});
