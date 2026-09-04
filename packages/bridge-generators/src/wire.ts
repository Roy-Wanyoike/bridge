/**
 * Shared wire-format constants for the event envelope (#16) and the JSON
 * over HTTP RPC shape (#17) that EVERY language generator emits.
 *
 * Keeping the literals in one module is what guarantees the four generated
 * languages interoperate: identical envelope keys, identical event type
 * strings and identical error-code → HTTP-status mapping in Go, Rust,
 * TypeScript and Python output.
 *
 * Wire contract (docs/EVENTS.md + docs/RPC.md):
 * - Event envelope (CloudEvents-style):
 *   `{"specversion": "1.0", "id": <uuid>, "source": <string>,
 *     "type": "<package>.<EventName>", "time": <RFC3339>, "data": {...}}`.
 *   `id`, `source` and `time` are ALWAYS supplied by the caller — generated
 *   code contains no clocks and no uuid generation (determinism).
 * - RPC: POST `/{package}/{Service}/{Method}`, JSON request/response bodies,
 *   errors as `{"code": string, "message": string}` with the canonical
 *   HTTP mapping below.
 */

/** CloudEvents `specversion` emitted in every generated envelope. */
export const ENVELOPE_SPECVERSION = '1.0';

/** Envelope top-level keys in wire order (documentation/tests reference). */
export const ENVELOPE_KEYS = [
  'specversion',
  'id',
  'source',
  'type',
  'time',
  'data',
] as const;

/**
 * Fully-qualified event type: `"<package>.<EventName>"`, e.g.
 * `payments.v1.PaymentCaptured`.
 */
export function eventTypeName(packageName: string, eventName: string): string {
  return `${packageName}.${eventName}`;
}

/**
 * Canonical Bridge RPC error codes with their HTTP status mapping. The same
 * table is emitted as a `switch`/`match`/`dict` in every target language.
 * Unknown codes fall back to 500 (`internal`).
 */
export const RPC_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  method_not_allowed: 405,
  already_exists: 409,
  failed_precondition: 412,
  resource_exhausted: 429,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  deadline_exceeded: 504,
};

/** Codes in stable, sorted-by-status order for deterministic emission. */
export const RPC_ERROR_CODES_SORTED: readonly string[] = Object.keys(
  RPC_ERROR_STATUS,
).sort((a, b) => {
  const statusDiff = RPC_ERROR_STATUS[a]! - RPC_ERROR_STATUS[b]!;
  return statusDiff !== 0 ? statusDiff : a < b ? -1 : a > b ? 1 : 0;
});

/** HTTP status for an error code; unknown codes map to 500. */
export function rpcErrorStatus(code: string): number {
  return RPC_ERROR_STATUS[code] ?? 500;
}
