/**
 * E2E tests: generate / diff / check.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKEN, GOOD, PAYMENTS_BREAKING, PAYMENTS_SAFE, PAYMENTS_V1, run, tmpdir, writeFile,
} from './helpers';

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
// generate
// ---------------------------------------------------------------------------

const LANG_SIGNATURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['go', ['go.mod', 'types.go', 'validate.go', 'services.go']],
  ['rust', ['Cargo.toml', 'src/lib.rs', 'src/types.rs', 'src/validate.rs', 'src/services.rs']],
  ['typescript', ['package.json', 'tsconfig.json', 'src/index.ts', 'src/types.ts', 'src/services.ts']],
  ['python', ['pyproject.toml', 'shop_v1/__init__.py', 'shop_v1/models.py', 'shop_v1/services.py']],
];

for (const [language, expected] of LANG_SIGNATURES) {
  test(`generate --language ${language} writes the expected files`, () => {
    const dir = fresh(`gen-${language}`);
    const file = writeFile(dir, 'good.bridge', GOOD);
    const outDir = path.join(dir, 'generated', language);
    const r = run(['generate', '--language', language, '--out', outDir, file]);
    assert.equal(r.status, 0);
    for (const rel of expected) {
      const target = path.join(outDir, ...rel.split('/'));
      assert.ok(fs.existsSync(target), `writes ${rel}`);
      assert.ok(r.stdout.includes(target), `prints the written path ${target}`);
    }
    assert.ok(r.stdout.includes(`file(s) written to ${outDir}`), 'prints the summary line');
  });
}

test('generate: default output root honors the bridge.json "out" key', () => {
  const dir = fresh('gen-config-out');
  writeFile(dir, 'good.bridge', GOOD);
  writeFile(dir, 'bridge.json', JSON.stringify({ version: 1, source: 'good.bridge', out: 'custom-gen' }));
  const r = run(['generate', '--language', 'go'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'custom-gen', 'go', 'types.go')));
});

test('generate refuses to overwrite without --force, succeeds with --force', () => {
  const dir = fresh('gen-force');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');
  const first = run(['generate', '--language', 'go', '--out', outDir, file]);
  assert.equal(first.status, 0);

  const second = run(['generate', '--language', 'go', '--out', outDir, file]);
  assert.equal(second.status, 1);
  assert.match(second.all, /refusing to overwrite \d+ existing file\(s\)/);
  assert.match(second.all, /--force/);

  const third = run(['generate', '--language', 'go', '--out', outDir, '--force', file]);
  assert.equal(third.status, 0);
});

test('generate --package-name overrides the derived name in output', () => {
  const dir = fresh('gen-pkgname');
  const file = writeFile(dir, 'good.bridge', GOOD);
  const outDir = path.join(dir, 'out');
  const r = run(['generate', '--language', 'go', '--package-name', 'acme/widgets', '--out', outDir, file]);
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(outDir, 'go.mod'), 'utf8'), /\/\/ Package: acme\/widgets/);
});

test('generate: unknown language is a usage error (exit 2)', () => {
  const dir = fresh('gen-badlang');
  const r = run(['generate', '--language', 'cobol'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.all, /unknown language 'cobol'/);
});

test('generate: missing --language is a usage error (exit 2)', () => {
  const dir = fresh('gen-nolang');
  const r = run(['generate'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.all, /missing required option --language/);
});

test('generate: compile errors exit 1 before any file is written', () => {
  const dir = fresh('gen-broken');
  const file = writeFile(dir, 'broken.bridge', BROKEN);
  const outDir = path.join(dir, 'out');
  const r = run(['generate', '--language', 'go', '--out', outDir, file]);
  assert.equal(r.status, 1);
  assert.match(r.all, /does not compile/);
  assert.ok(!fs.existsSync(outDir), 'nothing written on compile failure');
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff: safe change passes (exit 0, PASSED)', () => {
  const dir = fresh('diff-safe');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_SAFE);
  const r = run(['diff', oldFile, newFile]);
  assert.equal(r.status, 0);
  assert.match(r.all, /Compatibility: PASSED/);
  assert.match(r.all, /Added optional field: Payment\.reference/);
});

test('diff: breaking change fails (exit 1, report says Breaking)', () => {
  const dir = fresh('diff-breaking');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_BREAKING);
  const r = run(['diff', oldFile, newFile]);
  assert.equal(r.status, 1);
  assert.match(r.all, /Breaking: Money\.currency removed/);
  assert.match(r.all, /Verdict: BREAKING/);
  assert.match(r.all, /Compatibility: FAILED/);
  assert.match(r.stderr, /compatibility check FAILED \(strict mode\)/);
});

test('diff --compatible: breaking changes still fail', () => {
  const dir = fresh('diff-compatible');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_BREAKING);
  const r = run(['diff', '--compatible', oldFile, newFile]);
  assert.equal(r.status, 1);
  assert.match(r.all, /mode: compatible/);
  assert.match(r.stderr, /FAILED \(compatible mode\)/);
});

test('diff: uncompileable input exits 1 with diagnostics', () => {
  const dir = fresh('diff-broken');
  const oldFile = writeFile(dir, 'old.bridge', GOOD);
  const newFile = writeFile(dir, 'new.bridge', BROKEN);
  const r = run(['diff', oldFile, newFile]);
  assert.equal(r.status, 1);
  assert.match(r.all, /new\.bridge does not compile/);
  assert.match(r.all, /new\.bridge:9:13/);
});

test('diff: wrong number of files is a usage error (exit 2)', () => {
  const dir = fresh('diff-args');
  const one = writeFile(dir, 'old.bridge', GOOD);
  assert.equal(run(['diff', one]).status, 2);
  const two = writeFile(dir, 'new.bridge', GOOD);
  assert.equal(run(['diff', one, two, two]).status, 2);
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

test('check --json: safe change parses with passed: true', () => {
  const dir = fresh('check-json-safe');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_SAFE);
  const r = run(['check', '--json', oldFile, newFile]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as {
    package: string;
    mode: string;
    passed: boolean;
    verdict: string;
    summary: { safe: number; warning: number; breaking: number; unknown: number };
    changes: Array<{ path: string; classification: string }>;
  };
  assert.equal(parsed.package, 'payments.v1');
  assert.equal(parsed.mode, 'strict');
  assert.equal(parsed.passed, true);
  assert.equal(parsed.verdict, 'SAFE');
  assert.equal(parsed.summary.breaking, 0);
  assert.ok(parsed.changes.some((c) => c.path === 'Payment.reference' && c.classification === 'SAFE'));
});

test('check --json: breaking change parses with passed: false, exit 1', () => {
  const dir = fresh('check-json-breaking');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_BREAKING);
  const r = run(['check', '--json', oldFile, newFile]);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout) as { passed: boolean; verdict: string; summary: { breaking: number } };
  assert.equal(parsed.passed, false);
  assert.equal(parsed.verdict, 'BREAKING');
  assert.ok(parsed.summary.breaking > 0);
});

test('check (text): prints verdict/passed lines and exits 1 on breaking', () => {
  const dir = fresh('check-text');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_BREAKING);
  const r = run(['check', oldFile, newFile]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^package: payments\.v1$/m);
  assert.match(r.stdout, /^verdict: BREAKING$/m);
  assert.match(r.stdout, /^passed: false$/m);
  assert.match(r.stdout, /breaking [1-9]/);
});

test('check: safe change exits 0 with passed: true', () => {
  const dir = fresh('check-safe');
  const oldFile = writeFile(dir, 'old.bridge', PAYMENTS_V1);
  const newFile = writeFile(dir, 'new.bridge', PAYMENTS_SAFE);
  const r = run(['check', oldFile, newFile]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^passed: true$/m);
});
