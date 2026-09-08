/**
 * WASM target generator.
 *
 * Compiles the contract's Rust core (types + validators, reused from the
 * Rust data generator) into a wasm32 library with `wasm-bindgen` surface,
 * plus typed TypeScript wrappers for the emitted bindings.
 *
 * Scope note (documented in generated files too): the WASM surface carries
 * the contract's DATA across the boundary — parse/validate/serialize every
 * type from JavaScript with Rust-side correctness. Function-carrying FFI
 * (Rust handler registry + Go cgo client) lives in the C-ABI targets; a
 * browser has no dynamic-library loader, so service dispatch there is a
 * different (host-driven) pattern.
 */

import type { IRPackage } from '@bridge/core';
import { generate } from '@bridge/generators';
import { rustCrateName } from './abi';
import { ffiCrateName } from './abi';
import { fileHeader, generatedFile } from './util';
import type { GeneratedFile } from './util';

/** TS type for a wasm-exposed Bridge type. */
function wasmTsType(ref: Record<string, unknown>): string {
  switch (ref['kind']) {
    case 'primitive': {
      switch (ref['primitive']) {
        case 'bool':
          return 'boolean';
        case 'int32':
        case 'int64':
        case 'uint32':
        case 'uint64':
        case 'float32':
        case 'float64':
          return 'number';
        default:
          return 'string';
      }
    }
    case 'list':
    case 'set':
      return `${wasmTsType(ref['element'] as Record<string, unknown>)}[]`;
    case 'map':
      return `Record<string, ${wasmTsType(ref['value'] as Record<string, unknown>)}>`;
    case 'optional':
      return `${wasmTsType(ref['inner'] as Record<string, unknown>)} | null`;
    default:
      return 'unknown';
  }
}

/** Generates the wasm32 crate + TS wrappers for an IR package. */
export function generateWasm(ir: IRPackage): GeneratedFile[] {
  const crate = ffiCrateName(ir.name) + '-wasm';
  const files: GeneratedFile[] = [wasmCargoToml(ir, crate)];
  // Reuse the canonical generated Rust types/validators.
  const dataFiles = generate(ir, { language: 'rust', generateServices: false, generateEvents: false });
  for (const path of ['src/types.rs', 'src/enums.rs', 'src/validate.rs']) {
    const file = dataFiles.find((f) => f.path === path);
    if (file !== undefined) files.push(file);
  }
  files.push(wasmLibRs(ir, dataFiles.some((f) => f.path === 'src/types.rs')), tsDeclarations(ir), tsLoader(ir));
  return files;
}

function wasmCargoToml(ir: IRPackage, crate: string): GeneratedFile {
  const lines = [
    `# ${fileHeader('#', ir.name)}`,
    '[package]',
    `name = "${crate}"`,
    'version = "0.1.0"',
    'edition = "2021"',
    `description = "wasm32 bindings for the ${ir.name} Bridge contract."`,
    '',
    '[lib]',
    'crate-type = ["cdylib", "rlib"]',
    '',
    '[dependencies]',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'wasm-bindgen = "0.2"',
    '',
  ];
  return generatedFile('Cargo.toml', lines.join('\n'));
}

/** src/lib.rs: wasm-bindgen surface over the contract's types. */
function wasmLibRs(ir: IRPackage, hasTypes: boolean): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! wasm32 surface: parse / validate / serialize every contract type');
  lines.push('//! from JavaScript with Rust-side correctness. Build with');
  lines.push('//! `cargo build --target wasm32-unknown-unknown` then generate the JS');
  lines.push('//! glue with `wasm-bindgen` (see index.ts for the typed wrappers).');
  lines.push('');
  lines.push('use serde::Deserialize;');
  lines.push('use serde::Serialize;');
  lines.push('use wasm_bindgen::prelude::*;');
  lines.push('');
  lines.push('pub mod types;');
  lines.push('pub mod enums;');
  lines.push('pub mod validate;');
  lines.push('pub use types::*;');
  lines.push('pub use enums::*;');
  lines.push('');
  lines.push('/// Generates a wasm-bindgen class wrapper around one contract type.');
  lines.push('/// (fromJson / toJson / validate, callable from JavaScript).');
  lines.push('macro_rules! bridge_wasm_type {');
  lines.push('    ($name:ident) => {');
  lines.push('        #[wasm_bindgen]');
  lines.push('        pub struct $name {');
  lines.push('            inner: types::$name,');
  lines.push('        }');
  lines.push('');
  lines.push('        #[wasm_bindgen]');
  lines.push('        impl $name {');
  lines.push('            /// Parses the type from its JSON wire representation.');
  lines.push('            #[wasm_bindgen(js_name = fromJson)]');
  lines.push('            pub fn from_json(json: &str) -> Result<$name, JsValue> {');
  lines.push('                let inner: types::$name = serde_json::from_str(json)');
  lines.push('                    .map_err(|err| JsValue::from_str(&err.to_string()))?;');
  lines.push('                Ok($name { inner })');
  lines.push('            }');
  lines.push('');
  lines.push('            /// Serializes the type to its JSON wire representation.');
  lines.push('            #[wasm_bindgen(js_name = toJson)]');
  lines.push('            pub fn to_json(&self) -> Result<String, JsValue> {');
  lines.push('                serde_json::to_string(&self.inner).map_err(|err| JsValue::from_str(&err.to_string()))');
  lines.push('            }');
  lines.push('');
  lines.push('            /// Validates constraints; Err carries the violation messages.');
  lines.push('            #[wasm_bindgen(js_name = validate)]');
  lines.push('            pub fn validate(&self) -> Result<(), JsValue> {');
  lines.push('                self.inner.validate().map_err(|err| JsValue::from_str(&format!("{}: {}", err.field, err.message)))');
  lines.push('            }');
  lines.push('        }');
  lines.push('    };');
  lines.push('}');
  lines.push('');
  // Extract the struct names from the generated types module and emit one
  // wrapper invocation per type.
  const dataFiles = generate(ir, { language: 'rust', generateServices: false, generateEvents: false });
  const typesFile = dataFiles.find((f) => f.path === 'src/types.rs');
  const typeNames: string[] = [];
  if (typesFile !== undefined) {
    for (const match of typesFile.content.matchAll(/^pub struct (\w+)/gm)) {
      typeNames.push(match[1]!);
    }
  }
  for (const name of typeNames) {
    lines.push(`bridge_wasm_type!(${name});`);
  }
  if (typeNames.length === 0) {
    lines.push('// (no struct types in this package)');
  }
  lines.push('');
  lines.push('/// Package identity exposed for diagnostics.');
  lines.push('#[wasm_bindgen]');
  lines.push('pub fn bridge_package() -> String {');
  lines.push(`    String::from(${JSON.stringify(ir.name)})`);
  lines.push('}');
  lines.push('');
  lines.push('/// Serializer version gate: JS callers can verify compatibility.');
  lines.push('#[wasm_bindgen]');
  lines.push('pub fn bridge_format_version() -> u32 {');
  lines.push('    1');
  lines.push('}');
  lines.push('');
  return generatedFile('src/lib.rs', `${lines.join('\n')}\n`);
}

/** index.d.ts: typed declarations for the wasm-bindgen output. */
function tsDeclarations(ir: IRPackage): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! Typed declarations for the wasm-bindgen output of this crate.');
  lines.push('//! Runtime shape: each Bridge struct type exposes `fromJson(string)`,');
  lines.push('//! `toJson()` and `validate()`; module-level `bridgePackage()` /');
  lines.push('//! `bridgeFormatVersion()` identify the contract.');
  lines.push('');
  lines.push(`export const BRIDGE_PACKAGE = ${JSON.stringify(ir.name)};`);
  lines.push('export const BRIDGE_FORMAT_VERSION = 1;');
  lines.push('');
  lines.push('export declare class BridgeWasmError extends Error {}');
  lines.push('');

  const dataFiles = generate(ir, { language: 'rust', generateServices: false, generateEvents: false });
  const typesFile = dataFiles.find((f) => f.path === 'src/types.rs');
  const structs = new Map<string, Array<{ name: string; ts: string }>>();
  if (typesFile !== undefined) {
    const structBlocks = typesFile.content.split('#[derive(');
    for (const block of structBlocks.slice(1)) {
      const nameMatch = /pub struct (\w+)/.exec(block);
      if (nameMatch === null) continue;
      const fields: Array<{ name: string; ts: string }> = [];
      for (const fieldMatch of /pub (\w+):\s*(.+),/g.exec(block) === null ? [] : block.matchAll(/pub (\w+):\s*([^\n]+?),?$/gm)) {
        const rustName = fieldMatch[1]!;
        const rustType = fieldMatch[2]!.trim();
        fields.push({ name: rustName, ts: rustToTsType(rustType) });
      }
      structs.set(nameMatch[1]!, fields);
    }
  }
  for (const [name, fields] of structs) {
    const camel = name.charAt(0).toLowerCase() + name.slice(1);
    lines.push(`export declare class ${name}Wasm {`);
    lines.push(`  static fromJson(json: string): ${name}Wasm;`);
    lines.push('  toJson(): string;');
    lines.push('  validate(): void;');
    for (const field of fields) {
      lines.push(`  readonly ${camelToJs(field.name)}: ${field.ts};`);
    }
    lines.push('}');
    lines.push('');
    void camel;
  }
  lines.push('export declare function bridgePackage(): string;');
  lines.push('export declare function bridgeFormatVersion(): number;');
  lines.push('');
  return generatedFile('index.d.ts', `${lines.join('\n')}\n`);
}

/** index.js: loader + typed façade over the wasm-bindgen output. */
function tsLoader(ir: IRPackage): GeneratedFile {
  const crate = (ffiCrateName(ir.name) + '-wasm').replace(/-/g, '_');
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('/**');
  lines.push(' * Loader + typed façade for the wasm module. Run `wasm-bindgen` with');
  lines.push(' * `--out-dir pkg` on the built wasm32 artifact first:');
  lines.push(' *');
  lines.push(' *   cargo build --target wasm32-unknown-unknown --release');
  lines.push(` *   wasm-bindgen target/wasm32-unknown-unknown/release/${crate}.wasm --out-dir pkg --target bundler`);
  lines.push(' *');
  lines.push(' * The default import path resolves to ./pkg — override with');
  lines.push(' * BRIDGE_WASM_INIT env-free bundler aliases if needed.');
  lines.push(' */');
  lines.push('');
  lines.push(`// @ts-ignore — generated by wasm-bindgen at build time`);
  lines.push(`import init, { bridgePackage, bridgeFormatVersion${''} } from './pkg/${crate}_bg.js';`);
  lines.push('');
  lines.push('export * from \'./index.d.js\';');
  lines.push('');
  lines.push('let initialized = false;');
  lines.push('');
  lines.push('/** Loads and instantiates the wasm module exactly once. */');
  lines.push('export async function loadWasm(): Promise<void> {');
  lines.push('  if (initialized) return;');
  lines.push('  await init();');
  lines.push('  initialized = true;');
  lines.push('}');
  lines.push('');
  lines.push('/** Identity probe: returns the contract package name from the module. */');
  lines.push('export async function packageId(): Promise<string> {');
  lines.push('  await loadWasm();');
  lines.push('  return bridgePackage();');
  lines.push('}');
  lines.push('');
  lines.push('/** Format gate: returns 1 for the v1 wire format. */');
  lines.push('export async function formatVersion(): Promise<number> {');
  lines.push('  await loadWasm();');
  lines.push('  return bridgeFormatVersion();');
  lines.push('}');
  lines.push('');
  void rustCrateName;
  return generatedFile('index.ts', `${lines.join('\n')}\n`);
}

/** Rust type → TS type for declaration emission. */
function rustToTsType(rustType: string): string {
  const t = rustType.trim();
  if (t === 'String' || t === 'uuid' || t.startsWith('String')) return 'string';
  if (t === 'bool') return 'boolean';
  if (t.startsWith('i') || t.startsWith('u') || t.startsWith('f')) {
    return 'number';
  }
  if (t.startsWith('Vec<')) {
    return `${rustToTsType(t.slice(4, -1))}[]`;
  }
  if (t.startsWith('Option<')) {
    return `${rustToTsType(t.slice(7, -1))} | null`;
  }
  if (t.startsWith('BTreeMap<') || t.startsWith('HashMap<')) {
    const inner = t.slice(t.indexOf('<') + 1, t.lastIndexOf('>'));
    const value = inner.split(',').slice(1).join(',').trim();
    return `Record<string, ${rustToTsType(value)}>`;
  }
  if (t === 'serde_json::Value' || t === 'JsonValue') return 'unknown';
  return 'unknown';
}

function camelToJs(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

void wasmTsType;
