// Demo: a SAFE/WARNING-grade evolution passes the compatibility gate.
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

const oldIr = compile('v1.orders.bridge'); // published baseline
const newIr = compile('v2.orders.bridge'); // candidate

console.log(formatReport(diffPackages(oldIr, newIr)));

const strict = check(oldIr, newIr); // default mode: 'strict'
const compatible = check(oldIr, newIr, { mode: 'compatible' });
console.log(`strict gate:      ${strict.passed ? 'PASSED' : 'FAILED'}`);
console.log(`compatible gate:  ${compatible.passed ? 'PASSED' : 'FAILED'}`);
console.log(
  'Both modes pass: adding optional fields and widening int32 -> int64 never breaks consumers.',
);
