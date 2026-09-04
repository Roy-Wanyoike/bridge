// Demo: diff two revisions of the payments contract with @bridge/compat.
//
// v2 adds an optional field (SAFE), adds an enum value (WARNING) and removes
// a field (BREAKING) — so the strict CI gate must fail.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource } from '@bridge/core';
import { check, diffPackages, formatReport } from '@bridge/compat';

const dir = import.meta.dirname;

function compile(file) {
  const source = readFileSync(join(dir, file), 'utf8');
  const result = compileSource(source, file);
  if (!result.ok) {
    console.error(`${file} failed to compile:`);
    for (const d of result.diagnostics) {
      console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
    }
    process.exit(1);
  }
  return result.ir;
}

const oldIr = compile('v1.payments.bridge'); // published baseline
const newIr = compile('v2.payments.bridge'); // candidate

const report = diffPackages(oldIr, newIr);
console.log(formatReport(report));

const { passed } = check(oldIr, newIr); // default mode: 'strict'
console.log(
  `CI gate: \`bridge check\` would exit ${passed ? 0 : 1} — release the candidate under a NEW major name, never overwrite the published version.`,
);
// The demo itself exits 0: it successfully demonstrated a breaking diff.
// CI pipelines gate on `check()`'s boolean (or the `bridge check` exit code).
process.exit(0);
