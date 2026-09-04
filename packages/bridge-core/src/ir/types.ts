/**
 * Bridge Canonical IR — the stable boundary between the compiler and all
 * downstream consumers (generators, compatibility engine, registry, CLI).
 *
 * ⚠ FROZEN CONTRACT: generators, compat, registry and CLI depend on these
 * shapes. Extending requires coordination; changing existing signatures is a
 * breaking change to every consumer.
 *
 * Design rules:
 * - Deterministic: identical IDL input produces identical IR (deep-equal).
 * - Stable ordering: all arrays below are sorted or in declaration order;
 *   consumers must not rely on object key order.
 * - No floats in hashing paths; constraints keep their textual arguments.
 */

/** Primitive types supported by the Bridge IDL. */
export type PrimitiveKind =
  | 'string'
  | 'bool'
  | 'int32'
  | 'int64'
  | 'uint32'
  | 'uint64'
  | 'float32'
  | 'float64'
  | 'bytes'
  | 'uuid'
  | 'timestamp'
  | 'decimal'
  | 'json';

/** A reference to a type, used in fields, methods, aliases, composites. */
export type TypeRef =
  | { kind: 'primitive'; primitive: PrimitiveKind }
  /** Reference to a named type declared in this or an imported package. */
  | { kind: 'named'; name: string; /** Dotted package name when cross-package. */ package?: string }
  | { kind: 'list'; element: TypeRef }
  | { kind: 'set'; element: TypeRef }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  /** Optional wrapper; equivalent to a nullable absence-aware value. */
  | { kind: 'optional'; inner: TypeRef };

/** Supported validation constraint kinds (Bridge IDL `@constraint(args)`). */
export type ConstraintKind =
  | 'min'
  | 'max'
  | 'length'
  | 'email'
  | 'url'
  | 'pattern'
  | 'uuid';

export interface IRConstraint {
  kind: ConstraintKind;
  /** Textual arguments as written, e.g. `length(3)` → ['3']. */
  args: string[];
  /** Optional custom violation message. */
  message?: string;
}

export interface IRField {
  name: string;
  type: TypeRef;
  /** Optional fields may be absent in wire formats. */
  optional: boolean;
  constraints: IRConstraint[];
  /** Doc comment attached to the field (/// style), if any. */
  docs?: string;
  /** Deprecation: true or a message explaining the deprecation. */
  deprecated?: string | true;
  /** Default value as written in the IDL, if any. */
  default?: string;
}

export interface IREnumVariant {
  name: string;
  docs?: string;
  deprecated?: string | true;
}

export interface IRStruct {
  kind: 'struct';
  fields: IRField[];
}

export interface IREnum {
  kind: 'enum';
  variants: IREnumVariant[];
}

/** Tagged union members. Each member is a field-shaped variant. */
export interface IRUnion {
  kind: 'union';
  variants: IRField[];
}

export interface IRAlias {
  kind: 'alias';
  target: TypeRef;
}

export type IRTypeBody = IRStruct | IREnum | IRUnion | IRAlias;

export type IRTypeDefinition = IRTypeBody & {
  name: string;
  docs?: string;
  deprecated?: string | true;
};

export interface IRMethod {
  name: string;
  /** Request type (named struct reference). */
  input: TypeRef;
  /** Response type. */
  output: TypeRef;
  docs?: string;
  deprecated?: string | true;
}

export interface IRService {
  name: string;
  methods: IRMethod[];
  docs?: string;
}

export interface IREvent {
  name: string;
  fields: IRField[];
  docs?: string;
}

/** One compiled Bridge package: the unit of publication and hashing. */
export interface IRPackage {
  /** Dotted package name, e.g. `payments.v1`. */
  name: string;
  /** Dotted names of imported packages, sorted, deduplicated. */
  imports: string[];
  /** Type definitions, sorted by name. */
  types: IRTypeDefinition[];
  services: IRService[];
  events: IREvent[];
  /** Package-level doc comment. */
  docs?: string;
}

/** Compiler diagnostic with precise source location. */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  /** Stable code, e.g. `BR1001`. */
  code: string;
  message: string;
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Actionable suggestion, e.g. "Did you mean `Money`?". */
  hint?: string;
}

/** Result of compiling IDL source text. */
export interface CompileResult {
  ok: boolean;
  /** Canonical IR, present only when ok === true. */
  ir?: IRPackage;
  diagnostics: Diagnostic[];
}
