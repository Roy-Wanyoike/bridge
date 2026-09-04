// Demo: compile hello.bridge with @bridge/core and inspect the canonical IR.
//
// Run from this directory:  node demo.mjs
// (requires `npm install && npm run build` at the repo root once)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSource, shortHash } from '@bridge/core';

const dir = import.meta.dirname;
const source = readFileSync(join(dir, 'hello.bridge'), 'utf8');
const result = compileSource(source, 'hello.bridge');

if (!result.ok) {
  console.error('hello.bridge failed to compile:');
  for (const d of result.diagnostics) {
    console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
  }
  process.exit(1);
}

const ir = result.ir;
console.log(`package: ${ir.name}`);

const greeting = ir.types.find((t) => t.name === 'Greeting');
console.log('Greeting fields:');
for (const field of greeting.fields) {
  const type =
    field.type.kind === 'primitive' ? field.type.primitive : field.type.kind;
  const optional = field.optional ? ' (optional)' : '';
  const constraints = field.constraints
    .map((c) => `@${c.kind}(${c.args.join(', ')})`)
    .join(' ');
  console.log(
    `  ${field.name}: ${type}${optional}${constraints ? ` ${constraints}` : ''}`,
  );
}

console.log(`short hash: ${shortHash(ir)}`);
console.log(
  'The hash is content-addressed: identical contracts always produce the identical digest.',
);
