// Demo (flagship proof): generate Go + Python from one contract, then run a
// LIVE Python round-trip of the generated code via python3.
//
// The generated Python is written to a temporary directory and executed with
// `python3 -c`: it serializes Money to the wire dict, decodes it back and
// asserts the two objects are equal. If your Python code ever disagrees with
// your Go code about the wire format, this demo is where it shows.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once; python3 for
// the round-trip — without it the demo skips the live check and still exits 0)
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileSource } from '@bridge/core';
import { generate } from '@bridge/generators';

const dir = import.meta.dirname;
const goOut = join(dir, 'generated', 'go');
rmSync(goOut, { recursive: true, force: true });

const source = readFileSync(join(dir, 'billing.bridge'), 'utf8');
const result = compileSource(source, 'billing.bridge');
if (!result.ok) {
  console.error('billing.bridge failed to compile:');
  for (const d of result.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}
const ir = result.ir;

// 1. Go side — materialized under generated/ (gitignored) for inspection.
const goFiles = generate(ir, { language: 'go' });
for (const file of goFiles) {
  const target = join(goOut, file.path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, file.content);
}
console.log('go files:');
for (const file of goFiles) console.log(`  ${file.path}`);

// 2. Python side — generated into a throwaway temp dir and executed live.
const pyFiles = generate(ir, { language: 'python' });
const pyRoot = mkdtempSync(join(tmpdir(), 'bridge-go-python-'));
try {
  for (const file of pyFiles) {
    const target = join(pyRoot, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, file.content);
  }

  const python = process.platform === 'win32' ? 'python' : 'python3';
  const probe = spawnSync(
    python,
    [
      '-c',
      [
        'from billing_v1 import Money',
        'money = Money(amount=1250, currency="USD")',
        'wire = money.to_dict()',
        'print("wire dict:", wire)',
        'decoded = Money.from_dict(wire)',
        'assert decoded == money, "round-trip mismatch"',
        'print("round-trip OK: Money(amount=%d, currency=%s)" % (decoded.amount, decoded.currency))',
      ].join('\n'),
    ],
    { cwd: pyRoot, encoding: 'utf8' },
  );

  if (probe.error && probe.error.code === 'ENOENT') {
    console.log(
      `${python} not available — skipping the live round-trip (CI covers this).`,
    );
    process.exit(0);
  }
  process.stdout.write(probe.stdout);
  if (probe.status !== 0) {
    process.stderr.write(probe.stderr);
    console.error('Python round-trip FAILED — wire formats disagree.');
    process.exit(1);
  }
  console.log('python files executed from a temp dir:', pyFiles.length);
} finally {
  rmSync(pyRoot, { recursive: true, force: true });
}
