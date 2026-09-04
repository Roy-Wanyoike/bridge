/**
 * Dependency-free JSON-RPC 2.0 plumbing with LSP wire framing.
 *
 * The Language Server Protocol runs JSON-RPC 2.0 over a byte stream using
 * HTTP-style headers:
 *
 * ```
 * Content-Length: <bytes>\r\n
 * \r\n
 * <JSON body>
 * ```
 *
 * Per the LSP specification, `Content-Length` counts BYTES of the body
 * encoded as UTF-8 — not characters, not code points. Everything here is
 * hand-rolled on top of `Buffer` so the package has zero runtime
 * dependencies beyond `@bridge/core`.
 */

/** JSON-RPC 2.0 message envelope (requests, responses, notifications). */
export interface JsonRpcMessage {
  jsonrpc: '2.0';
  /** Present on requests and responses; absent on notifications. */
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC / LSP error codes used by this server. */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** LSP-specific: request received before the `initialize` handshake. */
  ServerNotInitialized: -32002,
} as const;

/** True when the message is a request (has `method` AND an `id`). */
export function isRequest(message: JsonRpcMessage): boolean {
  return message.method !== undefined && message.id !== undefined;
}

/** True when the message is a notification (has `method`, no `id`). */
export function isNotification(message: JsonRpcMessage): boolean {
  return message.method !== undefined && message.id === undefined;
}

/** True when the message is a response to a previous request. */
export function isResponse(message: JsonRpcMessage): boolean {
  return message.method === undefined && (message.result !== undefined || message.error !== undefined);
}

/** Maximum bytes we will buffer waiting for the `\r\n\r\n` header terminator. */
const MAX_HEADER_BYTES = 32 * 1024;

/**
 * Incremental reader for framed JSON-RPC messages.
 *
 * Feed it raw stream chunks with {@link push}; it reassembles headers and
 * bodies across chunk boundaries and invokes `onMessage` once per complete
 * message. The reader never throws: framing corruption and bodies that fail
 * `JSON.parse` are reported through the optional `onError` callback so the
 * transport can decide how to recover.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (message: JsonRpcMessage) => void,
    private readonly onError?: (kind: 'framing' | 'parse', cause: unknown) => void,
  ) {}

  /** Feed the next chunk from the byte stream. */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.onError?.('framing', 'Header block exceeds 32 KiB without a terminator.');
        }
        return; // wait for more bytes
      }

      let contentLength = -1;
      for (const rawLine of this.buffer.subarray(0, headerEnd).toString('ascii').split('\r\n')) {
        const colon = rawLine.indexOf(':');
        if (colon < 0) continue;
        const name = rawLine.slice(0, colon).trim().toLowerCase();
        if (name === 'content-length') {
          const value = Number.parseInt(rawLine.slice(colon + 1).trim(), 10);
          if (Number.isFinite(value) && value >= 0) contentLength = value;
        }
        // `Content-Type` and any other headers are tolerated and ignored.
      }

      if (contentLength < 0) {
        this.buffer = Buffer.alloc(0);
        this.onError?.('framing', 'Framing error: missing or invalid Content-Length header.');
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return; // wait for the rest of the body

      const body = this.buffer.subarray(bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        this.onMessage(JSON.parse(body.toString('utf8')) as JsonRpcMessage);
      } catch (cause) {
        // The framing is intact — only this body was malformed, so the
        // stream can safely continue with the next message.
        this.onError?.('parse', cause);
      }
    }
  }
}

/**
 * Serialize one JSON-RPC message with LSP framing and write it to the
 * stream. `Content-Length` is computed with `Buffer.byteLength` so bodies
 * containing multi-byte UTF-8 characters are framed byte-accurately.
 */
export interface MessageWriter {
  /** Minimal write surface satisfied by streams, sockets and stdout. */
  write(chunk: Buffer): unknown;
}

export function writeMessage(writable: MessageWriter, message: JsonRpcMessage): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  writable.write(Buffer.concat([head, body]));
}
