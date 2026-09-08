/**
 * Rust C-ABI generator.
 *
 * Emits a cdylib crate for a Bridge package: the contract's types (reused
 * byte-for-byte from the Rust data generator), a handler registry the
 * embedder fills with real implementations, and `#[no_mangle] extern "C"`
 * entry points per service method plus the universal `echo` probe.
 *
 * Ownership: the callee allocates exactly one output buffer per call
 * (JSON bytes); the caller releases it with the generated `<pkg>_free`.
 * Panics never cross the boundary (catch_unwind → STATUS_PANIC).
 */

import type { IRPackage } from '@bridge/core';
import { generate } from '@bridge/generators';
import {
  FFI_STATUS,
  cHeaderFile,
  demoHandlerSymbol,
  ffiCrateName,
  ffiLibName,
  freeSymbol,
  methodSymbol,
  sortedServiceMethods,
} from './abi';
import { fileHeader, generatedFile, joinBlocks } from './util';
import type { GeneratedFile } from './util';

/** Input/output type name for a method (named refs only, per the IR). */
function typeName(ref: { kind: string; name?: string }): string {
  if (ref.kind === 'named' && typeof ref.name === 'string') return ref.name;
  throw new Error(`ffi generator: service methods must use named request/response types (got ${ref.kind})`);
}

/** Rust identifier for a method (snake_case) inside the registry struct. */
function registryField(method: string): string {
  return method
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Generates the Rust C-ABI cdylib crate for an IR package. */
export function generateRustFfi(ir: IRPackage, generateServices = true): GeneratedFile[] {
  const crate = ffiCrateName(ir.name);
  const files: GeneratedFile[] = [];

  files.push(cargoToml(ir, crate));
  files.push(cHeaderFile(ir));

  const methods = generateServices ? sortedServiceMethods(ir) : [];
  const hasMethods = methods.length > 0;

  // Reuse the data generator's types/enums/validate modules verbatim —
  // one contract, one canonical set of types on both sides of the wire.
  const dataFiles = generate(ir, { language: 'rust', generateServices: false, generateEvents: false });
  for (const path of ['src/types.rs', 'src/enums.rs', 'src/validate.rs']) {
    const file = dataFiles.find((f) => f.path === path);
    if (file !== undefined) files.push(file);
  }
  const hasTypes = dataFiles.some((f) => f.path === 'src/types.rs');
  const hasEnums = dataFiles.some((f) => f.path === 'src/enums.rs');

  files.push(libRs(ir, crate, hasMethods, hasTypes, hasEnums));
  files.push(ffiRs(ir, methods, hasTypes));
  files.push(roundtripTest(ir, hasMethods));

  return files;
}

function cargoToml(ir: IRPackage, crate: string): GeneratedFile {
  const lines = [
    `# ${fileHeader('#', ir.name)}`,
    '[package]',
    `name = "${crate}"`,
    'version = "0.1.0"',
    'edition = "2021"',
    `description = "C-ABI dynamic library for the ${ir.name} Bridge contract."`,
    '',
    '[lib]',
    'crate-type = ["cdylib", "rlib"]',
    `name = "${ffiLibName(ir.name)}"`,
    '',
    '[dependencies]',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    '',
  ];
  return generatedFile('Cargo.toml', lines.join('\n'));
}

function libRs(ir: IRPackage, _crate: string, hasMethods: boolean, hasTypes: boolean, hasEnums: boolean): GeneratedFile {
  const blocks: string[] = [];
  const head = [
    fileHeader('//', ir.name),
    '//!',
    `//! C-ABI entry points for the ${ir.name} contract.`,
    '//!',
    '//! - Types are the canonical Bridge-generated Rust types (serde).',
    '//! - Embedders install per-method handlers via `install_handlers`.',
    '//! - The `echo` probe exercises the buffer protocol without a handler.',
    '//! - Panics are caught at the boundary and never unwind across FFI.',
  ].join('\n');
  blocks.push(head);

  const modLines: string[] = [];
  if (hasTypes) modLines.push('pub mod types;');
  if (hasEnums) modLines.push('pub mod enums;');
  if (hasTypes) modLines.push('pub mod validate;');
  modLines.push('pub mod ffi;');
  blocks.push(modLines.join('\n'));

  if (hasTypes) {
    blocks.push('pub use types::*;');
  }

  if (hasMethods) {
    // Handler registry + demo installer live in lib.rs so embedders can
    // link a single symbol surface.
    const fields = sortedServiceMethods(ir).map(({ service, method }) => {
      const input = typeName(method.input);
      const output = typeName(method.output);
      return `    pub ${registryField(service.name)}_${registryField(method.name)}: Option<fn(${input}) -> Result<${output}, BridgeHandlerError>>,`;
    });
    const defaultHandlers = sortedServiceMethods(ir)
      .map(({ service, method }) => `            ${registryField(service.name)}_${registryField(method.name)}: None,`)
      .join('\n');

    blocks.push(
      [
        '/// Error carried back over the boundary as `{"error": {"code", "message"}}`.',
        '#[derive(Debug, Clone, serde::Serialize)]',
        'pub struct BridgeHandlerError {',
        '    pub code: String,',
        '    pub message: String,',
        '}',
        '',
        'impl BridgeHandlerError {',
        '    pub fn new(code: &str, message: impl Into<String>) -> Self {',
        '        Self { code: code.to_string(), message: message.into() }',
        '    }',
        '}',
        '',
        '/// Per-method handlers installed by the embedder. `None` methods',
        '/// answer with STATUS_NO_HANDLER.',
        'pub struct Handlers {',
        fields.join('\n'),
        '}',
        '',
        'impl Default for Handlers {',
        '    fn default() -> Self {',
        '        Self {',
        defaultHandlers,
        '        }',
        '    }',
        '}',
        '',
        'static HANDLERS: std::sync::OnceLock<Handlers> = std::sync::OnceLock::new();',
        '',
        '/// Installs the handler set. Only the FIRST call wins (OnceLock);',
        '/// subsequent calls are no-ops.',
        'pub fn install_handlers(handlers: Handlers) {',
        '    let _ = HANDLERS.set(handlers);',
        '}',
        '',
        `#[no_mangle]`,
        `pub extern "C" fn ${demoHandlerSymbol(ir.name)}() -> i32 {`,
        '    // Demo installer: leaves every method unregistered so callers can',
        '    // exercise the STATUS_NO_HANDLER path deterministically.',
        `    install_handlers(Handlers::default());`,
        `    ${FFI_STATUS.ok}`,
        '}',
      ].join('\n'),
    );
  }

  const content = `${joinBlocks(blocks)}\n`;
  return generatedFile('src/lib.rs', content);
}

/**
 * The `echo` probe shared by every package: parses the input as JSON and
 * echoes it back — exercising allocation, ownership and free without a
 * handler.
 */
function echoBlock(ir: IRPackage): string[] {
  const lines = [
    `/// Universal probe: echoes the input JSON back verbatim. Exercises the`,
    '/// buffer protocol (allocate → write → free) without needing a handler.',
    '#[no_mangle]',
    `pub extern "C" fn ${echoSymbol(ir.name)}(input: *const u8, input_len: usize, output: *mut *mut u8, output_len: *mut usize) -> i32 {`,
    '    let status = catch_unwind(AssertUnwindSafe(|| {',
    '        let bytes = unsafe { std::slice::from_raw_parts(input, input_len) };',
    '        let value: serde_json::Value = match serde_json::from_slice(bytes) {',
    '            Ok(v) => v,',
    '            Err(_) => return respond_error(output, output_len, STATUS_INVALID_JSON, "invalid_request", "input is not valid JSON"),',
    '        };',
    '        respond_json(output, output_len, &value)',
    '    }));',
    '    match status {',
    `        Ok(code) => code,`,
    `        Err(_) => ${FFI_STATUS.panic},`,
    '    }',
    '}',
  ];
  return lines;
}

function pkgSym(ir: IRPackage): string {
  return ir.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Echo symbol for a package. */
export function echoSymbol(packageName: string): string {
  return `bridge_${packageName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_echo_call`;
}

/** Renders src/ffi.rs: status plumbing + one entry point per method. */
function ffiRs(ir: IRPackage, methods: ReturnType<typeof sortedServiceMethods>, hasTypes: boolean): GeneratedFile {
  const hasMethods = methods.length > 0;
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! C-ABI surface: buffer protocol, panic containment, per-method');
  lines.push('//! dispatch to the installed handlers.');
  lines.push('');
  lines.push('use std::panic::{catch_unwind, AssertUnwindSafe};');
  lines.push('');
  if (hasMethods) {
    lines.push('use crate::HANDLERS;');
  }
  if (hasTypes) {
    lines.push('use crate::types::*;');
  }
  lines.push('');
  lines.push(`pub const STATUS_OK: i32 = ${FFI_STATUS.ok};`);
  lines.push(`pub const STATUS_PANIC: i32 = ${FFI_STATUS.panic};`);
  lines.push(`pub const STATUS_INVALID_JSON: i32 = ${FFI_STATUS.invalidJson};`);
  lines.push(`pub const STATUS_HANDLER_ERROR: i32 = ${FFI_STATUS.handlerError};`);
  lines.push(`pub const STATUS_NO_HANDLER: i32 = ${FFI_STATUS.noHandler};`);
  lines.push(`pub const STATUS_VALIDATION_FAILED: i32 = ${FFI_STATUS.validationFailed};`);
  lines.push('');
  lines.push('/// Writes `value` into a freshly allocated buffer; the caller owns it.');
  lines.push('fn respond_json(output: *mut *mut u8, output_len: *mut usize, value: &serde_json::Value) -> i32 {');
  lines.push('    let bytes = match serde_json::to_vec(value) {');
  lines.push('        Ok(b) => b,');
  lines.push('        Err(_) => return STATUS_HANDLER_ERROR,');
  lines.push('    };');
  lines.push('    let len = bytes.len();');
  lines.push('    let ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8;');
  lines.push('    unsafe {');
  lines.push('        *output = ptr;');
  lines.push('        *output_len = len;');
  lines.push('    }');
  lines.push('    STATUS_OK');
  lines.push('}');
  lines.push('');
  lines.push('/// Writes `{"error": {"code", "message"}}` into the output buffer and');
  lines.push('/// returns the supplied failure status (the body documents the cause).');
  lines.push('fn respond_error(');
  lines.push('    output: *mut *mut u8,');
  lines.push('    output_len: *mut usize,');
  lines.push('    status: i32,');
  lines.push('    code: &str,');
  lines.push('    message: &str,');
  lines.push(') -> i32 {');
  lines.push('    let body = serde_json::json!({ "error": { "code": code, "message": message } });');
  lines.push('    let _ = respond_json(output, output_len, &body);');
  lines.push('    status');
  lines.push('}');
  lines.push('');
  lines.push('/// Releases an output buffer previously returned by this library.');
  lines.push('/// Passing null or a zero length is a safe no-op.');
  lines.push(`#[no_mangle]`);
  lines.push(`pub extern "C" fn ${freeSymbol(ir.name)}(ptr: *mut u8, len: usize) {`);
  lines.push('    if ptr.is_null() || len == 0 {');
  lines.push('        return;');
  lines.push('    }');
  lines.push('    unsafe {');
  lines.push('        drop(Vec::from_raw_parts(ptr as *mut u8, len, len));');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push(echoBlock(ir).join('\n'));
  lines.push('');
  lines.push('/// Safe wrapper over the echo symbol (same buffer protocol).');
  lines.push('#[allow(non_snake_case)]');
  lines.push('pub fn echo_call(');
  lines.push('    input: *const u8,');
  lines.push('    input_len: usize,');
  lines.push('    output: *mut *mut u8,');
  lines.push('    output_len: *mut usize,');
  lines.push(') -> i32 {');
  lines.push(`    ${echoSymbol(ir.name)}(input, input_len, output, output_len)`);
  lines.push('}');
  lines.push('');
  lines.push('/// Safe wrapper over the exported free function.');
  lines.push('pub fn free_buffer(ptr: *mut u8, len: usize) {');
  lines.push(`    ${freeSymbol(ir.name)}(ptr, len)`);
  lines.push('}');
  lines.push('');

  for (const { service, method } of methods) {
    const input = typeName(method.input);
    const output = typeName(method.output);
    const symbol = methodSymbol(ir.name, service.name, method.name);
    const field = `${registryField(service.name)}_${registryField(method.name)}`;
    lines.push(`/// ${service.name}.${method.name} over the C ABI.`);
    lines.push('/// Input: JSON `' + input + '`. Output: JSON `' + output + '` (caller frees).');
    lines.push('#[no_mangle]');
    lines.push(`pub extern "C" fn ${symbol}(`);
    lines.push('    input: *const u8,');
    lines.push('    input_len: usize,');
    lines.push('    output: *mut *mut u8,');
    lines.push('    output_len: *mut usize,');
    lines.push(') -> i32 {');
    lines.push('    let status = catch_unwind(AssertUnwindSafe(|| {');
    lines.push('        // Handler presence is checked BEFORE parsing so embedders can');
    lines.push('        // probe dispatch without a valid request body.');
    lines.push('        let handler = HANDLERS.get().and_then(|h| h.' + field + ');');
    lines.push('        let handler = match handler {');
    lines.push('            Some(h) => h,');
    lines.push('            None => return respond_error(output, output_len, STATUS_NO_HANDLER, "no_handler", "no handler installed for this method"),');
    lines.push('        };');
    lines.push('        let bytes = unsafe { std::slice::from_raw_parts(input, input_len) };');
    lines.push(`        let request: ${input} = match serde_json::from_slice(bytes) {`);
    lines.push('            Ok(r) => r,');
    lines.push('            Err(_) => return respond_error(output, output_len, STATUS_INVALID_JSON, "invalid_request", "request does not match the contract"),');
    lines.push('        };');
    lines.push('        if let Err(_validation) = request.validate() {');
    lines.push('            return respond_error(output, output_len, STATUS_VALIDATION_FAILED, "validation_failed", "request violates the contract constraints");');
    lines.push('        }');
    lines.push('        match handler(request) {');
    lines.push('            Ok(response) => match serde_json::to_value(&response) {');
    lines.push('                Ok(value) => respond_json(output, output_len, &value),');
    lines.push('                Err(_) => respond_error(output, output_len, STATUS_HANDLER_ERROR, "handler_error", "response serialization failed"),');
    lines.push('            },');
    lines.push('            Err(err) => respond_error(output, output_len, STATUS_HANDLER_ERROR, &err.code, &err.message),');
    lines.push('        }');
    lines.push('    }));');
    lines.push('    match status {');
    lines.push('        Ok(code) => code,');
    lines.push(`        Err(_) => ${FFI_STATUS.panic},`);
    lines.push('    }');
    lines.push('}');
    lines.push('');
    lines.push('/// Safe Rust wrapper over the raw symbol (same buffer protocol).');
    lines.push('pub fn ' + field + '_call(');
    lines.push('    input: *const u8,');
    lines.push('    input_len: usize,');
    lines.push('    output: *mut *mut u8,');
    lines.push('    output_len: *mut usize,');
    lines.push(') -> i32 {');
    lines.push(`    ${symbol}(input, input_len, output, output_len)`);
    lines.push('}');
    lines.push('');
  }

  return generatedFile('src/ffi.rs', `${lines.join('\n')}\n`);
}

/** Rust-side self test: echo + no-handler paths, run by `cargo test`. */
function roundtripTest(ir: IRPackage, hasMethods: boolean): GeneratedFile {
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('//! ABI-level self test: exercised by `cargo test` without any');
  lines.push('//! foreign caller. The Go verify suite cross-checks the same paths');
  lines.push('//! through cgo.');
  lines.push('');
  lines.push(`use ${ffiLibName(ir.name)}::ffi;`);
  if (hasMethods) {
    lines.push(`use ${ffiLibName(ir.name)}::{install_handlers, Handlers};`);
  }
  lines.push('');
  lines.push('#test]');
  lines[lines.length - 1] = '#[test]';
  lines.push('fn echo_round_trips_json() {');
  lines.push('    let input = br#"{"k": [1, 2, 3]}"#;');
  lines.push('    let mut out: *mut u8 = std::ptr::null_mut();');
  lines.push('    let mut out_len: usize = 0;');
  lines.push('    let status = ffi::echo_call(');
  lines.push('        input.as_ptr(),');
  lines.push('        input.len(),');
  lines.push('        &mut out,');
  lines.push('        &mut out_len,');
  lines.push('    );');
  lines.push('    assert_eq!(status, ffi::STATUS_OK);');
  lines.push('    let echoed = unsafe { std::slice::from_raw_parts(out, out_len) };');
  lines.push('    let value: serde_json::Value = serde_json::from_slice(echoed).unwrap();');
  lines.push('    assert_eq!(value["k"][1], 2);');
  lines.push(`    ${ffiLibName(ir.name)}::ffi::free_buffer(out, out_len);`);
  lines.push('}');
  lines.push('');
  lines.push('#[test]');
  lines.push('fn invalid_json_is_rejected_with_status_and_error_body() {');
  lines.push('    let input = b"{nope";');
  lines.push('    let mut out: *mut u8 = std::ptr::null_mut();');
  lines.push('    let mut out_len: usize = 0;');
  lines.push('    let status = ffi::echo_call(input.as_ptr(), input.len(), &mut out, &mut out_len);');
  lines.push('    assert_eq!(status, ffi::STATUS_INVALID_JSON);');
  lines.push('    let body = unsafe { std::slice::from_raw_parts(out, out_len) };');
  lines.push('    let value: serde_json::Value = serde_json::from_slice(body).unwrap();');
  lines.push('    assert_eq!(value["error"]["code"], "invalid_request");');
  lines.push('    ffi::free_buffer(out, out_len);');
  lines.push('}');
  if (hasMethods) {
    lines.push('');
    lines.push('#[test]');
    lines.push('fn uninstalled_handlers_answer_no_handler() {');
    lines.push('    install_handlers(Handlers::default());');
    const first = sortedServiceMethods(ir)[0];
    if (first !== undefined) {
      const field = `${registryField(first.service.name)}_${registryField(first.method.name)}`;
      lines.push(`    use ${ffiLibName(ir.name)}::ffi as rawffi;`);
      lines.push('    let input = b"{}";');
      lines.push('    let mut out: *mut u8 = std::ptr::null_mut();');
      lines.push('    let mut out_len: usize = 0;');
      lines.push('    let status = rawffi::' + field + '_call(input.as_ptr(), input.len(), &mut out, &mut out_len);');
      lines.push('    assert_eq!(status, ffi::STATUS_NO_HANDLER);');
      lines.push('    ffi::free_buffer(out, out_len);');
    }
    lines.push('}');
  }
  lines.push('');
  return generatedFile('tests/abi.rs', `${lines.join('\n')}\n`);
}
