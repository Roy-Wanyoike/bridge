/**
 * Unit tests: authentication (static tokens + OIDC JWT verification) and
 * artifact signing (ed25519 over canonical publish bodies).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { canonicalJson } from '@bridge/core';
import {
  Levels,
  assertTokenTable,
  authenticateStaticToken,
  createAuthenticator,
  extractBearerToken,
  parseJwks,
  requireLevel,
  scopesToLevel,
  verifyJwt,
} from '../auth';
import { generateSigningKey, mintJwt } from './helpers';
import { verifyPublishSignature } from '../signing';
import type { OidcConfig } from '../types';

test('static tokens: table validation', () => {
  assert.throws(() => assertTokenTable({ '': { tenant: 'acme', role: 'read' } }));
  assert.doesNotThrow(() => assertTokenTable({ t: { tenant: 'any non-empty tenant', role: 'read' } }));
  assert.throws(() => assertTokenTable({ t: { tenant: 'acme', role: 'owner' as never } }));
  assert.doesNotThrow(() => assertTokenTable({ secret: { tenant: 'acme', role: 'write' } }));
});

test('static tokens: bearer extraction and lookup', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.throws(() => extractBearerToken('Basic abc'), /Bearer/i);
  assert.throws(() => extractBearerToken(undefined), /Bearer/i);

  const principal = authenticateStaticToken({ s: { tenant: 'acme', role: 'write' } }, 'Bearer s');
  assert.equal(principal.org, 'acme');
  assert.equal(principal.level, 2);
  assert.throws(() => authenticateStaticToken({ s: { tenant: 'acme', role: 'write' } }, 'Bearer wrong'));
});

test('levels: requireLevel enforces the scope hierarchy', () => {
  const reader = {
    kind: 'token' as const,
    subject: 'token:acme',
    org: 'acme',
    level: 1 as const,
    scopes: ['registry:read'],
  };
  requireLevel(reader, Levels.read); // ok
  assert.throws(() => requireLevel(reader, Levels.publish), /not permitted/);
  const admin = {
    kind: 'token' as const,
    subject: 'token:acme',
    org: 'acme',
    level: 3 as const,
    scopes: ['registry:admin'],
  };
  requireLevel(admin, Levels.publish); // admin implies publish
});

test('scopes: admin > publish > read mapping', () => {
  assert.equal(scopesToLevel(['registry:read']), 1);
  assert.equal(scopesToLevel(['registry:publish']), 2);
  assert.equal(scopesToLevel(['registry:admin']), 3);
  assert.equal(scopesToLevel([]), 1);
});

// ------------------------------------------------------------------- OIDC

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://issuer.example.com',
    sub: 'user-123',
    aud: 'bridge-registry',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    scope: 'registry:read registry:publish',
    org: 'acme',
    ...overrides,
  };
}

function oidcConfig(jwks: { keys: unknown[] }, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: 'https://issuer.example.com',
    audience: 'bridge-registry',
    jwks: { keys: jwks.keys },
    ...overrides,
  };
}

test('OIDC: a valid RS256 token authenticates', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims());
  const claims = verifyJwt(token, cfg, keys);
  assert.equal(claims['sub'], 'user-123');
});

test('OIDC: a valid ES256 token authenticates', () => {
  const { mint, key } = generateSigningKey('ES256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'ES256', mint.kid, baseClaims());
  const claims = verifyJwt(token, cfg, keys);
  assert.equal(claims['sub'], 'user-123');
});

test('OIDC: tampered payload is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify(baseClaims({ sub: 'admin' }))).toString('base64url')}.${s}`;
  assert.throws(() => verifyJwt(forged, cfg, keys), /signature|malformed/i);
});

test('OIDC: expired token is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  const token = mintJwt(key, 'RS256', mint.kid, baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
  assert.throws(() => verifyJwt(token, cfg, keys), /expired/);
});

test('OIDC: wrong issuer/audience is rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims({ iss: 'https://evil.example.com' })), cfg, keys),
    /iss/,
  );
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims({ aud: 'other' })), cfg, keys),
    /aud/,
  );
});

test('OIDC: none-alg and unknown-kid tokens are rejected', () => {
  const { mint, key } = generateSigningKey('RS256');
  const cfg = oidcConfig({ keys: [mint.jwk] });
  const keys = parseJwks(cfg.jwks!);
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', mint.kid, baseClaims(), { alg: 'none' }), cfg, keys),
    /alg/,
  );
  assert.throws(
    () => verifyJwt(mintJwt(key, 'RS256', 'other-kid', baseClaims()), cfg, keys),
    /kid|key/i,
  );
});

test('OIDC: missing org claim is rejected by the authenticator', async () => {
  const { mint, key } = generateSigningKey('RS256');
  const claims: Record<string, unknown> = baseClaims();
  delete claims['org'];
  const authenticator = createAuthenticator({ oidc: oidcConfig({ keys: [mint.jwk] }) });
  await assert.rejects(
    () => authenticator.authenticate(`Bearer ${mintJwt(key, 'RS256', mint.kid, claims)}`),
    /org/,
  );
});

test('OIDC: an authenticator with no mechanisms fails closed', () => {
  assert.throws(() => createAuthenticator(undefined), /at least one mechanism/);
  assert.throws(() => createAuthenticator({}), /at least one mechanism/);
});

test('OIDC: end-to-end authentication via createAuthenticator', async () => {
  const { mint, key } = generateSigningKey('RS256');
  const authenticator = createAuthenticator({
    oidc: oidcConfig({ keys: [mint.jwk] }),
  });
  const principal = await authenticator.authenticate(`Bearer ${mintJwt(key, 'RS256', mint.kid, baseClaims())}`);
  assert.equal(principal.kind, 'oidc');
  assert.equal(principal.org, 'acme');
  assert.equal(principal.level, 2);
});

// ---------------------------------------------------------------- signing

test('signing: a signed publish verifies and a tampered one does not', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const body = { ir: makeIrBody(), meta: {} };
  const message = Buffer.from(canonicalJson(body), 'utf8');
  const signature = cryptoSign(null, message, privateKey);

  const result = verifyPublishSignature(
    body,
    { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
    { keys: { k1: pem } },
  );
  assert.equal(result.signed, true);

  const tampered = { ...body, ir: { ...makeIrBody(), name: 'other.v1' } };
  assert.throws(() =>
    verifyPublishSignature(
      tampered,
      { 'x-bridge-key-id': 'k1', 'x-bridge-signature': signature.toString('base64') },
      { keys: { k1: pem } },
    ),
  );
});

test('signing: unsigned publish is rejected in required mode', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.throws(
    () => verifyPublishSignature({ ir: makeIrBody() }, {}, { keys: { k1: pem } }),
    /signature-required|must be signed|signed/i,
  );
});

test('signing: unsigned publish passes in optional mode', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const result = verifyPublishSignature({ ir: makeIrBody() }, {}, { keys: { k1: pem }, mode: 'optional' });
  assert.equal(result.signed, false);
});

function makeIrBody(): Record<string, unknown> {
  return { name: 'payments.v1', imports: [], types: [], services: [], events: [] };
}
