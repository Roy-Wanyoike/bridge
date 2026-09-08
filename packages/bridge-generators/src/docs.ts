/**
 * Doc-comment rendering per target language.
 *
 * IR `docs` strings may contain newlines; each renderer splits them into
 * language-appropriate comment lines. Deprecation notices are appended as
 * the language-idiomatic marker:
 *
 * - Go:    `//` comments with a trailing `Deprecated: <msg>` line.
 * - Rust:  `///` doc comments with a `Deprecated:` line (+ `#[deprecated]`
 *          attribute on types, emitted by the Rust generator itself).
 * - TS:    JSDoc blocks with an `@deprecated <msg>` tag.
 * - Python: docstrings with a `Deprecated:` line.
 */

/** Splits an IR docs string into clean lines. */
export function docLines(docs: string | undefined): string[] {
  if (docs === undefined) return [];
  return docs
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** Appends the deprecation notice lines to a docs line list. */
export function withDeprecation(
  lines: string[],
  deprecated: string | true | undefined,
): string[] {
  if (deprecated === undefined) return lines;
  const msg = deprecated === true ? 'This is deprecated.' : `Deprecated: ${deprecated}`;
  return [...lines, msg];
}

/** Go doc comment (`// line` per line). Empty docs -> empty string. */
export function goDoc(docs: string | undefined, deprecated?: string | true): string {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return '';
  return lines.map((line) => `// ${line}`).join('\n');
}

/** Rust doc comment (`/// line` per line). Empty docs -> empty string. */
export function rustDoc(docs: string | undefined, deprecated?: string | true): string {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return '';
  return lines.map((line) => `/// ${line}`).join('\n');
}

/** TS JSDoc block. Empty docs -> empty string. */
export function tsDoc(docs: string | undefined, deprecated?: string | true): string {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return '';
  if (lines.length === 1) return `/** ${lines[0]} */`;
  const body = lines.map((line) => ` * ${line}`).join('\n');
  return `/**\n${body}\n */`;
}

/**
 * Python docstring block, indented at `indent` spaces. Returns undefined
 * when there is nothing to document.
 */
export function pythonDocstring(
  docs: string | undefined,
  deprecated?: string | true,
  indent = 4,
): string | undefined {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return undefined;
  const pad = ' '.repeat(indent);
  if (lines.length === 1) return `${pad}"""${lines[0]}"""`;
  const body = lines.map((line) => `${pad}${line}`).join('\n');
  return `${pad}"""\n${body}\n${pad}"""`;
}

/**
 * Python field comments (`# line` above the field). Returns undefined
 * when there is nothing to document.
 */
export function pythonFieldComment(
  docs: string | undefined,
  deprecated?: string | true,
  indent = 4,
): string | undefined {
  const lines = withDeprecation(docLines(docs), deprecated);
  if (lines.length === 0) return undefined;
  const pad = ' '.repeat(indent);
  return lines.map((line) => `${pad}# ${line}`).join('\n');
}

/** Indents every non-empty line of a block by n spaces. */
export function indentBlock(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join('\n');
}
