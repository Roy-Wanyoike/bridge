/**
 * Go generator.
 *
 * Emits, in order: go.mod, types.go, enums.go, validate.go, services.go,
 * events.go. Files without content are skipped (e.g. enums.go when the
 * package declares no enums), keeping the emitted file list deterministic.
 *
 * Go-specific decisions (documented in generated files too):
 * - Fields are exported (CamelCase with initialism expansion: id -> ID,
 *   api -> API, url -> URL, ...); json tags keep the snake_case wire names.
 *   Optional fields are pointers with `json:"...,omitempty"`.
 * - `set<T>` becomes `Set[T]` — a generic `map[T]struct{}` wrapper whose
 *   MarshalJSON/UnmarshalJSON speak the JSON-array wire format, with
 *   SetToSlice/SliceToSet converters.
 * - Required-field presence is NOT enforced at runtime by Go Validate:
 *   JSON zero values are indistinguishable from missing fields for
 *   non-pointer fields. Go Validate covers constraints (first error,
 *   wrapped with fmt.Errorf) and nested struct validation.
 * - Defaults are documented as `Default:` comments (no builder machinery).
 * - Cross-package references become `type X = json.RawMessage` opaque
 *   aliases documented as "imported from <pkg>".
 * - Tagged unions map to a `Kind string` + `Value json.RawMessage` struct
 *   with typed constructors (`NewX<Variant>`) and accessors (`As<Variant>`).
 */

import type {
  IRConstraint,
  IRField,
  IRService,
  IRTypeDefinition,
  TypeRef,
} from '@bridge/core';
import { generatedFile } from '../util';
import { fileHeader } from '../header';
import { docLines, goDoc } from '../docs';
import {
  NUMERIC_PRIMITIVES,
  STRING_LIKE_PRIMITIVES,
  defaultLiteral,
  goZeroValue,
  isLocalStructRef,
  renderTypeRef,
} from '../mappings';
import { crossPackageRefs, sortedEvents, sortedServices, sortedTypes, usesSets } from '../analysis';
import {
  goExportedName,
  goPackageName,
  goReceiver,
  goSafeIdent,
  pascalFromScreaming,
  sanitizedPackageName,
} from '../naming';
import type { GeneratedFile, GeneratorInput } from './input';

/** Shared regexes emitted once in validate.go when the package uses them. */
const GO_EMAIL_RE = 'reBridgeEmail';
const GO_URL_RE = 'reBridgeURL';
const GO_UUID_RE = 'reBridgeUUID';

/** Generates the Go project for an IR package. */
export function generateGo(input: GeneratorInput): GeneratedFile[] {
  const files: GeneratedFile[] = [goModFile(input)];
  const types = goTypesFile(input);
  if (types !== undefined) files.push(types);
  const enums = goEnumsFile(input);
  if (enums !== undefined) files.push(enums);
  const validate = goValidateFile(input);
  if (validate !== undefined) files.push(validate);
  const services = goServicesFile(input);
  if (services !== undefined) files.push(services);
  const events = goEventsFile(input);
  if (events !== undefined) files.push(events);
  return files;
}

/* ------------------------------------------------------------------ */
/* Per-file helpers                                                    */
/* ------------------------------------------------------------------ */

/** Import accumulator; renders a deterministic gofmt-style import block. */
class GoImports {
  private readonly names = new Set<string>();

  add(name: string): void {
    this.names.add(name);
  }

  block(): string {
    if (this.names.size === 0) return '';
    const sorted = [...this.names].sort();
    if (sorted.length === 1) return `import ${JSON.stringify(sorted[0])}`;
    const lines = sorted.map((name) => `\t${JSON.stringify(name)}`).join('\n');
    return `import (\n${lines}\n)`;
  }
}

/** Full doc block for a field: docs + deprecation + default note. */
function goFieldDoc(field: IRField): string {
  const lines = docLines(field.docs);
  if (field.deprecated !== undefined) {
    lines.push(field.deprecated === true ? 'Deprecated.' : `Deprecated: ${field.deprecated}`);
  }
  if (field.default !== undefined) lines.push(`Default: ${field.default}`);
  if (lines.length === 0) return '';
  return lines.map((line) => `// ${line}`).join('\n');
}

/** Indents a doc/normal block by n tabs. */
function tab(block: string, levels = 1): string {
  const pad = '\t'.repeat(levels);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Package clause. */
function goPackageClause(packageName: string): string {
  return `package ${goPackageName(packageName)}`;
}

/* ------------------------------------------------------------------ */
/* go.mod                                                              */
/* ------------------------------------------------------------------ */

function goModFile(input: GeneratorInput): GeneratedFile {
  const content = [
    fileHeader('go', input.packageName),
    '',
    `module bridge/generated/${sanitizedPackageName(input.packageName)}`,
    '',
    'go 1.22',
    '',
  ].join('\n');
  return generatedFile('go.mod', content);
}

/* ------------------------------------------------------------------ */
/* types.go                                                            */
/* ------------------------------------------------------------------ */

function goTypesFile(input: GeneratorInput): GeneratedFile | undefined {
  const types = sortedTypes(input.ir);
  const structs = types.filter((t) => t.kind === 'struct');
  const unions = types.filter((t) => t.kind === 'union');
  const aliases = types.filter((t) => t.kind === 'alias');
  const opaque = crossPackageRefs(input.ir);
  const hasSets = usesSets(input.ir);
  const hasStructs = structs.length > 0;
  const hasUnions = unions.length > 0;
  const hasAliases = aliases.length > 0;
  if (!hasStructs && !hasUnions && !hasAliases && opaque.length === 0 && !hasSets) {
    return undefined;
  }

  const imports = new GoImports();
  let body = '';

  // Opaque aliases for cross-package references (may be referenced by the
  // declarations below, so they come first).
  for (const ref of opaque) {
    imports.add('encoding/json');
    const doc = goDoc(
      `${ref.name} is an opaque alias: imported from ${ref.fromPackage}; regenerate with that package for full types.`,
    );
    body += `${doc}\ntype ${ref.name} = json.RawMessage\n\n`;
  }

  for (const alias of aliases) {
    const doc = goDoc(alias.docs, alias.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `type ${alias.name} = ${renderTypeRef(alias.target, input.render)}\n\n`;
  }

  for (const struct of structs) {
    const doc = goDoc(struct.docs, struct.deprecated);
    if (doc.length > 0) body += `${doc}\n`;
    body += `type ${struct.name} struct {\n`;
    for (const field of struct.fields) {
      const fieldDoc = goFieldDoc(field);
      if (fieldDoc.length > 0) body += `${tab(fieldDoc)}\n`;
      const tag = field.optional ? ` json:"${field.name},omitempty"` : ` json:"${field.name}"`;
      body += `\t${goExportedName(field.name)} ${goFieldType(field, input)} \`${tag}\`\n`;
    }
    body += '}\n\n';
  }

  for (const union of unions) {
    body += goUnion(union as IRTypeDefinition & { kind: 'union' }, input, imports);
  }

  if (hasSets) {
    body += goSetSupport();
  }

  if (opaque.length > 0 || hasUnions || hasSets) imports.add('encoding/json');
  if (hasUnions || hasSets) imports.add('fmt');
  if (hasSets) imports.add('sort');

  const parts = [fileHeader('go', input.packageName), '', goPackageClause(input.packageName)];
  const importBlock = imports.block();
  if (importBlock.length > 0) parts.push('', importBlock);
  parts.push('', body.trimEnd(), '');
  return generatedFile('types.go', parts.join('\n'));
}

/** Go type for a field; optional fields are pointers. */
function goFieldType(field: IRField, input: GeneratorInput): string {
  const base = renderTypeRef(field.type, input.render);
  if (field.optional && field.type.kind !== 'optional') return `*${base}`;
  return base;
}

function goUnion(
  union: IRTypeDefinition & { kind: 'union' },
  input: GeneratorInput,
  imports: GoImports,
): string {
  imports.add('encoding/json');
  imports.add('fmt');
  let out = '';
  const variantLines = union.variants.map(
    (v) => `  - ${v.name}: ${renderTypeRef(v.type, input.render)}`,
  );
  const docText = [
    `Tagged union. Wire format: {"kind": "<variant>", "value": <payload>}.`,
    'Variants:',
    ...variantLines,
  ];
  if (union.docs !== undefined) docText.unshift(...docLines(union.docs));
  const doc = goDoc(docText.join('\n'), union.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${union.name} struct {\n`;
  out += `${tab('// Kind selects the union variant.')}\n`;
  out += `\tKind string \`json:"kind"\`\n`;
  out += `${tab('// Value is the JSON payload for the selected variant.')}\n`;
  out += `\tValue json.RawMessage \`json:"value"\`\n`;
  out += '}\n\n';

  const receiver = goReceiver(union.name);
  for (const variant of union.variants) {
    const variantGoName = goExportedName(variant.name);
    const payloadType = renderTypeRef(variant.type, input.render);
    const zero = goZeroValue(variant.type, input.render);
    const vdoc = goDoc(variant.docs, variant.deprecated);

    if (vdoc.length > 0) out += `${vdoc}\n`;
    out += `${goDoc(`New${union.name}${variantGoName} builds a ${union.name} carrying the ${variant.name} variant.`)}\n`;
    out += `func New${union.name}${variantGoName}(value ${payloadType}) (${union.name}, error) {\n`;
    out += `\traw, err := json.Marshal(value)\n`;
    out += `\tif err != nil {\n`;
    out += `\t\treturn ${union.name}{}, fmt.Errorf("marshal ${variant.name}: %w", err)\n`;
    out += `\t}\n`;
    out += `\treturn ${union.name}{Kind: ${JSON.stringify(variant.name)}, Value: raw}, nil\n`;
    out += '}\n\n';

    if (vdoc.length > 0) out += `${vdoc}\n`;
    out += `${goDoc(`As${variantGoName} returns the ${variant.name} payload when Kind == ${JSON.stringify(variant.name)}.`)}\n`;
    out += `func (${receiver} ${union.name}) As${variantGoName}() (${payloadType}, bool) {\n`;
    out += `\tif ${receiver}.Kind != ${JSON.stringify(variant.name)} {\n`;
    out += `\t\treturn ${zero}, false\n`;
    out += `\t}\n`;
    out += `\tvar out ${payloadType}\n`;
    out += `\tif err := json.Unmarshal(${receiver}.Value, &out); err != nil {\n`;
    out += `\t\treturn ${zero}, false\n`;
    out += `\t}\n`;
    out += `\treturn out, true\n`;
    out += '}\n\n';
  }
  return out;
}

function goSetSupport(): string {
  let out = '';
  out += `${goDoc('Set is a set of comparable items. On the JSON wire it is an array.')}\n`;
  out += 'type Set[T comparable] map[T]struct{}\n\n';
  out += `${goDoc('MarshalJSON encodes the set as a JSON array in deterministic (stringified) key order.')}\n`;
  out += 'func (s Set[T]) MarshalJSON() ([]byte, error) {\n';
  out += '\titems := make([]T, 0, len(s))\n';
  out += '\tfor item := range s {\n';
  out += '\t\titems = append(items, item)\n';
  out += '\t}\n';
  out += '\tsort.Slice(items, func(i, j int) bool {\n';
  out += '\t\treturn fmt.Sprint(items[i]) < fmt.Sprint(items[j])\n';
  out += '\t})\n';
  out += '\treturn json.Marshal(items)\n';
  out += '}\n\n';
  out += `${goDoc('UnmarshalJSON decodes the set from a JSON array.')}\n`;
  out += 'func (s *Set[T]) UnmarshalJSON(data []byte) error {\n';
  out += '\tvar items []T\n';
  out += '\tif err := json.Unmarshal(data, &items); err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += '\tout := make(Set[T], len(items))\n';
  out += '\tfor _, item := range items {\n';
  out += '\t\tout[item] = struct{}{}\n';
  out += '\t}\n';
  out += '\t*s = out\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  out += `${goDoc('SetToSlice converts a Set into its JSON-array representation (deterministic order).')}\n`;
  out += 'func SetToSlice[T comparable](s Set[T]) []T {\n';
  out += '\traw, err := json.Marshal(s)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn nil\n';
  out += '\t}\n';
  out += '\tvar items []T\n';
  out += '\tif err := json.Unmarshal(raw, &items); err != nil {\n';
  out += '\t\treturn nil\n';
  out += '\t}\n';
  out += '\treturn items\n';
  out += '}\n\n';
  out += `${goDoc('SliceToSet converts a JSON-array representation into a Set.')}\n`;
  out += 'func SliceToSet[T comparable](items []T) Set[T] {\n';
  out += '\tout := make(Set[T], len(items))\n';
  out += '\tfor _, item := range items {\n';
  out += '\t\tout[item] = struct{}{}\n';
  out += '\t}\n';
  out += '\treturn out\n';
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* enums.go                                                            */
/* ------------------------------------------------------------------ */

function goEnumsFile(input: GeneratorInput): GeneratedFile | undefined {
  const enums = sortedTypes(input.ir).filter((t) => t.kind === 'enum');
  if (enums.length === 0) return undefined;
  const imports = new GoImports();
  imports.add('encoding/json');
  imports.add('fmt');
  let body = '';
  for (const enumType of enums) {
    body += goEnum(enumType as IRTypeDefinition & { kind: 'enum' });
  }
  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    imports.block(),
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('enums.go', parts.join('\n'));
}

function goEnum(enumType: IRTypeDefinition & { kind: 'enum' }): string {
  let out = '';
  const doc = goDoc(enumType.docs, enumType.deprecated);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${enumType.name} string\n\n`;
  out += `// ${enumType.name} variants.\n`;
  out += 'const (\n';
  for (const variant of enumType.variants) {
    const vdoc = goDoc(variant.docs, variant.deprecated);
    if (vdoc.length > 0) out += `${tab(vdoc)}\n`;
    out += `\t${goConstName(enumType, variant.name)} ${enumType.name} = ${JSON.stringify(variant.name)}\n`;
  }
  out += ')\n\n';

  const parse = `${goSafeIdent('Parse')}${enumType.name}`;
  out += `${goDoc(`${parse} parses the wire representation into a ${enumType.name}.`)}\n`;
  out += `func ${parse}(value string) (${enumType.name}, error) {\n`;
  out += '\tswitch value {\n';
  for (const variant of enumType.variants) {
    out += `\tcase ${JSON.stringify(variant.name)}:\n`;
    out += `\t\treturn ${goConstName(enumType, variant.name)}, nil\n`;
  }
  out += '\t}\n';
  out += `\treturn "", fmt.Errorf("unknown ${enumType.name} value %q", value)\n`;
  out += '}\n\n';

  out += `${goDoc(`MarshalJSON encodes ${enumType.name} as its wire representation.`)}\n`;
  out += `func (e ${enumType.name}) MarshalJSON() ([]byte, error) {\n`;
  out += '\tswitch e {\n';
  for (const variant of enumType.variants) {
    out += `\tcase ${goConstName(enumType, variant.name)}:\n`;
    out += `\t\treturn []byte(${JSON.stringify(JSON.stringify(variant.name))}), nil\n`;
  }
  out += '\t}\n';
  out += `\treturn nil, fmt.Errorf("cannot marshal invalid ${enumType.name} value %q", string(e))\n`;
  out += '}\n\n';

  out += `${goDoc(`UnmarshalJSON decodes ${enumType.name} from its wire representation, erroring on unknown values.`)}\n`;
  out += `func (e *${enumType.name}) UnmarshalJSON(data []byte) error {\n`;
  out += '\tvar raw string\n';
  out += '\tif err := json.Unmarshal(data, &raw); err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += `\tparsed, err := ${parse}(raw)\n`;
  out += '\tif err != nil {\n';
  out += '\t\treturn err\n';
  out += '\t}\n';
  out += '\t*e = parsed\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

function goConstName(enumType: IRTypeDefinition & { kind: 'enum' }, variant: string): string {
  return `${enumType.name}${pascalFromScreaming(variant)}`;
}

/* ------------------------------------------------------------------ */
/* validate.go                                                         */
/* ------------------------------------------------------------------ */

function goValidateFile(input: GeneratorInput): GeneratedFile | undefined {
  const structs = sortedTypes(input.ir).filter((t) => t.kind === 'struct');
  if (structs.length === 0) return undefined;

  const imports = new GoImports();
  imports.add('fmt');
  let regexBlock = '';
  let usesEmail = false;
  let usesURL = false;
  let usesUUID = false;

  // Shared + per-field regex variables.
  for (const struct of structs) {
    for (const field of (struct as IRTypeDefinition & { kind: 'struct' }).fields) {
      for (const constraint of field.constraints) {
        if (constraint.kind === 'pattern') {
          imports.add('regexp');
          const arg = constraint.args[0] ?? '';
          regexBlock += `// ${goPatternVar(struct.name, field.name)} matches the @pattern constraint on ${struct.name}.${goExportedName(field.name)}.\n`;
          regexBlock += `var ${goPatternVar(struct.name, field.name)} = regexp.MustCompile(${JSON.stringify(arg)})\n\n`;
        } else if (constraint.kind === 'email') {
          usesEmail = true;
        } else if (constraint.kind === 'url') {
          usesURL = true;
        } else if (constraint.kind === 'uuid') {
          usesUUID = true;
        }
      }
    }
  }
  if (usesEmail || usesURL || usesUUID) imports.add('regexp');
  if (usesEmail) {
    regexBlock = `// ${GO_EMAIL_RE} implements the @email constraint: ^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$\nvar ${GO_EMAIL_RE} = regexp.MustCompile("^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$")\n\n${regexBlock}`;
  }
  if (usesURL) {
    regexBlock = `// ${GO_URL_RE} implements the @url constraint: ^https?://\\S+$\nvar ${GO_URL_RE} = regexp.MustCompile("^https?://\\\\S+$")\n\n${regexBlock}`;
  }
  if (usesUUID) {
    regexBlock = `// ${GO_UUID_RE} implements the @uuid constraint (8-4-4-4-12 hex).\nvar ${GO_UUID_RE} = regexp.MustCompile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")\n\n${regexBlock}`;
  }

  let body = '';
  for (const struct of structs) {
    body += goValidateStruct(struct as IRTypeDefinition & { kind: 'struct' }, input, imports);
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    imports.block(),
  ];
  if (regexBlock.length > 0) parts.push('', regexBlock.trimEnd());
  parts.push('', body.trimEnd(), '');
  return generatedFile('validate.go', parts.join('\n'));
}

/** Variable name for a @pattern constraint regex. */
function goPatternVar(typeName: string, fieldName: string): string {
  return `re${typeName}${goExportedName(fieldName)}`;
}

function goValidateStruct(
  struct: IRTypeDefinition & { kind: 'struct' },
  input: GeneratorInput,
  imports: GoImports,
): string {
  let out = '';
  out += `${goDoc(`Validate checks the constraints declared on ${struct.name}. The first violation is returned, wrapped with the field name.`)}\n`;
  const receiver = goReceiver(struct.name);
  out += `func (${receiver} ${struct.name}) Validate() error {\n`;
  for (const field of struct.fields) {
    out += goFieldValidation(struct, field, input, imports);
  }
  for (const field of struct.fields) {
    out += goNestedValidation(struct, field, input);
  }
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

function goFieldValidation(
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  input: GeneratorInput,
  imports: GoImports,
): string {
  let out = '';
  const receiver = goReceiver(struct.name);
  const goField = goExportedName(field.name);
  const valueExpr = field.optional
    ? `*${receiver}.${goField}`
    : `${receiver}.${goField}`;

  for (const constraint of field.constraints) {
    const rendered = goConstraintCheck(constraint, struct, field, valueExpr, input, imports);
    if (rendered === undefined) continue;
    if (field.optional) {
      out += `\tif ${receiver}.${goField} != nil {\n`;
      out += tab(rendered.trimEnd(), 1) + '\n';
      out += `\t}\n`;
    } else {
      out += rendered;
    }
  }
  return out;
}

function goConstraintCheck(
  constraint: IRConstraint,
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  valueExpr: string,
  input: GeneratorInput,
  imports: GoImports,
): string | undefined {
  const fail = (fallback: string): string => {
    const msg = constraint.message ?? fallback;
    return `\t\treturn fmt.Errorf(${JSON.stringify(`${field.name}: ${msg}`)})\n`;
  };
  void input;

  switch (constraint.kind) {
    case 'min':
    case 'max': {
      if (!isNumericField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      const op = constraint.kind === 'min' ? '<' : '>';
      const text = constraint.kind === 'min' ? `must be >= ${arg}` : `must be <= ${arg}`;
      return `\tif ${valueExpr} ${op} ${arg} {\n${fail(text)}\t}\n`;
    }
    case 'length': {
      if (!isStringLikeField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      // len() counts bytes; docs note the unicode caveat.
      return `\tif len(${valueExpr}) != ${arg} {\n${fail(`must be exactly ${arg} characters`)}\t}\n`;
    }
    case 'email': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_EMAIL_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid email address')}\t}\n`;
    }
    case 'url': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_URL_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid URL')}\t}\n`;
    }
    case 'uuid': {
      if (!isStringLikeField(field)) return undefined;
      return `\tif !${GO_UUID_RE}.MatchString(${valueExpr}) {\n${fail('must be a valid UUID')}\t}\n`;
    }
    case 'pattern': {
      if (!isStringLikeField(field)) return undefined;
      const arg = constraint.args[0] ?? '';
      const varName = goPatternVar(struct.name, field.name);
      return `\tif !${varName}.MatchString(${valueExpr}) {\n${fail(`must match pattern ${arg}`)}\t}\n`;
    }
    default:
      return undefined;
  }
}

function goNestedValidation(
  struct: IRTypeDefinition & { kind: 'struct' },
  field: IRField,
  input: GeneratorInput,
): string {
  let ref: TypeRef = field.type;
  if (ref.kind === 'optional') ref = ref.inner;
  if (!isLocalStructRef(ref, input.ir)) return '';
  const receiver = goReceiver(struct.name);
  const goField = goExportedName(field.name);
  let out = '';
  if (field.optional) {
    out += `\tif ${receiver}.${goField} != nil {\n`;
    out += `\t\tif err := ${receiver}.${goField}.Validate(); err != nil {\n`;
    out += `\t\t\treturn fmt.Errorf("${field.name}: %w", err)\n`;
    out += `\t\t}\n`;
    out += `\t}\n`;
  } else {
    out += `\tif err := ${receiver}.${goField}.Validate(); err != nil {\n`;
    out += `\t\treturn fmt.Errorf("${field.name}: %w", err)\n`;
    out += `\t}\n`;
  }
  return out;
}

function isNumericField(field: IRField): boolean {
  const t = unwrapOptional(field.type);
  return t.kind === 'primitive' && NUMERIC_PRIMITIVES.has(t.primitive);
}

function isStringLikeField(field: IRField): boolean {
  const t = unwrapOptional(field.type);
  return t.kind === 'primitive' && STRING_LIKE_PRIMITIVES.has(t.primitive);
}

function unwrapOptional(ref: TypeRef): TypeRef {
  return ref.kind === 'optional' ? ref.inner : ref;
}

/* ------------------------------------------------------------------ */
/* services.go                                                         */
/* ------------------------------------------------------------------ */

function goServicesFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateServices) return undefined;
  const services = sortedServices(input.ir);
  if (services.length === 0) return undefined;

  let body = '';
  body += `${goDoc('HTTPDoer executes HTTP requests. *http.Client implements it.')}\n`;
  body += 'type HTTPDoer interface {\n';
  body += '\tDo(req *http.Request) (*http.Response, error)\n';
  body += '}\n\n';
  for (const service of services) {
    body += goService(service, input);
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    'import (\n\t"bytes"\n\t"context"\n\t"encoding/json"\n\t"fmt"\n\t"io"\n\t"net/http"\n\t"strings"\n)',
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('services.go', parts.join('\n'));
}

function goService(service: IRService, input: GeneratorInput): string {
  let out = '';
  const serverDocs = [`${service.name}Server is the server interface for the ${service.name} service.`];
  if (service.docs !== undefined) serverDocs.unshift(...docLines(service.docs));
  const sdoc = goDoc(serverDocs.join('\n'));
  if (sdoc.length > 0) out += `${sdoc}\n`;
  out += `type ${service.name}Server interface {\n`;
  for (const method of service.methods) {
    const mdoc = goDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${tab(mdoc)}\n`;
    out += `\t${method.name}(ctx context.Context, req *${methodTypeName(method.input, input)}) (*${methodTypeName(method.output, input)}, error)\n`;
  }
  out += '}\n\n';

  const clientDocs = [
    `${service.name}JSONClient is a JSON-over-HTTP client for the ${service.name} service.`,
    `Routes: POST /${input.packageName}/${service.name}/<Method>.`,
  ];
  out += `${goDoc(clientDocs.join('\n'))}\n`;
  out += `type ${service.name}JSONClient struct {\n`;
  out += '\tbaseURL string\n';
  out += '\thttp    HTTPDoer\n';
  out += '}\n\n';
  out += `${goDoc(`New${service.name}JSONClient creates a client. baseURL must not have a trailing slash.`)}\n`;
  out += `func New${service.name}JSONClient(doer HTTPDoer, baseURL string) *${service.name}JSONClient {\n`;
  out += `\treturn &${service.name}JSONClient{baseURL: baseURL, http: doer}\n`;
  out += '}\n\n';

  for (const method of service.methods) {
    const mdoc = goDoc(method.docs, method.deprecated);
    if (mdoc.length > 0) out += `${mdoc}\n`;
    const inType = methodTypeName(method.input, input);
    const outType = methodTypeName(method.output, input);
    out += `func (c *${service.name}JSONClient) ${method.name}(req *${inType}) (*${outType}, error) {\n`;
    out += `\tvar out ${outType}\n`;
    out += `\tif err := c.do(${JSON.stringify(method.name)}, req, &out); err != nil {\n`;
    out += '\t\treturn nil, err\n';
    out += '\t}\n';
    out += '\treturn &out, nil\n';
    out += '}\n\n';
  }

  out += goClientDoHelper(service, input.packageName);
  return out;
}

function goClientDoHelper(service: IRService, packageName: string): string {
  let out = '';
  out += `${goDoc('do marshals req as JSON, POSTs it to /<package>/<Service>/<Method> and decodes the JSON response.')}\n`;
  out += `func (c *${service.name}JSONClient) do(method string, req any, out any) error {\n`;
  out += '\tbody, err := json.Marshal(req)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("marshal request: %w", err)\n';
  out += '\t}\n';
  out += `\turl := strings.TrimSuffix(c.baseURL, "/") + ${JSON.stringify(`/${packageName}/${service.name}/`)} + method\n`;
  out += `\thttpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))\n`;
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("build request: %w", err)\n';
  out += '\t}\n';
  out += '\thttpReq.Header.Set("Content-Type", "application/json")\n';
  out += '\tresp, err := c.http.Do(httpReq)\n';
  out += '\tif err != nil {\n';
  out += `\t\treturn fmt.Errorf("call %s: %w", method, err)\n`;
  out += '\t}\n';
  out += '\tdefer resp.Body.Close()\n';
  out += '\trespBody, err := io.ReadAll(resp.Body)\n';
  out += '\tif err != nil {\n';
  out += '\t\treturn fmt.Errorf("read response: %w", err)\n';
  out += '\t}\n';
  out += '\tif resp.StatusCode < 200 || resp.StatusCode > 299 {\n';
  out += `\t\treturn fmt.Errorf("%s: non-2xx status %d: %s", method, resp.StatusCode, string(respBody))\n`;
  out += '\t}\n';
  out += '\tif err := json.Unmarshal(respBody, out); err != nil {\n';
  out += '\t\treturn fmt.Errorf("unmarshal response: %w", err)\n';
  out += '\t}\n';
  out += '\treturn nil\n';
  out += '}\n\n';
  return out;
}

/* ------------------------------------------------------------------ */
/* events.go                                                           */
/* ------------------------------------------------------------------ */

function goEventsFile(input: GeneratorInput): GeneratedFile | undefined {
  if (!input.generateEvents) return undefined;
  const events = sortedEvents(input.ir);
  if (events.length === 0) return undefined;

  let body = '';
  for (const event of events) {
    body += goEvent(event, input);
  }

  const parts = [
    fileHeader('go', input.packageName),
    '',
    goPackageClause(input.packageName),
    '',
    'import (\n\t"encoding/json"\n\t"fmt"\n)',
    '',
    body.trimEnd(),
    '',
  ];
  return generatedFile('events.go', parts.join('\n'));
}

function goEvent(event: import('@bridge/core').IREvent, input: GeneratorInput): string {
  let out = '';
  const doc = goDoc(event.docs);
  if (doc.length > 0) out += `${doc}\n`;
  out += `type ${event.name} struct {\n`;
  for (const field of event.fields) {
    const fdoc = goDoc(field.docs, field.deprecated);
    if (fdoc.length > 0) out += `${tab(fdoc)}\n`;
    const base = renderTypeRef(field.type, input.render);
    const goType = field.optional && field.type.kind !== 'optional' ? `*${base}` : base;
    const tag = field.optional ? ` json:"${field.name},omitempty"` : ` json:"${field.name}"`;
    out += `\t${goExportedName(field.name)} ${goType} \`${tag}\`\n`;
  }
  out += '}\n\n';

  out += `type ${event.name}Envelope struct {\n`;
  out += `\tEvent string \`json:"event"\`\n`;
  out += `\tPayload ${event.name} \`json:"payload"\`\n`;
  out += '}\n\n';

  out += `${goDoc(`Envelope wraps the ${event.name} in the Bridge wire envelope: {"event": name, "payload": {...}}.`)}\n`;
  out += `func (e ${event.name}) Envelope() ${event.name}Envelope {\n`;
  out += `\treturn ${event.name}Envelope{Event: ${JSON.stringify(event.name)}, Payload: e}\n`;
  out += '}\n\n';

  out += `${goDoc(`Decode${event.name}Envelope decodes an envelope and verifies the event name.`)}\n`;
  out += `func Decode${event.name}Envelope(data []byte) (${event.name}Envelope, error) {\n`;
  out += `\tvar env ${event.name}Envelope\n`;
  out += '\tif err := json.Unmarshal(data, &env); err != nil {\n';
  out += `\t\treturn ${event.name}Envelope{}, err\n`;
  out += '\t}\n';
  out += `\tif env.Event != ${JSON.stringify(event.name)} {\n`;
  out += `\t\treturn ${event.name}Envelope{}, fmt.Errorf("unexpected event %q, want %q", env.Event, ${JSON.stringify(event.name)})\n`;
  out += '\t}\n';
  out += '\treturn env, nil\n';
  out += '}\n\n';
  return out;
}

/** Method input/output type: named refs render as the type name. */
function methodTypeName(ref: TypeRef, input: GeneratorInput): string {
  if (ref.kind === 'named') return ref.name;
  return renderTypeRef(ref, input.render);
}
