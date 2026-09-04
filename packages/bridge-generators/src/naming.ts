/**
 * Naming utilities for the Bridge generators.
 *
 * All functions are pure and deterministic: identical input always yields
 * identical output. They handle the three concerns that every language
 * backend needs:
 *
 * 1. Case conversion (snake_case -> CamelCase / PascalCase / camelCase).
 * 2. Go initialism expansion (id -> ID, api -> API, ...).
 * 3. Keyword collision handling per language (Rust `r#type`, TS `type_`,
 *    Python `from_`).
 */

/** Initialisms that Go style guides require to stay all-caps. */
const GO_INITIALISMS: ReadonlySet<string> = new Set([
  'id',
  'api',
  'url',
  'uri',
  'http',
  'https',
  'json',
  'sql',
  'uuid',
  'tcp',
  'udp',
  'ip',
  'rpc',
  'cpu',
  'db',
  'tls',
  'ssh',
  'ok',
]);

/** Go reserved words that could collide with a *lowercase* identifier. */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var',
]);

/**
 * Rust keywords that require escaping when used as identifiers.
 * `self`, `Self`, `super` and `crate` cannot be raw identifiers, so they
 * fall back to the trailing-underscore strategy.
 */
const RUST_RAW_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'as', 'async', 'await', 'become', 'box', 'break', 'const',
  'continue', 'do', 'dyn', 'else', 'enum', 'extern', 'false', 'final', 'fn',
  'for', 'gen', 'if', 'impl', 'in', 'let', 'loop', 'macro', 'match', 'mod',
  'move', 'mut', 'override', 'priv', 'pub', 'ref', 'return', 'static',
  'struct', 'trait', 'true', 'try', 'type', 'typeof', 'union', 'unsafe',
  'unsized', 'use', 'virtual', 'where', 'while', 'yield',
]);

const RUST_NON_RAW_KEYWORDS: ReadonlySet<string> = new Set([
  'self', 'self', 'Self', 'super', 'crate',
]);

/** Python reserved keywords (Python 3.12 keyword list). */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case',
]);

/**
 * TypeScript reserved words that Bridge escapes with a trailing underscore
 * in generated interfaces/members. Property names are legal in modern TS,
 * but escaping keeps generated code usable in destructuring patterns and
 * older targets; the wire name is preserved via a `@wireName` JSDoc tag.
 */
const TS_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'type', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield', 'await',
  'implements', 'readonly', 'namespace', 'module', 'declare', 'abstract',
]);

/** Splits a snake_case identifier into its parts. */
export function snakeParts(name: string): string[] {
  return name.split('_').filter((part) => part.length > 0);
}

/** Capitalizes a single word: `currency` -> `Currency`. */
function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `order_id` -> `OrderId` (without initialism expansion). */
export function pascalCase(name: string): string {
  return snakeParts(name).map(capitalize).join('');
}

/** `SCREAMING_SNAKE` -> `ScreamingSnake`. */
export function pascalFromScreaming(name: string): string {
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => capitalize(part.toLowerCase()))
    .join('');
}

/** `ScreamingSnake` -> `SCREAMING_SNAKE`. */
export function screamingSnakeFromPascal(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return parts.map((part) => part.toUpperCase()).join('_');
}

/**
 * Go exported field name from a snake_case wire name, with initialism
 * expansion: `user_id` -> `UserID`, `api_key` -> `APIKey`,
 * `http_url` -> `HTTPURL`, `json_body` -> `JSONBody`.
 * Each part is expanded independently (`payment_id` -> `PaymentID`).
 */
export function goExportedName(snake: string): string {
  return snakeParts(snake)
    .map((part) => {
      const lower = part.toLowerCase();
      if (GO_INITIALISMS.has(lower)) return lower.toUpperCase();
      return capitalize(part);
    })
    .join('');
}

/** Go local (unexported) identifier from a snake_case name. */
export function goLocalName(snake: string): string {
  const exported = goExportedName(snake);
  return exported.charAt(0).toLowerCase() + exported.slice(1);
}

/**
 * Go receiver name for a type: first letter of the PascalCase name,
 * lowercased (`Money` -> `m`, `Order` -> `o`).
 */
export function goReceiver(typeName: string): string {
  const first = typeName.charAt(0);
  return first ? first.toLowerCase() : 'x';
}

/** Rust identifier for a field name, handling keyword collisions. */
export function rustFieldName(snake: string): { name: string; rename?: string } {
  if (RUST_RAW_KEYWORDS.has(snake)) {
    return { name: `r#${snake}`, rename: snake };
  }
  if (RUST_NON_RAW_KEYWORDS.has(snake)) {
    return { name: `${snake}_`, rename: snake };
  }
  return { name: snake };
}

/** Rust variant identifier for an enum variant declared name. */
export function rustVariantName(declared: string): string {
  return pascalFromScreaming(declared);
}

/**
 * Returns `true` when serde's `rename_all = "SCREAMING_SNAKE_CASE"` already
 * reproduces the declared wire name, i.e. no explicit per-variant rename
 * attribute is required.
 */
export function serdeRenameAllMatches(declared: string): boolean {
  return screamingSnakeFromPascal(rustVariantName(declared)) === declared;
}

/** Python identifier for a field name, handling keyword collisions. */
export function pythonFieldName(snake: string): { name: string; wire: string } {
  if (PYTHON_KEYWORDS.has(snake)) {
    return { name: `${snake}_`, wire: snake };
  }
  return { name: snake, wire: snake };
}

/** Python identifier validity check (rough, ASCII-oriented). */
export function isPythonIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_KEYWORDS.has(name);
}

/** TypeScript member name, escaping reserved words with a trailing `_`. */
export function tsFieldName(snake: string): { name: string; wire: string; escaped: boolean } {
  if (TS_RESERVED_WORDS.has(snake)) {
    return { name: `${snake}_`, wire: snake, escaped: true };
  }
  return { name: snake, wire: snake, escaped: false };
}

/**
 * TS identifier that is safe to use for local declarations (functions,
 * constants): appends `_` for reserved words, digits-leading or empty.
 */
export function tsSafeIdent(name: string): string {
  if (name.length === 0) return '_';
  if (/^[0-9]/.test(name) || TS_RESERVED_WORDS.has(name)) return `${name}_`;
  return name;
}

/**
 * Go identifier that is safe to use for local declarations inside a
 * function (helpers, regex vars). Falls back to appending `_` on keyword
 * collisions. The result is exported-style (callers pass PascalCase input).
 */
export function goSafeIdent(name: string): string {
  if (GO_KEYWORDS.has(name)) return `${name}_`;
  return name;
}

/** Package name for Go: dots -> underscores, lowercased (`payments.v1` -> `payments_v1`). */
export function goPackageName(pkg: string): string {
  return pkg.toLowerCase().replace(/\./g, '_').replace(/[^a-z0-9_]/g, '');
}

/** Crate name for Rust: dots -> dashes (`payments.v1` -> `bridge-payments-v1`). */
export function rustCrateName(pkg: string, prefix = 'bridge'): string {
  const sanitized = pkg.toLowerCase().replace(/\./g, '-').replace(/[^a-z0-9-]/g, '');
  return prefix ? `${prefix}-${sanitized}` : sanitized;
}

/** Distribution/module name for Python: `payments.v1` -> module `payments_v1`. */
export function pythonModuleName(pkg: string): string {
  return goPackageName(pkg);
}

/** npm package name: `payments.v1` -> `@generated/payments.v1`. */
export function tsPackageName(pkg: string): string {
  return `@generated/${pkg}`;
}

/**
 * Sanitized package name used in project file identifiers:
 * `payments.v1` -> `payments_v1` (go module suffix), dashed variants are
 * derived by callers via `rustCrateName`.
 */
export function sanitizedPackageName(pkg: string): string {
  return goPackageName(pkg);
}

/** Upper snake case identifier, used for constant names (`Money_amount` -> `MONEY_AMOUNT`). */
export function upperSnake(...parts: string[]): string {
  return parts
    .flatMap((part) => snakeParts(part))
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
    .filter((part) => part.length > 0)
    .join('_');
}

/** Service method name -> snake_case client method (`CreatePayment` -> `create_payment`). */
/** `OrderPlaced` → `ORDER_PLACED` — SCREAMING_SNAKE for generated constants. */
export function camelToScreamingSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

export function camelToLowerSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Service method name -> camelCase client method (`CreatePayment` -> `createPayment`). */
export function pascalToCamel(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
