/**
 * Structural equality and canonical rendering for IR type references and
 * constraints. Implemented locally with zero dependencies: the compat engine
 * must stay dependency-free and must not depend on compiler internals beyond
 * the frozen IR types.
 *
 * All functions are pure and deterministic.
 */
import type { ConstraintKind, IRConstraint, TypeRef } from '@bridge/core';

/** Total order for strings (used to canonicalize iteration and sorting). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Render a `TypeRef` in the canonical human-readable notation used in change
 * messages: `int32`, `Money`, `vendor.pkg.Money`, `list<int32>`,
 * `set<string>`, `map<string, Money>`, `int32?`.
 */
export function renderTypeRef(t: TypeRef): string {
  switch (t.kind) {
    case 'primitive':
      return t.primitive;
    case 'named':
      return t.package === undefined ? t.name : `${t.package}.${t.name}`;
    case 'list':
      return `list<${renderTypeRef(t.element)}>`;
    case 'set':
      return `set<${renderTypeRef(t.element)}>`;
    case 'map':
      return `map<${renderTypeRef(t.key)}, ${renderTypeRef(t.value)}>`;
    case 'optional':
      return `${renderTypeRef(t.inner)}?`;
    default: {
      // Exhaustive over the frozen union; keeps strict TS happy if the IR
      // contract is ever extended without this engine being updated.
      const unreachable: never = t;
      throw new Error(`unreachable TypeRef kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Render an `IRConstraint` for change messages: kind plus its textual args,
 * e.g. `min 0`, `length 3`, `pattern ^[a-z]+$`, `email`. The custom message
 * is intentionally NOT rendered here (message-only changes must render as
 * equal so they can be classified SAFE).
 */
export function renderConstraint(c: IRConstraint): string {
  return c.args.length === 0 ? c.kind : `${c.kind} ${c.args.join(', ')}`;
}

/**
 * Structural deep equality of two `TypeRef`s. Two references are equal iff
 * they have the same shape with equal leaves (primitive kinds, named names
 * and packages, nested elements). `undefined` and absent optional `package`
 * compare equal.
 */
export function typeRefsEqual(a: TypeRef, b: TypeRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'primitive':
      return a.primitive === (b as typeof a).primitive;
    case 'named':
      return a.name === (b as typeof a).name && a.package === (b as typeof a).package;
    case 'list':
    case 'set':
      return typeRefsEqual(a.element, (b as typeof a).element);
    case 'map':
      return (
        typeRefsEqual(a.key, (b as typeof a).key) &&
        typeRefsEqual(a.value, (b as typeof a).value)
      );
    case 'optional':
      return typeRefsEqual(a.inner, (b as typeof a).inner);
    default: {
      const unreachable: never = a;
      throw new Error(`unreachable TypeRef kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Multiset (order-insensitive) equality of two string arrays. Used for
 * constraint args: `min(0)` and `min(0)` are equal regardless of the order
 * the arguments were written in.
 */
function multisetEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(cmp);
  const sb = [...b].sort(cmp);
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Equality of two constraints for compatibility purposes: same kind and
 * multiset-equal args. The custom violation `message` is deliberately
 * EXCLUDED so that a message-only edit can be detected separately and
 * classified SAFE.
 */
export function constraintsEqual(a: IRConstraint, b: IRConstraint): boolean {
  return a.kind === b.kind && multisetEqual(a.args, b.args);
}

/**
 * True when the `json` primitive appears anywhere inside the type tree.
 * Comparisons involving `json` are undecidable for the engine (a JSON value
 * may be arbitrarily shaped on the wire) and therefore classify as UNKNOWN.
 */
export function involvesJson(t: TypeRef): boolean {
  switch (t.kind) {
    case 'primitive':
      return t.primitive === 'json';
    case 'named':
      return false;
    case 'list':
    case 'set':
      return involvesJson(t.element);
    case 'map':
      return involvesJson(t.key) || involvesJson(t.value);
    case 'optional':
      return involvesJson(t.inner);
    default: {
      const unreachable: never = t;
      throw new Error(`unreachable TypeRef kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Group constraints by kind, preserving a deterministic per-kind order. */
export function groupByKind(
  constraints: readonly IRConstraint[],
): Map<ConstraintKind, IRConstraint[]> {
  const byKind = new Map<ConstraintKind, IRConstraint[]>();
  for (const c of constraints) {
    const list = byKind.get(c.kind);
    if (list === undefined) byKind.set(c.kind, [c]);
    else list.push(c);
  }
  return byKind;
}

/** Sort constraints deterministically by their rendered args. */
export function sortByArgs(constraints: readonly IRConstraint[]): IRConstraint[] {
  return [...constraints].sort((a, b) => cmp(a.args.join('\u0000'), b.args.join('\u0000')));
}
