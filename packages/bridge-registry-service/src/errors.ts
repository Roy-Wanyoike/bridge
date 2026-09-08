/**
 * Error plumbing for the HTTP layer.
 *
 * Two error families exist:
 * - {@link ServiceError} — HTTP-level failures raised by the service itself
 *   (bad routes, malformed bodies, auth, rate limits). Carries its HTTP
 *   status and optional structured `details`.
 * - `RegistryError` (from `@bridge/registry`) — storage-level failures,
 *   mapped to HTTP statuses by {@link statusForRegistryError}.
 *
 * Every error response uses the JSON envelope
 * `{"error": {"code": ..., "message": ..., "details"?: ...}}`. Internal
 * failures never leak stack traces or underlying driver messages.
 */

/**
 * Machine-readable codes owned by the service (not the store).
 * The full table is rendered into the OpenAPI document (`Error` schema).
 */
export type ServiceErrorCode =
  /** Malformed JSON body, wrong body shape, bad coordinates. */
  | 'invalid_argument'
  /** The contract content failed structural validation (`details.errors`). */
  | 'invalid_contract'
  /** Declared content hash does not match the actual canonical IR hash. */
  | 'hash-mismatch'
  /** Missing, malformed or unverifiable bearer token / artifact signature. */
  | 'unauthenticated'
  /** Missing artifact signature on a publish (signing mode `required`). */
  | 'signature-required'
  /** Artifact signature did not verify, or unknown signing key id. */
  | 'invalid-signature'
  /** Valid credentials, insufficient scope. */
  | 'forbidden'
  /** Valid credentials but no org binding (OIDC `org` claim missing). */
  | 'missing-org-claim'
  /** Unknown route — also used for resources in other tenants (no leak). */
  | 'not-found'
  /** Known route, unsupported method. */
  | 'method-not-allowed'
  /** Request body exceeds the configured size limit. */
  | 'payload-too-large'
  /** Rate limit exceeded; see the `Retry-After` response header. */
  | 'rate-limited'
  /** Auth is misconfigured at boot (fail-closed). */
  | 'auth-unconfigured'
  /** Storage is unavailable. */
  | 'storage-unavailable'
  /** Unexpected internal failure. */
  | 'internal';

/** HTTP status for a `RegistryError` code, per the service's error contract:
 * `not-found` → 404, `hash-conflict`/`immutable` → 409,
 * `invalid-name`/`invalid-version` → 400, `corrupt`/`io` → 500.
 * Unknown codes map to 500. */
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
  /** Structured extras rendered in the error envelope when present. */
  public readonly details?: unknown;

  constructor(status: number, code: ServiceErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** `true` when the error represents an authentication/authorization failure. */
export function isAuthError(err: unknown): err is ServiceError {
  return (
    err instanceof ServiceError &&
    (err.code === 'unauthenticated' ||
      err.code === 'forbidden' ||
      err.code === 'missing-org-claim' ||
      err.code === 'signature-required' ||
      err.code === 'invalid-signature')
  );
}
