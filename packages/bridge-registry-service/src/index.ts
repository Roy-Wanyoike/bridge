/**
 * `@bridge/registry-service` — HTTP API over the Bridge contract registry.
 *
 * Dependency-free `node:http` server exposing `RegistryStore` operations as
 * JSON endpoints with bearer-token auth, tenant recording and an append-only
 * audit log. See the package README for the full API table and quickstart.
 *
 * @example
 * ```ts
 * import { RegistryStore } from '@bridge/registry';
 * import { createServer } from '@bridge/registry-service';
 *
 * const server = createServer({
 *   store: new RegistryStore('.bridge-registry'),
 *   tokens: { 'secret-1': { tenant: 'acme', role: 'write' } },
 *   audit: 'audit.jsonl',
 * });
 * server.listen(4350);
 * ```
 */

export { createServer, start } from './server';
export { FileAuditSink, MemoryAuditSink, clampLimit } from './audit';
export { ServiceError, statusForRegistryError } from './errors';
export type { ServiceErrorCode } from './errors';
export { authenticate, requireRole, ROLE_RANK, Roles } from './auth';
export type {
  AuditEntry,
  AuditSink,
  RegistryRole,
  RegistryServiceOptions,
  RegistryTokenInfo,
  TokenTable,
} from './types';
