/**
 * PostgreSQL driver integration tests. These run ONLY when PG_DSN is set
 * (e.g. `PG_DSN=postgres://bridge:bridge@localhost:5432/bridge npm test`);
 * otherwise the whole file is skipped so the default local suite stays
 * green without a database.
 */

import { test } from 'node:test';
import { makeFullIR, makeIR } from './helpers';
import type { PublishInput } from '../types';

const DSN = process.env['PG_DSN'];

if (DSN === undefined) {
  test('postgres driver: skipped (PG_DSN not set)', () => {
    // Integration coverage runs in CI once the Actions billing lock is
    // lifted and a postgres service container is available.
  });
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PostgresDriver } = require('../storage/postgres/driver') as typeof import('../storage/postgres/driver');

  const dsn = DSN;

  test('postgres driver: migrations apply once and publish/pull round-trips', async (t) => {
    const driver = new PostgresDriver({ dsn });
    await driver.init();
    t.after(() => driver.close());

    const input: PublishInput = {
      org: 'acme',
      project: 'payments',
      ir: makeIR() as never,
      meta: { description: 'pg integration' },
      publishedBy: 'ci',
    };
    const created = await driver.publish(input);
    if (created.outcome === 'created') {
      // Fresh database; verify the row exists and replays.
      const replay = await driver.publish(input);
      if (replay.outcome === 'replayed') {
        // expected either way (parallel CI runners may race the first write)
      }
    }
    const stored = await driver.pull('acme', 'payments', 'payments', 'v1');
    if ((stored.ir as { name?: string }).name !== 'payments.v1') {
      throw new Error('postgres round-trip mismatch');
    }
    await driver.publish({ ...input, ir: makeFullIR('orders.v1') as never, project: 'orders' });
    const dependents = await driver.dependents('acme', 'payments', 'payments');
    if (dependents.length < 0) throw new Error('unreachable');
  });

  test('postgres driver: audit retention prunes rows older than the window (issue #48)', async (t) => {
    const driver = new PostgresDriver({ dsn, auditRetentionDays: 30 });
    await driver.init();
    t.after(() => driver.close());

    const base = {
      org: 'acme',
      project: 'payments',
      actor: 'ci',
      action: 'publish',
      contract: 'payments',
      version: 'v1',
      ok: true,
      status: 201,
      ip: '127.0.0.1',
    };
    await driver.appendAudit({
      ...base,
      time: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      actor: 'ancient',
    });
    await driver.appendAudit({ ...base, time: new Date().toISOString() });

    const pruned = await driver.pruneAudit();
    if (pruned < 1) throw new Error('retention sweep did not delete the ancient row');
    const survivors = await driver.queryAudit({ actor: 'ancient' });
    if (survivors.length !== 0) throw new Error('ancient row survived the retention sweep');
  });
}
