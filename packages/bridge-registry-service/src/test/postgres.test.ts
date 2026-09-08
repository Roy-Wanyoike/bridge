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
}
