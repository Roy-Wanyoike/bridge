/**
 * Artifact signing: ed25519 signatures over publish payloads.
 *
 * Publishers sign the canonical JSON of the publish body with an ed25519
 * private key; the service verifies against the configured public half
 * before persisting. Because the message is the *canonical* JSON (keys
 * sorted, via `@bridge/core`'s `canonicalJson`), any byte-level
 * re-serialization of the same object still verifies, but any content
 * change — even a single value — invalidates the signature (tamper
 * detection).
 *
 * Wire format (request headers):
 * - `x-bridge-key-id`: key id configured in `SigningConfig.keys`
 * - `x-bridge-signature`: base64 (or base64url) ed25519 signature
 *
 * Additionally, a publish body MAY carry `contentHash` (SHA-256 hex of the
 * canonical IR). When present, the service compares it to the freshly
 * computed `hashPackage(ir)` and rejects mismatches with 400 — an explicit
 * tamper tripwire that is independent of the signature.
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@bridge/core';
import { ServiceError } from './errors';
import type { SigningConfig } from './types';

const SIGNATURE_HEADER = 'x-bridge-signature';
const KEY_ID_HEADER = 'x-bridge-key-id';
const MAX_SIGNATURE_LENGTH = 512;
const MAX_KEY_ID_LENGTH = 256;

export { SIGNATURE_HEADER, KEY_ID_HEADER };

interface LoadedKeys {
  keys: Map<string, KeyObject>;
  mode: 'required' | 'optional';
}

function loadKeys(config: SigningConfig | undefined): LoadedKeys {
  const keys = new Map<string, KeyObject>();
  let mode: 'required' | 'optional' = 'optional';
  if (config !== undefined && config.keys !== undefined && typeof config.keys === 'object') {
    for (const [kid, pem] of Object.entries(config.keys)) {
      if (typeof kid !== 'string' || kid.length === 0 || kid.length > MAX_KEY_ID_LENGTH) {
        throw new TypeError(`signing.keys: key ids must be non-empty strings (max ${MAX_KEY_ID_LENGTH} chars)`);
      }
      if (typeof pem !== 'string' && !Buffer.isBuffer(pem)) {
        throw new TypeError(`signing.keys[${kid}]: expected a PEM string or Buffer`);
      }
      let key: KeyObject;
      try {
        key = createPublicKeySafe(pem);
      } catch (err) {
        throw new TypeError(`signing.keys[${kid}]: not a readable public key: ${(err as Error).message}`);
      }
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new TypeError(`signing.keys[${kid}]: only ed25519 keys are supported`);
      }
      keys.set(kid, key);
    }
    if (keys.size > 0) mode = config.mode ?? 'required';
  }
  return { keys, mode };
}

function createPublicKeySafe(pem: string | Buffer): KeyObject {
  return createPublicKey(pem as string);
}

/** Parsed signature material from request headers. */
export interface ArtifactSignature {
  keyId: string;
  signature: Buffer;
}

/** Extract and structurally validate signature headers (no crypto yet). */
export function parseSignatureHeaders(headers: Record<string, string | string[] | undefined>): ArtifactSignature | null {
  const rawSig = headerValue(headers, SIGNATURE_HEADER);
  const rawKid = headerValue(headers, KEY_ID_HEADER);
  if (rawSig === undefined && rawKid === undefined) return null;
  if (rawSig === undefined || rawKid === undefined) {
    throw new ServiceError(
      401,
      'invalid-signature',
      `publish requires both ${SIGNATURE_HEADER} and ${KEY_ID_HEADER} headers`,
    );
  }
  if (rawSig.length > MAX_SIGNATURE_LENGTH || !/^[A-Za-z0-9+/=_-]+$/.test(rawSig)) {
    throw new ServiceError(401, 'invalid-signature', 'signature header is malformed');
  }
  if (rawKid.length > MAX_KEY_ID_LENGTH) {
    throw new ServiceError(401, 'invalid-signature', 'key id header is malformed');
  }
  const signature = Buffer.from(rawSig, 'base64');
  if (signature.length !== 64) {
    throw new ServiceError(401, 'invalid-signature', 'ed25519 signatures are 64 bytes');
  }
  return { keyId: rawKid, signature };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const direct = headers[name];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string') return direct[0];
  // Node lower-cases incoming header names; tolerate exact-case too.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

/** Verify the artifact signature over the canonical JSON of `body`. */
export function verifyPublishSignature(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  config: SigningConfig | undefined,
): { mode: 'required' | 'optional'; signed: boolean } {
  const { keys, mode } = loadKeys(config);
  const parsed = parseSignatureHeaders(headers);

  if (parsed === null) {
    if (mode === 'required') {
      throw new ServiceError(
        401,
        'signature-required',
        `publishes must be signed: set the ${SIGNATURE_HEADER} and ${KEY_ID_HEADER} headers ` +
          '(ed25519 signature over the canonical JSON of the request body)',
      );
    }
    return { mode, signed: false };
  }

  const key = keys.get(parsed.keyId);
  if (key === undefined) {
    throw new ServiceError(401, 'invalid-signature', `unknown signing key id '${parsed.keyId}'`);
  }
  const message = Buffer.from(canonicalJson(body), 'utf8');
  if (!cryptoVerify(null, message, key, parsed.signature)) {
    throw new ServiceError(
      401,
      'invalid-signature',
      'artifact signature verification failed: the payload does not match the signature',
    );
  }
  return { mode, signed: true };
}

/** Compare an optional declared `contentHash` with the actual IR hash. */
export function assertContentHash(bodyIsh: Record<string, unknown>, actualHash: string): void {
  const declared = bodyIsh['contentHash'];
  if (declared === undefined) return;
  if (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared)) {
    throw new ServiceError(400, 'invalid_argument', 'contentHash must be a 64-char lowercase hex SHA-256');
  }
  if (declared !== actualHash) {
    throw new ServiceError(
      400,
      'hash-mismatch',
      `contentHash mismatch: declared ${declared}, actual ${actualHash}. ` +
        'The payload was tampered with or the publisher hashed different content.',
    );
  }
}
