// scripts/generate-all.mjs — regenerate code for every example contract.
//
// Compiles each example's contract with @bridge/core and writes all four
// target languages into examples/<name>/generated/<language>/ (gitignored).
// Used by the verify-* scripts and CI; safe to re-run any time — output is
// deterministic and the generated directories are wiped before each write.
//
// Run from anywhere:  node scripts/generate-all.mjs
// (requires `npm install && npm run build` at the repository root once)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeCompiler, compileSource } from '@bridge/core';
import { generate } from '@bridge/generators';

const ROOT = join(import.meta.dirname, '..');
const LANGUAGES = ['go', 'rust', 'typescript', 'python'];

/**
 * One entry per example that materializes generated code. Examples whose
 * point is diffing (versioning, compatibility) generate their published
 * baseline revision; the candidate revisions are compile-checked by their
 * demos.
 *
 * NOTE: the registry example is intentionally absent here. Its contract
 * combines a cross-package reference with an event, and the generated
 * TypeScript/Rust *event modules* currently reference the cross-package
 * opaque alias without importing it (the types module declares the alias).
 * Until the generator emits that import, the registry contract stays
 * compile-checked only (see COMPILE_ONLY below).
 */
const TARGETS = [
  { dir: 'payments', contract: 'payments.bridge' },
  { dir: 'hello-world', contract: 'hello.bridge' },
  { dir: 'go-typescript', contract: 'catalog.bridge' },
  { dir: 'go-python', contract: 'billing.bridge' },
  { dir: 'versioning', contract: 'v1.payments.bridge' },
  { dir: 'compatibility', contract: 'v1.orders.bridge' },
];

/** Compile-only target: the registry contract resolves `import payments.v1`
 * against the already-compiled payments IR (cross-package compile coverage,
 * no codegen). */
const COMPILE_ONLY = [
  {
    dir: 'registry',
    contract: 'orders.bridge',
    dependencies: [{ dir: 'payments', contract: 'payments.bridge' }],
  },
];

let failed = false;

function compile(target) {
  // Compile dependencies first, exactly like the registry demo does.
  const dependencies = new Map();
  for (const dep of target.dependencies ?? []) {
    const depResult = compileSource(
      readFileSync(join(ROOT, 'examples', dep.dir, dep.contract), 'utf8'),
      dep.contract,
    );
    if (!depResult.ok) {
      console.error(
        `${dep.contract} failed to compile (dependency of ${target.contract}):`,
      );
      for (const d of depResult.diagnostics) {
        console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
      }
      failed = true;
      return null;
    }
    dependencies.set(depResult.ir.name, depResult.ir);
  }

  const source = readFileSync(
    join(ROOT, 'examples', target.dir, target.contract),
    'utf8',
  );
  const result =
    dependencies.size === 0
      ? compileSource(source, target.contract)
      : bridgeCompiler.compilePackage(source, target.contract, dependencies);
  if (!result.ok) {
    console.error(`${target.contract} failed to compile:`);
    for (const d of result.diagnostics) {
      console.error(`  ${d.file}:${d.line}:${d.column} ${d.code} ${d.message}`);
    }
    failed = true;
    return null;
  }
  return result.ir;
}

for (const target of TARGETS) {
  const ir = compile(target);
  if (!ir) continue;

  const summary = [];
  for (const language of LANGUAGES) {
    const outDir = join(ROOT, 'examples', target.dir, 'generated', language);
    rmSync(outDir, { recursive: true, force: true });
    const files = generate(ir, { language });
    for (const file of files) {
      const filePath = join(outDir, file.path);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, file.content);
    }
    summary.push(`${language} (${files.length} files)`);
  }
  console.log(`${ir.name.padEnd(14)} -> ${summary.join(', ')}`);
}

for (const target of COMPILE_ONLY) {
  const ir = compile(target);
  if (ir) console.log(`${ir.name.padEnd(14)} -> compile-check only`);
}

if (failed) process.exit(1);
console.log('Generated code written under examples/*/generated/ (gitignored).');
