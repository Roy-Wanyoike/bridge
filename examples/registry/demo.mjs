// Demo: the local, content-addressed contract registry (@bridge/registry).
//
// Publishes payments.v1 + a dependent orders.v1 contract into a throwaway
// registry, then walks through versions / search / inspect / verify /
// dependents. The registry root is a temp dir, so the demo is repeatable.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeCompiler, compileSource } from '@bridge/core';
import { RegistryStore } from '@bridge/registry';

const dir = import.meta.dirname;

// 1. Compile the payments contract (no dependencies).
const paymentsSource = readFileSync(
  join(dir, '..', 'payments', 'payments.bridge'),
  'utf8',
);
const payments = compileSource(paymentsSource, 'payments.bridge');
if (!payments.ok) {
  console.error('payments.bridge failed to compile:');
  for (const d of payments.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}

// 2. Compile the orders contract, resolving its `import payments.v1`
//    against the already-compiled payments IR.
const ordersSource = readFileSync(join(dir, 'orders.bridge'), 'utf8');
const orders = bridgeCompiler.compilePackage(
  ordersSource,
  'orders.bridge',
  new Map([['payments.v1', payments.ir]]),
);
if (!orders.ok) {
  console.error('orders.bridge failed to compile:');
  for (const d of orders.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}

// 3. Publish both into a throwaway registry.
//    `publishTime` is fixed so the demo output is deterministic; real callers
//    pass the current time (or omit it — nothing is generated implicitly).
const root = mkdtempSync(join(tmpdir(), 'bridge-registry-demo-'));
const store = new RegistryStore(root);
const PUBLISH_TIME = '2024-01-15T09:00:00Z';

const paymentsMeta = store.publish(
  payments.ir,
  { owner: 'team-payments', description: 'Payments contract' },
  { publishTime: PUBLISH_TIME },
);
console.log(
  `published ${paymentsMeta.packageName}  hash=${paymentsMeta.shortHash}  version=${paymentsMeta.version}`,
);

const ordersMeta = store.publish(
  orders.ir,
  { owner: 'team-orders', description: 'Orders contract' },
  { publishTime: PUBLISH_TIME },
);
console.log(
  `published ${ordersMeta.packageName}     hash=${ordersMeta.shortHash}  version=${ordersMeta.version}`,
);

// 4. Walk the registry API.
console.log(`versions('payments.v1'): ${store.versions('payments.v1').join(', ')}`);
console.log(
  `search('payment'): ${store
    .search('payment')
    .map((m) => `${m.packageName}@${m.version}`)
    .join(', ')}`,
);
const inspected = store.inspect('payments.v1', 'v1');
console.log(
  `inspect('payments.v1', 'v1'): owner=${inspected.owner} imports=${inspected.imports.length === 0 ? '(none)' : inspected.imports.join(', ')}`,
);
const verified = store.verify('payments.v1', 'v1');
console.log(
  `verify('payments.v1', 'v1'): ok=${verified.ok} hash matches content address (${verified.hash.slice(0, 12)})`,
);
console.log(
  `dependents('payments.v1'): ${store
    .dependents('payments.v1')
    .map((m) => `${m.packageName}@${m.version}`)
    .join(', ')}`,
);

rmSync(root, { recursive: true, force: true });
