/**
 * Semantic analysis for the Bridge IDL.
 *
 * Runs after parsing over the best-effort AST and validates everything the
 * grammar cannot express: name resolution (with did-you-mean hints), duplicate
 * declarations, package/import hygiene, alias cycles, method signatures, map
 * key restrictions, optional-element restrictions and constraint
 * applicability. It also emits style warnings so `bridge check` can nudge
 * authors toward the canonical naming conventions without failing builds.
 *
 * The analyzer never throws: every problem becomes a diagnostic with a stable
 * `BR2xxx` code, a file/line/column position and, where actionable, a hint.
 *
 * Diagnostic codes (stable — registry and CLI surface them):
 * - BR2001 unknown type reference (errors, with did-you-mean hint when close)
 * - BR2002 duplicate top-level declaration name (type/event/service)
 * - BR2003 duplicate field / union-member name
 * - BR2004 duplicate enum variant name
 * - BR2005 duplicate method name
 * - BR2006 duplicate import
 * - BR2007 package statement problems (missing; parser reuses the code for
 *   placement/duplicates)
 * - BR2008 invalid package/import name (must be dotted lowercase identifier)
 * - BR2009 alias definition cycle
 * - BR2010 method input/output must be a named struct reference
 * - BR2011 map key must be a hashable primitive
 * - BR2012 optional wrapper on a list/set element
 * - BR2013 constraint not applicable to the field type
 * - BR2014 unknown constraint kind (emitted by the parser; listed here to
 *   keep the family documented in one place)
 * - BR2015 unknown imported package (compilePackage with dependencies)
 * - BR2101 type name not PascalCase (warning)
 * - BR2102 enum variant not SCREAMING_SNAKE_CASE (warning)
 * - BR2103 field name not snake_case (warning)
 */

import type { Diagnostic, IRPackage, PrimitiveKind } from './ir/types';
import {
  CONSTRAINT_KINDS,
  MAP_KEY_PRIMITIVES,
  NUMERIC_PRIMITIVES,
  PRIMITIVES,
  PRIMITIVE_SET,
  isTypeDecl,
  typeToText,
  type AliasDeclNode,
  type BridgeFileNode,
  type EnumDeclNode,
  type FieldNode,
  type NamedTypeNode,
  type ServiceDeclNode,
  type TypeDeclNode,
  type TypeNode,
} from './ast';

/** Stable diagnostic codes emitted by semantic analysis. */
export const SEMANTIC_CODES = {
  unknownType: 'BR2001',
  duplicateDeclaration: 'BR2002',
  duplicateField: 'BR2003',
  duplicateEnumVariant: 'BR2004',
  duplicateMethod: 'BR2005',
  duplicateImport: 'BR2006',
  packageStatement: 'BR2007',
  invalidDottedName: 'BR2008',
  aliasCycle: 'BR2009',
  methodSignature: 'BR2010',
  invalidMapKey: 'BR2011',
  optionalCollectionElement: 'BR2012',
  constraintNotApplicable: 'BR2013',
  unknownConstraint: 'BR2014',
  unknownImport: 'BR2015',
  typeNameStyle: 'BR2101',
  enumVariantStyle: 'BR2102',
  fieldNameStyle: 'BR2103',
} as const;

/** Internal error code used by the compiler pipeline for unexpected failures. */
export const INTERNAL_ERROR = 'BR2999';

/** A dotted lowercase identifier: `payments`, `payments.v1`, `a.b_c.d1`. */
const DOTTED_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** PascalCase for type declarations: `Money`, `PaymentStatus`, `HTTPError2`. */
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9]*$/;

/** SCREAMING_SNAKE_CASE for enum variants: `PENDING`, `RATE_LIMIT_5XX`. */
const SCREAMING_CASE_RE = /^[A-Z][A-Z0-9_]*$/;

/** snake_case for fields: `customer_id`, `amount2`, `id`. */
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/** Options for {@link analyzeFile}. */
export interface AnalyzeOptions {
  /**
   * Already-compiled dependency packages used to resolve qualified type
   * references (`identity.v1.User`) and validate imports. When omitted
   * (`compileSource`), cross-package resolution is skipped and imports are
   * not checked for existence.
   */
  dependencies?: Map<string, IRPackage>;
}

/**
 * Analyze a parsed Bridge file.
 *
 * Diagnostics are emitted in a deterministic order: package checks first,
 * then imports in source order, then declarations in source order (with
 * per-declaration checks in field/method order), then alias-cycle findings.
 */
export function analyzeFile(
  file: BridgeFileNode,
  filePath: string,
  options: AnalyzeOptions = {},
): Diagnostic[] {
  return new Analyzer(file, filePath, options.dependencies).run();
}

// ---------------------------------------------------------------------------

/** Result of resolving a type to a primitive for constraint checks. */
type PrimitiveResolution =
  | { found: true; primitive: PrimitiveKind }
  /** Named reference that could not be resolved (already diagnosed). */
  | { found: false };

class Analyzer {
  private readonly diags: Diagnostic[] = [];
  private readonly deps: Map<string, IRPackage> | undefined;
  /** Local type declarations by name (first declaration wins for lookups). */
  private readonly localTypes = new Map<string, TypeDeclNode>();
  /** Local type names + primitives — did-you-mean candidate pool. */
  private readonly candidateNames: string[] = [];
  private ownPackage = '';

  constructor(
    private readonly file: BridgeFileNode,
    private readonly filePath: string,
    dependencies?: Map<string, IRPackage>,
  ) {
    this.deps = dependencies;
  }

  run(): Diagnostic[] {
    this.checkPackage();
    this.checkImports();
    this.collectLocalTypes();
    this.checkDeclarations();
    this.checkAliasCycles();
    return this.diags;
  }

  // ------------------------------------------------------------- plumbing

  private push(
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    line: number,
    column: number,
    hint?: string,
  ): void {
    const d: Diagnostic = { severity, code, message, file: this.filePath, line, column };
    if (hint !== undefined) d.hint = hint;
    this.diags.push(d);
  }

  private error(code: string, message: string, line: number, column: number, hint?: string): void {
    this.push('error', code, message, line, column, hint);
  }

  private warning(code: string, message: string, line: number, column: number, hint?: string): void {
    this.push('warning', code, message, line, column, hint);
  }

  // ------------------------------------------------------------- package

  private checkPackage(): void {
    const pkg = this.file.package;
    if (pkg === undefined) {
      this.error(
        SEMANTIC_CODES.packageStatement,
        'Missing package statement — every Bridge file must declare its package.',
        1,
        1,
        'Add `package <name>` as the first statement, e.g. `package payments.v1`.',
      );
      return;
    }
    if (pkg.name !== '') {
      if (!DOTTED_NAME_RE.test(pkg.name)) {
        this.error(
          SEMANTIC_CODES.invalidDottedName,
          `Invalid package name \`${pkg.name}\`.`,
          pkg.line,
          pkg.column,
          'Package names are dotted lowercase identifiers: segments match [a-z][a-z0-9_]*, e.g. `payments.v1`.',
        );
      }
      this.ownPackage = pkg.name;
    }
  }

  // ------------------------------------------------------------- imports

  private checkImports(): void {
    const seen = new Set<string>();
    for (const imp of this.file.imports) {
      if (imp.name === '') continue; // parse error already reported
      if (seen.has(imp.name)) {
        this.error(
          SEMANTIC_CODES.duplicateImport,
          `Duplicate import of \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Remove the repeated import — each package may be imported at most once.',
        );
        continue;
      }
      seen.add(imp.name);
      if (!DOTTED_NAME_RE.test(imp.name)) {
        this.error(
          SEMANTIC_CODES.invalidDottedName,
          `Invalid import name \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Import names are dotted lowercase identifiers, e.g. `identity.v1`.',
        );
        continue;
      }
      if (this.deps !== undefined && !this.deps.has(imp.name)) {
        this.error(
          SEMANTIC_CODES.unknownImport,
          `Unknown imported package \`${imp.name}\`.`,
          imp.line,
          imp.column,
          'Imported packages must be compiled first and passed as dependencies to `compilePackage`.',
        );
      }
    }
  }

  // -------------------------------------------------- local type collection

  private collectLocalTypes(): void {
    // Primitive names join the did-you-mean pool so typos like `strng`
    // suggest `string`.
    this.candidateNames.push(...PRIMITIVES);
    for (const decl of this.file.decls) {
      if (!isTypeDecl(decl)) continue;
      if (!this.localTypes.has(decl.name)) {
        this.localTypes.set(decl.name, decl);
        this.candidateNames.push(decl.name);
      }
    }
  }

  // ---------------------------------------------------------- declarations

  private checkDeclarations(): void {
    const seenTypes = new Set<string>();
    const seenEvents = new Set<string>();
    const seenServices = new Set<string>();

    for (const decl of this.file.decls) {
      if (isTypeDecl(decl)) {
        this.checkDuplicateName(seenTypes, decl.name, 'type', decl.line, decl.column);
        if (!PASCAL_CASE_RE.test(decl.name)) {
          this.warning(
            SEMANTIC_CODES.typeNameStyle,
            `Type name \`${decl.name}\` is not PascalCase.`,
            decl.line,
            decl.column,
            'Bridge type names start with an uppercase letter and use no underscores, e.g. `PaymentStatus`.',
          );
        }
        switch (decl.decl) {
          case 'struct':
            this.checkFieldBody(decl.fields, `struct \`${decl.name}\``);
            break;
          case 'union':
            this.checkFieldBody(decl.members, `union \`${decl.name}\``);
            break;
          case 'enum':
            this.checkEnum(decl);
            break;
          case 'alias':
            // Type-expression checks for the alias target run here so that
            // unknown references are reported in declaration order.
            this.checkTypeExpr(decl.target);
            break;
        }
      } else if (decl.decl === 'event') {
        this.checkDuplicateName(seenEvents, decl.name, 'event', decl.line, decl.column);
        this.checkFieldBody(decl.fields, `event \`${decl.name}\``);
      } else {
        this.checkDuplicateName(seenServices, decl.name, 'service', decl.line, decl.column);
        this.checkService(decl);
      }
    }
  }

  private checkDuplicateName(
    seen: Set<string>,
    name: string,
    what: string,
    line: number,
    column: number,
  ): void {
    if (name === '') return; // parse error already reported
    if (seen.has(name)) {
      this.error(
        SEMANTIC_CODES.duplicateDeclaration,
        `Duplicate ${what} name \`${name}\`.`,
        line,
        column,
        `Rename one of the declarations — ${what} names must be unique within a package.`,
      );
    } else {
      seen.add(name);
    }
  }

  // --------------------------------------------------------------- fields

  private checkFieldBody(fields: FieldNode[], container: string): void {
    const seenFields = new Set<string>();
    for (const field of fields) {
      if (field.name === '') continue; // parse error already reported
      if (seenFields.has(field.name)) {
        this.error(
          SEMANTIC_CODES.duplicateField,
          `Duplicate field name \`${field.name}\` in ${container}.`,
          field.line,
          field.column,
          'Field names must be unique within a struct, union or event.',
        );
      } else {
        seenFields.add(field.name);
      }
      if (!SNAKE_CASE_RE.test(field.name)) {
        this.warning(
          SEMANTIC_CODES.fieldNameStyle,
          `Field name \`${field.name}\` is not snake_case.`,
          field.line,
          field.column,
          'Bridge field names are lowercase with underscores between words, e.g. `customer_id`.',
        );
      }
      this.checkTypeExpr(field.type);
      this.checkConstraints(field, container);
    }
  }

  private checkEnum(decl: EnumDeclNode): void {
    const seen = new Set<string>();
    for (const variant of decl.variants) {
      if (variant.name === '') continue; // parse error already reported
      if (seen.has(variant.name)) {
        this.error(
          SEMANTIC_CODES.duplicateEnumVariant,
          `Duplicate variant name \`${variant.name}\` in enum \`${decl.name}\`.`,
          variant.line,
          variant.column,
          'Variant names must be unique within an enum.',
        );
      } else {
        seen.add(variant.name);
      }
      if (!SCREAMING_CASE_RE.test(variant.name)) {
        this.warning(
          SEMANTIC_CODES.enumVariantStyle,
          `Enum variant \`${variant.name}\` is not SCREAMING_SNAKE_CASE.`,
          variant.line,
          variant.column,
          'Bridge enum variants are all-uppercase with underscores between words, e.g. `PAYMENT_FAILED`.',
        );
      }
    }
  }

  // ----------------------------------------------------------- type walks

  private checkTypeExpr(t: TypeNode): void {
    switch (t.kind) {
      case 'primitive':
        return;
      case 'named':
        this.checkNamedRef(t);
        return;
      case 'list':
      case 'set': {
        if (t.element.kind === 'optional') {
          this.error(
            SEMANTIC_CODES.optionalCollectionElement,
            `Optional elements are not allowed inside \`${t.kind}\` types — \`${typeToText(t)}\` is invalid.`,
            t.element.line,
            t.element.column,
            'Wrap the whole collection instead: `ids: list<string>?` means the list itself may be absent.',
          );
          this.checkTypeExpr(t.element.inner);
          return;
        }
        this.checkTypeExpr(t.element);
        return;
      }
      case 'map': {
        if (t.key.kind !== 'primitive' || !MAP_KEY_PRIMITIVES.has(t.key.primitive)) {
          this.error(
            SEMANTIC_CODES.invalidMapKey,
            `Map key type \`${typeToText(t.key)}\` is not allowed — keys must be hashable primitives.`,
            t.key.line,
            t.key.column,
            `Allowed map key types: ${[...MAP_KEY_PRIMITIVES].join(', ')}.`,
          );
        }
        this.checkTypeExpr(t.value);
        return;
      }
      case 'optional':
        this.checkTypeExpr(t.inner);
        return;
      case 'error':
        return; // parse error already reported
    }
  }

  private checkNamedRef(t: NamedTypeNode): void {
    if (t.package === undefined) {
      if (PRIMITIVE_SET.has(t.name)) return; // defensive: parser routes primitives
      if (this.localTypes.has(t.name)) return;
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.name}\`.`,
        t.line,
        t.column,
        suggestionHint(t.name, this.candidateNames),
      );
      return;
    }

    // Qualified reference `pkg.Type`.
    if (t.package === this.ownPackage) {
      // Self-qualified reference to the enclosing package resolves locally.
      if (this.localTypes.has(t.name)) return;
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\`.`,
        t.line,
        t.column,
        suggestionHint(t.name, this.candidateNames),
      );
      return;
    }

    if (!this.importedPackages().has(t.package)) {
      const pkgSuggestion = didYouMean(t.package, [this.ownPackage, ...this.importedPackages()]);
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\` — package \`${t.package}\` is not imported.`,
        t.line,
        t.column,
        pkgSuggestion !== undefined
          ? `Did you mean package \`${pkgSuggestion}\`?`
          : `Add \`import ${t.package}\` below the package statement, or reference a type from an imported package.`,
      );
      return;
    }

    const dep = this.deps?.get(t.package);
    if (dep === undefined) return; // no dependencies in compileSource — nothing deeper to check
    const depNames = dep.types.map((td) => td.name);
    if (!depNames.includes(t.name)) {
      this.error(
        SEMANTIC_CODES.unknownType,
        `Unknown type \`${t.package}.${t.name}\` — package \`${t.package}\` does not declare it.`,
        t.line,
        t.column,
        suggestionHint(t.name, depNames),
      );
    }
  }

  private importedNamesCache: Set<string> | undefined;

  private importedPackages(): Set<string> {
    if (this.importedNamesCache === undefined) {
      this.importedNamesCache = new Set(this.file.imports.map((i) => i.name));
    }
    return this.importedNamesCache;
  }

  // ------------------------------------------------------------- services

  private checkService(decl: ServiceDeclNode): void {
    const seen = new Set<string>();
    for (const method of decl.methods) {
      if (method.name === '') continue; // parse error already reported
      if (seen.has(method.name)) {
        this.error(
          SEMANTIC_CODES.duplicateMethod,
          `Duplicate method name \`${method.name}\` in service \`${decl.name}\`.`,
          method.line,
          method.column,
          'Method names must be unique within a service.',
        );
      } else {
        seen.add(method.name);
      }
      this.checkMethodSignature(method.name, 'input', method.input);
      this.checkMethodSignature(method.name, 'output', method.output);
    }
  }

  private checkMethodSignature(
    methodName: string,
    what: 'input' | 'output',
    t: TypeNode,
  ): void {
    if (t.kind === 'error') return; // parse error already reported
    if (t.kind !== 'named') {
      this.error(
        SEMANTIC_CODES.methodSignature,
        `Method \`${methodName}\` ${what} must be a named struct reference, but \`${typeToText(t)}\` is not.`,
        t.line,
        t.column,
        'Declare a request/response struct and reference it by name, e.g. `CreatePayment(CreatePaymentRequest) -> Payment`.',
      );
      return;
    }
    // Resolve the named reference to a declaration and require a struct.
    // `checkNamedRef` reports unknown/unimported references first so that a
    // broken signature does not silently pass when the type is missing.
    this.checkNamedRef(t);
    const resolved = this.resolveNamed(t);
    if (resolved === undefined) return; // unknown reference already diagnosed
    if (resolved.decl !== 'struct') {
      this.error(
        SEMANTIC_CODES.methodSignature,
        `Method \`${methodName}\` ${what} \`${t.name}\` must reference a struct, but \`${t.name}\` is a ${resolved.decl}.`,
        t.line,
        t.column,
        `Change \`${t.name}\` to a struct, or wrap it in one, e.g. \`type ${t.name}Response { value: ${t.name} }\`.`,
      );
    }
  }

  /**
   * Resolve a named type reference to a local declaration or a dependency's
   * type definition rendered as a pseudo-declaration. Returns undefined when
   * the reference is unknown (already diagnosed) or not checkable here.
   */
  private resolveNamed(t: NamedTypeNode): { decl: 'struct' | 'enum' | 'union' | 'alias' } | undefined {
    if (t.package === undefined || t.package === this.ownPackage) {
      const local = this.localTypes.get(t.name);
      return local === undefined ? undefined : { decl: local.decl };
    }
    if (!this.importedPackages().has(t.package)) return undefined;
    const dep = this.deps?.get(t.package);
    if (dep === undefined) return undefined;
    const depType = dep.types.find((td) => td.name === t.name);
    if (depType === undefined) return undefined;
    return { decl: depType.kind };
  }

  // ---------------------------------------------------------- constraints

  private checkConstraints(field: FieldNode, container: string): void {
    for (const constraint of field.constraints) {
      if (!CONSTRAINT_KINDS.has(constraint.kindName)) continue; // parser reported BR2014
      const underlying = field.type.kind === 'optional' ? field.type.inner : field.type;
      const numeric = constraint.kindName === 'min' || constraint.kindName === 'max';
      const resolved = this.resolveToPrimitive(underlying);
      if (resolved === undefined) continue; // unknown type — already diagnosed
      if (numeric && !NUMERIC_PRIMITIVES.has(resolved)) {
        this.error(
          SEMANTIC_CODES.constraintNotApplicable,
          `@${constraint.kindName} applies to numeric types only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
          constraint.line,
          constraint.column,
          '@min/@max support int32, int64, uint32, uint64, float32, float64 and decimal fields.',
        );
      } else if (!numeric && resolved !== 'string') {
        this.error(
          SEMANTIC_CODES.constraintNotApplicable,
          `@${constraint.kindName} applies to string fields only, but field \`${field.name}\` of ${container} has type \`${typeToText(underlying)}\`.`,
          constraint.line,
          constraint.column,
          '@length/@email/@url/@pattern/@uuid support `string` fields only.',
        );
      }
    }
  }

  /**
   * Resolve a type expression to its underlying primitive, following local
   * aliases (cycle-safe). Returns undefined when the type is not primitive-
   * resolvable (struct/enum/union, composite, or an unknown reference that
   * was already diagnosed).
   */
  private resolveToPrimitive(t: TypeNode): PrimitiveKind | undefined {
    const visited = new Set<string>();
    let current: TypeNode = t;
    for (;;) {
      switch (current.kind) {
        case 'primitive':
          return current.primitive;
        case 'optional':
          current = current.inner;
          continue;
        case 'named': {
          if (current.package !== undefined && current.package !== this.ownPackage) return undefined;
          if (visited.has(current.name)) return undefined; // alias cycle — diagnosed separately
          visited.add(current.name);
          const decl = this.localTypes.get(current.name);
          if (decl === undefined) return undefined;
          if (decl.decl !== 'alias') return undefined;
          current = decl.target;
          continue;
        }
        default:
          return undefined;
      }
    }
  }

  // --------------------------------------------------------- alias cycles

  private checkAliasCycles(): void {
    // Direct alias→alias edges among local aliases (transitive via DFS).
    const edges = new Map<string, string[]>();
    for (const [name, decl] of this.localTypes) {
      if (decl.decl !== 'alias') continue;
      const targets = new Set<string>();
      this.collectAliasTargets(decl, targets, new Set());
      edges.set(name, [...targets]);
    }

    const state = new Map<string, 0 | 1 | 2>(); // 0 = unvisited, 1 = in stack, 2 = done
    const stack: string[] = [];
    const visit = (name: string): void => {
      state.set(name, 1);
      stack.push(name);
      for (const next of edges.get(name) ?? []) {
        const s = state.get(next) ?? 0;
        if (s === 1) {
          // Cycle closes at `next`. Report once, at `next`'s declaration.
          const start = stack.indexOf(next);
          const cycle = [...stack.slice(start), next];
          const decl = this.localTypes.get(next);
          const line = decl?.line ?? 1;
          const column = decl?.column ?? 1;
          this.error(
            SEMANTIC_CODES.aliasCycle,
            `Alias \`${next}\` participates in a definition cycle: ${cycle.join(' -> ')}.`,
            line,
            column,
            'Break the cycle — Bridge aliases must resolve to a concrete type without referencing themselves.',
          );
        } else if (s === 0) {
          visit(next);
        }
      }
      stack.pop();
      state.set(name, 2);
    };

    for (const name of edges.keys()) {
      if ((state.get(name) ?? 0) === 0) visit(name);
    }
  }

  /** Collect local alias names referenced (directly) by an alias target. */
  private collectAliasTargets(
    decl: AliasDeclNode,
    out: Set<string>,
    guard: Set<TypeNode>,
  ): void {
    const walk = (t: TypeNode): void => {
      if (guard.has(t)) return; // defensive: AST nodes are acyclic
      guard.add(t);
      switch (t.kind) {
        case 'named':
          if (t.package === undefined || t.package === this.ownPackage) {
            const target = this.localTypes.get(t.name);
            if (target?.decl === 'alias') out.add(t.name);
          }
          return;
        case 'list':
        case 'set':
          walk(t.element);
          return;
        case 'map':
          walk(t.key);
          walk(t.value);
          return;
        case 'optional':
          walk(t.inner);
          return;
        default:
          return;
      }
    };
    walk(decl.target);
  }
}

// ---------------------------------------------------------------------------
// Did-you-mean suggestions
// ---------------------------------------------------------------------------

/**
 * Levenshtein edit distance (insert/delete/substitute), full DP over short
 * identifier-sized strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr.push(Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      ));
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/** Maximum edit distance for a did-you-mean suggestion. */
const MAX_SUGGESTION_DISTANCE = 2;

/**
 * Pick the closest candidate within {@link MAX_SUGGESTION_DISTANCE} edits,
 * or undefined when nothing is close enough. Deterministic: ties are broken
 * by alphabetical order of the candidate list.
 */
export function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of [...candidates].sort()) {
    if (candidate === name) continue;
    const distance = levenshtein(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best !== undefined && bestDistance > MAX_SUGGESTION_DISTANCE) return undefined;
  return best;
}

/** Render a did-you-mean hint, or undefined when there is no suggestion. */
export function suggestionHint(name: string, candidates: Iterable<string>): string | undefined {
  const suggestion = didYouMean(name, candidates);
  return suggestion === undefined ? undefined : `Did you mean \`${suggestion}\`?`;
}
