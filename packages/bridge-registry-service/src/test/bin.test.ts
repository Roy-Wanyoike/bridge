/**
 * Unit tests: CLI option building for the issue #48 hardened defaults —
 * production-profile gating, strict-TLS sslmode mapping and the fact that
 * the plain profile leaves the server defaults (rate limiting ON) in charge.
 * No sockets are opened: PostgresDriver connects lazily.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, productionProfileSsl } from '../bin/bridge-registry-service';
import type { Config } from '../bin/bridge-registry-service';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    driver: 'memory',
    tokens: {},
    signingKeys: {},
    signingOptional: false,
    productionProfile: false,
    ...overrides,
  };
}

test('production profile: strict-TLS sslmode mapping (issue #48)', () => {
  assert.equal(productionProfileSsl(undefined), 'require');
  assert.equal(productionProfileSsl('prefer'), 'require');
  assert.equal(productionProfileSsl('require'), 'require');
  assert.equal(productionProfileSsl('verify-full'), 'verify-full');
  assert.throws(() => productionProfileSsl('disable'), /sslmode=disable/);
});

test('production profile: signing is mandatory and throttling is on (issue #48)', () => {
  assert.throws(() => buildOptions(baseConfig({ productionProfile: true })), /--signing-key/);
  assert.throws(
    () =>
      buildOptions(baseConfig({ productionProfile: true, signingKeys: { k1: 'pem' }, signingOptional: true })),
    /--signing-optional/,
  );

  const options = buildOptions(baseConfig({ productionProfile: true, signingKeys: { k1: 'pem' } }));
  assert.equal(options.rateLimit?.enabled, true);
  assert.equal(options.signing?.mode, 'required');
});

test('production profile: postgres DSN is upgraded to sslmode=require (issue #48)', () => {
  const options = buildOptions(
    baseConfig({
      productionProfile: true,
      signingKeys: { k1: 'pem' },
      driver: 'postgres',
      pgDsn: 'postgres://u:p@db.example.test/bridge',
    }),
  );
  assert.equal(options.driver.kind, 'postgres');

  // An explicit sslmode=disable DSN is refused outright.
  assert.throws(
    () =>
      buildOptions(
        baseConfig({
          productionProfile: true,
          signingKeys: { k1: 'pem' },
          driver: 'postgres',
          pgDsn: 'postgres://u:p@db.example.test/bridge?sslmode=disable',
        }),
      ),
    /TLS is mandatory/,
  );
});

test('plain profile leaves the server defaults in charge (issue #48)', () => {
  const options = buildOptions(baseConfig());
  assert.equal(options.rateLimit, undefined, 'the server enables its limiter by default');
  assert.equal(options.driver.kind, 'memory');
});
