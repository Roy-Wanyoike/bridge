/**
 * @bridge/lsp — Language Server Protocol server for the Bridge IDL.
 *
 * Dependency-free JSON-RPC over stdio (hand-rolled framing) on top of the
 * `@bridge/core` compiler.
 *
 * Public API:
 * - `createConnection(readable, writable, options?)` — attach the server to
 *   any byte-stream pair (stdio in production, in-memory duplexes in tests)
 * - `BridgeLspServer` — transport-agnostic message handling + document store
 * - `MessageReader` / `writeMessage` — LSP framing primitives
 * - `toLspDiagnostic`, `toLspPosition` / `toBridgePosition`, `identifierAt`,
 *   `fullDocumentRange`, `wordPrefixAt`, `diagnosticRangeAt` — position
 *   mapping and text utilities (UTF-16 code unit semantics, see positions.ts)
 * - protocol types + `Methods`, `ErrorCodes` constants
 */

export { createConnection, type ConnectionOptions, type LspConnection } from './connection';
export {
  BridgeLspServer,
  SERVER_NAME,
  SERVER_VERSION,
  defaultUriToPath,
  toLspDiagnostic,
  type MessageSink,
  type ServerOptions,
} from './server';
export { MessageReader, ErrorCodes, isNotification, isRequest, isResponse, writeMessage, type JsonRpcErrorBody, type JsonRpcMessage } from './jsonrpc';
export {
  diagnosticRangeAt,
  fullDocumentRange,
  identifierAt,
  lineTextAt,
  toBridgePosition,
  toLspPosition,
  wordPrefixAt,
} from './positions';
export * from './protocol';
