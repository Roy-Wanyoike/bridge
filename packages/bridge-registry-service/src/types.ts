/**
 * Public types of the registry service.
 *
 * The service is a thin, dependency-free `node:http` layer over a
 * {@link RegistryStore}: it adds bearer-token auth, tenant recording,
 * an append-only audit log and stable JSON error envelopes.
 */

import type { RegistryStore } from '@bridge/registry';

/** Access role carried by a token. Higher roles imply lower ones. */
export type RegistryRole = 'read' | 'write' | 'admin';

/** Parsed credential attached to one bearer token. */
export interface RegistryTokenInfo {
  /**
   * Tenant the token belongs to. Recorded verbatim as `owner` in contract
   * metadata for every publish made with this token.
   */
  tenant: string;
  role: RegistryRole;
}

/** Token table: raw bearer token → credentials. */
export type TokenTable = Readonly<Record<string, RegistryTokenInfo>>;

/** One append-only audit record (also one JSONL line on disk). */
export interface AuditEntry {
  /** ISO8601 timestamp taken when the entry was appended. */
  time: string;
  /**
   * Attempted operation: `'publish'` (PUT contract), `'read'` (any other
   * GET on the API) or `'audit'` (GET /api/v1/audit).
   */
  action: 'publish' | 'read' | 'audit';
  /** Token tenant, or `null` when the request had no recognizable token. */
  tenant: string | null;
  /** Route package name, or `null` when the route has none. */
  contract: string | null;
  /** Resolved version when known, otherwise `null`. */
  version: string | null;
  /** `true` when the operation succeeded. */
  ok: boolean;
}

/**
 * Audit sink. The default file sink appends JSONL lines; provide a custom
 * implementation to forward entries elsewhere (syslog, queue, ...).
 */
export interface AuditSink {
  /** Append one entry. Must not throw for lost-write tolerance in handlers. */
  append(entry: AuditEntry): void;
  /** Return up to `limit` most recent entries, in append order. */
  tail(limit: number): AuditEntry[];
}

export interface RegistryServiceOptions {
  /** Backing registry store (from `@bridge/registry`). */
  store: RegistryStore;
  /**
   * Bearer tokens. Keys are raw token strings compared by map lookup
   * (not constant-time — treat as ordinary secrets, serve over TLS).
   * An empty/omitted table means every API request is unauthenticated.
   */
  tokens?: TokenTable;
  /**
   * Audit destination: a JSONL file path (created/appended, fsync-less)
   * or a custom {@link AuditSink}. Defaults to an in-memory sink whose
   * entries are lost on restart — pass a path for durable audit logs.
   */
  audit?: string | AuditSink;
  /** Bind host for {@link start}; defaults to all interfaces. */
  host?: string;
}
