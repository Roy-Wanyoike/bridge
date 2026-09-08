/**
 * `@bridge/registry-service` — multi-tenant HTTP registry for Bridge
 * contracts.
 *
 * Dependency-free `node:http` server over a {@link StorageDriver} with
 * org/project tenancy, OIDC (or static-token) auth, ed25519 artifact
 * signing, an append-only audit log, rate limiting and a hand-written
 * OpenAPI document at `GET /v1/openapi.json`.
 *
 * @example
 * ```ts
 * import { InMemoryDriver } from './storage/memory';
 * import { start } from './server';
 *
 * start({
 *   driver: new InMemoryDriver(),
 *   auth: { tokens: { 'secret-1': { tenant: 'acme', role: 'write' } } },
 * }).listen(4350);
 * ```
 */

export { createServer, start } from './server';
export { openApiDocument } from './openapi';
export {
  DriverAuditBackend,
  FileAuditSink,
  MemoryAuditSink,
  applyAuditFilter,
  clampLimit,
} from './audit';
export {
  OidcAuthenticator,
  assertTokenTable,
  authenticateStaticToken,
  createAuthenticator,
  extractBearerToken,
  jwkToPublicKey,
  parseJwks,
  requireLevel,
  scopesToLevel,
  verifyJwt,
  verifyJwtSignature,
  Levels,
  ROLE_RANK,
} from './auth';
export type { RequestAuthenticator } from './auth';
export { ServiceError, isAuthError, statusForRegistryError } from './errors';
export type { ServiceErrorCode } from './errors';
export { TokenBucketLimiter } from './ratelimit';
export type { RateLimitDecision, RateLimitTier } from './ratelimit';
export {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  assertContentHash,
  parseSignatureHeaders,
  verifyPublishSignature,
} from './signing';
export {
  assertContractName,
  assertIsoTimestamp,
  assertOrgOrProject,
  isPlainObject,
  isValidContractName,
  isValidOrgOrProject,
  validateIRPackage,
} from './validation';
export { InMemoryDriver } from './storage/memory';
export { PostgresDriver } from './storage/postgres/driver';
export type {
  AccessLevel,
  AuditBackend,
  AuditEntry,
  AuditFilter,
  AuthConfig,
  ContractMeta,
  Jwk,
  JwksDocument,
  OidcConfig,
  Principal,
  PublishInput,
  PublishMeta,
  PublishResult,
  RateLimitConfig,
  RateLimitOptions,
  RegistryRole,
  RegistryServiceOptions,
  RegistryTokenInfo,
  SigningConfig,
  StorageDriver,
  StoredContract,
  TokenTable,
} from './types';
