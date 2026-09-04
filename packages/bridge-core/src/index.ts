/**
 * @bridge/core — the Bridge compiler: IDL front-end and canonical IR.
 *
 * Public API:
 * - `compileSource(text, filePath)` → CompileResult   (compiler pipeline)
 * - `parse` / lexer internals                         (exported for tooling)
 * - canonical IR types + `hashPackage`                (stable boundary)
 */
export * from './ir/types';
export * from './ir/hash';

import type { CompileResult, IRPackage } from './ir/types';

/**
 * Compiler API implemented by the compiler pipeline (compiler/compile.ts).
 * Kept here as the typed surface that CLI, registry and tooling program
 * against. Agent note: implement in src/compiler/compile.ts and re-export.
 */
export interface BridgeCompiler {
  /**
   * Compile Bridge IDL source text into the canonical IR.
   * Must never throw on malformed input — always return diagnostics.
   */
  compileSource(text: string, filePath: string): CompileResult;
  /**
   * Compile a package plus its (already compiled) dependencies, validating
   * cross-package references. `dependencies` maps dotted package name → IR.
   */
  compilePackage(
    text: string,
    filePath: string,
    dependencies: Map<string, IRPackage>,
  ): CompileResult;
}
