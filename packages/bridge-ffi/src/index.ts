/**
 * `@bridge/ffi` — carries one Bridge contract across language boundaries
 * as FUNCTIONS and as WASM-callable types.
 *
 * Three targets, all deterministic (byte-identical output for identical
 * IR):
 *
 * - `rust-ffi` — a cdylib crate: canonical Rust types (reused from
 *   `@bridge/generators`) + a C-ABI surface (one entry point per service
 *   method, an `echo` probe, buffer-ownership rules, panic containment).
 * - `go-ffi` — a cgo client package sharing the SAME generated C header,
 *   with typed JSON-in/JSON-out wrappers and a build-tagged cross-language
 *   verification test.
 * - `wasm` — a wasm32 crate with `wasm-bindgen` surface (parse/validate/
 *   serialize every contract type from JS) + typed TS declarations and a
 *   loader façade.
 *
 * See `abi.ts` for the status codes and ownership rules both native sides
 * agree on.
 */

import type { IRPackage } from '@bridge/core';
import { generateGoFfi } from './go-ffi';
import { generateRustFfi } from './rust-ffi';
import { generateWasm } from './wasm';
import type { GeneratedFile } from './util';
import {
  FFI_STATUS,
  GO_VERIFY_TAG,
  cHeaderFile,
  cSymbolPackage,
  demoHandlerSymbol,
  echoSymbol,
  ffiCrateName,
  ffiLibName,
  freeSymbol,
  headerPath,
  methodSymbol,
  sortedServiceMethods,
} from './abi';

export {
  FFI_STATUS,
  GO_VERIFY_TAG,
  cHeaderFile,
  cSymbolPackage,
  demoHandlerSymbol,
  echoSymbol,
  ffiCrateName,
  ffiLibName,
  freeSymbol,
  headerPath,
  methodSymbol,
  sortedServiceMethods,
} from './abi';
export { GENERATED_MARKER, generatedFile } from './util';
export { goModulePath, generateGoFfi } from './go-ffi';
export { generateRustFfi } from './rust-ffi';
export { generateWasm } from './wasm';
export type { GeneratedFile } from './util';

/** The three FFI targets. */
export type FfiTarget = 'rust-ffi' | 'go-ffi' | 'wasm';

export interface FfiOptions {
  /** Which glue to emit. */
  target: FfiTarget;
  /** Overrides the derived package name (defaults to `ir.name`). */
  packageName?: string;
  /** Whether service-method surfaces are emitted (default true). */
  generateServices?: boolean;
}

/** Version of the FFI generator; embedded in every generated file header. */
export const FFI_GENERATOR_VERSION = '0.1.0';

/**
 * Generates the FFI glue for one IR package.
 *
 * @param ir canonical IR (as produced by `@bridge/core`)
 * @param options target + knobs
 * @returns files in deterministic order; paths are relative POSIX paths
 */
export function generateFfi(ir: IRPackage, options: FfiOptions): GeneratedFile[] {
  const generateServices = options.generateServices ?? true;
  switch (options.target) {
    case 'rust-ffi':
      return generateRustFfi(ir, generateServices);
    case 'go-ffi':
      return generateGoFfi(ir, generateServices);
    case 'wasm':
      return generateWasm(ir);
  }
}
