/**
 * Bearer-token authentication and role authorization.
 *
 * Roles form a hierarchy: `read` < `write` < `admin`.
 * - any valid token may use read endpoints (list/get/versions/dependents/search)
 * - `write` (or `admin`) is required to publish
 * - `admin` is required to read the audit endpoint
 */

import { ServiceError } from './errors';
import type { RegistryRole, RegistryTokenInfo, TokenTable } from './types';

/** Numeric rank of each role; compare with the numbers in {@link Roles}. */
export const ROLE_RANK: Record<RegistryRole, number> = { read: 1, write: 2, admin: 3 };

/** Required role levels for endpoint families. */
export const Roles = {
  /** Any valid token. */
  read: ROLE_RANK.read,
  /** Publish contracts. */
  write: ROLE_RANK.write,
  /** Read the audit log. */
  admin: ROLE_RANK.admin,
} as const;

const ALL_ROLES: readonly string[] = ['read', 'write', 'admin'];

/**
 * Validate a token table eagerly (at `createServer` time): every entry must
 * carry a non-empty string `tenant` and a known `role`. Returns the table
 * unchanged. Malformed tables are programming errors → `TypeError`.
 */
export function assertTokenTable(tokens: TokenTable): TokenTable {
  for (const [token, info] of Object.entries(tokens)) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('tokens: token strings must be non-empty');
    }
    if (
      typeof info !== 'object' ||
      info === null ||
      typeof (info as RegistryTokenInfo).tenant !== 'string' ||
      (info as RegistryTokenInfo).tenant.length === 0 ||
      !ALL_ROLES.includes((info as RegistryTokenInfo).role)
    ) {
      throw new TypeError(
        `tokens[${JSON.stringify(token)}]: expected { tenant: string, role: 'read'|'write'|'admin' }`,
      );
    }
  }
  return tokens;
}

/**
 * Authenticate a request from its `Authorization` header value.
 *
 * Accepts `Bearer <token>` (scheme case-insensitive, per RFC 7235).
 * Throws 401 `unauthenticated` when the header is missing, malformed or
 * the token is unknown.
 */
export function authenticate(tokens: TokenTable, authorization: string | undefined): RegistryTokenInfo {
  const fail = (): ServiceError =>
    new ServiceError(401, 'unauthenticated', 'missing or invalid bearer token');

  if (typeof authorization !== 'string') throw fail();
  const space = authorization.indexOf(' ');
  if (space <= 0) throw fail();
  const scheme = authorization.slice(0, space).toLowerCase();
  if (scheme !== 'bearer') throw fail();
  const token = authorization.slice(space + 1).trim();
  if (token.length === 0) throw fail();

  const info = tokens[token];
  if (info === undefined) throw fail();
  return info;
}

/**
 * Require a minimum role level; throws 403 `forbidden` when the token's
 * role ranks below it.
 */
export function requireRole(auth: RegistryTokenInfo, needed: number): void {
  if (ROLE_RANK[auth.role] < needed) {
    throw new ServiceError(
      403,
      'forbidden',
      `token role '${auth.role}' is not permitted for this operation ` +
        `(requires role level ${needed})`,
    );
  }
}
