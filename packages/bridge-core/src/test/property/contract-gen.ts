/**
 * Seeded generator for random *valid* Bridge IDL contracts.
 *
 * For every case the generator produces:
 * - a syntactically and semantically valid Bridge source string
 *   (grammar per packages/bridge-core/src/parser.ts; semantic rules per
 *   src/semantic.ts — unique names, resolvable references, hashable map
 *   keys, applicable constraints, no optional collection elements);
 * - the exact `IRPackage` the compiler must produce for it (mirrors the
 *   lowering rules of src/compiler/compile.ts: types sorted by name,
 *   imports sorted + deduplicated, declaration order preserved for
 *   fields/variants/methods/services/events, optional markers unwrapped,
 *   constraint messages extracted, defaults re-quoted).
 *
 * The source deliberately carries cosmetic noise (extra blank lines, plain
 * `//` comments, spacing variance) so the properties exercise real parsing
 * rather than formatting artifacts. The type-declaration order can be
 * permuted via {@link renderSource} to prove canonicalization (IR sorts
 * types by name; services/events intentionally keep declaration order).
 */

import type {
  IRConstraint,
  IRField,
  IRPackage,
  IRService,
  IRTypeDefinition,
  PrimitiveKind,
  TypeRef,
} from '../../ir/types';
import { MAP_KEY_PRIMITIVES, NUMERIC_PRIMITIVES } from '../../ast';
import type { Rng } from './harness';

// ---------------------------------------------------------------------------
// Plan model — the generator's intermediate representation
// ---------------------------------------------------------------------------

type TypeSpec =
  | { k: 'prim'; prim: PrimitiveKind }
  | { k: 'named'; name: string }
  | { k: 'qualified'; pkg: string; name: string }
  | { k: 'list'; element: TypeSpec }
  | { k: 'set'; element: TypeSpec }
  | { k: 'map'; key: PrimitiveKind; value: TypeSpec };

interface ArgPlan {
  text: string;
  isString: boolean;
}

interface ConstraintPlan {
  kind: string;
  args: ArgPlan[];
}

interface DefaultPlan {
  text: string;
  isString: boolean;
}

interface FieldPlan {
  name: string;
  type: TypeSpec;
  optional: boolean;
  constraints: ConstraintPlan[];
  docs?: string;
  deprecated?: string | true;
  defaultValue?: DefaultPlan;
}

interface StructPlan {
  kind: 'struct';
  name: string;
  fields: FieldPlan[];
  docs?: string;
  deprecated?: string | true;
}

interface EnumPlan {
  kind: 'enum';
  name: string;
  variants: { name: string; docs?: string; deprecated?: string | true }[];
  docs?: string;
  deprecated?: string | true;
}

interface UnionPlan {
  kind: 'union';
  name: string;
  members: FieldPlan[];
  docs?: string;
  deprecated?: string | true;
}

interface AliasPlan {
  kind: 'alias';
  name: string;
  target: TypeSpec;
  docs?: string;
  deprecated?: string | true;
}

type TypePlan = StructPlan | EnumPlan | UnionPlan | AliasPlan;

interface MethodPlan {
  name: string;
  input: string; // local struct name
  output: string; // local struct name
  docs?: string;
  deprecated?: string | true;
}

interface ServicePlan {
  name: string;
  methods: MethodPlan[];
  docs?: string;
}

interface EventPlan {
  name: string;
  fields: FieldPlan[];
  docs?: string;
}

export interface ContractPlan {
  package: string;
  pkgDocs?: string;
  imports: string[];
  typeDecls: TypePlan[];
  services: ServicePlan[];
  events: EventPlan[];
}

export interface GeneratedContract {
  plan: ContractPlan;
  source: string;
  expected: IRPackage;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const PRIMS: readonly PrimitiveKind[] = [
  'string', 'bool', 'int32', 'int64', 'uint32', 'uint64',
  'float32', 'float64', 'bytes', 'uuid', 'timestamp', 'decimal', 'json',
];

const STRING_CONSTRAINTS = ['length', 'email', 'url', 'uuid', 'pattern'] as const;

const PATTERNS = ['^[a-z]+$', '^[A-Z][a-z]*$', '^v[0-9]+$', '^[a-z][a-z0-9_]*$'];

const TYPE_NAMES = [
  'Money', 'Payment', 'Order', 'Customer', 'Item', 'Status', 'Result',
  'Node', 'Edge', 'Address', 'Catalog', 'Receipt',
];

const FIELD_NAMES = [
  'id', 'name', 'amount', 'currency', 'status', 'created_at', 'tags',
  'metadata', 'count', 'label', 'owner', 'payload', 'total', 'kind',
];

const VARIANT_NAMES = [
  'PENDING', 'ACTIVE', 'FAILED', 'ARCHIVED', 'DRAFT', 'ENABLED',
  'DISABLED', 'UNKNOWN',
];

const EVENT_NAMES = ['PaymentCaptured', 'OrderPlaced', 'UserSignedUp', 'StockChanged'];

const SERVICE_NAMES = ['Payments', 'Orders', 'Catalog', 'Billing'];

const METHOD_WORDS = ['get', 'create', 'update', 'delete', 'list', 'search'];

const DOC_LINES = [
  'A generated declaration used by the property suites.',
  'Docs are preserved verbatim by the formatter.',
  'Second line of a multi-line doc comment.',
  'Synthetic documentation for deterministic testing.',
];

const DEPRECATION_NOTES = [
  'Use the v2 field instead.',
  'Scheduled for removal.',
];

const NOISE_COMMENTS = [
  '// noise: plain comments are skipped by the lexer',
  '// another one',
];

const IMPORT_POOL = ['auth.v1', 'billing.v2', 'common.types', 'identity.v2', 'search.v1'];

const FOREIGN_TYPE = (i: number) => `Ext${i}`;

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

/** Generate a random valid contract plan. */
export function generateContractPlan(rng: Rng): ContractPlan {
  const pkg = `gen.p${rng.int(0, 9999)}.v${rng.int(0, 9)}`;
  const pkgDocs = rng.bool(0.3) ? pickLines(rng, DOC_LINES, 1, 2).join('\n') : undefined;

  const imports = rng.shuffle(IMPORT_POOL).slice(0, rng.int(0, 2));

  // All type names up-front so field types may reference later declarations
  // (forward references are legal; semantic analysis collects names first).
  const typeCount = rng.int(2, 6);
  const names = rng.shuffle(TYPE_NAMES).slice(0, typeCount);

  const plan: ContractPlan = { package: pkg, pkgDocs, imports, typeDecls: [], services: [], events: [] };
  const generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[] = [];

  for (let i = 0; i < typeCount; i++) {
    const name = names[i] as string;
    // First declaration is always a struct so services always have a valid
    // request/response target.
    const kind = i === 0 ? 'struct' : weightedTypeKind(rng);
    switch (kind) {
      case 'struct':
        plan.typeDecls.push({
          kind: 'struct',
          name,
          fields: genFields(rng, rng.int(1, 5), generated, imports),
          docs: maybeDocs(rng),
          deprecated: maybeDeprecated(rng),
        });
        break;
      case 'enum':
        plan.typeDecls.push({
          kind: 'enum',
          name,
          variants: rng
            .shuffle(VARIANT_NAMES)
            .slice(0, rng.int(1, 4))
            .map((variant) => ({
              name: variant,
              docs: maybeDocs(rng),
              deprecated: maybeDeprecated(rng),
            })),
          docs: maybeDocs(rng),
          deprecated: maybeDeprecated(rng),
        });
        break;
      case 'union':
        plan.typeDecls.push({
          kind: 'union',
          name,
          members: genFields(rng, rng.int(1, 4), generated, imports),
          docs: maybeDocs(rng),
          deprecated: maybeDeprecated(rng),
        });
        break;
      case 'alias':
        plan.typeDecls.push({
          kind: 'alias',
          name,
          // Backward-only alias targets keep the reference graph acyclic
          // under any declaration permutation.
          target: genAliasTarget(rng, generated),
          docs: maybeDocs(rng),
          deprecated: maybeDeprecated(rng),
        });
        break;
    }
    generated.push({ name, kind });
  }

  const structNames = plan.typeDecls
    .filter((t): t is StructPlan => t.kind === 'struct')
    .map((t) => t.name);

  const serviceCount = rng.int(0, 2);
  for (let s = 0; s < serviceCount; s++) {
    const methodCount = rng.int(1, 3);
    const methods: MethodPlan[] = [];
    for (let m = 0; m < methodCount; m++) {
      methods.push({
        name: `${rng.pick(METHOD_WORDS)}${rng.pick(TYPE_NAMES)}${m}`,
        input: rng.pick(structNames),
        output: rng.pick(structNames),
        docs: maybeDocs(rng),
        deprecated: maybeDeprecated(rng),
      });
    }
    plan.services.push({
      name: `${rng.pick(SERVICE_NAMES)}${s}${rng.bool(0.5) ? 'Svc' : ''}`,
      methods,
      docs: maybeDocs(rng),
    });
  }

  const eventNames = rng.shuffle(EVENT_NAMES);
  const eventCount = rng.int(0, Math.min(2, eventNames.length));
  for (let e = 0; e < eventCount; e++) {
    plan.events.push({
      name: eventNames[e] as string,
      fields: genFields(rng, rng.int(1, 3), generated, imports),
      docs: maybeDocs(rng),
    });
  }

  return plan;
}

/** Weighted declaration kind picker: structs dominate, aliases are rare. */
function weightedTypeKind(rng: Rng): 'struct' | 'enum' | 'union' | 'alias' {
  const r = rng.float();
  if (r < 0.55) return 'struct';
  if (r < 0.75) return 'enum';
  if (r < 0.88) return 'union';
  return 'alias';
}

function pickLines(rng: Rng, pool: readonly string[], min: number, max: number): string[] {
  return rng.shuffle(pool).slice(0, rng.int(min, max));
}

function maybeDocs(rng: Rng): string | undefined {
  return rng.bool(0.25) ? rng.pick(DOC_LINES) : undefined;
}

function maybeDeprecated(rng: Rng): string | true | undefined {
  if (!rng.bool(0.1)) return undefined;
  return rng.bool(0.5) ? true : rng.pick(DEPRECATION_NOTES);
}

function genFields(
  rng: Rng,
  count: number,
  generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[],
  imports: string[],
): FieldPlan[] {
  const namePool = rng.shuffle(FIELD_NAMES);
  const fields: FieldPlan[] = [];
  for (let i = 0; i < count; i++) {
    fields.push(genField(rng, namePool[i] ?? `f${i}`, generated, imports));
  }
  return fields;
}

function genField(
  rng: Rng,
  name: string,
  generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[],
  imports: string[],
): FieldPlan {
  const type = genTypeSpec(rng, generated, imports);
  const field: FieldPlan = {
    name,
    type,
    optional: rng.bool(0.2),
    constraints: [],
  };

  // Constraints only attach to direct primitive fields: @min/@max require a
  // numeric primitive, the string kinds require `string` (semantic rules).
  if (type.k === 'prim') {
    field.constraints = genConstraints(rng, type.prim);
  }

  const dep = maybeDeprecated(rng);
  if (dep !== undefined) field.deprecated = dep;

  // Defaults: numbers for numeric primitives, quoted strings for string,
  // bare identifiers (true/false) for bool. Others keep no default.
  if (type.k === 'prim' && rng.bool(0.2)) {
    if (NUMERIC_PRIMITIVES.has(type.prim)) {
      field.defaultValue = { text: String(rng.int(0, 1000)), isString: false };
    } else if (type.prim === 'string') {
      field.defaultValue = { text: `v${rng.int(0, 99)}`, isString: true };
    } else if (type.prim === 'bool') {
      field.defaultValue = { text: rng.bool() ? 'true' : 'false', isString: false };
    }
  }
  return field;
}

function genConstraints(rng: Rng, prim: PrimitiveKind): ConstraintPlan[] {
  const plans: ConstraintPlan[] = [];
  const withMessage = () => rng.bool(0.3);

  if (NUMERIC_PRIMITIVES.has(prim)) {
    if (rng.bool(0.5)) {
      const min = rng.int(0, 500);
      const args: ArgPlan[] = [{ text: String(min), isString: false }];
      if (withMessage()) args.push({ text: 'below minimum', isString: true });
      plans.push({ kind: 'min', args });
    }
    if (rng.bool(0.5)) {
      const max = rng.int(501, 2000);
      const args: ArgPlan[] = [{ text: String(max), isString: false }];
      if (withMessage()) args.push({ text: 'above maximum', isString: true });
      plans.push({ kind: 'max', args });
    }
    return plans;
  }

  if (prim !== 'string' || !rng.bool(0.5)) return plans;

  const kind = rng.pick(STRING_CONSTRAINTS);
  if (kind === 'length') {
    const args: ArgPlan[] = [{ text: String(rng.int(0, 64)), isString: false }];
    if (withMessage()) args.push({ text: 'bad length', isString: true });
    plans.push({ kind, args });
  } else if (kind === 'pattern') {
    const args: ArgPlan[] = [{ text: rng.pick(PATTERNS), isString: true }];
    if (withMessage()) args.push({ text: 'pattern mismatch', isString: true });
    plans.push({ kind, args });
  } else {
    // email / url / uuid take no positional arguments — a lone string is a
    // custom violation message.
    const args: ArgPlan[] = [];
    if (withMessage()) args.push({ text: `not a valid ${kind}`, isString: true });
    plans.push({ kind, args });
  }
  return plans;
}

function genTypeSpec(
  rng: Rng,
  generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[],
  imports: string[],
): TypeSpec {
  const r = rng.float();
  if (r < 0.45) return { k: 'prim', prim: rng.pick(PRIMS) };
  if (r < 0.6 && generated.length > 0) {
    return { k: 'named', name: rng.pick(generated).name };
  }
  if (r < 0.68 && imports.length > 0) {
    return { k: 'qualified', pkg: rng.pick(imports), name: FOREIGN_TYPE(rng.int(0, 9)) };
  }
  if (r < 0.8) {
    return { k: 'list', element: genInnerElement(rng, generated) };
  }
  if (r < 0.9) {
    return { k: 'set', element: { k: 'prim', prim: rng.pick(PRIMS) } };
  }
  const key = rng.pick([...MAP_KEY_PRIMITIVES]) as PrimitiveKind;
  return { k: 'map', key, value: genInnerElement(rng, generated) };
}

/** Collection element / map value: primitive or local named (never optional). */
function genInnerElement(
  rng: Rng,
  generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[],
): TypeSpec {
  if (generated.length > 0 && rng.bool(0.35)) {
    return { k: 'named', name: rng.pick(generated).name };
  }
  return { k: 'prim', prim: rng.pick(PRIMS) };
}

function genAliasTarget(
  rng: Rng,
  generated: { name: string; kind: 'struct' | 'enum' | 'union' | 'alias' }[],
): TypeSpec {
  // `generated` holds every declaration created *before* this alias (the
  // caller pushes the alias afterwards), so targets are backward-only and
  // the alias graph stays acyclic.
  if (generated.length > 0 && rng.bool(0.4)) {
    return { k: 'named', name: rng.pick(generated).name };
  }
  if (rng.bool(0.25)) {
    return { k: 'list', element: { k: 'prim', prim: rng.pick(PRIMS) } };
  }
  if (rng.bool(0.15)) {
    const key = rng.pick([...MAP_KEY_PRIMITIVES]) as PrimitiveKind;
    return { k: 'map', key, value: { k: 'prim', prim: rng.pick(PRIMS) } };
  }
  return { k: 'prim', prim: rng.pick(PRIMS) };
}

// ---------------------------------------------------------------------------
// Source rendering (with cosmetic noise)
// ---------------------------------------------------------------------------

const INDENT = '    ';

/**
 * Render the plan to Bridge source. `typeOrder` permutes the type
 * declarations (a permutation of 0..typeDecls.length-1); everything else —
 * including services/events order — is fixed.
 */
export function renderSource(plan: ContractPlan, rng: Rng, typeOrder?: number[]): string {
  const out: string[] = [];
  const order =
    typeOrder ??
    plan.typeDecls.map((_, i) => i);

  if (plan.pkgDocs !== undefined) pushDocs(out, plan.pkgDocs);
  out.push(`package ${plan.package}`);
  out.push('');
  if (plan.imports.length > 0) {
    for (const imp of plan.imports) out.push(`import ${imp}`);
    out.push('');
  }

  const declBlocks: string[] = [];
  for (const index of order) {
    declBlocks.push(renderTypePlan(plan.typeDecls[index] as TypePlan, rng));
  }
  // Occasional noise comments and 1-2 blank lines between declarations.
  let first = true;
  for (const block of declBlocks) {
    if (!first) {
      out.push('');
      if (rng.bool(0.3)) out.push('');
      if (rng.bool(0.2)) out.push(rng.pick(NOISE_COMMENTS));
    }
    first = false;
    out.push(block);
  }
  for (const service of plan.services) {
    out.push('');
    if (rng.bool(0.2)) out.push(rng.pick(NOISE_COMMENTS));
    out.push(renderService(service));
  }
  for (const event of plan.events) {
    out.push('');
    if (rng.bool(0.2)) out.push(rng.pick(NOISE_COMMENTS));
    out.push(renderEvent(event, rng));
  }

  return `${out.join('\n')}\n`;
}

function pushDocs(out: string[], docs: string, indent = ''): void {
  for (const line of docs.split('\n')) {
    out.push(`${indent}/// ${line}`);
  }
}

function renderDep(d: string | true | undefined): string {
  if (d === undefined) return '';
  if (d === true) return ' @deprecated';
  return ` @deprecated(${JSON.stringify(d)})`;
}

function renderTypePlan(plan: TypePlan, rng: Rng): string {
  const lines: string[] = [];
  if (plan.docs !== undefined) pushDocs(lines, plan.docs);
  const dep = renderDep(plan.deprecated);
  switch (plan.kind) {
    case 'struct': {
      lines.push(`type ${plan.name}${dep} {`);
      for (const field of plan.fields) lines.push(renderField(field, rng));
      lines.push('}');
      break;
    }
    case 'union': {
      lines.push(`union ${plan.name}${dep} {`);
      for (const member of plan.members) lines.push(renderField(member, rng));
      lines.push('}');
      break;
    }
    case 'enum': {
      lines.push(`enum ${plan.name}${dep} {`);
      for (const variant of plan.variants) {
        if (variant.docs !== undefined) pushDocs(lines, variant.docs, INDENT);
        lines.push(`${INDENT}${variant.name}${renderDep(variant.deprecated)}`);
      }
      lines.push('}');
      break;
    }
    case 'alias': {
      lines.push(`alias ${plan.name}${dep} = ${typeText(plan.target)}`);
      break;
    }
  }
  return lines.join('\n');
}

function renderField(field: FieldPlan, rng: Rng): string {
  const lines: string[] = [];
  if (field.docs !== undefined) pushDocs(lines, field.docs, INDENT);
  const sep = rng.bool(0.15) ? ':  ' : ': ';
  let line = `${INDENT}${field.name}${sep}${typeText(field.type)}${field.optional ? '?' : ''}`;
  for (const constraint of field.constraints) {
    line += ` @${constraint.kind}${renderArgs(constraint.args)}`;
  }
  line += renderDep(field.deprecated);
  if (field.defaultValue !== undefined) {
    const rendered = field.defaultValue.isString
      ? JSON.stringify(field.defaultValue.text)
      : field.defaultValue.text;
    line += ` = ${rendered}`;
  }
  lines.push(line);
  return lines.join('\n');
}

function renderArgs(args: ArgPlan[]): string {
  if (args.length === 0) return '';
  const rendered = args.map((a) => (a.isString ? JSON.stringify(a.text) : a.text));
  return `(${rendered.join(', ')})`;
}

function renderService(service: ServicePlan): string {
  const lines: string[] = [];
  if (service.docs !== undefined) pushDocs(lines, service.docs);
  lines.push(`service ${service.name} {`);
  for (const method of service.methods) {
    if (method.docs !== undefined) pushDocs(lines, method.docs, INDENT);
    lines.push(
      `${INDENT}${method.name}(${method.input}) -> ${method.output}${renderDep(method.deprecated)}`,
    );
  }
  lines.push('}');
  return lines.join('\n');
}

function renderEvent(event: EventPlan, rng: Rng): string {
  const lines: string[] = [];
  if (event.docs !== undefined) pushDocs(lines, event.docs);
  lines.push(`event ${event.name} {`);
  for (const field of event.fields) lines.push(renderField(field, rng));
  lines.push('}');
  return lines.join('\n');
}

function typeText(t: TypeSpec): string {
  switch (t.k) {
    case 'prim':
      return t.prim;
    case 'named':
      return t.name;
    case 'qualified':
      return `${t.pkg}.${t.name}`;
    case 'list':
      return `list<${typeText(t.element)}>`;
    case 'set':
      return `set<${typeText(t.element)}>`;
    case 'map':
      return `map<${t.key}, ${typeText(t.value)}>`;
  }
}

// ---------------------------------------------------------------------------
// Expected IR (mirrors compiler/compile.ts lowering exactly)
// ---------------------------------------------------------------------------

/** The `IRPackage` the compiler must produce for the given plan. */
export function expectedIr(plan: ContractPlan): IRPackage {
  const types: IRTypeDefinition[] = plan.typeDecls.map(typeIr);
  types.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const imports = [...new Set(plan.imports)].sort();

  const pkg: IRPackage = {
    name: plan.package,
    imports,
    types,
    services: plan.services.map(serviceIr),
    events: plan.events.map(eventIr),
  };
  if (plan.pkgDocs !== undefined) pkg.docs = plan.pkgDocs;
  return pkg;
}

function typeIr(plan: TypePlan): IRTypeDefinition {
  let body: IRTypeDefinition;
  switch (plan.kind) {
    case 'struct':
      body = { kind: 'struct', fields: plan.fields.map(fieldIr), name: plan.name };
      break;
    case 'union':
      body = { kind: 'union', variants: plan.members.map(fieldIr), name: plan.name };
      break;
    case 'enum': {
      body = {
        kind: 'enum',
        variants: plan.variants.map((v) => {
          const variant: { name: string; docs?: string; deprecated?: string | true } = { name: v.name };
          if (v.docs !== undefined) variant.docs = v.docs;
          if (v.deprecated !== undefined) variant.deprecated = v.deprecated;
          return variant;
        }),
        name: plan.name,
      };
      break;
    }
    case 'alias':
      body = { kind: 'alias', target: typeRef(plan.target), name: plan.name };
      break;
  }
  if (plan.docs !== undefined) body.docs = plan.docs;
  if (plan.deprecated !== undefined) body.deprecated = plan.deprecated;
  return body;
}

function fieldIr(plan: FieldPlan): IRField {
  const field: IRField = {
    name: plan.name,
    type: typeRef(plan.type),
    optional: plan.optional,
    constraints: plan.constraints.map(constraintIr),
  };
  if (plan.docs !== undefined) field.docs = plan.docs;
  if (plan.deprecated !== undefined) field.deprecated = plan.deprecated;
  if (plan.defaultValue !== undefined) {
    field.default = plan.defaultValue.isString
      ? JSON.stringify(plan.defaultValue.text)
      : plan.defaultValue.text;
  }
  return field;
}

/**
 * Lower a constraint like the compiler: the last argument becomes the
 * violation `message` when it is a string literal beyond the kind's
 * positional arguments (min/max/length/pattern take one).
 */
function constraintIr(plan: ConstraintPlan): IRConstraint {
  const positional: Record<string, number> = { min: 1, max: 1, length: 1, pattern: 1, email: 0, url: 0, uuid: 0 };
  const required = positional[plan.kind] ?? 0;
  let args = plan.args.map((a) => a.text);
  let message: string | undefined;
  if (plan.args.length > required && plan.args.length > 0) {
    const last = plan.args[plan.args.length - 1] as ArgPlan;
    if (last.isString) {
      message = last.text;
      args = args.slice(0, -1);
    }
  }
  const constraint: IRConstraint = { kind: plan.kind as IRConstraint['kind'], args };
  if (message !== undefined) constraint.message = message;
  return constraint;
}

function typeRef(t: TypeSpec): TypeRef {
  switch (t.k) {
    case 'prim':
      return { kind: 'primitive', primitive: t.prim };
    case 'named':
      return { kind: 'named', name: t.name };
    case 'qualified':
      return { kind: 'named', name: t.name, package: t.pkg };
    case 'list':
      return { kind: 'list', element: typeRef(t.element) };
    case 'set':
      return { kind: 'set', element: typeRef(t.element) };
    case 'map':
      return { kind: 'map', key: typeRef({ k: 'prim', prim: t.key }), value: typeRef(t.value) };
  }
}

function serviceIr(plan: ServicePlan): IRService {
  const service: IRService = {
    name: plan.name,
    methods: plan.methods.map((m) => {
      const method: IRService['methods'][number] = {
        name: m.name,
        input: { kind: 'named', name: m.input },
        output: { kind: 'named', name: m.output },
      };
      if (m.docs !== undefined) method.docs = m.docs;
      if (m.deprecated !== undefined) method.deprecated = m.deprecated;
      return method;
    }),
  };
  if (plan.docs !== undefined) service.docs = plan.docs;
  return service;
}

function eventIr(plan: EventPlan): IRPackage['events'][number] {
  const event: IRPackage['events'][number] = {
    name: plan.name,
    fields: plan.fields.map(fieldIr),
  };
  if (plan.docs !== undefined) event.docs = plan.docs;
  return event;
}

// ---------------------------------------------------------------------------
// One-shot helper
// ---------------------------------------------------------------------------

/** Generate plan + rendered source + expected IR in one call. */
export function generateContract(rng: Rng): GeneratedContract {
  const plan = generateContractPlan(rng);
  return { plan, source: renderSource(plan, rng), expected: expectedIr(plan) };
}
