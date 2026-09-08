/**
 * A thin, zero-dependency PostgreSQL wire-protocol client (protocol 3.0).
 *
 * Scope: everything the registry service's PostgreSQL driver needs —
 * connect (optionally TLS), password auth (cleartext, MD5, SCRAM-SHA-256),
 * and parameterized queries via the extended query protocol (Parse / Bind /
 * Describe / Execute / Sync), text-format parameters and results.
 *
 * Deliberately out of scope: COPY, LISTEN/NOTIFY, binary formats, pipelined
 * multi-statement batches, cancellation, prepared-statement reuse.
 *
 * Pure encoding/decoding helpers are exported separately so they can be
 * unit-tested without a server; the live path is exercised by the
 * PG_DSN-gated integration test.
 */

import { createHash, createHmac, randomBytes, pbkdf2Sync } from 'node:crypto';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';

// ------------------------------------------------------------------ options
export interface PgConnectOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  /** `prefer` (default — TLS when the server supports it), `disable`, `require`, `verify-full`. */
  ssl?: 'disable' | 'prefer' | 'require' | 'verify-full';
  /** True when `ssl` was NOT present in the DSN and was defaulted (boot-log flag). */
  sslDefaulted?: boolean;
  applicationName?: string;
  connectionTimeoutMs?: number;
}

/** Parse a PostgreSQL connection URI: postgres://user:pass@host:port/db?sslmode=… */
export function parseDsn(dsn: string): PgConnectOptions {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new TypeError('PG_DSN: not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TypeError(`PG_DSN: unsupported scheme ${JSON.stringify(url.protocol)} (expected postgres://)`);
  }
  if (!url.hostname) throw new TypeError('PG_DSN: host is required');
  const user = decodeURIComponent(url.username);
  if (!user) throw new TypeError('PG_DSN: user is required');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new TypeError('PG_DSN: database is required');
  const sslParam = url.searchParams.get('sslmode') ?? undefined;
  // issue #48: a DSN without sslmode defaults to 'prefer' (TLS when the
  // server supports it) instead of silently disabling TLS.
  const ssl =
    sslParam === undefined
      ? 'prefer'
      : sslParam === 'disable' || sslParam === 'prefer' || sslParam === 'require' || sslParam === 'verify-full'
        ? (sslParam as PgConnectOptions['ssl'])
        : undefined;
  if (sslParam !== undefined && ssl === undefined) {
    throw new TypeError(`PG_DSN: unsupported sslmode '${sslParam}'`);
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`PG_DSN: invalid port ${JSON.stringify(url.port)}`);
  }
  return {
    host: url.hostname,
    port,
    user,
    password: url.password === '' ? undefined : decodeURIComponent(url.password),
    database,
    ssl,
    sslDefaulted: sslParam === undefined,
    applicationName: url.searchParams.get('application_name') ?? undefined,
  };
}

// ------------------------------------------------------- message encoding

export interface PgMessage {
  type: string;
  payload: Buffer;
}

function withLength(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function writeCString(buf: Buffer, value: string): Buffer {
  return Buffer.concat([buf, Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function writeInt16(buf: Buffer, value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(value, 0);
  return Buffer.concat([buf, b]);
}

function writeInt32(buf: Buffer, value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return Buffer.concat([buf, b]);
}

/** StartupMessage (protocol 3.0): int32 length, int32 196608, key/value pairs, NUL. */
export function encodeStartupMessage(params: Record<string, string>): Buffer {
  let body = writeInt32(Buffer.alloc(0), 196608);
  for (const [key, value] of Object.entries(params)) {
    body = writeCString(writeCString(body, key), value);
  }
  body = Buffer.concat([body, Buffer.from([0])]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length + 4, 0);
  return Buffer.concat([head, body]);
}

/** SSLRequest: int32 8, int32 80877103. */
export function encodeSSLRequest(): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(8, 0);
  b.writeUInt32BE(80877103, 4);
  return b;
}

export function encodePasswordMessage(password: string): Buffer {
  return withLength('p', Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]));
}

/** Parse ('P'): prepared statement with explicit parameter type OIDs. */
export function encodeParse(name: string, sql: string, paramTypeOids: number[]): Buffer {
  let body = writeCString(Buffer.alloc(0), name);
  body = writeCString(body, sql);
  body = writeInt16(body, paramTypeOids.length);
  for (const oid of paramTypeOids) body = writeInt32(body, oid);
  return withLength('P', body);
}

/** Bind ('B'): all parameters text-format, results text-format. */
export function encodeBind(portal: string, statement: string, params: (string | null)[]): Buffer {
  let body = writeCString(Buffer.alloc(0), portal);
  body = writeCString(body, statement);
  body = writeInt16(body, 0); // parameter format codes: all text
  body = writeInt16(body, params.length);
  for (const param of params) {
    if (param === null) {
      body = writeInt32(body, -1);
    } else {
      const bytes = Buffer.from(param, 'utf8');
      body = writeInt32(body, bytes.length);
      body = Buffer.concat([body, bytes]);
    }
  }
  body = writeInt16(body, 1); // result format codes count
  body = writeInt16(body, 0); // all text
  return withLength('B', body);
}

export function encodeDescribeStatement(name = ''): Buffer {
  let body: Buffer = Buffer.from('S', 'ascii');
  body = writeCString(body, name);
  return withLength('D', body);
}

export function encodeExecute(portal = '', maxRows = 0): Buffer {
  let body = writeCString(Buffer.alloc(0), portal);
  body = writeInt32(body, maxRows);
  return withLength('E', body);
}

export function encodeSync(): Buffer {
  return withLength('S', Buffer.alloc(0));
}

export function encodeTerminate(): Buffer {
  return withLength('X', Buffer.alloc(0));
}

/** Simple query ('Q'): one or more SQL statements, no parameters. */
export function encodeSimpleQuery(sql: string): Buffer {
  return withLength('Q', Buffer.concat([Buffer.from(sql, 'utf8'), Buffer.from([0])])) as Buffer;
}

export function encodeSASLInitialResponse(mechanism: string, initialResponse: Buffer): Buffer {
  let body = writeCString(Buffer.alloc(0), mechanism);
  body = writeInt32(body, initialResponse.length);
  body = Buffer.concat([body, initialResponse]);
  return withLength('p', body);
}

export function encodeSASLResponse(response: Buffer): Buffer {
  return withLength('p', response);
}

// ------------------------------------------------------------------- auth

/** PostgreSQL MD5 auth: 'md5' + hex(md5(hex(md5(password + user)) + salt)). */
export function md5AuthResponse(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(password + user, 'utf8').digest('hex');
  const outer = createHash('md5').update(inner + salt.toString('binary'), 'binary').digest('hex');
  return `md5${outer}`;
}

/** Random SCRAM client nonce (base64 of 18 random bytes). */
export function scramNonce(): string {
  return randomBytes(18).toString('base64');
}

/** Build the client-first message; returns the message and its bare part. */
export function scramClientFirst(nonce: string): { message: string; clientFirstBare: string } {
  const clientFirstBare = `n=,r=${nonce}`;
  return { message: `n,,${clientFirstBare}`, clientFirstBare };
}

export interface ScramClientFinal {
  clientFinalMessage: string;
  /** HMAC(ServerKey, AuthMessage) — must equal the server's `v=` value. */
  expectedServerSignature: Buffer;
}

/**
 * Compute the SCRAM-SHA-256 client-final message.
 * Password is used raw UTF-8 (SASLprep is a no-op for typical passwords).
 */
export function scramClientFinal(
  password: string,
  saltBase64: string,
  iterations: number,
  serverFirstMessage: string,
  clientFirstBare: string,
): ScramClientFinal {
  const salt = Buffer.from(saltBase64, 'base64');
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key', 'utf8').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const clientFinalWithoutProof = `c=biws,r=${serverNonce(serverFirstMessage)}`;
  const authMessage = `${clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
  const clientSignature = createHmac('sha256', storedKey).update(authMessage, 'utf8').digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) {
    proof[i] = clientKey[i]! ^ clientSignature[i]!;
  }
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key', 'utf8').digest();
  const expectedServerSignature = createHmac('sha256', serverKey).update(authMessage, 'utf8').digest();
  return {
    clientFinalMessage: `${clientFinalWithoutProof},p=${proof.toString('base64')}`,
    expectedServerSignature,
  };
}

function serverNonce(serverFirstMessage: string): string {
  const match = /(?:^|,)r=([^,]*)/.exec(serverFirstMessage);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    throw new Error('SCRAM: server-first message has no nonce');
  }
  return match[1];
}

// ------------------------------------------------------------ frame parsing

/**
 * Extract complete wire frames from `buffer`.
 * Returns the frames and the number of bytes consumed (frames are not
 * removed from the buffer; callers slice it off).
 */
export function parseMessages(buffer: Buffer): { messages: PgMessage[]; consumed: number } {
  const messages: PgMessage[] = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const length = buffer.readUInt32BE(offset + 1);
    if (length < 4 || length > 1024 * 1024 * 1024) throw new Error(`postgres: bad frame length ${length}`);
    if (buffer.length - offset < length + 1) break;
    messages.push({
      type: buffer.toString('ascii', offset, offset + 1),
      payload: buffer.subarray(offset + 5, offset + 1 + length),
    });
    offset += length + 1;
  }
  return { messages, consumed: offset };
}

/** Parse an ErrorResponse/NoticeResponse payload into its fields. */
export function parseErrorResponse(payload: Buffer): { severity: string; code: string; message: string; detail?: string } {
  let severity = 'ERROR';
  let code = 'XX000';
  let message = 'unknown postgres error';
  let detail: string | undefined;
  let offset = 0;
  while (offset < payload.length) {
    const fieldType = payload.toString('ascii', offset, offset + 1);
    if (fieldType === '\0') break;
    const nul = payload.indexOf(0, offset + 1);
    if (nul < 0) break;
    const value = payload.toString('utf8', offset + 1, nul);
    offset = nul + 1;
    if (fieldType === 'S') severity = value;
    else if (fieldType === 'C') code = value;
    else if (fieldType === 'M') message = value;
    else if (fieldType === 'D') detail = value;
  }
  return { severity, code, message, detail };
}

// ------------------------------------------------------------------- errors

/** A PostgreSQL server-side error (ErrorResponse). */
export class PgError extends Error {
  public readonly severity: string;
  public readonly code: string;
  public readonly detail?: string;

  constructor(fields: { severity: string; code: string; message: string; detail?: string }) {
    super(fields.message);
    this.name = 'PgError';
    this.severity = fields.severity;
    this.code = fields.code;
    this.detail = fields.detail;
  }
}

// ------------------------------------------------------------------ results

export interface PgResult {
  columns: string[];
  rows: Record<string, string | null>[];
  rowCount: number | null;
  command: string | null;
}

// ------------------------------------------------------------------- mutex

/**
 * FIFO promise-queue mutex.
 *
 * `run(fn)` executes `fn` exclusively; overlapping callers are queued and
 * started in submission order, never interleaved. The PostgreSQL wire
 * protocol is strictly request/response per connection — two interleaved
 * exchanges on one socket let one caller consume the other's rows (possible
 * cross-tenant delivery) and leave the other hanging forever — so every
 * {@link PgClient} serializes its query traffic through one of these.
 *
 * When the transport dies mid-flight, {@link close} rejects every QUEUED
 * (not yet started) waiter immediately and fails all future `run` calls:
 * nothing may open a new exchange on a dead connection, and nothing waits
 * forever behind it. The single actively-running section is failed by the
 * socket handlers themselves (its own message waiter is rejected).
 */
export class Mutex {
  private queue: Array<{ start: () => void; fail: (err: Error) => void }> = [];
  private busy = false;
  private closedError: Error | null = null;

  /** Run `fn` in a critical section. FIFO order; never interleaved. */
  public run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closedError !== null) {
        reject(this.closedError);
        return;
      }
      const entry: { start: () => void; fail: (err: Error) => void } = {
        start: () => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => this.release());
        },
        fail: (err) => reject(err),
      };
      this.queue.push(entry);
      if (!this.busy) this.release(); // pump immediately when idle
    });
  }

  /**
   * Reject every queued (not yet started) waiter with `err` and fail all
   * future `run` calls. Idempotent.
   */
  public close(err: Error): void {
    if (this.closedError !== null) return;
    this.closedError = err;
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) entry.fail(err);
  }

  /** Number of queued (waiting, not running) entries. */
  public get pending(): number {
    return this.queue.length;
  }

  /** True once {@link close} has been called. */
  public get isClosed(): boolean {
    return this.closedError !== null;
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.busy = false;
      return;
    }
    this.busy = true;
    next.start();
  }
}

// ------------------------------------------------------------------- client

const QUERY_TYPES: readonly string[] = ['1', '2', '3', 'C', 'D', 'E', 'I', 'K', 'N', 'n', 'R', 'S', 'T', 'v', 'Z'];

export class PgClient {
  private socket: Socket | TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: { resolve: (msg: PgMessage) => void; reject: (err: Error) => void } | null = null;
  private closed = false;
  /** True when the transport was TLS-upgraded (cleartext-auth gate). */
  private readonly tlsActive: boolean;
  /**
   * Serializes query()/simpleQuery() per connection (issue #47): the wire
   * protocol allows exactly one exchange in flight — concurrent callers
   * would otherwise overwrite the single `waiter` slot, hang forever, or
   * consume each other's rows.
   */
  private readonly mutex = new Mutex();

  private constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.tlsActive = socket instanceof TLSSocket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', (err: Error) => {
      // Fail the active exchange AND everything queued behind the mutex —
      // no eternal hangs, no responses delivered after reconnect attempts.
      this.failWaiter(err);
      this.mutex.close(new Error(`postgres: connection error: ${err.message}`));
    });
    socket.on('close', () => {
      this.closed = true;
      const err = new Error('postgres: connection closed');
      this.failWaiter(err);
      this.mutex.close(err);
    });
  }

  /** Open a connection and complete startup + authentication. */
  public static async connect(options: PgConnectOptions): Promise<PgClient> {
    if (options.connectionTimeoutMs !== undefined && (!Number.isFinite(options.connectionTimeoutMs) || options.connectionTimeoutMs <= 0)) {
      throw new TypeError('connectionTimeoutMs must be a positive number');
    }
    const timeoutMs = options.connectionTimeoutMs ?? 10_000;
    const socket = await tcpConnectPromise(options, timeoutMs);
    let active: Socket | TLSSocket = socket;

    // issue #48: default 'prefer' — upgrade to TLS when the server supports
    // it, continue in clear text only when it does not (and then refuse to
    // send a cleartext password; see authenticate()).
    const ssl = options.ssl ?? 'prefer';
    if (options.ssl === undefined) {
      console.warn('[bridge-registry-service] postgres: no sslmode configured; defaulting to sslmode=prefer');
    }
    if (ssl !== 'disable') {
      socket.write(encodeSSLRequest());
      const decision = await readExact(socket, 1, timeoutMs);
      if (decision.toString('ascii') === 'S') {
        active = await new Promise<TLSSocket>((resolve, reject) => {
          const tls = tlsConnect(
            {
              socket,
              servername: options.host,
              rejectUnauthorized: ssl === 'verify-full',
            },
            () => resolve(tls),
          );
          tls.once('error', reject);
        });
      } else if (ssl === 'require' || ssl === 'verify-full') {
        socket.destroy();
        throw new Error('postgres: server does not support SSL (sslmode=require)');
      }
      // 'prefer' + 'N' → continue in clear text.
    }

    const client = new PgClient(active);
    try {
      let startup: Record<string, string> = {
        user: options.user,
        database: options.database,
        client_encoding: 'UTF8',
        TimeZone: 'UTC',
      };
      if (options.applicationName !== undefined) startup = { ...startup, application_name: options.applicationName };
      active.write(encodeStartupMessage(startup));
      await client.authenticate(options);
      return client;
    } catch (err) {
      active.destroy();
      throw err;
    }
  }

  /** Negotiate the Authentication* exchange until ReadyForQuery. */
  private async authenticate(options: PgConnectOptions): Promise<void> {
    let saslState: { clientFirstBare: string; serverFirst: string; expected: Buffer } | null = null;
    for (;;) {
      const msg = await this.nextMessage();
      if (msg.type === 'Z') return; // ReadyForQuery
      if (msg.type === 'E') throw new PgError(parseErrorResponse(msg.payload));
      if (msg.type === 'S' || msg.type === 'K' || msg.type === 'N') continue; // ParameterStatus/KeyData/Notice
      if (msg.type !== 'R') throw new Error(`postgres: unexpected message '${msg.type}' during auth`);

      const code = msg.payload.readInt32BE(0);
      if (code === 0) continue; // AuthenticationOk
      if (code === 3) {
        if (typeof options.password !== 'string') throw new Error('postgres: server requested a password but none was configured');
        if (!this.tlsActive) {
          // issue #48: a cleartext password on a plaintext connection ships
          // the credential to anyone on the path. Refuse with a clear
          // message; SCRAM-SHA-256 (code 10) remains available over plain
          // text because the password never crosses the wire.
          throw new Error(
            'postgres: server requested CLEARTEXT password auth over a plaintext connection — ' +
              'the password would be sent unencrypted. Use sslmode=require (or verify-full), ' +
              'or switch the server to SCRAM-SHA-256 / trust auth for non-TLS local development.',
          );
        }
        this.socket.write(encodePasswordMessage(options.password));
        continue;
      }
      if (code === 5) {
        if (typeof options.password !== 'string') throw new Error('postgres: server requested a password but none was configured');
        const salt = msg.payload.subarray(4, 8);
        this.socket.write(encodePasswordMessage(md5AuthResponse(options.user, options.password, salt)));
        continue;
      }
      if (code === 10) {
        const mechanisms = parseMechanisms(msg.payload.subarray(4));
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          throw new Error(`postgres: unsupported SASL mechanisms [${mechanisms.join(', ')}]`);
        }
        const nonce = scramNonce();
        const first = scramClientFirst(nonce);
        saslState = { clientFirstBare: first.clientFirstBare, serverFirst: '', expected: Buffer.alloc(0) };
        this.socket.write(encodeSASLInitialResponse('SCRAM-SHA-256', Buffer.from(first.message, 'utf8')));
        continue;
      }
      if (code === 11) {
        if (saslState === null || typeof options.password !== 'string') {
          throw new Error('postgres: unexpected SASLContinue');
        }
        const serverFirst = msg.payload.toString('utf8', 4);
        const match = /^r=[^,]*,s=([^,]*),i=(\d+)$/.exec(serverFirst);
        if (match === null) throw new Error('postgres: malformed SCRAM server-first message');
        const iterations = Number(match[2]);
        if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
          throw new Error('postgres: SCRAM iteration count out of range');
        }
        const final = scramClientFinal(options.password, match[1]!, iterations, serverFirst, saslState.clientFirstBare);
        saslState.serverFirst = serverFirst;
        saslState.expected = final.expectedServerSignature;
        this.socket.write(encodeSASLResponse(Buffer.from(final.clientFinalMessage, 'utf8')));
        continue;
      }
      if (code === 12) {
        if (saslState === null) throw new Error('postgres: unexpected SASLFinal');
        const serverFinal = msg.payload.toString('utf8', 4);
        const match = /^v=([A-Za-z0-9+/=]+)$/.exec(serverFinal);
        const serverSignature = match === null ? null : Buffer.from(match[1]!, 'base64');
        if (serverSignature === null || !serverSignature.equals(saslState.expected)) {
          throw new Error('postgres: SCRAM server signature mismatch');
        }
        continue;
      }
      throw new Error(`postgres: unsupported authentication method ${code}`);
    }
  }

  /**
   * Run one parameterized query (extended protocol). Values must be
   * string | number | boolean | null (converted to PostgreSQL text).
   *
   * Serialized per connection through the connection mutex: only one
   * exchange is ever in flight, in FIFO call order.
   */
  public async query(sql: string, params: unknown[] = []): Promise<PgResult> {
    if (this.closed) throw new Error('postgres: connection is closed');
    return this.mutex.run(() => this.queryOnce(sql, params));
  }

  /** Query body — only ever runs while holding the connection mutex. */
  private async queryOnce(sql: string, params: unknown[]): Promise<PgResult> {
    const encoded: (string | null)[] = params.map((value) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
      if (typeof value === 'boolean') return value ? 't' : 'f';
      if (Buffer.isBuffer(value)) return value.toString('utf8');
      throw new TypeError(`postgres: unsupported parameter type ${typeof value}`);
    });

    this.socket.write(
      Buffer.concat([
        encodeParse('', sql, []),
        encodeBind('', '', encoded),
        encodeDescribeStatement(''),
        encodeExecute('', 0),
        encodeSync(),
      ]),
    );

    const columns: string[] = [];
    const rows: Record<string, string | null>[] = [];
    let command: string | null = null;
    let rowCount: number | null = null;
    let error: PgError | null = null;
    let sawRowDescription = false;

    for (;;) {
      const msg = await this.nextMessage();
      if (!QUERY_TYPES.includes(msg.type)) {
        throw new Error(`postgres: unexpected message '${msg.type}' during query`);
      }
      switch (msg.type) {
        case 'T': {
          sawRowDescription = true;
          let offset = 2;
          const count = msg.payload.readInt16BE(0);
          for (let i = 0; i < count; i++) {
            const nul = msg.payload.indexOf(0, offset);
            columns.push(msg.payload.toString('utf8', offset, nul));
            offset = nul! + 1 + 18; // name NUL + tableoid(4) attnum(2) typeoid(4) typlen(2) typmod(4) format(2)
          }
          break;
        }
        case 'D': {
          const row: Record<string, string | null> = {};
          let offset = 2;
          const count = msg.payload.readInt16BE(0);
          for (let i = 0; i < count; i++) {
            const len = msg.payload.readInt32BE(offset);
            offset += 4;
            if (len === -1) {
              row[columns[i] ?? `col${i}`] = null;
            } else {
              row[columns[i] ?? `col${i}`] = msg.payload.toString('utf8', offset, offset + len);
              offset += len;
            }
          }
          rows.push(row);
          break;
        }
        case 'C': {
          command = msg.payload.toString('utf8').replace(/\0$/, '');
          const tag = command.split(' ').at(-1);
          const parsed = tag === undefined ? Number.NaN : Number(tag);
          if (!sawRowDescription && Number.isInteger(parsed) && parsed >= 0) rowCount = parsed;
          else if (sawRowDescription) rowCount = rows.length;
          break;
        }
        case 'E': {
          if (error === null) error = new PgError(parseErrorResponse(msg.payload));
          break;
        }
        case 'Z': {
          if (error !== null) throw error;
          return { columns, rows, rowCount, command };
        }
        default:
          break; // ParseComplete '1', BindComplete '2', NoData 'n', ParameterStatus 'S', Notice 'N', KeyData 'K'
      }
    }
  }

  /**
   * Run one simple-protocol query (multi-statement SQL allowed; no
   * parameters). Returns the LAST statement's result — sufficient for
   * migrations and transaction control (BEGIN/COMMIT/ROLLBACK).
   *
   * Serialized per connection through the connection mutex.
   */
  public async simpleQuery(sql: string): Promise<PgResult> {
    if (this.closed) throw new Error('postgres: connection is closed');
    return this.mutex.run(() => this.simpleQueryOnce(sql));
  }

  /** Simple-query body — only ever runs while holding the connection mutex. */
  private async simpleQueryOnce(sql: string): Promise<PgResult> {
    this.socket.write(encodeSimpleQuery(sql));

    const columns: string[] = [];
    const rows: Record<string, string | null>[] = [];
    let command: string | null = null;
    let rowCount: number | null = null;
    let error: PgError | null = null;
    let sawRowDescription = false;

    for (;;) {
      const msg = await this.nextMessage();
      if (!QUERY_TYPES.includes(msg.type)) {
        throw new Error(`postgres: unexpected message '${msg.type}' during simple query`);
      }
      switch (msg.type) {
        case 'T': {
          sawRowDescription = true;
          columns.length = 0;
          let offset = 2;
          const count = msg.payload.readInt16BE(0);
          for (let i = 0; i < count; i++) {
            const nul = msg.payload.indexOf(0, offset);
            columns.push(msg.payload.toString('utf8', offset, nul));
            offset = nul! + 1 + 18;
          }
          break;
        }
        case 'D': {
          const row: Record<string, string | null> = {};
          let offset = 2;
          const count = msg.payload.readInt16BE(0);
          for (let i = 0; i < count; i++) {
            const len = msg.payload.readInt32BE(offset);
            offset += 4;
            if (len === -1) {
              row[columns[i] ?? `col${i}`] = null;
            } else {
              row[columns[i] ?? `col${i}`] = msg.payload.toString('utf8', offset, offset + len);
              offset += len;
            }
          }
          rows.push(row);
          break;
        }
        case 'C': {
          command = msg.payload.toString('utf8').replace(/\0$/, '');
          const tag = command.split(' ').at(-1);
          const parsed = tag === undefined ? Number.NaN : Number(tag);
          if (!sawRowDescription && Number.isInteger(parsed) && parsed >= 0) rowCount = parsed;
          else if (sawRowDescription) rowCount = rows.length;
          break;
        }
        case 'E': {
          if (error === null) error = new PgError(parseErrorResponse(msg.payload));
          break;
        }
        case 'Z': {
          if (error !== null) throw error;
          return { columns, rows, rowCount, command };
        }
        default:
          break; // 'S' ParameterStatus, 'N' Notice, 'K' KeyData, 'I' EmptyQueryResponse
      }
    }
  }

  /** Send Terminate and destroy the socket. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeTerminate());
    } catch {
      /* socket already gone */
    }
    this.socket.destroy();
  }

  private nextMessage(): Promise<PgMessage> {
    const { messages, consumed } = parseMessages(this.buffer);
    if (messages.length > 0) {
      this.buffer = this.buffer.subarray(consumed);
      return Promise.resolve(messages[0]!);
    }
    if (this.closed) return Promise.reject(new Error('postgres: connection closed'));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private pump(): void {
    if (this.waiter === null) return;
    const { messages, consumed } = parseMessages(this.buffer);
    if (messages.length === 0) return;
    this.buffer = this.buffer.subarray(consumed);
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(messages[0]!);
  }

  private failWaiter(err: Error): void {
    if (this.waiter === null) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter.reject(err);
  }
}

// ----------------------------------------------------------------- helpers

function parseMechanisms(payload: Buffer): string[] {
  const mechanisms: string[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const nul = payload.indexOf(0, offset);
    if (nul < 0) break;
    const mech = payload.toString('utf8', offset, nul);
    if (mech === '') break;
    mechanisms.push(mech);
    offset = nul + 1;
  }
  return mechanisms;
}

function tcpConnectPromise(options: PgConnectOptions, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: options.host, port: options.port }, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`postgres: connect timeout after ${timeoutMs}ms (${options.host}:${options.port})`));
    }, timeoutMs);
    socket.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`postgres: connect failed: ${err.message}`));
    });
  });
}

/** Read exactly `n` bytes from the socket (used for the 1-byte SSL decision). */
function readExact(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('postgres: timeout waiting for SSL decision'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= n) {
        const out = buffer.subarray(0, n);
        // Prepend any excess bytes back? The excess path cannot happen for
        // the 1-byte SSL decision (server sends exactly one byte).
        cleanup();
        resolve(out);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('postgres: connection closed before SSL decision'));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

