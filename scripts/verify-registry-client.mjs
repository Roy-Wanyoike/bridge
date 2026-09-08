// Mock-fetch verification of the dashboard's live-mode REST client (issue #50).
// Run: node scripts/verify-registry-client.mjs   (local evidence only, not committed)
// Proves: 404 → null; non-404 → typed RegistryError; timeout → typed error;
// schema drift → typed error; listAllContracts/getOverview fan-out is concurrent.
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DASH = '/home/z/my-project/worktrees/dash-ui/dashboard';
const out = mkdtempSync(join(tmpdir(), 'regclient-'));
try {
  // Compile registry-client + demo-data with the dashboard's own TS.
  execSync(
    `npx tsc src/lib/registry-client.ts src/lib/demo-data.ts --outDir ${out} --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck --strict`,
    { cwd: DASH, stdio: 'pipe' },
  );

  let state = { mode: 'ok', inFlight: 0, maxInFlight: 0, calls: [] };
  globalThis.fetch = async (url) => {
    state.calls.push(String(url).replace('http://registry.test', ''));
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    try {
      if (state.mode === 'timeout') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (state.mode === 'network') throw new Error('connect ECONNREFUSED');
      await new Promise((r) => setTimeout(r, 20)); // small latency so overlap is measurable
      if (state.mode === '500') return { ok: false, status: 500, json: async () => ({}) };
      if (state.mode === '404') return { ok: false, status: 404, json: async () => ({}) };
      if (state.mode === 'drift') return { ok: true, status: 200, json: async () => ({ unexpected: [] }) };
      const path = String(url).replace('http://registry.test', '');
      if (path === '/v1/orgs') return json({ orgs: [{ org: 'acme', projects: ['payments'] }, { org: 'globex', projects: ['billing'] }] });
      if (path === '/v1/orgs/acme/projects' || path === '/v1/orgs/globex/projects') return json({ projects: [{ project: 'p1' }] });
      if (path.endsWith('/contracts')) return json({ contracts: [{ org: 'x', project: 'p1', base: 'c1', packageName: 'c1.v1', latestVersion: 'v1', latestHash: 'h', latestShortHash: 'h', owner: 'o', versionCount: 1, firstPublishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', consumers: 0, languages: [] }] });
      if (path.endsWith('/versions')) return json({ versions: [{ version: 'v1' }, { version: 'v2' }] });
      if (path.includes('/diff?from=')) return json({ verdict: 'SAFE', summary: {}, changes: [], impact: {} });
      if (path === '/v1/audit') return json({ entries: [] });
      return json({});
    } finally {
      state.inFlight -= 1;
    }
  };

  const mod = await import(join(out, 'registry-client.mjs')).catch(() => import(join(out, 'registry-client.js')));
  const { RestRegistryClient, RegistryError, isNotFound } = mod;
  const client = new RestRegistryClient('http://registry.test');
  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
    if (!cond) failures += 1;
  };

  // 1. 404 → null (not-found path)
  state.mode = '404'; state.calls = [];
  const c = await client.getContract('acme', 'payments', 'missing');
  check('404 on getContract resolves to null (notFound() path)', c === null);

  // 2. non-404 → typed throw (error.tsx path)
  state.mode = '500';
  const err500 = await client.getContract('acme', 'payments', 'x').then(() => null, (e) => e);
  check('500 on getContract throws RegistryError', err500 instanceof RegistryError && err500.status === 500 && err500.path.includes('/contracts/x'), `status=${err500?.status}`);
  check('non-404 RegistryError is not isNotFound', isNotFound(err500) === false);

  // 3. timeout → typed RegistryError (status 0)
  state.mode = 'timeout';
  const errT = await client.listOrgs().then(() => null, (e) => e);
  check('timeout surfaces typed RegistryError', errT instanceof RegistryError && errT.status === 0 && /timed out/.test(errT.message), errT.message);

  // 4. network failure → typed RegistryError
  state.mode = 'network';
  const errN = await client.listAudit().then(() => null, (e) => e);
  check('network failure surfaces typed RegistryError', errN instanceof RegistryError && errN.status === 0, errN.message);

  // 5. schema drift → typed error instead of silent []
  state.mode = 'drift';
  const errD = await client.listOrgs().then(() => null, (e) => e);
  check('missing expected key throws (no silent empty page)', errD instanceof RegistryError && /expected array keys/.test(errD.message), errD.message);

  // 6. listAllContracts fan-out: 2 orgs × (1 projects call + 1 contracts call) — concurrent
  state.mode = 'ok'; state.maxInFlight = 0; state.calls = [];
  const all = await client.listAllContracts();
  check('listAllContracts returns all org/project contracts', all.length === 2, `got ${all.length} (2 orgs × 1 project × 1 contract)`);
  check('fan-out is concurrent (max in-flight fetches > 1)', state.maxInFlight > 1, `maxInFlight=${state.maxInFlight}, calls=${state.calls.length}`);
  check('request sequence is breadth-first (orgs first, then parallel per-org work)', state.calls[0] === '/v1/orgs' && state.calls.slice(1).every((p) => p !== '/v1/orgs'));

  // 7. getOverview happy path still composes, concurrently
  state.mode = 'ok'; state.maxInFlight = 0; state.calls = [];
  const ov = await client.getOverview();
  check('getOverview composes concurrently', ov.contracts === 2 && ov.versions === 2 && state.maxInFlight > 1, `maxInFlight=${state.maxInFlight}`);

  console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
  if (failures !== 0) process.exit(1);
} finally {
  rmSync(out, { recursive: true, force: true });
}
