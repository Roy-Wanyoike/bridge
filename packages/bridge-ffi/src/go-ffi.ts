/**
 * Go cgo client generator.
 *
 * Emits a Go package whose cgo preamble includes the SAME C header the
 * Rust crate defines — one ABI, two declarations. Each method becomes a
 * typed wrapper: marshal the request → copy into a C buffer → call →
 * read the response → free → unmarshal (mapping non-zero statuses to a
 * typed Go error carrying the `{"error": ...}` body).
 */

import type { IRPackage } from '@bridge/core';
import { cHeaderFile, freeSymbol, methodSymbol, sortedServiceMethods } from './abi';
import { fileHeader, generatedFile } from './util';
import type { GeneratedFile } from './util';

function typeName(ref: { kind: string; name?: string }): string {
  if (ref.kind === 'named' && typeof ref.name === 'string') return ref.name;
  throw new Error(`ffi generator: service methods must use named request/response types (got ${ref.kind})`);
}

function pkgSym(packageName: string): string {
  return packageName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Go method name (PascalCase over service+method, preserving humps). */
function goMethod(service: string, method: string): string {
  const raw = service + method;
  const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split('_');
  return parts.map((p) => (p.length > 0 ? p.charAt(0).toUpperCase() + p.slice(1) : '')).join('');
}

/** Go module path for the generated package. */
export function goModulePath(packageName: string): string {
  return `bridge/generated/${pkgSym(packageName)}/ffi`;
}

/** Generates the Go cgo client package for an IR package. */
export function generateGoFfi(ir: IRPackage, generateServices = true): GeneratedFile[] {
  const files: GeneratedFile[] = [goMod(ir), goHeader(ir)];
  const methods = generateServices ? sortedServiceMethods(ir) : [];
  files.push(clientGo(ir, methods));
  files.push(verifyTestGo(ir, methods));
  return files;
}

function goMod(ir: IRPackage): GeneratedFile {
  const lines = [
    `// ${fileHeader('//', ir.name)}`,
    `module ${goModulePath(ir.name)}`,
    '',
    'go 1.22',
    '',
  ];
  return generatedFile('go.mod', lines.join('\n'));
}

/** The shared C header, emitted at the Go package root for cgo. */
function goHeader(ir: IRPackage): GeneratedFile {
  const header = cHeaderFile(ir);
  return generatedFile(`bridge_${pkgSym(ir.name)}.h`, header.content);
}

/** client.go: cgo preamble + typed wrappers + error plumbing. */
function clientGo(ir: IRPackage, methods: ReturnType<typeof sortedServiceMethods>): GeneratedFile {
  const sym = pkgSym(ir.name);
  const free = freeSymbol(ir.name);
  const lines: string[] = [];
  lines.push(fileHeader('//', ir.name));
  lines.push('');
  lines.push('// Package ffi is the cgo client for the ' + ir.name + ' Bridge contract:');
  lines.push('// each service method is a typed function call into the Rust cdylib.');
  lines.push('//');
  lines.push('// Ownership: input buffers are copied from Go memory; response buffers');
  lines.push('// are allocated by the library and released via ' + free + ' before the');
  lines.push('// wrapper returns — responses are never leaked.');
  lines.push('//');
  lines.push('// Link requirements (set when building against the compiled cdylib):');
  lines.push('//   CGO_LDFLAGS="-L<crate>/target/release -l<libname>"');
  lines.push('');
  lines.push('package ffi');
  lines.push('');
  lines.push('/*');
  lines.push('#include <stdlib.h>');
  lines.push('#include "bridge_' + sym + '.h"');
  lines.push('*/');
  lines.push('import "C"');
  lines.push('');
  lines.push('import (');
  lines.push('\t"encoding/json"');
  lines.push('\t"fmt"');
  lines.push('\t"unsafe"');
  lines.push(')');
  lines.push('');
  lines.push('// BridgeCallError carries the library error body across the boundary.');
  lines.push('type BridgeCallError struct {');
  lines.push('\tStatus  int');
  lines.push('\tCode    string `json:"code"`');
  lines.push('\tMessage string `json:"message"`');
  lines.push('}');
  lines.push('');
  lines.push('func (e *BridgeCallError) Error() string {');
  lines.push('\treturn fmt.Sprintf("bridge ffi %s: %s (status %d)", e.Code, e.Message, e.Status)');
  lines.push('}');
  lines.push('');
  lines.push('// cCall is the C signature every generated entry point shares.');
  lines.push('type cCall func(*C.uint8_t, C.uintptr_t, **C.uint8_t, *C.uintptr_t) C.int32_t');
  lines.push('');
  lines.push('// callSymbol is the shared plumbing behind every typed wrapper.');
  lines.push('// status 0 → response bytes; non-zero → *BridgeCallError from the');
  lines.push('// `{"error": {...}}` body. Response buffers are always freed.');
  lines.push('func callSymbol(call cCall, request []byte) ([]byte, error) {');
  lines.push('\tvar outPtr *C.uint8_t');
  lines.push('\tvar outLen C.uintptr_t');
  lines.push('');
  lines.push('\tvar inPtr *C.uint8_t');
  lines.push('\tvar inLen C.uintptr_t');
  lines.push('\tif len(request) > 0 {');
  lines.push('\t\tcInput := C.CBytes(request)');
  lines.push('\t\tdefer C.free(cInput)');
  lines.push('\t\tinPtr = (*C.uint8_t)(cInput)');
  lines.push('\t\tinLen = C.uintptr_t(len(request))');
  lines.push('\t}');
  lines.push('');
  lines.push('\tstatus := int(call(inPtr, inLen, &outPtr, &outLen))');
  lines.push('');
  lines.push('\tvar response []byte');
  lines.push('\tif outPtr != nil && outLen > 0 {');
  lines.push('\t\tresponse = C.GoBytes(unsafe.Pointer(outPtr), C.int(outLen))');
  lines.push('\t\tC.' + free + '(outPtr, C.uintptr_t(outLen))');
  lines.push('\t}');
  lines.push('');
  lines.push('\tif status != 0 {');
  lines.push('\t\tcallErr := &BridgeCallError{Status: status, Code: "internal", Message: "call failed"}');
  lines.push('\t\tvar body struct {');
  lines.push('\t\t\tError *BridgeCallError `json:"error"`');
  lines.push('\t\t}');
  lines.push('\t\tif len(response) > 0 && json.Unmarshal(response, &body) == nil && body.Error != nil {');
  lines.push('\t\t\tcallErr.Code = body.Error.Code');
  lines.push('\t\t\tcallErr.Message = body.Error.Message');
  lines.push('\t\t}');
  lines.push('\t\treturn nil, callErr');
  lines.push('\t}');
  lines.push('\treturn response, nil');
  lines.push('}');
  lines.push('');
  lines.push('// Echo calls the universal probe: the input JSON comes back verbatim.');
  lines.push('// It exercises allocation, ownership and freeing without any handler.');
  lines.push('func Echo(request []byte) ([]byte, error) {');
  lines.push('\treturn callSymbol(func(in *C.uint8_t, inLen C.uintptr_t, out **C.uint8_t, outLen *C.uintptr_t) C.int32_t {');
  lines.push('\t\treturn C.bridge_' + sym + '_echo_call(in, inLen, out, outLen)');
  lines.push('\t}, request)');
  lines.push('}');

  for (const { service, method } of methods) {
    const input = typeName(method.input);
    const output = typeName(method.output);
    const symbol = methodSymbol(ir.name, service.name, method.name);
    const name = goMethod(service.name, method.name);
    lines.push('');
    lines.push('// ' + name + ' calls ' + service.name + '.' + method.name + ' over the FFI.');
    lines.push('// Request: raw JSON of the contract type `' + input + '`.');
    lines.push('// Response: raw JSON of `' + output + '`, or *BridgeCallError.');
    lines.push('func ' + name + '(request json.RawMessage) (json.RawMessage, error) {');
    lines.push('\tresult, callErr := callSymbol(func(in *C.uint8_t, inLen C.uintptr_t, out **C.uint8_t, outLen *C.uintptr_t) C.int32_t {');
    lines.push('\t\treturn C.' + symbol + '(in, inLen, out, outLen)');
    lines.push('\t}, request)');
    lines.push('\tif callErr != nil {');
    lines.push('\t\treturn nil, callErr');
    lines.push('\t}');
    lines.push('\treturn json.RawMessage(result), nil');
    lines.push('}');
  }

  return generatedFile('client.go', `${lines.join('\n')}\n`);
}

/** verify test (build-tagged): real round-trip against the built dylib. */
function verifyTestGo(ir: IRPackage, methods: ReturnType<typeof sortedServiceMethods>): GeneratedFile {
  const lines: string[] = [];
  lines.push('// ' + fileHeader('//', ir.name));
  lines.push('//');
  lines.push('// Cross-language verification: run with the Rust cdylib built and');
  lines.push('// linked, e.g.');
  lines.push('//   go test -tags bridge_ffi_verify ./...');
  lines.push('');
  lines.push('//go:build bridge_ffi_verify');
  lines.push('');
  lines.push('package ffi');
  lines.push('');
  lines.push('import (');
  lines.push('\t"encoding/json"');
  lines.push('\t"reflect"');
  lines.push('\t"testing"');
  lines.push(')');
  lines.push('');
  lines.push('// TestEchoRoundTrip proves the buffer protocol end to end through C:');
  lines.push('// Go allocates the input, the library allocates the output, Go frees.');
  lines.push('// Equality is SEMANTIC (JSON value equality): the echo re-serializes');
  lines.push('// through serde_json, so key order/whitespace is normalized.');
  lines.push('func TestEchoRoundTrip(t *testing.T) {');
  lines.push('\tinput := []byte(`{"hello": ["bridge", "ffi", 1], "ok": true}`)');
  lines.push('\toutput, err := Echo(input)');
  lines.push('\tif err != nil {');
  lines.push('\t\tt.Fatalf("echo: %v", err)');
  lines.push('\t}');
  lines.push('\tvar want, got any;');
  lines.push('\tif err := json.Unmarshal(input, &want); err != nil {');
  lines.push('\t\tt.Fatalf("unmarshal input: %v", err)');
  lines.push('\t}');
  lines.push('\tif err := json.Unmarshal(output, &got); err != nil {');
  lines.push('\t\tt.Fatalf("unmarshal output: %v", err)');
  lines.push('\t}');
  lines.push('\tif !reflect.DeepEqual(want, got) {');
  lines.push('\t\tt.Fatalf("echo mismatch: want %s got %s", input, output)');
  lines.push('\t}');
  lines.push('}');
  lines.push('');
  lines.push('// TestInvalidJSONRejected proves error plumbing over the boundary.');
  lines.push('func TestInvalidJSONRejected(t *testing.T) {');
  lines.push('\t_, err := Echo([]byte("{nope"))');
  lines.push('\tif err == nil {');
  lines.push('\t\tt.Fatal("expected an error for invalid JSON")');
  lines.push('\t}');
  lines.push('\tif callErr, ok := err.(*BridgeCallError); !ok || callErr.Status == 0 {');
  lines.push('\t\tt.Fatalf("expected a BridgeCallError with a non-zero status, got %v", err)');
  lines.push('\t}');
  lines.push('}');
  if (methods.length > 0) {
    const { service, method } = methods[0]!;
    lines.push('');
    lines.push('// TestNoHandler proves per-method dispatch reports uninstalled handlers');
    lines.push('// with the canonical error body (handler presence is checked BEFORE');
    lines.push('// request parsing, so `{}` is enough to reach the dispatch decision).');
    lines.push('func TestNoHandler(t *testing.T) {');
    lines.push('\t_, err := ' + goMethod(service.name, method.name) + '(json.RawMessage(`{}`))');
    lines.push('\tif err == nil {');
    lines.push('\t\tt.Fatal("expected no_handler error before handlers are installed")');
    lines.push('\t}');
    lines.push('\tif callErr, ok := err.(*BridgeCallError); !ok || callErr.Code != "no_handler" {');
    lines.push('\t\tt.Fatalf("expected no_handler, got %v", err)');
    lines.push('\t}');
    lines.push('}');
  }
  lines.push('');
  return generatedFile('ffi_verify_test.go', lines.join('\n'));
}
