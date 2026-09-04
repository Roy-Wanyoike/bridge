/**
 * `@bridge/registry-service` — dependency-free HTTP layer over a
 * {@link RegistryStore}.
 *
 * JSON over HTTP. Every response is JSON; every error response uses the
 * envelope `{"error": {"code": ..., "message": ...}}`. `RegistryError`
 * codes map to HTTP status (`not-found` 404, `hash-conflict`/`immutable`
 * 409, `invalid-name`/`invalid-version` 400, `corrupt`/`io` 500).
 *
 * No top-level side effects: `createServer` returns a plain `http.Server`
 * (bind it yourself, e.g. `listen(0)` in tests); `start` is the convenience
 * wrapper that binds and prints the bound port.
 */

import { createServer as nodeCreateServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { normalizeVersion, RegistryError, splitPackageVersion } from '@bridge/registry';
import type { IRPackage, PublishMeta, RegistryStore } from '@bridge/registry';
import { FileAuditSink, MemoryAuditSink } from './audit';
import { assertTokenTable, authenticate, requireRole, Roles } from './auth';
import { ServiceError, statusForRegistryError } from './errors';
import type { AuditEntry, AuditSink, RegistryServiceOptions, RegistryTokenInfo, TokenTable } from './types';

/** Hard cap on request body size (8 MiB — generous for IR documents). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Default number of audit entries returned by GET /api/v1/audit. */
const DEFAULT_AUDIT_TAIL = 100;
/** Upper bound for the `limit` query parameter. */
const MAX_AUDIT_TAIL = 10_000;

/** Per-request bookkeeping used to decide what gets audited. */
interface RequestContext {
  /** Attempted operation; `null` for /health and unknown routes. */
  action: 'publish' | 'read' | 'audit' | null;
  /** Route package name when the route has one. */
  contract: string | null;
  /** Resolved version when known. */
  version: string | null;
  /** Authenticated credentials once auth succeeded. */
  auth: RegistryTokenInfo | null;
}

interface Deps {
  store: RegistryStore;
  tokens: TokenTable;
  audit: AuditSink;
}

type Segments = string[];

/** Classified API route (after path decoding). */
type Route =
  | { kind: 'list' }
  | { kind: 'contract'; name: string }
  | { kind: 'versions'; name: string }
  | { kind: 'dependents'; name: string }
  | { kind: 'search' }
  | { kind: 'audit' };

// ---------------------------------------------------------------- factories

/**
 * Create the HTTP server.
 *
 * Returns the unstarted `http.Server` so callers control binding (tests use
 * `server.listen(0)`). Validates options eagerly; malformed token tables or
 * audit options throw `TypeError` before any request is served.
 */
export function createServer(options: RegistryServiceOptions): Server {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createServer: options object is required');
  }
  const store: RegistryStore | undefined = options.store;
  if (typeof store !== 'object' || store === null || typeof store.publish !== 'function') {
    throw new TypeError('createServer: options.store must be a RegistryStore from @bridge/registry');
  }
  const tokens = assertTokenTable(options.tokens ?? {});
  const audit = resolveAudit(options.audit);
  const deps: Deps = { store, tokens, audit };
  return nodeCreateServer((req, res) => {
    void handle(req, res, deps);
  });
}

/**
 * Convenience starter: creates the server, binds it (default port 0 —
 * auto-assigned) and prints `bridge-registry-service listening on port N`
 * once bound. Returns the server.
 */
export function start(options: RegistryServiceOptions, port = 0): Server {
  const server = createServer(options);
  server.listen(port, options.host);
  server.on('listening', () => {
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`bridge-registry-service listening on port ${bound}`);
  });
  return server;
}

function resolveAudit(audit: string | AuditSink | undefined): AuditSink {
  if (audit === undefined) return new MemoryAuditSink();
  if (typeof audit === 'string') return new FileAuditSink(audit);
  if (
    typeof audit === 'object' &&
    audit !== null &&
    typeof audit.append === 'function' &&
    typeof audit.tail === 'function'
  ) {
    return audit;
  }
  throw new TypeError('audit: expected a JSONL file path or an AuditSink with append()/tail()');
}

// ------------------------------------------------------------- entry points

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const ctx: RequestContext = { action: null, contract: null, version: null, auth: null };
  res.on('error', () => {
    /* socket-level noise (client aborts) is not an application error */
  });
  try {
    await routeRequest(req, res, ctx, deps);
    if (ctx.action === 'publish') appendAudit(deps.audit, ctx, true);
  } catch (err) {
    sendError(res, err);
    const authFail =
      err instanceof ServiceError && (err.code === 'unauthenticated' || err.code === 'forbidden');
    if (authFail || ctx.action === 'publish') appendAudit(deps.audit, ctx, false);
  }
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: Deps,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://bridge.local');

  let segments: Segments;
  try {
    segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
  } catch {
    throw new ServiceError(400, 'invalid_argument', 'malformed percent-encoding in request path');
  }

  // GET /health — unauthenticated liveness probe.
  if (segments.length === 1 && segments[0] === 'health') {
    if (method !== 'GET') {
      throw new ServiceError(405, 'method-not-allowed', `method ${method} is not allowed for /health`);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments[0] !== 'api' || segments[1] !== 'v1') {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }

  const route = classifyRoute(segments.slice(2));
  if (route === null) {
    throw new ServiceError(404, 'not-found', `unknown route ${url.pathname}`);
  }

  // Authentication covers every /api/v1 route; authorization happens per route.
  ctx.auth = authenticate(deps.tokens, req.headers.authorization);

  switch (route.kind) {
    case 'list': {
      requireMethod(method, 'GET', '/api/v1/contracts');
      ctx.action = 'read';
      sendJson(res, 200, { contracts: deps.store.list() });
      return;
    }
    case 'contract': {
      ctx.contract = route.name;
      if (method === 'PUT') {
        await publish(req, res, ctx, route.name, deps);
        return;
      }
      requireMethod(method, 'GET', `/api/v1/contracts/${route.name}`);
      ctx.action = 'read';
      const { name, version } = splitTarget(route.name);
      if (version === null) {
        const latest = deps.store.latest(name); // 404 when unknown
        const { ir, meta } = deps.store.pull(name, latest.version);
        ctx.version = meta.version;
        sendJson(res, 200, { ir, meta });
      } else {
        const { ir, meta } = deps.store.pull(name, version); // re-verifies integrity
        ctx.version = meta.version;
        sendJson(res, 200, { ir, meta });
      }
      return;
    }
    case 'versions': {
      requireMethod(method, 'GET', `/api/v1/contracts/${route.name}/versions`);
      ctx.action = 'read';
      ctx.contract = route.name;
      sendJson(res, 200, { name: route.name, versions: deps.store.versions(route.name) });
      return;
    }
    case 'dependents': {
      requireMethod(method, 'GET', `/api/v1/contracts/${route.name}/dependents`);
      ctx.action = 'read';
      ctx.contract = route.name;
      sendJson(res, 200, { dependents: deps.store.dependents(route.name) });
      return;
    }
    case 'search': {
      requireMethod(method, 'GET', '/api/v1/search');
      ctx.action = 'read';
      const query = url.searchParams.get('q') ?? '';
      sendJson(res, 200, { query, results: deps.store.search(query) });
      return;
    }
    case 'audit': {
      requireMethod(method, 'GET', '/api/v1/audit');
      ctx.action = 'audit';
      requireRole(ctx.auth, Roles.admin);
      sendJson(res, 200, { entries: deps.audit.tail(auditLimit(url)) });
      return;
    }
  }
}

// ------------------------------------------------------------------ publish

interface PublishPayload {
  ir: IRPackage;
  meta: PublishMeta;
  publishTime?: string;
  version?: string;
}

async function publish(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  routeName: string,
  deps: Deps,
): Promise<void> {
  ctx.action = 'publish';
  const auth = ctx.auth; // authenticate() has run for every /api/v1 route
  if (auth === null) {
    throw new ServiceError(401, 'unauthenticated', 'missing or invalid bearer token');
  }
  requireRole(auth, Roles.write);

  const bodyText = await readBody(req);
  const parsed = parseJsonBody(bodyText);
  const payload = extractPublishPayload(parsed);
  const target = resolvePublishTarget(routeName, payload.ir, payload.version);
  // Record the attempted coordinates for the audit log even on failure.
  ctx.version = (target.version ?? splitPackageVersion(payload.ir.name).version) || null;

  const existed = probeExisting(deps.store, payload.ir.name, target.version);
  const meta = deps.store.publish(
    payload.ir,
    { ...payload.meta, owner: auth.tenant },
    { publishTime: payload.publishTime, version: target.version },
  );
  ctx.version = meta.version;
  sendJson(res, existed ? 200 : 201, { meta });
}

/** Parse the request body into the publish payload (envelope or bare IR). */
function extractPublishPayload(parsed: unknown): PublishPayload {
  if (!isPlainObject(parsed)) {
    throw new ServiceError(400, 'invalid_argument', 'request body must be a JSON object');
  }
  let ir: unknown;
  let meta: unknown = {};
  let publishTime: unknown;
  let version: unknown;
  if (parsed['ir'] !== undefined) {
    ir = parsed['ir'];
    meta = parsed['meta'] ?? {};
    publishTime = parsed['publishTime'];
    version = parsed['version'];
  } else if (typeof parsed['name'] === 'string') {
    ir = parsed; // bare-IR form: the body is the IR itself
  } else {
    throw new ServiceError(
      400,
      'invalid_argument',
      'request body must be {"ir": <IRPackage>, "meta"?: {...}} or an IR object with a string "name"',
    );
  }
  if (!isPlainObject(ir)) {
    throw new ServiceError(400, 'invalid_argument', 'body.ir must be a JSON object');
  }
  if (typeof ir['name'] !== 'string') {
    throw new ServiceError(400, 'invalid_argument', 'body.ir.name must be a string');
  }
  if (!isPlainObject(meta)) {
    throw new ServiceError(400, 'invalid_argument', 'body.meta must be a JSON object');
  }
  const publishMeta: PublishMeta = {};
  for (const field of ['description', 'repository'] as const) {
    const value = meta[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new ServiceError(400, 'invalid_argument', `body.meta.${field} must be a string`);
    }
    publishMeta[field] = value;
  }
  if (meta['owner'] !== undefined && typeof meta['owner'] !== 'string') {
    throw new ServiceError(400, 'invalid_argument', 'body.meta.owner must be a string when provided');
  }
  if (publishTime !== undefined && typeof publishTime !== 'string') {
    throw new ServiceError(400, 'invalid_argument', 'body.publishTime must be a string');
  }
  if (version !== undefined && typeof version !== 'string') {
    throw new ServiceError(400, 'invalid_argument', 'body.version must be a string');
  }
  return {
    ir: ir as unknown as IRPackage,
    meta: publishMeta,
    publishTime: publishTime as string | undefined,
    version: version as string | undefined,
  };
}

/**
 * Reconcile the route target with the IR's own name.
 *
 * Accepted route shapes: `payments`, `payments.v1`, `payments@v1`.
 * The route base must equal the IR name's base, and an explicit route
 * version must agree with the IR name's version segment. When the IR name
 * carries no version, the route version (or body `version`) selects one;
 * when neither exists the store rejects with `invalid-version` (400).
 */
function resolvePublishTarget(
  routeName: string,
  ir: IRPackage,
  bodyVersion: string | undefined,
): { name: string; version: string | undefined } {
  const at = routeName.indexOf('@');
  let namePart = routeName;
  let atVersion: string | null = null;
  if (at >= 0) {
    namePart = routeName.slice(0, at);
    atVersion = routeName.slice(at + 1);
    if (namePart === '' || atVersion === '') {
      throw new ServiceError(
        400,
        'invalid_argument',
        `route name '${routeName}': expected <name>@<version> with non-empty parts`,
      );
    }
  }

  const routeParts = splitPackageVersion(namePart);
  const irParts = splitPackageVersion(ir.name);
  if (routeParts.base !== irParts.base) {
    throw new ServiceError(
      400,
      'invalid_argument',
      `route name '${routeName}' does not match IR package name '${ir.name}'`,
    );
  }
  if (atVersion !== null && routeParts.version !== '' && routeParts.version !== atVersion) {
    throw new ServiceError(
      400,
      'invalid_argument',
      `route name '${routeName}' carries conflicting versions '${atVersion}' and '${routeParts.version}'`,
    );
  }

  const routeVersion = atVersion ?? (routeParts.version !== '' ? routeParts.version : null);
  if (irParts.version !== '') {
    if (routeVersion !== null && normalizeVersion(routeVersion) !== irParts.version) {
      throw new ServiceError(
        400,
        'invalid_argument',
        `route version '${routeVersion}' does not match IR package name '${ir.name}'`,
      );
    }
    return { name: ir.name, version: undefined }; // store derives from ir.name
  }
  if (routeVersion !== null && bodyVersion !== undefined) {
    if (normalizeVersion(routeVersion) !== normalizeVersion(bodyVersion)) {
      throw new ServiceError(
        400,
        'invalid_argument',
        `route version '${routeVersion}' conflicts with body version '${bodyVersion}'`,
      );
    }
  }
  const version = routeVersion ?? bodyVersion;
  return { name: ir.name, version };
}

/** Best-effort "does this version already exist" probe for 200-vs-201. */
function probeExisting(store: RegistryStore, name: string, version: string | undefined): boolean {
  const resolved = version ?? splitPackageVersion(name).version;
  if (resolved === '') return false; // store will reject with 'invalid-version'
  try {
    store.inspect(name, resolved);
    return true;
  } catch (err) {
    if (err instanceof RegistryError && err.code === 'not-found') return false;
    throw err;
  }
}

// ------------------------------------------------------------------ helpers

function classifyRoute(rest: Segments): Route | null {
  if (rest.length === 1 && rest[0] === 'contracts') return { kind: 'list' };
  if (rest.length === 2 && rest[0] === 'contracts') return { kind: 'contract', name: rest[1] ?? '' };
  if (rest.length === 3 && rest[0] === 'contracts') {
    if (rest[2] === 'versions') return { kind: 'versions', name: rest[1] ?? '' };
    if (rest[2] === 'dependents') return { kind: 'dependents', name: rest[1] ?? '' };
    return null;
  }
  if (rest.length === 1 && rest[0] === 'search') return { kind: 'search' };
  if (rest.length === 1 && rest[0] === 'audit') return { kind: 'audit' };
  return null;
}

/** Split `name@version`; `@`-less targets have `version: null`. */
function splitTarget(segment: string): { name: string; version: string | null } {
  const at = segment.lastIndexOf('@');
  if (at <= 0) return { name: segment, version: null };
  const name = segment.slice(0, at);
  const version = segment.slice(at + 1);
  if (version === '') {
    throw new ServiceError(400, 'invalid_argument', `empty version after '@' in '${segment}'`);
  }
  return { name, version };
}

function decodeSegment(segment: string): string {
  return decodeURIComponent(segment);
}

function requireMethod(method: string, allowed: string, what: string): void {
  if (method !== allowed) {
    throw new ServiceError(405, 'method-not-allowed', `method ${method} is not allowed for ${what}`);
  }
}

function auditLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_AUDIT_TAIL;
  if (raw.trim() === '') {
    throw new ServiceError(400, 'invalid_argument', 'query parameter limit must be a non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || Math.trunc(value) !== value) {
    throw new ServiceError(400, 'invalid_argument', `query parameter limit '${raw}' is not a non-negative integer`);
  }
  return Math.min(Math.trunc(value), MAX_AUDIT_TAIL);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ServiceError(413, 'payload-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ServiceError(
      400,
      'invalid_argument',
      `request body is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.byteLength),
  });
  res.end(data);
}

function sendError(res: ServerResponse, err: unknown): void {
  let status = 500;
  let code = 'internal';
  let message = 'internal server error';
  if (err instanceof ServiceError) {
    status = err.status;
    code = err.code;
    message = err.message;
  } else if (err instanceof RegistryError) {
    status = statusForRegistryError(err.code);
    code = err.code;
    message = err.message;
  } else if (err instanceof TypeError) {
    // Store argument validation (e.g. malformed IR shapes from clients).
    status = 400;
    code = 'invalid_argument';
    message = err.message;
  }
  try {
    sendJson(res, status, { error: { code, message } });
  } catch {
    // Socket already destroyed (client abort): nothing to send.
    res.destroy();
  }
}

function appendAudit(sink: AuditSink, ctx: RequestContext, ok: boolean): void {
  if (ctx.action === null) return;
  const entry: AuditEntry = {
    time: new Date().toISOString(),
    action: ctx.action,
    tenant: ctx.auth?.tenant ?? null,
    contract: ctx.contract,
    version: ctx.version,
    ok,
  };
  try {
    sink.append(entry);
  } catch (err) {
    // A broken audit sink must not take the response down with it.
    console.error('[bridge-registry-service] audit append failed:', (err as Error)?.message ?? err);
  }
}
