// scripts/generate-ffi.mjs — generate FFI glue for the payments example.
//
// Writes the Rust C-ABI crate, the Go cgo client and the WASM bindings for
// one example contract into examples/<name>/generated/ffi/<target>/ —
// gitignored, regenerated on every verify run.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileSource } from '@bridge/core';
import { generateFfi } from '@bridge/ffi';

const ROOT = join(import.meta.dirname, '..');

const TARGETS = [{ dir: 'payments', contract: 'payments.bridge' }];

for (const target of TARGETS) {
  const source = await (async () => {
    const { readFileSync } = await import('node:fs');
    return readFileSync(join(ROOT, 'examples', target.dir, target.contract), 'utf8');
  })();
  const { ir } = compileSource(source);
  for (const ffiTarget of ['rust-ffi', 'go-ffi', 'wasm']) {
    const outDir = join(ROOT, 'examples', target.dir, 'generated', 'ffi', ffiTarget);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const files = generateFfi(ir, { target: ffiTarget });
    for (const file of files) {
      const filePath = join(outDir, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content);
    }
    console.log(`${ir.name} -> ${ffiTarget} (${files.length} files)`);
  }
}
