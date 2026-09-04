/**
 * End-to-end example test: the canonical payments contract (mirrors
 * examples/payments/payments.bridge) compiled to its exact canonical IR, plus
 * a cross-package consumer compiled against it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePackage, compileSource } from '../compiler/compile';
import { hashPackage } from '../ir/hash';
import type { IRPackage, IRTypeDefinition } from '../ir/types';

const PAYMENTS = `package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
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
    status: PaymentStatus
    created_at: timestamp
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

function compilePayments(): IRPackage {
  const result = compileSource(PAYMENTS, 'payments.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  return result.ir;
}

/** The struct member of the IR type-definition union (with name/docs/deprecated). */
type IRStructDef = Extract<IRTypeDefinition, { kind: 'struct' }>;

function structByName(ir: IRPackage, name: string): IRStructDef {
  const def = ir.types.find((t) => t.name === name);
  assert.ok(def !== undefined, `type ${name} must exist in the IR`);
  if (def.kind !== 'struct') {
    return assert.fail(`type ${name} must be a struct, got ${def.kind}`);
  }
  return def;
}

test('payments example compiles with zero diagnostics', () => {
  const result = compileSource(PAYMENTS, 'payments.bridge');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ok, true);
});

test('IR package name and sorted type names', () => {
  const ir = compilePayments();
  assert.equal(ir.name, 'payments.v1');
  assert.deepEqual(ir.imports, []);
  assert.deepEqual(
    ir.types.map((t) => t.name),
    ['CreatePaymentRequest', 'GetPaymentRequest', 'Money', 'Payment', 'PaymentStatus'],
    'types must be sorted by name',
  );
});

test('Money struct has the exact canonical IR shape', () => {
  const ir = compilePayments();
  const money = ir.types.find((t) => t.name === 'Money');
  assert.deepEqual(money, {
    kind: 'struct',
    name: 'Money',
    fields: [
      {
        name: 'amount',
        type: { kind: 'primitive', primitive: 'int64' },
        optional: false,
        constraints: [],
      },
      {
        name: 'currency',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'length', args: ['3'] }],
      },
    ],
  });
});

test('PaymentStatus enum preserves variant order exactly', () => {
  const ir = compilePayments();
  const status = ir.types.find((t) => t.name === 'PaymentStatus');
  assert.deepEqual(status, {
    kind: 'enum',
    name: 'PaymentStatus',
    variants: [
      { name: 'PENDING' },
      { name: 'COMPLETED' },
      { name: 'FAILED' },
      { name: 'REFUNDED' },
    ],
  });
});

test('Payment fields: optionality, composite/named refs, no phantom package keys', () => {
  const ir = compilePayments();
  const payment = structByName(ir, 'Payment');
  assert.deepEqual(
    payment.fields.map((f) => [f.name, f.optional, f.type]),
    [
      ['id', false, { kind: 'primitive', primitive: 'uuid' }],
      ['customer_id', false, { kind: 'primitive', primitive: 'uuid' }],
      ['amount', false, { kind: 'named', name: 'Money' }],
      ['status', false, { kind: 'named', name: 'PaymentStatus' }],
      ['created_at', false, { kind: 'primitive', primitive: 'timestamp' }],
    ],
  );
});

test('service Payments exposes both methods with named struct I/O', () => {
  const ir = compilePayments();
  assert.deepEqual(ir.services, [
    {
      name: 'Payments',
      methods: [
        {
          name: 'CreatePayment',
          input: { kind: 'named', name: 'CreatePaymentRequest' },
          output: { kind: 'named', name: 'Payment' },
        },
        {
          name: 'GetPayment',
          input: { kind: 'named', name: 'GetPaymentRequest' },
          output: { kind: 'named', name: 'Payment' },
        },
      ],
    },
  ]);
  assert.deepEqual(ir.events, []);
});

test('payments IR is deterministic, hashable and JSON-stable', () => {
  const a = compilePayments();
  const b = compilePayments();
  assert.deepEqual(a, b);
  const hash = hashPackage(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashPackage(b));
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('a checkout package compiles against the published payments.v1 IR', () => {
  const payments = compilePayments();
  const result = compilePackage(
    `
package checkout.v1

import payments.v1

type Cart {
    items: map<string, payments.v1.Money>
}

service Checkout {
    Pay(payments.v1.CreatePaymentRequest) -> payments.v1.Payment
}
`,
    'checkout.bridge',
    new Map([['payments.v1', payments]]),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  assert.deepEqual(result.ir.imports, ['payments.v1']);
  const cart = structByName(result.ir, 'Cart');
  const items = cart.fields.find((f) => f.name === 'items');
  assert.ok(items !== undefined);
  assert.deepEqual(items.type, {
    kind: 'map',
    key: { kind: 'primitive', primitive: 'string' },
    value: { kind: 'named', name: 'Money', package: 'payments.v1' },
  });
  const pay = result.ir.services[0]?.methods[0];
  assert.ok(pay !== undefined);
  assert.deepEqual(pay.input, {
    kind: 'named',
    name: 'CreatePaymentRequest',
    package: 'payments.v1',
  });
});
