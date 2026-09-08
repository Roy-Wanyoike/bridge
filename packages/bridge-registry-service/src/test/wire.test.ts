/**
 * Unit tests for the PostgreSQL wire layer's concurrency primitive (the
 * FIFO promise-queue mutex that serializes every PgClient connection).
 *
 * The live wire protocol needs a real PostgreSQL server (PG_DSN-gated
 * integration); the mutex itself is the piece that fixes the shared-client
 * race (issue #47), so it is exercised directly here: interleaved
 * "queries" resolve in submission order without ever overlapping, and a
 * closed mutex fails every pending waiter fast instead of hanging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex, parseDsn } from '../storage/postgres/wire';

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

test('parseDsn: sslmode defaults to prefer, flagged for the boot log (issue #48)', () => {
  const defaulted = parseDsn('postgres://u:p@localhost:5432/bridge');
  assert.equal(defaulted.ssl, 'prefer', 'a DSN without sslmode must not silently disable TLS');
  assert.equal(defaulted.sslDefaulted, true);

  const explicit = ['disable', 'prefer', 'require', 'verify-full'] as const;
  for (const mode of explicit) {
    const parsed = parseDsn(`postgres://u:p@localhost:5432/bridge?sslmode=${mode}`);
    assert.equal(parsed.ssl, mode);
    assert.equal(parsed.sslDefaulted, false);
  }
});

test('mutex: interleaved queries resolve in submission order (FIFO)', async () => {
  const mutex = new Mutex();
  const started: number[] = [];
  const completed: number[] = [];

  // Simulate ≥50 parallel PgClient.query() calls with deliberately
  // shuffled, variable durations — the kind of HTTP-driven interleave that
  // used to overwrite the single waiter slot.
  const durations = Array.from({ length: 64 }, (_, i) => ((i * 7919) % 13) + 1); // pseudo-shuffled 1..13
  const jobs = durations.map((ms, id) =>
    mutex.run(async (): Promise<number> => {
      started.push(id);
      await new Promise((resolve) => setTimeout(resolve, ms));
      completed.push(id);
      return id;
    }),
  );

  const results = await Promise.all(jobs);
  assert.deepEqual(results, durations.map((_, id) => id), 'every caller resolves with its own result');
  assert.deepEqual(completed, durations.map((_, id) => id), 'completion order is submission order (FIFO)');
});

test('mutex: critical sections never overlap (mutual exclusion)', async () => {
  const mutex = new Mutex();
  let active = 0;
  let maxActive = 0;

  const jobs = Array.from({ length: 50 }, (_, id) =>
    mutex.run(async (): Promise<number> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      if (id % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return id;
    }),
  );

  await Promise.all(jobs);
  assert.equal(maxActive, 1, 'at most one critical section runs at any time');
});

test('mutex: a late caller cannot starve; queue drains in order', async () => {
  const mutex = new Mutex();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = mutex.run(async () => {
    await gate;
    order.push('first');
  });
  const second = mutex.run(async () => {
    order.push('second');
  });
  const third = mutex.run(async () => {
    order.push('third');
  });

  await tick();
  assert.deepEqual(order, [], 'nothing runs while the first section is in flight');
  assert.equal(mutex.pending, 2, 'second and third are queued behind the first');

  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('mutex: close() rejects all pending waiters and future run() calls', async () => {
  const mutex = new Mutex();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = mutex.run(async () => {
    await gate;
  });

  // Queue 10 waiters behind the in-flight section, then kill the mutex —
  // exactly what the PgClient socket error/close handlers do.
  const queued = Array.from({ length: 10 }, () => {
    const job = mutex.run(async (): Promise<never> => {
      throw new Error('must never start');
    });
    // Observe immediately so the rejection is never "unhandled" while we
    // assert on it below.
    return job.catch((e: Error) => e);
  });
  await tick();
  assert.equal(mutex.pending, 10);

  const err = new Error('postgres: connection closed');
  mutex.close(err);
  releaseFirst();
  await first; // the in-flight section itself completes normally

  for (const outcome of queued) {
    const failure = (await outcome) as Error;
    assert.match(failure.message, /connection closed/);
    assert.doesNotMatch(failure.message, /must never start/, 'queued sections must never run');
  }
  // New calls fail fast too — nothing may open an exchange on a dead socket.
  await assert.rejects(() => mutex.run(async () => 'x'), /connection closed/);
  assert.ok(mutex.isClosed);
});

test('mutex: rejection of one section does not break the queue', async () => {
  const mutex = new Mutex();
  const order: number[] = [];
  const jobs = [
    mutex.run(async () => {
      order.push(1);
    }),
    mutex.run(async (): Promise<void> => {
      order.push(2);
      throw new Error('boom');
    }),
    mutex.run(async () => {
      order.push(3);
    }),
  ];
  await assert.rejects(() => jobs[1]!, /boom/);
  await Promise.all([jobs[0]!, jobs[2]!]);
  assert.deepEqual(order, [1, 2, 3], 'a failing section releases the mutex for the next waiter');
});
