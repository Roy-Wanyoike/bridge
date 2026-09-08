/**
 * Lexer tests: UTF-8 BOM tolerance at position 0 and CRLF canonicalization
 * of doc comments. (Core lexing behavior is exercised through the parser
 * suite; these cover the adversarial-input cases from issue #42.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../lexer';
import { compileSource } from '../compiler/compile';

// ------------------------------------------------------------------ BOM

test('BOM at position 0 is skipped silently', () => {
  const lexed = tokenize('\uFEFFpackage p\ntype T {\n    x: int32\n}\n', 'bom.bridge');
  assert.deepEqual(lexed.diagnostics, [], 'no diagnostic for a leading BOM');
  const first = lexed.tokens[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, 'keyword');
  assert.equal(first.text, 'package');
  assert.equal(first.line, 1, 'BOM is invisible: the first token stays on line 1');
  assert.equal(first.column, 1, 'BOM is invisible: the first token stays at column 1');
});

test('a file containing only a BOM lexes to a single eof token', () => {
  const lexed = tokenize('\uFEFF', 'bom.bridge');
  assert.deepEqual(lexed.diagnostics, []);
  assert.equal(lexed.tokens.length, 1);
  assert.equal(lexed.tokens[0]?.kind, 'eof');
});

test('a BOM-compiling file compiles cleanly end to end', () => {
  const result = compileSource('\uFEFFpackage p\ntype T {\n    x: int32\n}\n', 'bom.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('a BOM after position 0 is still an unexpected character', () => {
  const lexed = tokenize('package p\n\uFEFF\ntype T { x: int32 }\n', 'bom.bridge');
  assert.equal(
    lexed.diagnostics.some((d) => d.code === 'BR1001'),
    true,
    'mid-file BOM must be reported',
  );
});

// ------------------------------------------------------------------ CRLF

test('CRLF doc comments: trailing \\r is stripped from doc text', () => {
  const lexed = tokenize(
    'package p\r\n/// Struct docs.\r\ntype T {\r\n    /// Field docs.\r\n    x: int32\r\n}\r\n',
    'crlf.bridge',
  );
  assert.deepEqual(lexed.diagnostics, []);
  const docs = lexed.tokens.filter((t) => t.kind === 'doc').map((t) => t.text);
  assert.deepEqual(docs, ['Struct docs.', 'Field docs.']);
  assert.ok(docs.every((d) => !d.includes('\r')), JSON.stringify(docs));
});

test('CRLF files parse with clean doc text end to end', () => {
  const result = compileSource(
    'package p\r\n/// Struct docs.\r\ntype T {\r\n    /// Field docs.\r\n    x: int32\r\n}\r\n',
    'crlf.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const t = result.ir?.types[0];
  assert.equal(t?.docs, 'Struct docs.');
  assert.equal(t?.kind === 'struct' ? t.fields[0]?.docs : undefined, 'Field docs.');
});

test('lone \\r is whitespace and CRLF still advances the line counter', () => {
  const lexed = tokenize('package p\r\n\r\ntype T {\r\n    x: int32\r\n}\r\n', 'crlf.bridge');
  assert.deepEqual(lexed.diagnostics, []);
  const typeKeyword = lexed.tokens.find((t) => t.text === 'type');
  assert.equal(typeKeyword?.line, 3, 'each CRLF advances exactly one line');
  const eof = lexed.tokens[lexed.tokens.length - 1];
  assert.equal(eof?.kind, 'eof');
});
