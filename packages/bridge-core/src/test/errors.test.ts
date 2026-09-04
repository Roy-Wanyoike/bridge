/**
 * Error-surface tests: diagnostic rendering (file:line:col, code, caret,
 * hint) and a seeded fuzz harness proving the compiler NEVER throws — every
 * input, however malformed, yields a structured CompileResult.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../compiler/compile';
import { formatSource } from '../format';
import { formatDiagnostic, formatDiagnostics } from '../diagnostics';
import { hashPackage } from '../ir/hash';
import type { CompileResult, Diagnostic } from '../ir/types';

// -------------------------------------------------------------- rendering

const SAMPLE_SOURCE = 'package p\ntype T {\n    amount: money\n}\n';

const SAMPLE_DIAGNOSTIC: Diagnostic = {
  severity: 'error',
  code: 'BR2001',
  message: 'Unknown type `money`.',
  file: 'payments.bridge',
  line: 3,
  column: 13,
  hint: 'Did you mean `Money`?',
};

test('formatDiagnostic renders file:line:col, severity, code and message', () => {
  const text = formatDiagnostic(SAMPLE_DIAGNOSTIC, SAMPLE_SOURCE);
  const first = text.split('\n')[0] ?? '';
  assert.equal(first, 'payments.bridge:3:13: error BR2001: Unknown type `money`.');
});

test('formatDiagnostic echoes the source line and points the caret at the column', () => {
  const text = formatDiagnostic(SAMPLE_DIAGNOSTIC, SAMPLE_SOURCE);
  const lines = text.split('\n');
  assert.ok(lines.some((l) => l === '  3 |     amount: money'), text);
  // Gutter is `  <line-pad> | `, the caret sits under column 13 (offset 12).
  const caret = lines.find((l) => l.includes('^'));
  assert.ok(caret !== undefined, 'caret line must be rendered');
  assert.equal(caret, '    | ' + ' '.repeat(12) + '^');
  assert.ok(text.includes('Did you mean `Money`?'), 'hint is rendered');
});

test('formatDiagnostic renders a hint block only when present', () => {
  const noHint: Diagnostic = { ...SAMPLE_DIAGNOSTIC, hint: undefined };
  const text = formatDiagnostic(noHint, SAMPLE_SOURCE);
  assert.ok(!text.includes('Did you mean'), text);
});

test('formatDiagnostic omits the snippet without source or for out-of-range lines', () => {
  const noSource = formatDiagnostic(SAMPLE_DIAGNOSTIC);
  assert.ok(!noSource.includes('|'), 'no snippet without source text');
  const beyond = formatDiagnostic(SAMPLE_DIAGNOSTIC, 'only one line\n');
  assert.ok(!beyond.includes('|'), 'no snippet when the line does not exist');
  assert.ok(beyond.startsWith('payments.bridge:3:13:'), 'header is still rendered');
});

test('formatDiagnostic expands tabs so the caret lines up with the expanded line', () => {
  const diagnostic: Diagnostic = {
    severity: 'error',
    code: 'BR2011',
    message: 'Map key type `float64` is not allowed — keys must be hashable primitives.',
    file: 't.bridge',
    line: 2,
    column: 6,
  };
  const text = formatDiagnostic(diagnostic, 'type T {\n\tbad: map<float64, string>\n}\n');
  const lines = text.split('\n');
  assert.ok(lines.some((l) => l === '  2 |     bad: map<float64, string>'), text);
  const caret = lines.find((l) => l.includes('^'));
  assert.ok(caret !== undefined);
  // Raw column 6 → offset 5; one tab before the caret expands by 3 → offset 8.
  assert.equal(caret, '    | ' + ' '.repeat(8) + '^');
});

test('formatDiagnostics joins renderings with a blank line', () => {
  const second: Diagnostic = { ...SAMPLE_DIAGNOSTIC, line: 4, message: 'Another.' };
  const text = formatDiagnostics([SAMPLE_DIAGNOSTIC, second], SAMPLE_SOURCE);
  const parts = text.split('\n\n');
  assert.ok(parts.length >= 3, 'two renderings plus the separating blank line');
  assert.ok(text.includes('Another.'));
});

// ------------------------------------------------------------------ fuzzing

/** Deterministic 32-bit LCG so failures are reproducible from the seed. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A valid schema used as the base for truncations and mutations. */
const VALID_SCHEMA = `package payments.v1

import identity.v1

/// A monetary amount.
type Money {
    amount: int64 @min(0) @max(999999)
    currency: string @length(3) = "USD"
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus?
    tags: map<string, list<string>>
    created_at: timestamp
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

event PaymentCompleted {
    payment_id: uuid
    at: timestamp
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
}
`;

test('fuzz: 500 random inputs never throw; results always carry a diagnostics array', () => {
  const rng = makeRng(0x5eed);
  const TOKENS = [
    'package', 'import', 'type', 'enum', 'union', 'alias', 'service', 'event',
    '{', '}', '(', ')', '<', '>', ':', ',', '=', '?', '@', '.', '->', '-',
    'Money', 'Payment', 'PENDING', 'amount', 'customer_id', 'string', 'int64',
    'uuid', 'list', 'set', 'map', 'min', 'length', 'deprecated', 'pattern',
    '"quoted"', '"esc\\\\n"', '42', '-7', '3.14', '\n', ' ', '\t', '\r',
  ];
  const UNICODE_POOL = [
    'a', 'Z', '_', '9', ' ', '\t', '\n', '\r', '{', '}', '@', '"', '\\',
    'é', '中', '😀', ' ', '\u0000', '\u007f', 'ﬁ', '​', '₹',
  ];

  const randomBytes = (): string => {
    let out = '';
    const len = Math.floor(rng() * 200);
    for (let i = 0; i < len; i++) out += String.fromCharCode(Math.floor(rng() * 256));
    return out;
  };

  const randomUnicode = (): string => {
    let out = '';
    const len = Math.floor(rng() * 120);
    for (let i = 0; i < len; i++) out += UNICODE_POOL[Math.floor(rng() * UNICODE_POOL.length)] ?? '';
    return out;
  };

  const tokenSoup = (): string => {
    let out = '';
    const len = 1 + Math.floor(rng() * 40);
    for (let i = 0; i < len; i++) out += (TOKENS[Math.floor(rng() * TOKENS.length)] ?? '') + (rng() < 0.3 ? '\n' : ' ');
    return out;
  };

  const truncate = (): string =>
    VALID_SCHEMA.slice(0, Math.floor(rng() * (VALID_SCHEMA.length + 1)));

  const mutate = (): string => {
    const chars = [...VALID_SCHEMA];
    const operations = 1 + Math.floor(rng() * 5);
    for (let i = 0; i < operations; i++) {
      const at = Math.floor(rng() * chars.length);
      const roll = rng();
      if (roll < 0.34) {
        chars[at] = String.fromCharCode(32 + Math.floor(rng() * 95));
      } else if (roll < 0.67) {
        chars.splice(at, 1);
      } else {
        chars.splice(at, 0, String.fromCharCode(32 + Math.floor(rng() * 95)));
      }
      if (chars.length === 0) break;
    }
    return chars.join('');
  };

  const generate = (): string => {
    const roll = rng();
    if (roll < 0.2) return randomBytes();
    if (roll < 0.4) return randomUnicode();
    if (roll < 0.6) return truncate();
    if (roll < 0.85) return mutate();
    return tokenSoup();
  };

  /** Wrappers that turn "threw" into a failed assertion instead of a crash. */
  const compileSafe = (input: string): CompileResult => {
    try {
      return compileSource(input, 'fuzz.bridge');
    } catch (cause) {
      return assert.fail(`compileSource threw on ${JSON.stringify(input)}: ${String(cause)}`);
    }
  };
  const formatSafe = (input: string): ReturnType<typeof formatSource> => {
    try {
      return formatSource(input, 'fuzz.bridge');
    } catch (cause) {
      return assert.fail(`formatSource threw on ${JSON.stringify(input)}: ${String(cause)}`);
    }
  };

  for (let i = 0; i < 500; i++) {
    const input = generate();
    const label = `fuzz case ${i}`;

    // The compiler must never throw, and every result is well-formed.
    const result = compileSafe(input);
    assert.equal(typeof result.ok, 'boolean', label);
    assert.ok(Array.isArray(result.diagnostics), `${label}: diagnostics must be an array`);
    if (result.ok) {
      assert.ok(result.ir !== undefined, `${label}: ok results must carry IR`);
      const ir = result.ir;
      assert.doesNotThrow(() => hashPackage(ir), `${label}: hashing ok IR threw`);
    } else {
      assert.equal(result.ir, undefined, `${label}: failed results must not carry IR`);
    }

    // The formatter must never throw either, and must be idempotent when it
    // succeeds.
    const formatted = formatSafe(input);
    assert.ok(Array.isArray(formatted.diagnostics), label);
    if (formatted.ok && typeof formatted.output === 'string') {
      const canonical = formatted.output;
      const again = formatSafe(canonical);
      assert.equal(again.ok, true, `${label}: canonical output must re-parse cleanly`);
      assert.equal(again.output, canonical, `${label}: formatting must be idempotent`);
    }
  }
});

test('diagnostics are deterministic: the same input compiles to identical diagnostics', () => {
  const input = 'package p\ntype T {\n    a: money,\n    a: int32?\n}\nenum E { e1 }\n';
  const first = compileSource(input, 'det.bridge');
  const second = compileSource(input, 'det.bridge');
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.equal(first.ok, second.ok);
});
