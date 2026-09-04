/**
 * TypeScript generator.
 *
 * Emits, in order: package.json, tsconfig.json, src/types.ts, src/enums.ts,
 * src/validate.ts, src/services.ts, src/events.ts, src/index.ts. Files
 * without content are skipped (e.g. enums.ts when the package declares no
 * enums); index.ts re-exports only the modules that were actually emitted,
 * keeping the file list deterministic.
 *
 * TypeScript-specific decisions (documented in generated files too):
 * - Fields keep their snake_case wire names as member names; reserved words
 *   are escaped with a trailing underscore and keep the wire key via a
 *   `@wireName` JSDoc tag. Optional fields are `field?: T`.
 * - `int64`/`uint64` map to `number`: values above 2^53 lose precision —
 *   a documented caveat is attached to every such field.
 * - `bytes` maps to `Uint8Array`; on the JSON wire bytes are base64 strings.
 * - `set<T>` maps to `Set<T>`; the wire format is ALWAYS a JSON array, so
 *   types.ts also emits `setToArray`/`arrayToSet` converters.
 * - `map<K,V>` maps to `Record<K,V>`.
 * - Tagged unions map to a discriminated union of
 *   `{ kind: '<variant>', value: <payload> }` members, matching the wire
 *   format used by Go/Rust.
 * - Enums map to a string-literal union type plus a same-named `const`
 *   object of wire values plus a `parse<Name>` helper that throws on
 *   unknown wire values.
 * - Validation is runtime-shaped: `validate<Name>(value: unknown): string[]`
 *   checks the decoded JSON object by wire key, and `is<Name>` is a type
 *   guard. Required-field presence is intentionally NOT checked (matching
 *   the Go generator's zero-value semantics); constraints and nested
 *   struct validators are.
 * - Defaults map to a `<NAME>_DEFAULTS` partial-constant factory; combine
 *   with spread: `{ ...PAYMENT_DEFAULTS, ...rest }`.
 * - Services map to a `<Service>Client` interface plus
 *   `create<Service>Client({ baseUrl, fetchImpl? })` built on `fetch`
 *   (POST /<package>/<Service>/<Method>).
 * - Events map to payload interfaces plus the wire envelope
 *   `{"event": name, "payload": {...}}` with encode/decode helpers.
 * - Cross-package references become `export type X = unknown` opaque
 *   aliases documented as "imported from <pkg>".
 */

import type { IRField, IRService, IRTypeDefinition, IREvent, TypeRef } from '@bridge/core';
import { generatedFile } from '../util';
import { fileHeader, headerLines } from '../header';
import { docLines, tsDoc } from '../docs';
import {
  NUMERIC_PRIMITIVES,
  PRIMITIVE_MAPPINGS,
  STRING_LIKE_PRIMITIVES,
  defaultLiteral,
  findLocalType,
  isLocalEnumRef,
  isLocalStructRef,
  renderTypeRef,
} from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes, usesSets } from '../analysis';
import {
  pascalFromScreaming,
  pascalToCamel,
  tsFieldName,
  tsPackageName,
  tsSafeIdent,
  upperSnake,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Indents a block by n spaces. */
function spaceIndent(block: string, levels = 1): string {
  const pad = ' '.repeat(2 * levels);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Full JSDoc for a field: docs, primitive notes, default, deprecation, wireName. */
function tsFieldJSDoc(field: IRField): string {
  const lines = docLines(field.docs);
  const inner = field.type.kind === 'optional' ? field.type.inner : field.type;
  if (inner.kind === 'primitive') {
    if (inner.primitive === 'int64' || inner.primitive === 'uint64' || inner.primitive === 'bytes') {
      lines.push(`Note: ${PRIMITIVE_MAPPINGS[inner.primitive].note}.`);
    }
  }
  if (field.default !== undefined) lines.push(`Default: ${field.default}`);
  if (field.deprecated !== undefined) {
    lines.push(field.deprecated === true ? 'Deprecated.' : `Deprecated: ${field.deprecated}`);
  }
  const named = tsFieldName(field.name);
  if (named.escaped) {
    lines.push(`@wireName ${JSON.stringify(named.wire)} — JSON wire key for this field.`);
  }
  if (lines.length === 0) return '';
  return tsDoc(lines.join('\n'));
}

/** TS type for a field (TS optionality is expressed at the field level). */
function tsFieldType(field: IRField, input: GeneratorInput): string {
  return renderTypeRef(field.type, input.render);
}

/** Result of scanning refs for local named targets. */
interface LocalRefs {
  readonly types: Set<string>;
  readonly enums: Set<string>;
}

function emptyLocalRefs(): LocalRefs {
  return { types: new Set(), enums: new Set() };
}

/** True when the named ref points at any type declared in this package. */
function isLocalType(ref: { name: string; package?: string }, input: GeneratorInput): boolean {
  if (ref.package !== undefined && ref.package !== input.ir.name) return false;
  return findLocalType(input.ir, ref.name) !== undefined;
}

function scanRef(ref: TypeRef, input: GeneratorInput, into: LocalRefs): void {
  switch (ref.kind) {
    case 'primitive':
      break;
    case 'named':
      if (isLocalEnumRef(ref, input.ir)) into.enums.add(ref.name);
      else if (isLocalType(ref, input)) into.types.add(ref.name);
      break;
    case 'list':
      scanRef(ref.element, input, into);
      break;
    case 'set':
      scanRef(ref.element, input, into);
      break;
    case 'map':
      scanRef(ref.key, input, into);
      scanRef(ref.value, input, into);
      break;
    case 'optional':
      scanRef(ref.inner, input, into);
      break;
  }
}

/** Renders an import type statement for a sorted name set. */
function tsImportType(module: string, names: Iterable<string>): string | undefined {
  const sorted = [...names].sort();
  if (sorted.length === 0) return undefined;
  return `import type { ${sorted.join(', ')} } from '${module}';`;
}

/** Wraps a body with the standard file header. */
function tsFile(header: string, ...rest: string[]): string {
  return [header, ...rest].join('\n');
}

/* ------------------------------------------------------------------ */
/* package.json / tsconfig.json                                        */
/* ------------------------------------------------------------------ */

/** Deterministic 2-space JSON with trailing newline. */
function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tsPackageJsonFile(input: GeneratorInput): GeneratedFile {
  const content = jsonFile({
    '//': headerLines(input.packageName, [
      'Bridge-generated TypeScript package; see src/ for the modules.',
    ]),
    name: tsPackageName(input.packageName),
    version: '0.1.0',
    description: `Bridge-generated TypeScript types for ${input.packageName}. Do not edit.`,
    main: 'src/index.ts',
    types: 'src/index.ts',
    sideEffects: false,
    license: 'UNLICENSED',
  });
  return generatedFile('package.json', content);
}

function tsConfigJsonFile(input: GeneratorInput): GeneratedFile {
  const content = jsonFile({
    '//': headerLines(input.packageName, ['TypeScript configuration for the generated package.']),
    compilerOptions: {
      target: 'ES2020',
      module: 'CommonJS',
      moduleResolution: 'Node',
      lib: ['ES2020'],
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  });
  return generatedFile('tsconfig.json', content);
}

/* ------------------------------------------------------------------ */
/* src/types.ts                                                        */
/* ------------------------------------------------------------------ */

function tsTypesFile(input: GeneratorInput): GeneratedFile | undefined {
  const types = sortedTypes(input.ir);
  const structs = types.filter((t) => t.kind === 'struct');
  const unions = types.filter((t) => t.kind === 'union');
  const aliases = types.filter((t) => t.kind === 'alias');
  const opaque = crossPackageRefs(input.ir);

  const refs = emptyLocalRefs();
  for (const type of types) {
    switch (type.kind) {
      case 'struct':
        for (const field of type.fields) scanRef(field.type, input, refs);
        break;
      case 'union':
        for (const variant of type.variants) scanRef(variant.type, input, refs);
        break;
      case 'alias':
        scanRef(type.target, input, refs);
        break;
      case 'enum':
        break;
    }
  }

  if (structs.length === 0 && unions.length === 0 && aliases.length === 0 && opaque.length === 0) {
    return undefined;
  }

  let body = '';

  for (const ref of opaque) {
    body += `${tsDoc(
      `${ref.name} is an opaque alias: imported from ${ref.fromPackage}; regenerate with that package for full types.`,
    )}\nexport type ${ref.name} = unknown;\n\n`;
  }

  for (const alias of aliases) {
    const doc = tsDoc(alias.docs, alias.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `export type ${alias.name} = ${renderTypeRef(alias.target, input.render)};\n\n`;
  }

  for (const structType of structs) {
    body += tsStruct(structType as IRTypeDefinition & { kind: 'struct' }, input);
  }

  for (const union of unions) {
    body += tsUnion(union as IRTypeDefinition & { kind: 'union' }, input);
  }

  if (usesSets(input.ir)) {
    body += `${tsDoc(
      'Converts a set into its JSON-array wire representation.',
    )}\nexport function setToArray<T>(value: Set<T>): T[] {\n  return Array.from(value);\n}\n\n`;
    body += `${tsDoc(
      'Converts a JSON-array wire representation into a Set.',
    )}\nexport function arrayToSet<T>(values: readonly T[]): Set<T> {\n  return new Set(values);\n}\n\n`;
  }

  for (const structType of structs) {
    const defaults = tsDefaultsConst(structType as IRTypeDefinition & { kind: 'struct' }, input);
    if (defaults !== undefined) body += defaults;
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('Type declarations generated from the Bridge package.'),
  );
  const importStatement = tsImportType('./enums', refs.enums);
  const parts = [header];
  if (importStatement !== undefined) parts.push('', importStatement);
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/types.ts', parts.join('\n'));
}

function tsStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
): string {
  let out = '';
  const doc = tsDoc(struct.docs, struct.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export interface ${struct.name} {\n`;
  for (const field of struct.fields) {
    const fieldDoc = tsFieldJSDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const suffix = field.optional ? '?' : '';
    out += `  ${tsFieldName(field.name).name}${suffix}: ${tsFieldType(field, input)};\n`;
  }
  out += '}\n\n';
  return out;
}

function tsUnion(
  union: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
): string {
  let out = '';
  const docLinesOut = [
    ...docLines(union.docs),
    `Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.`,
  ];
  const doc = tsDoc(docLinesOut.join('\n'), union.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export type ${union.name} =\n`;
  union.variants.forEach((variant, index) => {
    const bar = '  |';
    out += `${bar} { kind: ${JSON.stringify(variant.name)}; value: ${renderTypeRef(variant.type, input.render)} }\n`;
  });
  out += ';\n\n';
  return out;
}

/** `<NAME>_DEFAULTS` partial constant when the struct has renderable defaults. */
function tsDefaultsConst(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
): string | undefined {
  const entries: string[] = [];
  for (const field of struct.fields) {
    if (field.default === undefined) continue;
    const literal = defaultLiteral(field.default, field.type, 'typescript');
    if (literal === undefined) continue;
    entries.push(`  ${tsFieldName(field.name).name}: ${literal},`);
  }
  if (entries.length === 0) return undefined;
  let out = `${tsDoc(
    `Bridge-declared defaults for ${struct.name} fields. Combine with required input via spread: { ...${upperSnake(struct.name)}_DEFAULTS, ...rest }.`,
  )}\n`;
  out += `export const ${upperSnake(struct.name)}_DEFAULTS: Partial<${struct.name}> = {\n`;
  out += `${entries.join('\n')}\n`;
  out += '};\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* src/enums.ts                                                        */
/* ------------------------------------------------------------------ */

function tsEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;

  let body = '';
  for (const enumType of enums) {
    body += tsEnum(enumType as IRTypeDefinition & { kind: 'enum' });
  }

  const parts = [
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('Enum declarations generated from the Bridge package.'),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('src/enums.ts', parts.join('\n'));
}

function tsEnum(enumType: IRTypeDefinition & { kind: 'enum' }): string {
  let out = '';
  const doc = tsDoc(enumType.docs, enumType.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export type ${enumType.name} =\n`;
  enumType.variants.forEach((variant, index) => {
    const bar = index === 0 ? '  |' : '  |';
    out += `${bar} ${JSON.stringify(variant.name)}\n`;
  });
  out += ';\n\n';

  out += `${tsDoc(`Wire values for the ${enumType.name} variants.`)}\n`;
  out += `export const ${enumType.name} = {\n`;
  for (const variant of enumType.variants) {
    const vdoc = tsDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${spaceIndent(vdoc)}\n`;
    out += `  ${pascalFromScreaming(variant.name)}: ${JSON.stringify(variant.name)},\n`;
  }
  out += '} as const;\n\n';

  const parse = `parse${enumType.name}`;
  out += `${tsDoc(
    `Parses the wire representation into a ${enumType.name}; throws on unknown values.`,
  )}\n`;
  out += `export function ${parse}(value: string): ${enumType.name} {\n`;
  out += `  switch (value) {\n`;
  for (const variant of enumType.variants) {
    out += `    case ${JSON.stringify(variant.name)}:\n`;
    out += `      return ${enumType.name}.${pascalFromScreaming(variant.name)};\n`;
  }
  out += `  }\n`;
  out += `  throw new Error(\`unknown ${enumType.name} value: \${value}\`);\n`;
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/validate.ts                                                     */
/* ------------------------------------------------------------------ */

/** Shared regex constant name for a per-field pattern. */
function tsPatternConst(typeName: string, fieldName: string): string {
  return `${upperSnake(typeName, fieldName)}_RE`;
}

function tsValidateFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const usesEmail = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'email')),
  );
  const usesURL = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'url')),
  );
  const usesUUID = input.ir.types.some((t) =>
    t.kind === 'struct' &&
    t.fields.some((f) => f.constraints.some((c) => c.kind === 'uuid')),
  );

  let body = '';
  const prelude: string[] = [];
  if (usesEmail) {
    prelude.push(`const BRIDGE_EMAIL_RE = new RegExp(${JSON.stringify('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')});`);
  }
  if (usesURL) {
    prelude.push(`const BRIDGE_URL_RE = new RegExp(${JSON.stringify('^https?://\\S+$')});`);
  }
  if (usesUUID) {
    prelude.push(
      `const BRIDGE_UUID_RE = new RegExp(${JSON.stringify(
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      )});`,
    );
  }

  for (const structType of structs) {
    body += tsValidateStruct(structType as IRTypeDefinition & { kind: 'struct' }, input, prelude);
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc(
      [
        'Runtime constraint validation generated from the Bridge @constraint annotations.',
        'Validators operate on the decoded JSON object (wire keys) and return one',
        'message per violation; required-field presence is intentionally not',
        'checked, matching the Go generator semantics.',
      ].join('\n'),
    ),
  );

  const importStatement = tsImportType(
    './types',
    structs.map((s) => s.name),
  );
  const parts = [header, ''];
  if (importStatement !== undefined) parts.push(importStatement, '');
  if (prelude.length > 0) parts.push(...prelude, '');
  parts.push(body.trimEnd(), '');
  return generatedFile('src/validate.ts', parts.join('\n'));
}

function tsValidateStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  prelude: string[],
): string {
  let checks = '';
  let nested = '';

  for (const field of struct.fields) {
    const local = tsSafeIdent(field.name);
    checks += `  const ${local} = obj[${JSON.stringify(field.name)}];\n`;
    for (const constraint of field.constraints) {
      const rendered = tsConstraintCheck(constraint, field, local, struct, prelude);
      if (rendered !== undefined) checks += rendered;
    }
    let ref: TypeRef = field.type;
    if (ref.kind === 'optional') ref = ref.inner;
    if (ref.kind !== 'named') continue;
    if (ref.package !== undefined && ref.package !== input.ir.name) continue;
    const localType = findLocalType(input.ir, ref.name);
    if (localType === undefined || localType.kind !== 'struct') continue;
    const validator = `validate${ref.name}`;
    nested += `  if (${local} !== undefined && ${local} !== null) {\n`;
    nested += `    for (const message of ${validator}(${local})) {\n`;
    nested += `      errors.push(\`${field.name}.\${message}\`);\n`;
    nested += `    }\n`;
    nested += `  }\n`;
  }

  let out = '';
  const docLinesOut = [
    `Validates the constraints declared on ${struct.name} in the Bridge contract.`,
    'Returns one message per violation; an empty array means the value is valid.',
  ];
  out += `${tsDoc(docLinesOut.join('\n'))}\n`;
  out += `export function validate${struct.name}(value: unknown): string[] {\n`;
  out += `  const errors: string[] = [];\n`;
  out += `  if (typeof value !== 'object' || value === null || Array.isArray(value)) {\n`;
  out += `    return [${JSON.stringify(`${struct.name}: expected object`)}];\n`;
  out += `  }\n`;
  out += `  const obj = value as { [key: string]: unknown };\n`;
  out += checks;
  out += nested;
  out += `  return errors;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Type guard: true when value satisfies every ${struct.name} constraint.`)}\n`;
  out += `export function is${struct.name}(value: unknown): value is ${struct.name} {\n`;
  out += `  return validate${struct.name}(value).length === 0;\n`;
  out += `}\n\n`;
  return out;
}

function tsConstraintCheck(
  constraint: { kind: string; args: string[]; message?: string },
  field: IRField,
  local: string,
  struct: IRTypeDefinition & { kind: 'struct' },
  prelude: string[],
): string | undefined {
  const fallback = (text: string): string => constraint.message ?? text;
  const unwrap = (ref: TypeRef): TypeRef => (ref.kind === 'optional' ? ref.inner : ref);
  const inner = unwrap(field.type);
  const isNumeric = inner.kind === 'primitive' && NUMERIC_PRIMITIVES.has(inner.primitive);
  const isStringLike = inner.kind === 'primitive' && STRING_LIKE_PRIMITIVES.has(inner.primitive);

  const push = (message: string): string =>
    `    errors.push(${JSON.stringify(`${field.name}: ${message}`)});\n`;

  switch (constraint.kind) {
    case 'min':
    case 'max': {
      if (!isNumeric) return undefined;
      const arg = constraint.args[0] ?? '';
      const op = constraint.kind === 'min' ? '<' : '>';
      const text = fallback(constraint.kind === 'min' ? `must be >= ${arg}` : `must be <= ${arg}`);
      return `  if (typeof ${local} === 'number' && ${local} ${op} ${arg}) {\n${push(text)}  }\n`;
    }
    case 'length': {
      if (!isStringLike) return undefined;
      const arg = constraint.args[0] ?? '';
      const text = fallback(`must be exactly ${arg} characters`);
      return `  if (typeof ${local} === 'string' && ${local}.length !== ${arg}) {\n${push(text)}  }\n`;
    }
    case 'email': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid email address');
      return `  if (typeof ${local} === 'string' && !BRIDGE_EMAIL_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'url': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid URL');
      return `  if (typeof ${local} === 'string' && !BRIDGE_URL_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'uuid': {
      if (!isStringLike) return undefined;
      const text = fallback('must be a valid UUID');
      return `  if (typeof ${local} === 'string' && !BRIDGE_UUID_RE.test(${local})) {\n${push(text)}  }\n`;
    }
    case 'pattern': {
      if (!isStringLike) return undefined;
      const arg = constraint.args[0] ?? '';
      const constName = tsPatternConst(struct.name, field.name);
      if (!prelude.some((line) => line.startsWith(`const ${constName} `))) {
        prelude.push(`const ${constName} = new RegExp(${JSON.stringify(arg)});`);
      }
      const text = fallback(`must match pattern ${arg}`);
      return `  if (typeof ${local} === 'string' && !${constName}.test(${local})) {\n${push(text)}  }\n`;
    }
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* src/services.ts                                                     */
/* ------------------------------------------------------------------ */

function tsServicesFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  const refs = emptyLocalRefs();
  for (const service of services) {
    for (const method of service.methods) {
      scanRef(method.input, input, refs);
      scanRef(method.output, input, refs);
    }
  }

  let body = '';
  body += `${tsDoc(
    'Minimal structural fetch type; keeps the generated package independent of DOM lib types.',
  )}\n`;
  body += `export type FetchLike = (\n`;
  body += `  input: string,\n`;
  body += `  init?: {\n`;
  body += `    method?: string;\n`;
  body += `    headers?: Record<string, string>;\n`;
  body += `    body?: string;\n`;
  body += `  },\n`;
  body += `) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;\n\n`;

  for (const service of services) {
    body += tsService(service, input);
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('JSON-over-HTTP service clients generated from the Bridge package.'),
  );
  const importStatement = tsImportType('./types', refs.types);
  const parts = [header];
  if (importStatement !== undefined) parts.push('', importStatement);
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/services.ts', parts.join('\n'));
}

function tsService(service: IRService, input: GeneratorInput): string {
  let out = '';
  const optionsName = `Create${service.name}ClientOptions`;

  const docLinesOut = [
    ...docLines(service.docs),
    `Client for the ${service.name} service. Routes: POST /${input.packageName}/${service.name}/<Method>.`,
  ];
  const doc = tsDoc(docLinesOut.join('\n'));
  out += `${doc}\n`;
  out += `export interface ${service.name}Client {\n`;
  for (const method of service.methods) {
    const mdoc = tsDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${spaceIndent(mdoc)}\n`;
    out += `  ${pascalToCamel(method.name)}(req: ${methodTypeName(method.input, input)}): Promise<${methodTypeName(method.output, input)}>;\n`;
  }
  out += `}\n\n`;

  out += `${tsDoc(`Options for create${service.name}Client.`)}\n`;
  out += `export interface ${optionsName} {\n`;
  out += `  /** Base URL of the Bridge server, without a trailing slash. */\n`;
  out += `  baseUrl: string;\n`;
  out += `  /** Optional fetch implementation; defaults to the global fetch. */\n`;
  out += `  fetchImpl?: FetchLike;\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Creates a JSON-over-HTTP client for the ${service.name} service.`)}\n`;
  out += `export function create${service.name}Client(options: ${optionsName}): ${service.name}Client {\n`;
  out += `  const baseUrl = options.baseUrl.replace(/\\/+$/, '');\n`;
  out += `  const routePrefix = ${JSON.stringify(`${input.packageName}/${service.name}`)};\n`;
  out += `  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch as FetchLike;\n`;
  out += `  async function call<TResponse>(method: string, body: unknown): Promise<TResponse> {\n`;
  out += `    const response = await fetchImpl(\`\${baseUrl}/\${routePrefix}/\${method}\`, {\n`;
  out += `      method: 'POST',\n`;
  out += `      headers: { 'Content-Type': 'application/json' },\n`;
  out += `      body: JSON.stringify(body),\n`;
  out += `    });\n`;
  out += `    if (!response.ok) {\n`;
  out += `      const text = await response.text();\n`;
  out += `      throw new Error(\`\${method}: non-2xx status \${response.status}: \${text}\`);\n`;
  out += `    }\n`;
  out += `    return (await response.json()) as TResponse;\n`;
  out += `  }\n`;
  out += `  return {\n`;
  for (const method of service.methods) {
    out += `    ${pascalToCamel(method.name)}: (req) =>\n`;
    out += `      call<${methodTypeName(method.output, input)}>(\n`;
    out += `        ${JSON.stringify(method.name)},\n`;
    out += `        req,\n`;
    out += `      ),\n`;
  }
  out += `  };\n`;
  out += `}\n\n`;
  return out;
}

/** Method input/output type: named refs render as the type name. */
function methodTypeName(ref: TypeRef, input: GeneratorInput): string {
  if (ref.kind === 'named') return ref.name;
  return renderTypeRef(ref, input.render);
}

/* ------------------------------------------------------------------ */
/* src/events.ts                                                       */
/* ------------------------------------------------------------------ */

function tsEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  const refs = emptyLocalRefs();
  for (const event of events) {
    for (const field of event.fields) scanRef(field.type, input, refs);
  }

  let body = '';
  body += `${tsDoc('Bridge wire envelope: {"event": name, "payload": {...}}.')}\n`;
  body += `export interface BridgeEnvelope<TPayload> {\n`;
  body += `  event: string;\n`;
  body += `  payload: TPayload;\n`;
  body += `}\n\n`;

  for (const event of events) {
    body += tsEvent(event, input);
  }

  const header = tsFile(
    fileHeader('typescript', input.packageName),
    '',
    tsDoc('Event payloads and the Bridge wire envelope: {"event": name, "payload": {...}}.'),
  );
  const importStatement = tsImportType('./types', refs.types);
  const parts = [header];
  if (importStatement !== undefined) parts.push('', importStatement);
  parts.push('', body.trimEnd(), '');
  return generatedFile('src/events.ts', parts.join('\n'));
}

function tsEvent(event: IREvent, input: GeneratorInput): string {
  let out = '';
  const doc = tsDoc(event.docs);
  if (doc.length > 0) out += `${doc}\n`;
  out += `export interface ${event.name} {\n`;
  for (const field of event.fields) {
    const fieldDoc = tsFieldJSDoc(field);
    if (fieldDoc.length > 0) out += `${spaceIndent(fieldDoc)}\n`;
    const suffix = field.optional ? '?' : '';
    out += `  ${tsFieldName(field.name).name}${suffix}: ${tsFieldType(field, input)};\n`;
  }
  out += `}\n\n`;

  out += `${tsDoc(`Wraps a ${event.name} in the Bridge wire envelope.`)}\n`;
  out += `export function encode${event.name}(event: ${event.name}): BridgeEnvelope<${event.name}> {\n`;
  out += `  return { event: ${JSON.stringify(event.name)}, payload: event };\n`;
  out += `}\n\n`;

  out += `${tsDoc(`Decodes a ${event.name} envelope, verifying the event name.`)}\n`;
  out += `export function decode${event.name}(data: unknown): BridgeEnvelope<${event.name}> {\n`;
  out += `  if (typeof data !== 'object' || data === null) {\n`;
  out += `    throw new Error(${JSON.stringify(`${event.name} envelope: expected object`)});\n`;
  out += `  }\n`;
  out += `  const envelope = data as { event?: unknown; payload?: unknown };\n`;
  out += `  if (envelope.event !== ${JSON.stringify(event.name)}) {\n`;
  out += `    throw new Error(\`${event.name} envelope: unexpected event \${JSON.stringify(envelope.event)}\`);\n`;
  out += `  }\n`;
  out += `  return { event: envelope.event, payload: envelope.payload as ${event.name} };\n`;
  out += `}\n\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* src/index.ts                                                        */
/* ------------------------------------------------------------------ */

function tsIndexFile(input: GeneratorInput, modules: string[]): GeneratedFile {
  const parts = [
    fileHeader('typescript', input.packageName),
    '',
    tsDoc(`Public surface of the Bridge-generated package for ${input.packageName}.`),
    '',
    ...modules.map((name) => `export * from './${name}';`),
    '',
  ];
  return generatedFile('src/index.ts', parts.join('\n'));
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Generates the TypeScript project for an IR package. */
export function generateTypeScript(input: GeneratorInput): GeneratedFile[] {
  const types = tsTypesFile(input);
  const enums = tsEnumsFile(input);
  const validate = tsValidateFile(input);
  const services = tsServicesFile(input);
  const events = tsEventsFile(input);

  const moduleFiles: Array<[string, GeneratedFile | undefined]> = [
    ['types', types],
    ['enums', enums],
    ['validate', validate],
    ['services', services],
    ['events', events],
  ];
  const present = moduleFiles
    .filter(([, file]) => file !== undefined)
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files: GeneratedFile[] = [
    tsPackageJsonFile(input),
    tsConfigJsonFile(input),
  ];
  for (const [, file] of moduleFiles) {
    if (file !== undefined) files.push(file);
  }
  files.push(tsIndexFile(input, present));
  return files;
}
