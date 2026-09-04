/**
 * The Bridge compiler pipeline: source text → canonical IR.
 *
 * Stages: lex → parse → semantic analysis → IR lowering. The pipeline never
 * throws on any input; unexpected internal failures are reported as a
 * `BR2999` diagnostic instead. When compilation succeeds (`ok === true`) the
 * result carries an `IRPackage` that is fully deterministic:
 *
 * - `types` are sorted by name, `imports` sorted and deduplicated;
 * - fields, union members, enum variants, methods, services and events keep
 *   declaration order;
 * - optional properties (`docs`, `deprecated`, `default`, `message`,
 *   `package`) are added only when present — no `undefined` values;
 * - all source positions are stripped (positions live in the AST only).
 *
 * Optional fields: a `T?` type suffix (or a `?` before the colon) sets
 * `field.optional = true` and unwraps the top-level optional wrapper — the
 * field's type remains `T`. Nested optionals (e.g. inside `list<T?>`) are
 * kept in the IR but rejected by semantic analysis.
 */

import type {
  CompileResult,
  ConstraintKind,
  IRConstraint,
  IRField,
  IRPackage,
  IRService,
  IRTypeBody,
  IRTypeDefinition,
  TypeRef,
} from '../ir/types';
import {
  isTypeDecl,
  type AliasDeclNode,
  type BridgeFileNode,
  type DefaultValueNode,
  type EnumDeclNode,
  type EventDeclNode,
  type FieldNode,
  type MethodNode,
  type ServiceDeclNode,
  type StructDeclNode,
  type TypeNode,
  type UnionDeclNode,
} from '../ast';
import { tokenize } from '../lexer';
import { parse } from '../parser';
import { INTERNAL_ERROR, analyzeFile } from '../semantic';

/**
 * Compile Bridge IDL source text. Cross-package references are checked only
 * syntactically (the referenced package must be imported); use
 * {@link compilePackage} to resolve them against compiled dependencies.
 */
export function compileSource(text: string, filePath: string): CompileResult {
  return runPipeline(text, filePath, undefined);
}

/**
 * Compile a package with its already-compiled dependencies. `dependencies`
 * maps dotted package names to their IR; every `import` must appear in the
 * map or a `BR2015` diagnostic is emitted, and qualified type references are
 * resolved against the dependency's exported types.
 */
export function compilePackage(
  text: string,
  filePath: string,
  dependencies: Map<string, IRPackage>,
): CompileResult {
  return runPipeline(text, filePath, dependencies);
}

/**
 * The compiler as a plain object implementing the `BridgeCompiler`
 * interface, for consumers that program against the interface
 * (CLI, registry, tooling).
 */
export const bridgeCompiler = {
  compileSource,
  compilePackage,
};

function runPipeline(
  text: string,
  filePath: string,
  dependencies: Map<string, IRPackage> | undefined,
): CompileResult {
  try {
    const lexed = tokenize(text, filePath);
    const parsed = parse(lexed.tokens, filePath);
    const diagnostics = [
      ...lexed.diagnostics,
      ...parsed.diagnostics,
      ...analyzeFile(parsed.file, filePath, dependencies === undefined ? {} : { dependencies }),
    ];
    const ir = lowerPackage(parsed.file);
    const ok = !diagnostics.some((d) => d.severity === 'error');
    return ok ? { ok: true, ir, diagnostics } : { ok: false, diagnostics };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: INTERNAL_ERROR,
          message: `Internal compiler error: ${message}`,
          file: filePath,
          line: 1,
          column: 1,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// IR lowering
// ---------------------------------------------------------------------------

function lowerPackage(file: BridgeFileNode): IRPackage {
  const types: IRTypeDefinition[] = [];
  const services: IRService[] = [];
  const events: { name: string; fields: IRField[]; docs?: string }[] = [];

  for (const decl of file.decls) {
    if (isTypeDecl(decl)) types.push(lowerTypeDecl(decl));
    else if (decl.decl === 'service') services.push(lowerService(decl));
    else events.push(lowerEvent(decl));
  }

  types.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const imports = [...new Set(file.imports.map((i) => i.name).filter((n) => n !== ''))].sort();

  const pkg: IRPackage = {
    name: file.package?.name ?? '',
    imports,
    types,
    services,
    events,
  };
  const pkgDocs = file.package?.docs;
  if (pkgDocs !== undefined) pkg.docs = pkgDocs;
  return pkg;
}

function lowerTypeDecl(
  decl: StructDeclNode | EnumDeclNode | UnionDeclNode | AliasDeclNode,
): IRTypeDefinition {
  const def: IRTypeDefinition = { ...lowerBody(decl), name: decl.name };
  if (decl.docs !== undefined) def.docs = decl.docs;
  if (decl.deprecated !== undefined) def.deprecated = decl.deprecated;
  return def;
}

function lowerBody(
  decl: StructDeclNode | EnumDeclNode | UnionDeclNode | AliasDeclNode,
): IRTypeBody {
  switch (decl.decl) {
    case 'struct':
      return { kind: 'struct', fields: decl.fields.map(lowerField) };
    case 'union':
      return { kind: 'union', variants: decl.members.map(lowerField) };
    case 'enum':
      return {
        kind: 'enum',
        variants: decl.variants.map((v) => {
          const variant: { name: string; docs?: string; deprecated?: string | true } = { name: v.name };
          if (v.docs !== undefined) variant.docs = v.docs;
          if (v.deprecated !== undefined) variant.deprecated = v.deprecated;
          return variant;
        }),
      };
    case 'alias':
      return { kind: 'alias', target: lowerType(decl.target) };
  }
}

function lowerField(field: FieldNode): IRField {
  let typeNode: TypeNode = field.type;
  const optional = field.optional || typeNode.kind === 'optional';
  if (typeNode.kind === 'optional') typeNode = typeNode.inner;

  const lowered: IRField = {
    name: field.name,
    type: lowerType(typeNode),
    optional,
    constraints: field.constraints.map(lowerConstraint),
  };
  if (field.docs !== undefined) lowered.docs = field.docs;
  if (field.deprecated !== undefined) lowered.deprecated = field.deprecated;
  const defaultValue = field.defaultValue;
  if (defaultValue !== undefined) lowered.default = lowerDefaultValue(defaultValue);
  return lowered;
}

/**
 * Lower a default value. String literals keep their quoting (e.g. `"USD"`)
 * so the IR preserves the distinction between `= "USD"` and `= USD`; numbers
 * and identifiers keep their raw text.
 */
function lowerDefaultValue(value: DefaultValueNode): string {
  return value.isString ? JSON.stringify(value.text) : value.text;
}

/**
 * Lower a constraint. The last argument becomes the violation `message`
 * when it is a string literal beyond the kind's positional arguments
 * (`min`/`max`/`length`/`pattern` take one, `email`/`url`/`uuid` take none).
 */
function lowerConstraint(constraint: FieldNode['constraints'][number]): IRConstraint {
  const positional: Readonly<Record<string, number>> = {
    min: 1,
    max: 1,
    length: 1,
    pattern: 1,
    email: 0,
    url: 0,
    uuid: 0,
  };
  const required = positional[constraint.kindName] ?? 0;
  let args = constraint.args.map((a) => a.text);
  let message: string | undefined;
  if (constraint.args.length > required && constraint.args.length > 0) {
    const last = constraint.args[constraint.args.length - 1];
    if (last !== undefined && last.isString) {
      message = last.text;
      args = args.slice(0, -1);
    }
  }
  const lowered: IRConstraint = { kind: constraint.kindName as ConstraintKind, args };
  if (message !== undefined) lowered.message = message;
  return lowered;
}

function lowerType(t: TypeNode): TypeRef {
  switch (t.kind) {
    case 'primitive':
      return { kind: 'primitive', primitive: t.primitive };
    case 'named':
      return t.package !== undefined
        ? { kind: 'named', name: t.name, package: t.package }
        : { kind: 'named', name: t.name };
    case 'list':
      return { kind: 'list', element: lowerType(t.element) };
    case 'set':
      return { kind: 'set', element: lowerType(t.element) };
    case 'map':
      return { kind: 'map', key: lowerType(t.key), value: lowerType(t.value) };
    case 'optional':
      return { kind: 'optional', inner: lowerType(t.inner) };
    case 'error':
      // Unreachable in ok IR (parse errors force ok=false); kept for type
      // safety with a neutral placeholder.
      return { kind: 'named', name: '' };
  }
}

function lowerService(decl: ServiceDeclNode): IRService {
  const service: IRService = {
    name: decl.name,
    methods: decl.methods.map((method: MethodNode) => {
      const m: {
        name: string;
        input: TypeRef;
        output: TypeRef;
        docs?: string;
        deprecated?: string | true;
      } = {
        name: method.name,
        input: lowerType(method.input),
        output: lowerType(method.output),
      };
      if (method.docs !== undefined) m.docs = method.docs;
      if (method.deprecated !== undefined) m.deprecated = method.deprecated;
      return m;
    }),
  };
  if (decl.docs !== undefined) service.docs = decl.docs;
  return service;
}

function lowerEvent(decl: EventDeclNode): { name: string; fields: IRField[]; docs?: string } {
  const event: { name: string; fields: IRField[]; docs?: string } = {
    name: decl.name,
    fields: decl.fields.map(lowerField),
  };
  if (decl.docs !== undefined) event.docs = decl.docs;
  return event;
}
