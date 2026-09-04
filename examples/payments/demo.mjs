// Demo: compile payments.bridge and inspect the canonical IR + content hash.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource, hashPackage, shortHash } from '@bridge/core';

const dir = import.meta.dirname;
const source = readFileSync(join(dir, 'payments.bridge'), 'utf8');
const result = compileSource(source, 'payments.bridge');

if (!result.ok) {
  console.error('payments.bridge failed to compile:');
  for (const d of result.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}

const ir = result.ir;
console.log(`package:  ${ir.name}`);
console.log(
  `imports:  ${ir.imports.length === 0 ? '(none)' : ir.imports.join(', ')}`,
);
console.log(`types:    ${ir.types.map((t) => t.name).join(', ')}`);
for (const service of ir.services) {
  console.log(
    `service:  ${service.name} { ${service.methods
      .map((m) => `${m.name}`)
      .join(', ')} }`,
  );
}
console.log(
  `events:   ${ir.events.length === 0 ? '(none)' : ir.events.map((e) => e.name).join(', ')}`,
);
console.log(`short hash: ${shortHash(ir)}`);
console.log(`full hash:  ${hashPackage(ir)}`);
console.log(
  'The hash is content-addressed (SHA-256 of the canonical JSON of the IR):',
);
console.log('identical contracts always produce the identical digest.');
