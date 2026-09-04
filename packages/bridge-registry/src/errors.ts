/**
 * Stable, machine-readable error codes for the registry.
 *
 * Consumers (CLI, tooling) should branch on `code`, never on message text.
 */
export type RegistryErrorCode =
  /** The requested package or version does not exist in the store. */
  | 'not-found'
  /** A content-addressed object already exists with different content. */
  | 'hash-conflict'
  /** Attempt to republish an existing version with different content. */
  | 'immutable'
  /** A package name argument (or stored name) violates the name rules. */
  | 'invalid-name'
  /** A version argument is malformed or conflicts with the package name. */
  | 'invalid-version'
  /** Stored registry data is missing, unparseable or fails integrity checks. */
  | 'corrupt'
  /** An unexpected filesystem failure (permissions, disk, ...). */
  | 'io';

/**
 * The error type thrown by every registry operation that can fail.
 *
 * Expected failures are always a `RegistryError` with a stable `code`;
 * programming errors (malformed arguments that are type-checkable) surface
 * as plain `TypeError`s instead.
 */
export class RegistryError extends Error {
  /** Machine-readable failure code — see {@link RegistryErrorCode}. */
  public readonly code: RegistryErrorCode;

  constructor(
    code: RegistryErrorCode,
    message: string,
    /** Underlying error (e.g. a NodeJS `SystemError`), when there is one. */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RegistryError';
    this.code = code;
  }
}
