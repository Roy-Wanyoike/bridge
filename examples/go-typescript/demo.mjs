// Demo: generate Go AND TypeScript from one contract with @bridge/generators.
//
// Writes examples/go-typescript/generated/{go,typescript} (gitignored) and
// prints the file lists.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource } from '@bridge/core';
import { generate } from '@bridge/generators';

const dir = import.meta.dirname;
const outRoot = join(dir, 'generated');
rmSync(outRoot, { recursive: true, force: true });

const source = readFileSync(join(dir, 'catalog.bridge'), 'utf8');
const result = compileSource(source, 'catalog.bridge');
if (!result.ok) {
  console.error('catalog.bridge failed to compile:');
  for (const d of result.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}

for (const language of ['go', 'typescript']) {
  const files = generate(result.ir, { language });
  for (const file of files) {
    const target = join(outRoot, language, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, file.content);
  }
  console.log(`${language}:`);
  for (const file of files) console.log(`  ${file.path}`);
}

console.log('');
console.log('Written to examples/go-typescript/generated/ (gitignored).');
console.log(
  'Both packages speak the same wire format: the Go service and the TypeScript client stay in lockstep because they compile from the same IR.',
);
