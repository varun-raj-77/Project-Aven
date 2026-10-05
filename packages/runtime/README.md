# @aven/runtime

AVEN-006 Aven-owned, provider-neutral model runtime boundary. The foundation
model is replaceable; Aven's owner relationship lives above it. This package
lets callers invoke **some** model runtime through one stable interface. It
ships **no real provider adapter**, makes no network call, needs no credential,
and owns no storage, Ledger, owner state, Root, permission or tool.

```text
caller ──ModelRuntimeRequest──> invokeModelRuntime ──> ModelRuntime.invoke (replaceable)
       <──ModelRuntimeResult───  (validate, cancel, normalize)  <── ModelRuntimeOutput
```

The runtime generates; it does not record. Recording successful output in the
Experience Ledger is a separate step owned by `apps/api`
(`createAssistantResponseService`).

## Interface

```ts
interface ModelRuntime {
  invoke(
    request: ModelRuntimeRequest,
    invocation: { signal: AbortSignal },
  ): Promise<ModelRuntimeOutput>;
}
```

- **`ModelRuntimeRequest`** =
  `{ messages: { role: 'system' | 'user' | 'assistant'; content: string }[] }`
  (1-1000 messages, non-blank content). Strict: owner/session/task IDs,
  permissions, approvals, Root, tools, learned state, provider names and
  sampling parameters are rejected. `role` is position in the model
  conversation, not provenance: a `user` message is not owner evidence.
  Generation parameters belong to the runtime's configuration, so the reported
  `configurationId` stays truthful. Input is already assembled by the caller;
  there is no retrieval, ranking or personalization here (AVEN-007/008/009).
- **`ModelRuntimeOutput`** (what an implementation returns) =
  `{ text, runtime, model, finishReason?, usage? }`, strict. `runtime` is the
  frozen AVEN-002 `RuntimeStamp` `{ identifier, version }`; `model` is the
  frozen `ModelConfiguration`
  `{ providerId, modelId, modelVersion, configurationId }`; `usage` is the
  frozen `Usage`. Identity values must be short identifiers
  (`[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}`) and must not look like credentials (a
  tripwire, not a secret scanner). They are the implementation's **declared**
  configuration; Aven records them as reported claims. `finishReason`
  (`complete` | `output_limit` | `content_filter` | `other`) and `usage` must be
  omitted when the provider does not supply them; nothing is fabricated. Raw
  provider responses, headers, tool calls and reasoning traces are rejected.
- **`ModelRuntimeResult`** = frozen `{ status: 'completed', ...output }`.

`invokeModelRuntime(runtime, request, { signal?, timeoutMs? })` is the single
normalizing entry point:

1. validates options and the request before invoking (`invalid_request`); the
   implementation receives a deep-frozen copy;
2. passes an `AbortSignal` that fires on caller abort or timeout and returns
   promptly (`runtime_aborted` / `runtime_timeout`) even if the implementation
   ignores it; a late result or rejection is discarded. `timeoutMs` is also a
   monotonic deadline checked before any outcome is accepted: synchronous work
   inside an implementation **cannot be preempted in-process**, but a result or
   rejection produced after the deadline is `runtime_timeout`, never a completed
   result;
3. maps anything thrown to `ModelRuntimeError` with a fixed message per code;
   foreign errors, and `ModelRuntimeError`s whose `code` is not one of the six
   allowed values at runtime, become `runtime_failure` (the original is kept
   only in the non-enumerable `cause`, which must never be serialized to a
   public boundary or the Ledger);
4. validates the output strictly (`malformed_runtime_result`).

No retry, failover, routing, streaming, tool calling or exactly-once guarantee.

## Errors

`invalid_request`, `runtime_unavailable`, `runtime_timeout`, `runtime_aborted`,
`runtime_failure`, `malformed_runtime_result`. Implementations report provider
conditions by throwing `ModelRuntimeError` with one of these codes.

## Deterministic test runtime

`@aven/runtime/testing` exports
`createScriptedModelRuntime({ model, runtime?, script })` for unit, integration
and future eval-harness tests. It is **not** exported from the production entry
point and generates nothing: each step returns exactly the configured text
(`respond`), rejects with a normalized code (`fail`), throws a raw value
(`throw`), returns an arbitrary malformed value (`malformed`), or never settles
until aborted (`pending`). It records the frozen requests it received. No clock,
randomness, network or credential.

## Future provider adapters

A live adapter (for example for AVEN-007's naive baseline) implements
`ModelRuntime`, keeps the provider's request/response shapes inside itself, and
reports a truthful `ModelConfiguration`. It must receive credentials from
external configuration owned by the operator/Root, never from the Ledger, owner
memory, model input or runtime metadata, and must not persist them. Model
routing by complexity, privacy, latency, cost, context size, reasoning or tool
capability is deliberately not implemented; runtime selection is explicit
injection.
