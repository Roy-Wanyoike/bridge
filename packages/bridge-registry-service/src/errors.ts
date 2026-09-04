/**
 * Error plumbing for the HTTP layer.
 *
 * Two error families exist:
 * - {@link ServiceError} — HTTP-level failures raised by the service itself
 *   (bad routes, malformed bodies, auth). Carries its HTTP status.
 * - `RegistryError` (from `@bridge/registry`) — store failures, mapped to
 *   HTTP statuses by {@link statusForRegistryError}.
 *
 * Every error response has the JSON envelope `{"error": {"code", "message"}}`.
 */

/** Machine-readable codes owned by the service (not the store). */
export type ServiceErrorCode =
  /** Malformed JSON body, wrong body shape, route/IR name mismatch. */
  | 'invalid_argument'
  /** Missing, malformed or unknown bearer token. */
  | 'unauthenticated'
  /** Valid token, insufficient role. */
  | 'forbidden'
  /** Unknown route or unknown contract. */
  | 'not-found'
  /** Known route, unsupported method. */
  | 'method-not-allowed'
  /** Request body exceeds the configured size limit. */
  | 'payload-too-large'
  /** Unexpected internal failure. */
  | 'internal';

/**
 * HTTP status for a `RegistryError` code, per the service's error contract:
 * `not-found` → 404, `hash-conflict`/`immutable` → 409,
 * `invalid-name`/`invalid-version` → 400, `corrupt`/`io` → 500.
 * Unknown codes map to 500.
 */
export function statusForRegistryError(code: string): number {
  switch (code) {
    case 'not-found':
      return 404;
    case 'hash-conflict':
    case 'immutable':
      return 409;
    case 'invalid-name':
    case 'invalid-version':
      return 400;
    case 'corrupt':
    case 'io':
      return 500;
    default:
      return 500;
  }
}

/** HTTP-level error raised by the service itself. */
export class ServiceError extends Error {
  /** HTTP status to respond with. */
  public readonly status: number;
  /** Machine-readable code (see {@link ServiceErrorCode}). */
  public readonly code: ServiceErrorCode;

  constructor(status: number, code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}
