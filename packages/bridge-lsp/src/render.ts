/**
 * Render canonical IR definitions back to Bridge IDL text.
 *
 * Used by hover (markdown payload) and completion (details). The IR keeps
 * enough information to reproduce the declaration faithfully: constraint
 * arguments survive as written, string-typed default values stay quoted
 * (`lowerDefaultValue` re-quotes them), optional flags are carried on the
 * field.
 *
 * One known approximation: `IRConstraint.args` stores the *textual*
 * argument values but not whether each was a string literal, so
 * `renderConstraint` re-quotes any argument that is not a plain number.
 * `@length(3)` and `@min(0)` are unaffected; `@pattern(^[a-z]+$)` renders
 * as `@pattern("^[a-z]+$")` — the semantic value is unchanged.
 */

import type { IRConstraint, IRField, IRTypeDefinition, IRTypeBody, TypeRef } from '@bridge/core';

/** Render a `TypeRef` in Bridge IDL syntax (`T?` for optionals). */
export function typeRefToText(type: TypeRef): string {
  switch (type.kind) {
    case 'primitive':
      return type.primitive;
    case 'named':
      return type.package === undefined ? type.name : `${type.package}.${type.name}`;
    case 'list':
      return `list<${typeRefToText(type.element)}>`;
    case 'set':
      return `set<${typeRefToText(type.element)}>`;
    case 'map':
      return `map<${typeRefToText(type.key)}, ${typeRefToText(type.value)}>`;
    case 'optional':
      return `${typeRefToText(type.inner)}?`;
  }
}

function isNumericLiteral(text: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(text);
}

function renderConstraint(constraint: IRConstraint): string {
  const args = constraint.args.map((arg) => (isNumericLiteral(arg) ? arg : JSON.stringify(arg)));
  return args.length === 0 ? `@${constraint.kind}` : `@${constraint.kind}(${args.join(', ')})`;
}

/** Render a field / union member in Bridge IDL syntax. */
export function fieldToText(field: IRField): string {
  let line = `${field.name}: ${typeRefToText(field.type)}`;
  if (field.optional) line += '?';
  for (const constraint of field.constraints) {
    line += ` ${renderConstraint(constraint)}`;
  }
  if (field.default !== undefined) line += ` = ${field.default}`;
  return line;
}

function fieldLines(fields: readonly IRField[], indent: string): string[] {
  return fields.map((field) => `${indent}${fieldToText(field)}`);
}

/**
 * Render an IR type definition as its full Bridge IDL declaration
 * (`type X { … }`, `enum X { … }`, `union X { … }`, `alias X = T`).
 */
export function typeDeclToText(definition: IRTypeDefinition): string {
  const body: IRTypeBody = definition;
  switch (body.kind) {
    case 'struct':
      return [`type ${definition.name} {`, ...fieldLines(body.fields, '    '), '}'].join('\n');
    case 'union':
      return [`union ${definition.name} {`, ...fieldLines(body.variants, '    '), '}'].join('\n');
    case 'enum':
      return [`enum ${definition.name} {`, ...body.variants.map((v) => `    ${v.name}`), '}'].join('\n');
    case 'alias':
      return `alias ${definition.name} = ${typeRefToText(body.target)}`;
  }
}

/** The declaration keyword for an IR definition (`struct`, `enum`, …). */
export function typeKindLabel(definition: IRTypeDefinition): string {
  return definition.kind;
}
