/**
 * IR analysis helpers shared by the language generators.
 *
 * The generator NEVER trusts caller array order: every collection that
 * affects output is defensively re-sorted here, which is what makes
 * `generate` deterministic even for semantically identical IR packages
 * whose arrays were built in different orders.
 */

import type {
  IRAlias,
  IRField,
  IRPackage,
  IRService,
  IRTypeDefinition,
  IRUnion,
  TypeRef,
} from '@bridge/core';

/** Copy of the package types, sorted by name (defensive ordering). */
export function sortedTypes(ir: IRPackage): IRTypeDefinition[] {
  return [...ir.types].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Copy of the services, sorted by name (defensive ordering). */
export function sortedServices(ir: IRPackage): IRService[] {
  return [...ir.services].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Copy of the events, sorted by name (defensive ordering). */
export function sortedEvents(ir: IRPackage): IRPackage['events'] {
  return [...ir.events].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Set of local type names. */
export function localTypeNames(ir: IRPackage): Set<string> {
  return new Set(ir.types.map((t) => t.name));
}

/** Walks a TypeRef, invoking the visitor on every node. */
export function walkTypeRef(ref: TypeRef, visit: (ref: TypeRef) => void): void {
  visit(ref);
  switch (ref.kind) {
    case 'primitive':
    case 'named':
      break;
    case 'list':
    case 'set':
      walkTypeRef(ref.element, visit);
      break;
    case 'map':
      walkTypeRef(ref.key, visit);
      walkTypeRef(ref.value, visit);
      break;
    case 'optional':
      walkTypeRef(ref.inner, visit);
      break;
  }
}

/** Collects every TypeRef that appears anywhere in the package. */
export function allTypeRefs(ir: IRPackage): TypeRef[] {
  const refs: TypeRef[] = [];
  const push = (ref: TypeRef) => walkTypeRef(ref, (r) => refs.push(r));

  for (const type of ir.types) {
    switch (type.kind) {
      case 'struct':
        for (const field of type.fields) push(field.type);
        break;
      case 'enum':
        break;
      case 'union':
        for (const variant of type.variants) push(variant.type);
        break;
      case 'alias':
        push(type.target);
        break;
    }
  }
  for (const service of ir.services) {
    for (const method of service.methods) {
      push(method.input);
      push(method.output);
    }
  }
  for (const event of ir.events) {
    for (const field of event.fields) push(field.type);
  }
  return refs;
}

export interface CrossPackageRef {
  readonly name: string;
  readonly fromPackage: string;
}

/**
 * Collects distinct cross-package named references, sorted by name.
 * Names that collide with local types are skipped: the local definition
 * wins and no opaque alias is emitted for them.
 */
export function crossPackageRefs(ir: IRPackage): CrossPackageRef[] {
  const locals = localTypeNames(ir);
  const byName = new Map<string, string>();
  for (const ref of allTypeRefs(ir)) {
    if (ref.kind !== 'named') continue;
    if (ref.package === undefined || ref.package === ir.name) continue;
    if (locals.has(ref.name)) continue;
    if (!byName.has(ref.name)) byName.set(ref.name, ref.package);
  }
  return [...byName.entries()]
    .map(([name, fromPackage]) => ({ name, fromPackage }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** True when any type in the package contains a set-typed field. */
export function usesSets(ir: IRPackage): boolean {
  return allTypeRefs(ir).some((ref) => containsSet(ref));
}

function containsSet(ref: TypeRef): boolean {
  switch (ref.kind) {
    case 'set':
      return true;
    case 'list':
      return containsSet(ref.element);
    case 'map':
      return containsSet(ref.key) || containsSet(ref.value);
    case 'optional':
      return containsSet(ref.inner);
    default:
      return false;
  }
}

/** True when any struct field in the package uses the given constraint kind. */
export function usesConstraint(ir: IRPackage, kind: string): boolean {
  for (const type of ir.types) {
    if (type.kind === 'struct') {
      for (const field of type.fields) {
        if (field.constraints.some((c) => c.kind === kind)) return true;
      }
    }
  }
  return false;
}

/** True when any struct field carries a default value. */
export function usesDefaults(ir: IRPackage): boolean {
  return ir.types.some(
    (type) => type.kind === 'struct' && type.fields.some((f) => f.default !== undefined),
  );
}

/** Struct fields that reference a local struct type (for nested validation). */
export function nestedStructFields(
  ir: IRPackage,
  fields: IRField[],
  packageName: string,
): IRField[] {
  return fields.filter((field) => {
    // Unwrap one optional layer: optional struct fields still get nested
    // validation, guarded by presence in each language.
    let ref = field.type;
    if (ref.kind === 'optional') ref = ref.inner;
    if (ref.kind !== 'named') return false;
    if (ref.package !== undefined && ref.package !== packageName) return false;
    const local = ir.types.find((t) => t.name === ref.name);
    return local !== undefined && local.kind === 'struct';
  });
}

/** Union variants of a type, when the type is a union. */
export function unionVariants(type: IRTypeDefinition): IRUnion['variants'] | undefined {
  return type.kind === 'union' ? type.variants : undefined;
}

/** Alias target of a type, when the type is an alias. */
export function aliasTarget(type: IRTypeDefinition): IRAlias['target'] | undefined {
  return type.kind === 'alias' ? type.target : undefined;
}
