/**
 * E2E tests: version/help, init, validate, fmt, lint, doctor — the CLI is
 * spawned as a real child process in isolated temp directories.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { BROKEN, GOOD, run, tmpdir, UGLY, UNPARSEABLE, WARNY, writeFile } from './helpers';

const tempRoots: string[] = [];
function fresh(label: string): string {
  const dir = tmpdir(label);
  tempRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// version / help / dispatch
// ---------------------------------------------------------------------------

test('version exits 0 and prints CLI and generator versions', () => {
  const r = run(['version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /bridge 0\.1\.0/);
  assert.match(r.stdout, /generator 0\.1\.0/);
});

test('help exits 0 and lists all commands', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  for (const command of [
    'init', 'validate', 'fmt', 'lint', 'generate', 'diff', 'check',
    'publish', 'pull', 'versions', 'inspect', 'search', 'doctor', 'version', 'help',
  ]) {
    assert.ok(r.stdout.includes(command), `help lists ${command}`);
  }
  assert.match(r.stdout, /Exit codes/);
});

test('help <command> shows command-specific usage', () => {
  const r = run(['help', 'publish']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--registry/);
  assert.match(r.stdout, /BRIDGE_REGISTRY/);
});

test('help with unknown command exits 2', () => {
  const r = run(['help', 'nonesuch']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'nonesuch'/);
});

test('unknown command exits 2 with hint', () => {
  const r = run(['transmogrify']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command 'transmogrify'/);
  assert.match(r.stderr, /bridge help/);
});

test('bare invocation prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.all, /Usage: bridge <command>/);
});

test('unknown option exits 2 with command hint', () => {
  const r = run(['validate', '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option '--bogus' for 'bridge validate'/);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init scaffolds a project with payments starter and valid config', () => {
  const dir = fresh('init');
  const r = run(['init', dir], { cwd: path.dirname(dir) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /created Bridge project/);
  assert.match(r.stdout, /Next steps/);

  const config = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config['version'], 1);
  assert.equal(config['source'], 'bridge.bridge');
  assert.equal(config['out'], 'generated');
  assert.ok(fs.readFileSync(path.join(dir, 'bridge.bridge'), 'utf8').includes('package payments.v1'));
});

test('init scaffold compiles out of the box (validate exit 0)', () => {
  const dir = fresh('init-validate');
  run(['init', dir]);
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ bridge\.bridge ok \(package payments\.v1, hash [0-9a-f]{12}\)/);
});

test('init --minimal scaffolds a compiling minimal contract', () => {
  const dir = fresh('init-minimal');
  run(['init', dir, '--minimal']);
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /package app\.v1/);
});

test('init refuses to overwrite existing files', () => {
  const dir = fresh('init-overwrite');
  fs.writeFileSync(path.join(dir, 'bridge.bridge'), 'package keep.v1', 'utf8');
  const r = run(['init', dir]);
  assert.equal(r.status, 1);
  assert.match(r.all, /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.bridge'), 'utf8'), 'package keep.v1');
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate: ok file exits 0 with ✓, package name and short hash', () => {
  const dir = fresh('validate-ok');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['validate', file]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ .*good\.bridge ok \(package shop\.v1, hash [0-9a-f]{12}\)/);
});

test('validate: broken file exits 1 with file:line:col diagnostic and hint', () => {
  const dir = fresh('validate-broken');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /broken\.bridge:9:13: error BR\d+: /);
  assert.match(r.all, /amount: money/);
  assert.match(r.all, /Did you mean `Money`\?/);
  assert.match(r.stderr, /1 of 1 file\(s\) failed validation/);
});

test('validate: missing file exits 1 with friendly error', () => {
  const r = run(['validate', path.join(fresh('validate-missing'), 'nope.bridge')]);
  assert.equal(r.status, 1);
  assert.match(r.all, /file not found/);
});

test('validate: multiple files — exit 1 when one fails, both reported', () => {
  const dir = fresh('validate-multi');
  const good = writeFile(dir, 'good.bridge', GOOD);
  const bad = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', good, bad]);
  assert.equal(r.status, 1);
  assert.match(r.all, /✓ .*good\.bridge ok/);
  assert.match(r.all, /broken\.bridge:9:13/);
  assert.match(r.all, /1 of 2 file\(s\) failed/);
});

test('validate --json: ok output parses with package and hash', () => {
  const dir = fresh('validate-json-ok');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['validate', '--json', file]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as Array<{ file: string; ok: boolean; package?: string; hash?: string; diagnostics: unknown[] }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.file, file);
  assert.equal(parsed[0]!.ok, true);
  assert.equal(parsed[0]!.package, 'shop.v1');
  assert.match(parsed[0]!.hash ?? '', /^[0-9a-f]{12}$/);
  assert.deepEqual(parsed[0]!.diagnostics, []);
});

test('validate --json: broken output parses with located diagnostics', () => {
  const dir = fresh('validate-json-broken');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['validate', '--json', file]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as Array<{
    file: string;
    ok: boolean;
    diagnostics: Array<{ severity: string; code: string; line: number; column: number }>;
  }>;
  assert.equal(parsed[0]!.ok, false);
  assert.ok(parsed[0]!.diagnostics.length > 0);
  const first = parsed[0]!.diagnostics[0]!;
  assert.equal(first.severity, 'error');
  assert.match(first.code, /^BR\d+/);
  assert.equal(first.line, 9);
  assert.equal(first.column, 13);
});

test('validate without files or config is a usage error', () => {
  const dir = fresh('validate-empty');
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.all, /no input files/);
});

test('validate falls back to the bridge.json source', () => {
  const dir = fresh('validate-config');
  writeFile(dir, 'contract.bridge', GOOD);
  writeFile(dir, 'bridge.json', JSON.stringify({ version: 1, source: 'contract.bridge', out: 'generated' }));
  const r = run(['validate'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ contract\.bridge ok/);
});

// ---------------------------------------------------------------------------
// fmt
// ---------------------------------------------------------------------------

test('fmt: unformatted file exits 1 and prints a unified diff', () => {
  const dir = fresh('fmt-diff');
  const file = writeFile(dir, 'ugly.bridge', UGLY);
  const r = run(['fmt', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /--- a\/.*ugly\.bridge/);
  assert.match(r.all, /\+\+\+ b\/.*ugly\.bridge/);
  assert.match(r.all, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(r.all, /^- {2}amount: int64$/m);
  assert.match(r.all, /^\+ {4}amount: int64$/m);
  assert.match(r.stderr, /need formatting/);
});

test('fmt -w rewrites the file in place; second run reports clean', () => {
  const dir = fresh('fmt-write');
  const file = writeFile(dir, 'ugly.bridge', UGLY);
  const first = run(['fmt', '-w', file]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /✓ formatted .*ugly\.bridge/);

  const formatted = fs.readFileSync(file, 'utf8');
  assert.match(formatted, /^    amount: int64$/m); // canonical 4-space indent
  assert.match(formatted, /^package shop\.v1\n\n/m); // blank line restored

  const second = run(['fmt', file]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already formatted/);
});

test('fmt: unparseable file exits 1 with diagnostics', () => {
  const dir = fresh('fmt-broken');
  const file = writeFile(dir, 'broken.bridge', UNPARSEABLE);
  const r = run(['fmt', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /error BR\d+/);
  assert.match(r.stderr, /could not be formatted/);
});

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

test('lint: clean file exits 0', () => {
  const dir = fresh('lint-clean');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const r = run(['lint', file]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /✓ .*good\.bridge ok/);
});

test('lint: warning tolerated by default (exit 0) but reported', () => {
  const dir = fresh('lint-warn');
  const file = writeFile(dir, 'warny.bridge', WARNY);
  const r = run(['lint', file]);
  assert.equal(r.status, 0);
  assert.match(r.all, /warny\.bridge:3:1: warning BR\d+/);
  assert.match(r.all, /not PascalCase/);
  assert.match(r.all, /tolerated/);
});

test('lint --strict: warning fails (exit 1)', () => {
  const dir = fresh('lint-strict');
  const file = writeFile(dir, 'warny.bridge', WARNY);
  const r = run(['lint', '--strict', file]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lint failed \(--strict\)/);
});

test('lint: error-severity diagnostic fails (exit 1)', () => {
  const dir = fresh('lint-error');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const r = run(['lint', file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /error BR\d+/);
  assert.match(r.stderr, /lint failed: \d+ error/);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test('doctor exits 0 with ✓ lines in a sane environment', () => {
  const dir = fresh('doctor');
  const r = run(['doctor'], { cwd: dir });
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length >= 5, `expected at least 5 checks, got ${lines.length}`);
  for (const line of lines) assert.ok(line.startsWith('✓'), `all checks pass: ${line}`);
  assert.match(r.stdout, /node \d+\.\d+\.\d+/);
  assert.match(r.stdout, /compiler ok/);
  assert.match(r.stdout, /generator 0\.1\.0 ok/);
  assert.match(r.stdout, /registry .*absent/);
});

test('doctor fails when the registry path is a file (not a directory)', () => {
  const dir = fresh('doctor-registry-file');
  const bogus = writeFile(dir, 'registry-file', 'not a directory');
  const r = run(['doctor', '--registry', bogus], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.all, /✗ registry .*not a directory/);
});
