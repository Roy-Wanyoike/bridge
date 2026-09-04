import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { canonicalJson, hashPackage } from '@bridge/core';
import { RegistryError, RegistryStore } from '../index';
import type { ContractMeta } from '../types';
import { makeIr } from './fixtures';
import type { IRPackage } from '@bridge/core';

// --------------------------------------------------------------------- helpers

/** Fresh isolated store rooted in a per-test temp dir, cleaned up on exit. */
function makeStore(t: TestContext): { store: RegistryStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { store: new RegistryStore(root), root };
}

function assertRegistryError(fn: () => unknown, code: RegistryError['code'], msg?: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof RegistryError && err.code === code,
    msg ?? `expected RegistryError with code '${code}'`,
  );
}

/** Recursively list every file under `dir`. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function objectFile(root: string, hash: string): string {
  return join(root, 'objects', hash.slice(0, 2), `${hash}.json`);
}

// ------------------------------------------------------------------- lifecycle

test('publish + pull round-trip preserves the IR exactly (deep equality)', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1', ['identity.v1']);
  store.publish(ir);
  const pulled = store.pull('payments.v1', 'v1');
  assert.deepEqual(pulled.ir, ir);
});

test('publish returns complete, correct ContractMeta', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1', ['identity.v1', 'shared.money.v2']);
  const meta = store.publish(ir, { owner: 'team-payments', description: 'Payment contracts' });
  assert.equal(meta.packageName, 'payments.v1');
  assert.equal(meta.base, 'payments');
  assert.equal(meta.version, 'v1');
  assert.equal(meta.hash, hashPackage(ir));
  assert.equal(meta.shortHash.length, 12);
  assert.equal(meta.shortHash, meta.hash.slice(0, 12));
  assert.deepEqual(meta.imports, ['identity.v1', 'shared.money.v2']);
  assert.equal(meta.owner, 'team-payments');
  assert.equal(meta.description, 'Payment contracts');
});

test('storage layout matches the spec exactly (object bytes, pointer, meta)', (t) => {
  const { store, root } = makeStore(t);
  const ir = makeIr('payments.v1');
  const meta = store.publish(ir);

  const objPath = objectFile(root, meta.hash);
  assert.ok(existsSync(objPath), `object should exist at ${objPath}`);
  assert.equal(readFileSync(objPath, 'utf8'), canonicalJson(ir));

  const pointer = JSON.parse(
    readFileSync(join(root, 'packages', 'payments', 'v1', 'contract.json'), 'utf8'),
  );
  assert.deepEqual(pointer, { hash: meta.hash, package: 'payments.v1' });

  const stored = JSON.parse(
    readFileSync(join(root, 'packages', 'payments', 'v1', 'meta.json'), 'utf8'),
  );
  assert.equal(stored.hash, meta.hash);
  assert.equal(store.paths.index, join(root, 'index.json'));
  assert.ok(existsSync(store.paths.index), 'index.json should exist after publish');
});

test('meta.json is deterministic: sorted keys, absent fields omitted', (t) => {
  const { store, root } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  const raw = JSON.parse(readFileSync(join(root, 'packages', 'payments', 'v1', 'meta.json'), 'utf8'));
  const keys = Object.keys(raw) as string[];
  assert.deepEqual(keys, [...keys].sort(), 'canonicalJson must sort object keys');
  assert.deepEqual(keys.sort(), ['base', 'hash', 'imports', 'packageName', 'shortHash', 'version']);
  assert.ok(!('owner' in raw));
  assert.ok(!('description' in raw));
  assert.ok(!('publishedAt' in raw));
});

test('publishedAt is absent unless publishTime is passed — never generated implicitly', (t) => {
  const { store, root } = makeStore(t);
  const meta = store.publish(makeIr('payments.v1'));
  assert.ok(!('publishedAt' in meta));
  assert.ok(!('publishedAt' in store.inspect('payments.v1', 'v1')));
  const raw = JSON.parse(readFileSync(join(root, 'packages', 'payments', 'v1', 'meta.json'), 'utf8'));
  assert.ok(!('publishedAt' in raw));
});

test('publishedAt is stored exactly as passed (verbatim, not reformatted)', (t) => {
  const { store, root } = makeStore(t);
  const when = '2025-06-01T12:00:00.000Z';
  const meta = store.publish(makeIr('fraud.v2'), {}, { publishTime: when });
  assert.equal(meta.publishedAt, when);
  const raw = JSON.parse(readFileSync(join(root, 'packages', 'fraud', 'v2', 'meta.json'), 'utf8'));
  assert.equal(raw.publishedAt, when);
});

test('imports are deduplicated and sorted in stored meta', (t) => {
  const { store } = makeStore(t);
  const meta = store.publish(makeIr('orders.v1', ['shared.money.v2', 'payments.v1', 'shared.money.v2']));
  assert.deepEqual(meta.imports, ['payments.v1', 'shared.money.v2']);
});

test('republishing identical content is an idempotent no-op returning the original meta', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1');
  const first = store.publish(ir, { owner: 'team-a' });
  const second = store.publish(ir, { owner: 'team-a' });
  assert.deepEqual(second, first);
  assert.equal(store.versions('payments.v1').length, 1);
});

test('republish ignores changed publish metadata (versions are immutable)', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1');
  const first = store.publish(ir, { owner: 'team-a' });
  const second = store.publish(ir, { owner: 'team-b', description: 'try to sneak an edit in' });
  assert.deepEqual(second, first);
  assert.equal(second.owner, 'team-a');
  assert.equal(store.inspect('payments.v1', 'v1').owner, 'team-a');
});

test('republish self-heals a missing object file without error', (t) => {
  const { store, root } = makeStore(t);
  const ir = makeIr('payments.v1');
  const meta = store.publish(ir);
  rmSync(objectFile(root, meta.hash));
  const again = store.publish(ir);
  assert.deepEqual(again, meta);
  assert.ok(existsSync(objectFile(root, meta.hash)), 'object should be restored');
});

test('republishing a version with different content throws immutable', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1', [], 0));
  assertRegistryError(() => store.publish(makeIr('payments.v1', [], 1)), 'immutable');
  // The stored artifact must be untouched by the failed attempt.
  assert.deepEqual(store.pull('payments.v1', 'v1').ir, makeIr('payments.v1', [], 0));
});

test('publishing onto a tampered object slot throws hash-conflict', (t) => {
  const { store, root } = makeStore(t);
  const ir = makeIr('payments.v1');
  const hash = hashPackage(ir);
  const dir = join(root, 'objects', hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.json`), '{"name":"impostor"}');
  assertRegistryError(() => store.publish(ir), 'hash-conflict');
});

test('multi-segment bases store under packages/<dotted-base>/<version>', (t) => {
  const { store, root } = makeStore(t);
  const ir = makeIr('identity.internal.v2');
  const meta = store.publish(ir);
  assert.equal(meta.base, 'identity.internal');
  assert.equal(meta.version, 'v2');
  assert.ok(existsSync(join(root, 'packages', 'identity.internal', 'v2', 'meta.json')));
  assert.deepEqual(store.pull('identity.internal.v2', 'v2').ir, ir);
  assert.deepEqual(store.versions('identity.internal'), ['v2']);
  assert.equal(store.latest('identity.internal').packageName, 'identity.internal.v2');
});

test('base-only names publish via opts.version (numeric input normalized)', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments');
  const meta = store.publish(ir, {}, { version: '3' });
  assert.equal(meta.version, 'v3');
  assert.equal(meta.packageName, 'payments');
  assert.deepEqual(store.pull('payments', 'v3').ir, ir);
  assert.deepEqual(store.versions('payments'), ['v3']);
  assert.equal(store.latest('payments').version, 'v3');
});

test('opts.version conflicting with the name-derived version throws invalid-version', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.publish(makeIr('payments.v1'), {}, { version: 'v2' }), 'invalid-version');
});

test('base-only name without opts.version throws invalid-version', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.publish(makeIr('payments')), 'invalid-version');
});

// -------------------------------------------------------------------- querying

test('versions lists published versions oldest → newest (v2 before v10)', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v10'));
  store.publish(makeIr('payments.v2'));
  store.publish(makeIr('payments.v1'));
  assert.deepEqual(store.versions('payments.v1'), ['v1', 'v2', 'v10']);
  assert.deepEqual(store.versions('payments'), ['v1', 'v2', 'v10']);
});

test('versions of an unknown package are an empty array', (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.versions('ghost.v1'), []);
});

test('latest picks the numerically greatest version', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('payments.v10'));
  store.publish(makeIr('payments.v2'));
  assert.equal(store.latest('payments.v1').version, 'v10');
  assert.equal(store.latest('payments').version, 'v10');
});

test('latest of an unknown package throws not-found', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.latest('ghost.v1'), 'not-found');
});

test('inspect returns the stored meta for a version', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1');
  const published = store.publish(ir, { owner: 'team-payments' });
  const inspected = store.inspect('payments.v1', 'v1');
  assert.deepEqual(inspected, published);
});

test('inspect of an unknown version throws not-found', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.inspect('payments.v1', 'v1'), 'not-found');
  assertRegistryError(() => store.inspect('payments.v1', 'v99'), 'not-found');
});

test('pull of an unknown package throws not-found', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.pull('ghost.v1', 'v1'), 'not-found');
});

test('pull of an unknown version of a known package throws not-found', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  assertRegistryError(() => store.pull('payments.v1', 'v2'), 'not-found');
});

test('list on a fresh store is empty and creates nothing', (t) => {
  const { store, root } = makeStore(t);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.versions('payments.v1'), []);
  // Constructor and reads are side-effect free: no dirs materialize.
  assert.ok(!existsSync(join(root, 'objects')));
  assert.ok(!existsSync(join(root, 'packages')));
  assert.ok(!existsSync(join(root, 'index.json')));
});

test('list returns the latest meta per package in deterministic base order', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'), { owner: 'p1' });
  store.publish(makeIr('payments.v2'), { owner: 'p2' });
  store.publish(makeIr('fraud.v2'), { owner: 'f' });
  const list = store.list();
  assert.deepEqual(
    list.map((m) => `${m.base}@${m.version}`),
    ['fraud@v2', 'payments@v2'],
  );
  assert.equal(list[1]?.owner, 'p2');
});

test('search matches by package name', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('identity.v1'));
  const hits = store.search('payments');
  assert.deepEqual(hits.map((m) => m.packageName), ['payments.v1']);
});

test('search matches by description', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('fraud.v2'), { description: 'Real-time fraud scoring for payments' });
  store.publish(makeIr('identity.v1'), { description: 'Identity and access' });
  const hits = store.search('fraud scoring');
  assert.deepEqual(hits.map((m) => m.packageName), ['fraud.v2']);
});

test('search matches by owner', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'), { owner: 'team-alpha' });
  store.publish(makeIr('identity.v1'), { owner: 'team-beta' });
  const hits = store.search('alpha');
  assert.deepEqual(hits.map((m) => m.packageName), ['payments.v1']);
});

test('search is case-insensitive and deterministic across calls', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('payments.v2'));
  store.publish(makeIr('fraud.v2'), { description: 'checks payments for fraud' });
  const expected = ['fraud@v2', 'payments@v1', 'payments@v2'];
  const first = store.search('PAYMENTS').map((m) => `${m.base}@${m.version}`);
  const second = store.search('payments').map((m) => `${m.base}@${m.version}`);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
});

test('search with no matches returns an empty array; empty query matches all', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('identity.v1'));
  assert.deepEqual(store.search('zzz-nothing'), []);
  assert.deepEqual(
    store.search('').map((m) => m.packageName),
    ['identity.v1', 'payments.v1'],
  );
});

// -------------------------------------------------------------------- integrity

test('verify returns ok with the stored hash when content is intact', (t) => {
  const { store } = makeStore(t);
  const ir = makeIr('payments.v1');
  const meta = store.publish(ir);
  assert.deepEqual(store.verify('payments.v1', 'v1'), { ok: true, hash: meta.hash });
  assert.deepEqual(store.verify('payments', 'v1'), { ok: true, hash: meta.hash });
});

test('tampered object bytes make pull throw corrupt', (t) => {
  const { store, root } = makeStore(t);
  const ir = makeIr('payments.v1');
  const meta = store.publish(ir);
  const objPath = objectFile(root, meta.hash);
  writeFileSync(objPath, canonicalJson(makeIr('payments.v1', [], 99)));
  assertRegistryError(() => store.pull('payments.v1', 'v1'), 'corrupt');
});

test('tampered object bytes make verify throw corrupt', (t) => {
  const { store, root } = makeStore(t);
  const meta = store.publish(makeIr('payments.v1'));
  writeFileSync(objectFile(root, meta.hash), 'not json at all');
  assertRegistryError(() => store.verify('payments.v1', 'v1'), 'corrupt');
});

// ----------------------------------------------------------------------- graph

test('dependents lists direct dependents only (not transitive ones)', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('fraud.v2', ['payments.v1']));
  store.publish(makeIr('orders.v1', ['fraud.v2']));
  const deps = store.dependents('payments.v1');
  assert.deepEqual(deps.map((m) => m.packageName), ['fraud.v2']);
});

test('dependents matches imports of the base name too', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('ledger.v1', ['payments']));
  assert.deepEqual(
    store.dependents('payments.v1').map((m) => m.packageName),
    ['ledger.v1'],
  );
});

test('dependents never includes the package itself', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  assert.deepEqual(store.dependents('payments.v1'), []);
  assert.deepEqual(store.dependents('payments'), []);
});

test('dependencies returns the transitive closure in BFS order', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('fraud.v2', ['payments.v1']));
  store.publish(makeIr('orders.v1', ['fraud.v2']));
  assert.deepEqual(store.dependencies('orders.v1'), ['fraud.v2', 'payments.v1']);
});

test('dependencies is cycle-safe (a → b → a terminates)', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('cyc.a.v1', ['cyc.b.v1']));
  store.publish(makeIr('cyc.b.v1', ['cyc.a.v1']));
  assert.deepEqual(store.dependencies('cyc.a.v1'), ['cyc.b.v1']);
  assert.deepEqual(store.dependencies('cyc.b.v1'), ['cyc.a.v1']);
});

test('dependencies includes unpublished imports but does not traverse them', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('orders.v1', ['ghost.v9']));
  assert.deepEqual(store.dependencies('orders.v1'), ['ghost.v9']);
});

test('dependencies of a package without imports is empty', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  assert.deepEqual(store.dependencies('payments.v1'), []);
});

test('dependencies resolves an explicit root version and bare-base imports to latest', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('payments.v2'));
  // Bare-base imports resolve to the latest published version of that base.
  store.publish(makeIr('orders.v1', ['payments']));
  // Import references appear as recorded, not rewritten to resolved names.
  assert.deepEqual(store.dependencies('orders.v1', 'v1'), ['payments']);
  assert.deepEqual(store.dependencies('orders.v1'), ['payments']);
});

test('dependencies of an unknown package throws not-found', (t) => {
  const { store } = makeStore(t);
  assertRegistryError(() => store.dependencies('ghost.v1'), 'not-found');
});

// ---------------------------------------------------------------- path safety

test('invalid package names are rejected everywhere with invalid-name', (t) => {
  const { store } = makeStore(t);
  const badNames = [
    '../etc/passwd',
    '/abs/payments',
    'Payments',
    '',
    'payments..v1',
    'pay~ments',
    'payments/v1',
    'payments\\v1',
    '.hidden',
    'payments.',
    'payments-',
    '1payments',
  ];
  for (const name of badNames) {
    const label = JSON.stringify(name);
    assertRegistryError(() => store.publish(makeIr(name)), 'invalid-name', `invalid-name for publish(${label})`);
    assertRegistryError(() => store.pull(name, 'v1'), 'invalid-name', `invalid-name for pull(${label})`);
    assertRegistryError(() => store.versions(name), 'invalid-name', `invalid-name for versions(${label})`);
    assertRegistryError(() => store.dependents(name), 'invalid-name', `invalid-name for dependents(${label})`);
  }
});

test('traversal attempts via the version argument are rejected with invalid-version', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  for (const bad of ['../../etc', 'v1/../../x', 'junk', '']) {
    const label = JSON.stringify(bad);
    assertRegistryError(() => store.pull('payments.v1', bad), 'invalid-version', `invalid-version for ${label}`);
    assertRegistryError(() => store.inspect('payments.v1', bad), 'invalid-version', `invalid-version for ${label}`);
  }
});

// ------------------------------------------------------------------ atomicity

test('publish leaves no .tmp or hidden-file leftovers anywhere in the store', (t) => {
  const { store, root } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('payments.v2'));
  store.publish(makeIr('fraud.v2', ['payments.v1']));
  store.publish(makeIr('identity.internal.v2'));
  const files = walkFiles(root);
  assert.ok(files.length > 0);
  for (const f of files) {
    const name = basename(f);
    assert.ok(!name.endsWith('.tmp'), `unexpected tmp leftover: ${f}`);
    assert.ok(!name.startsWith('.'), `unexpected hidden file: ${f}`);
  }
});

// -------------------------------------------------------------- misc behavior

test('a brand-new nested root stays untouched until the first publish', (t) => {
  const { root } = makeStore(t);
  const nested = join(root, 'fresh', 'nested');
  const store = new RegistryStore(nested);
  assert.equal(store.paths.root, nested);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.versions('payments.v1'), []);
  assert.ok(!existsSync(nested), 'constructor and reads must not create directories');
  store.publish(makeIr('payments.v1'));
  assert.ok(existsSync(join(nested, 'packages', 'payments', 'v1', 'meta.json')));
});

test('pull returns meta matching the published IR identity', (t) => {
  const { store } = makeStore(t);
  const ir: IRPackage = makeIr('payments.v1');
  const published: ContractMeta = store.publish(ir, { repository: 'github.com/acme/payments' });
  const { meta } = store.pull('payments.v1', 'v1');
  assert.equal(meta.hash, published.hash);
  assert.equal(meta.repository, 'github.com/acme/payments');
  assert.equal(meta.packageName, 'payments.v1');
});

test('index mirrors every published version and backs search/graph', (t) => {
  const { store } = makeStore(t);
  store.publish(makeIr('payments.v1'));
  store.publish(makeIr('payments.v2'));
  store.publish(makeIr('fraud.v2', ['payments.v1']));
  const raw = JSON.parse(readFileSync(store.paths.index, 'utf8'));
  const names = (raw.contracts as ContractMeta[]).map((m) => m.packageName);
  assert.deepEqual(names, ['fraud.v2', 'payments.v1', 'payments.v2']);
});
