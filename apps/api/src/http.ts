import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  ApiError,
  publicBody,
  toApiError,
  type ApiErrorCode,
} from './errors.ts';
import {
  EmptyBodySchema,
  HistoryQuerySchema,
  MAX_BODY_BYTES,
  SessionListQuerySchema,
  TaskListQuerySchema,
} from './schemas.ts';
import { API_VERSION, type ApiService } from './service.ts';

export interface ErrorLogEntry {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly method: string;
  readonly route: string;
  readonly cause: unknown;
}
export interface HandlerOptions {
  /** Receives internal causes. They are never written to a response. */
  readonly onError?: (entry: ErrorLogEntry) => void;
}

type Params = Record<string, string>;
interface Context {
  readonly params: Params;
  readonly query: URLSearchParams;
  readonly body: () => Promise<unknown>;
}
type Handler = (ctx: Context) => Promise<{ status: number; body: unknown }>;
interface Route {
  readonly name: string;
  readonly pattern: readonly string[];
  readonly methods: Partial<Record<'GET' | 'POST', Handler>>;
}

/**
 * Routes are an explicit, closed list. There are no PUT/PATCH/DELETE handlers
 * anywhere: history cannot be rewritten or deleted through this API, and no
 * route produces assistant output.
 */
function routes(service: ApiService): readonly Route[] {
  return [
    {
      name: 'health',
      pattern: ['v1', 'health'],
      methods: {
        GET: async () => ({
          status: 200,
          body: {
            status: 'ok',
            service: '@aven/api',
            version: API_VERSION,
            milestone: 'AVEN-005',
            // Static system metadata, not an assistant reply.
            modelRuntime: 'not_implemented',
            ownerIdentity: 'declared_unauthenticated',
          },
        }),
      },
    },
    {
      name: 'sessions',
      pattern: ['v1', 'owners', ':ownerId', 'sessions'],
      methods: {
        POST: async ({ params, query, body }) => {
          noQuery(query);
          strict(EmptyBodySchema, await body());
          return {
            status: 201,
            body: { session: service.createSession(params['ownerId']) },
          };
        },
        GET: async ({ params, query }) => {
          const q = strict(SessionListQuerySchema, queryObject(query));
          const page = service.listSessions(params['ownerId'], q);
          return {
            status: 200,
            body: { sessions: page.items, nextCursor: page.nextCursor },
          };
        },
      },
    },
    {
      name: 'session',
      pattern: ['v1', 'owners', ':ownerId', 'sessions', ':sessionId'],
      methods: {
        GET: async ({ params, query }) => {
          noQuery(query);
          return {
            status: 200,
            body: {
              session: service.getSession(
                params['ownerId'],
                params['sessionId'],
              ),
            },
          };
        },
      },
    },
    {
      name: 'tasks',
      pattern: ['v1', 'owners', ':ownerId', 'sessions', ':sessionId', 'tasks'],
      methods: {
        POST: async ({ params, query, body }) => {
          noQuery(query);
          strict(EmptyBodySchema, await body());
          return {
            status: 201,
            body: {
              task: service.createTask(params['ownerId'], params['sessionId']),
            },
          };
        },
        GET: async ({ params, query }) => {
          const q = strict(TaskListQuerySchema, queryObject(query));
          const page = service.listTasks(
            params['ownerId'],
            params['sessionId'],
            q,
          );
          return {
            status: 200,
            body: { tasks: page.items, nextCursor: page.nextCursor },
          };
        },
      },
    },
    {
      name: 'messages',
      pattern: [
        'v1',
        'owners',
        ':ownerId',
        'sessions',
        ':sessionId',
        'tasks',
        ':taskId',
        'messages',
      ],
      methods: {
        POST: async ({ params, query, body }) => {
          noQuery(query);
          const receipt = service.submitOwnerMessage(
            params['ownerId'],
            params['sessionId'],
            params['taskId'],
            await body(),
          );
          return { status: 201, body: receipt };
        },
      },
    },
    {
      name: 'history',
      pattern: [
        'v1',
        'owners',
        ':ownerId',
        'sessions',
        ':sessionId',
        'history',
      ],
      methods: {
        GET: async ({ params, query }) => {
          const q = strict(HistoryQuerySchema, queryObject(query));
          return {
            status: 200,
            body: service.readHistory(
              params['ownerId'],
              params['sessionId'],
              q,
            ),
          };
        },
      },
    },
  ];
}

/** Routes without query parameters reject any, so none can gain meaning. */
function noQuery(query: URLSearchParams): void {
  strict(z.strictObject({}), queryObject(query));
}

function strict<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError('invalid_request', result.error);
  return result.data;
}

/** Repeated query keys are ambiguous and rejected rather than resolved silently. */
function queryObject(query: URLSearchParams): Record<string, string> {
  // Null prototype: a `__proto__` key becomes an own property the strict schema rejects.
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of query) {
    if (Object.hasOwn(result, key))
      throw new ApiError(
        'invalid_request',
        new Error(`Repeated query parameter ${key}`),
      );
    result[key] = value;
  }
  return result;
}

function match(
  pattern: readonly string[],
  segments: readonly string[],
): Params | undefined {
  if (pattern.length !== segments.length) return undefined;
  const params: Params = {};
  for (const [i, part] of pattern.entries()) {
    const segment = segments[i] ?? '';
    if (part.startsWith(':')) params[part.slice(1)] = segment;
    else if (part !== segment) return undefined;
  }
  return params;
}

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * Every POST must declare `application/json`, even when its body is empty or
 * `{}`. That content type is not CORS-safelisted, so a web page cannot send any
 * write (session, task or message creation) as a "simple" request or an HTML
 * form: the browser must preflight first, and the preflight (`OPTIONS`) is
 * refused. This is checked before the body is read and before any handler runs.
 * It is a browser cross-site guard, not authentication.
 */
function requireJsonContentType(req: IncomingMessage): void {
  const type = (req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type !== 'application/json') throw new ApiError('unsupported_media_type');
}

/** Reads a POST body. The JSON content type has already been required. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES)
    throw new ApiError('payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('payload_too_large');
    chunks.push(buffer);
  }
  // A zero-length body means `{}`. It is only reachable after the POST
  // content-type check, so it is never a cross-site simple request.
  if (size === 0) return {};
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch (cause) {
    throw new ApiError('invalid_request', cause);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ApiError('invalid_request', cause);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * Builds a Node `http` request listener. Each request is handled to completion
 * synchronously against storage once its body has been read; no background work
 * outlives a request.
 */
export function createRequestHandler(
  service: ApiService,
  options: HandlerOptions = {},
) {
  const table = routes(service);
  const log = options.onError ?? (() => undefined);

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    let routeName = 'unmatched';
    try {
      if (!LOOPBACK_HOST.test(req.headers.host ?? ''))
        throw new ApiError('host_not_allowed');
      const target = req.url ?? '/';
      const url = new URL(target, 'http://localhost');
      // WHATWG URL parsing collapses dot segments (including %2e) and accepts
      // absolute-form targets; a path that is not already canonical is refused
      // rather than reinterpreted as another route.
      if (!target.startsWith('/') || url.pathname !== target.split('?')[0])
        throw new ApiError('invalid_request');
      let segments: string[];
      try {
        segments = url.pathname
          .split('/')
          .slice(1)
          .map((s) => decodeURIComponent(s));
      } catch (cause) {
        throw new ApiError('invalid_identifier', cause);
      }
      for (const route of table) {
        const params = match(route.pattern, segments);
        if (!params) continue;
        routeName = route.name;
        const handler =
          method === 'GET' || method === 'POST'
            ? route.methods[method]
            : undefined;
        if (!handler) {
          const allow = Object.keys(route.methods).join(', ');
          throw Object.assign(new ApiError('method_not_allowed'), { allow });
        }
        if (method === 'POST') requireJsonContentType(req);
        let body: Promise<unknown> | undefined;
        const result = await handler({
          params,
          query: url.searchParams,
          body: () => (body ??= readJson(req)),
        });
        send(res, result.status, result.body);
        return;
      }
      throw new ApiError('route_not_found');
    } catch (thrown) {
      const error = toApiError(thrown);
      if (error.status >= 500 || error.code === 'internal_error')
        log({
          code: error.code,
          status: error.status,
          method,
          route: routeName,
          cause: error.cause,
        });
      const allow = (thrown as { allow?: unknown }).allow;
      const headers: Record<string, string> =
        typeof allow === 'string' ? { allow } : {};
      // Unread request bodies would otherwise keep the socket busy.
      if (!req.complete) headers['connection'] = 'close';
      if (!res.headersSent) send(res, error.status, publicBody(error), headers);
      else res.destroy();
    }
  };
}
