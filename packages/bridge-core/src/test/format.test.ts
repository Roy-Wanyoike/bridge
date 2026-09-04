/**
 * Formatter tests: canonical 4-space output, exact layout, idempotence
 * (format∘format = format), doc preservation and failure behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSource } from '../format';

const MESSY = `package   shop.v1
/// Money.
type    Money{
    amount:int64 @min( 0 )
    currency:string @length(3)="USD"
    label?:string
    // plain comments are dropped; only /// docs survive
}

enum Status { ACTIVE
BANNED }

service   Svc{
/// Do it.
Get(Money)->Money
}
alias   Tag = map<string,list<int32>>

event Ping {}
`;

const CANONICAL = `package shop.v1

/// Money.
type Money {
    amount: int64 @min(0)
    currency: string @length(3) = "USD"
    label: string?
}

enum Status {
    ACTIVE
    BANNED
}

service Svc {
    /// Do it.
    Get(Money) -> Money
}

alias Tag = map<string, list<int32>>

event Ping {
}
`;

function formatOk(text: string): string {
  const result = formatSource(text, 'fmt.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(typeof result.output === 'string');
  return result.output;
}

test('canonical output: 4-space indent, one decl per block, single trailing newline', () => {
  assert.equal(formatOk(MESSY), CANONICAL);
});

test('formatting is idempotent: format(format(x)) === format(x)', () => {
  const once = formatOk(MESSY);
  const twice = formatOk(once);
  assert.equal(twice, once);
});

test('docs are preserved verbatim above their declaration', () => {
  const source = `/// Package docs.
package p

/// Struct docs.
type T {
    /// Field docs.
    id: uuid
}

/// Enum docs.
enum E {
    /// Variant docs.
    OK
}

/// Service docs.
service S {
    /// Method docs.
    Get(T) -> T
}
`;
  const once = formatOk(source);
  assert.equal(once, source, 'already-canonical input is a fixed point');
  assert.equal(formatOk(once), source);
});

test('optional markers normalize to the `T?` type suffix', () => {
  const output = formatOk('package p\ntype T {\n    a?: string\n    b: string?\n    c?: list<int32>?\n}\n');
  assert.equal(
    output,
    `package p

type T {
    a: string?
    b: string?
    c: list<int32>?
}
`,
  );
});

test('deprecated renders after constraints and before defaults', () => {
  const output = formatOk(
    'package p\n' +
      'type Old @deprecated("superseded") {\n' +
      '    x: int32 @min(0) @deprecated("use y")\n' +
      '    y: string @deprecated = "n/a"\n' +
      '}\n',
  );
  assert.equal(
    output,
    `package p

type Old @deprecated("superseded") {
    x: int32 @min(0) @deprecated("use y")
    y: string @deprecated = "n/a"
}
`,
  );
});

test('string constraint arguments are re-quoted with IDL escapes', () => {
  // IDL source carries `\\d` (escaped backslash); the decoded value is `\d`
  // and the canonical output re-escapes it to `\\d`.
  const output = formatOk('package p\ntype T {\n    re: string @pattern("^\\\\d+$")\n}\n');
  assert.ok(output.includes('@pattern("^\\\\d+$")'), output);
});

test('invalid source: ok=false, diagnostics present, no output', () => {
  const result = formatSource('type T {\n    x: int32\n', 'broken.bridge');
  assert.equal(result.ok, false);
  assert.equal(result.output, undefined);
  assert.ok(result.diagnostics.length >= 1);
  assert.ok(result.diagnostics.every((d) => typeof d.code === 'string'));
});

test('formatSource never throws on garbage and reports failure instead', () => {
  const garbage = ['', '   ', ']]]{', 'type', 'type T', '😀😀', 'package;\x00\x01', '"unterminated'];
  for (const text of garbage) {
    const result = formatSource(text, 'garbage.bridge');
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.diagnostics));
    if (!result.ok) assert.equal(result.output, undefined);
  }
});
