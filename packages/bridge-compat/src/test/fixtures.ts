/**
 * IR fixtures for the compat engine tests.
 *
 * The compiler is built in parallel, so tests construct canonical IR
 * literals directly (typed against the FROZEN `@bridge/core` IR contract)
 * instead of compiling IDL source. `makeIr` provides a payments-like base
 * package; individual tests override parts via `overrides`.
 */
import type {
  ConstraintKind,
  IRConstraint,
  IREnumVariant,
  IREvent,
  IRField,
  IRMethod,
  IRPackage,
  IRService,
  IRTypeDefinition,
  PrimitiveKind,
  TypeRef,
} from '@bridge/core';

// ---------------------------------------------------------------------------
// TypeRef builders
// ---------------------------------------------------------------------------

export function prim(primitive: PrimitiveKind): TypeRef {
  return { kind: 'primitive', primitive };
}

export function named(name: string, pkg?: string): TypeRef {
  return pkg === undefined ? { kind: 'named', name } : { kind: 'named', name, package: pkg };
}

export function listOf(element: TypeRef): TypeRef {
  return { kind: 'list', element };
}

export function setType(element: TypeRef): TypeRef {
  return { kind: 'set', element };
}

export function mapType(key: TypeRef, value: TypeRef): TypeRef {
  return { kind: 'map', key, value };
}

export function optType(inner: TypeRef): TypeRef {
  return { kind: 'optional', inner };
}

// ---------------------------------------------------------------------------
// IR builders
// ---------------------------------------------------------------------------

export function field(
  name: string,
  type: TypeRef,
  extra: Partial<Omit<IRField, 'name' | 'type'>> = {},
): IRField {
  return { name, type, optional: false, constraints: [], ...extra };
}

export function constraint(kind: ConstraintKind, args: string[], message?: string): IRConstraint {
  const c: IRConstraint = { kind, args };
  if (message !== undefined) c.message = message;
  return c;
}

export function struct(name: string, fields: IRField[]): IRTypeDefinition {
  return { kind: 'struct', name, fields };
}

export function enumType(name: string, variants: string[]): IRTypeDefinition {
  const vs: IREnumVariant[] = variants.map((v) => ({ name: v }));
  return { kind: 'enum', name, variants: vs };
}

export function unionType(name: string, variants: IRField[]): IRTypeDefinition {
  return { kind: 'union', name, variants };
}

export function aliasType(name: string, target: TypeRef): IRTypeDefinition {
  return { kind: 'alias', name, target };
}

export function method(name: string, input: TypeRef, output: TypeRef): IRMethod {
  return { name, input, output };
}

export function service(name: string, methods: IRMethod[]): IRService {
  return { name, methods };
}

export function event(name: string, fields: IRField[]): IREvent {
  return { name, fields };
}

/**
 * A payments-like base package. `Payment` carries the fields used by the
 * removal/optional/constraint/deprecation tests; `Money` is the widening
 * and constraint workhorse; `PaymentStatus` is the enum fixture.
 */
export function makeIr(overrides: Partial<IRPackage> = {}): IRPackage {
  return {
    name: 'payments.v1',
    imports: [],
    types: [
      struct('Money', [field('amount', prim('int32')), field('currency', prim('string'))]),
      struct('Payment', [
        field('id', prim('uuid')),
        field('amount', prim('int32')),
        field('currency', prim('string')),
      ]),
      enumType('PaymentStatus', ['PENDING', 'CAPTURED', 'FAILED']),
    ],
    services: [service('Payments', [method('CreatePayment', named('CreatePaymentRequest'), named('Payment'))])],
    events: [event('PaymentCaptured', [field('paymentId', prim('uuid')), field('amount', prim('int32'))])],
    docs: 'Payments contracts.',
    ...overrides,
  };
}

/**
 * Deep-clone `ir` and reverse every array (types, fields, variants,
 * methods, events, imports). Used to prove report determinism is
 * independent of input array order.
 */
export function reversed(ir: IRPackage): IRPackage {
  const copy: IRPackage = structuredClone(ir);
  copy.imports.reverse();
  copy.types = copy.types.slice().reverse();
  for (const t of copy.types) {
    if (t.kind === 'struct') t.fields.reverse();
    else if (t.kind === 'enum' || t.kind === 'union') t.variants.reverse();
  }
  copy.services = copy.services.slice().reverse();
  for (const s of copy.services) s.methods.reverse();
  copy.events = copy.events.slice().reverse();
  for (const e of copy.events) e.fields.reverse();
  return copy;
}
