/**
 * Lexer for the Bridge IDL.
 *
 * Converts source text into a flat token stream with 1-based line/column
 * positions. The lexer never throws: malformed input produces diagnostics
 * and lexing recovers in place so multiple errors can be reported in a
 * single pass.
 *
 * Grammar surface (v1):
 * - identifiers:      [A-Za-z_][A-Za-z0-9_]*
 * - keywords:         package import type enum union alias service event
 * - numbers:          [0-9]+(\.[0-9]+)?   (used in constraint arguments)
 * - strings:          double-quoted, single-line, escapes \n \t \" \\
 * - punctuation:      { } ( ) < > , = : ? @ . ->
 * - comments:         `//` (skipped) and `///` doc comments (emitted as
 *                     tokens so the parser can attach them to the following
 *                     declaration or field)
 */

import type { Diagnostic } from './ir/types';

/** Discriminators for the flat token stream produced by {@link tokenize}. */
export type TokenKind =
  | 'ident'
  | 'keyword'
  | 'number'
  | 'string'
  | 'punct'
  | 'doc'
  | 'eof';

/** Reserved words of the Bridge IDL. These may not be used as identifiers. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'package',
  'import',
  'type',
  'enum',
  'union',
  'alias',
  'service',
  'event',
]);

/** Single-character punctuation tokens (the two-character arrow `->` is special-cased). */
const PUNCT: ReadonlySet<string> = new Set([
  '{', '}', '(', ')', '<', '>', ',', '=', ':', '?', '@', '.', '-',
]);

/**
 * A single lexical token with its 1-based source position.
 *
 * `text` holds:
 * - the lexeme for identifiers, keywords, numbers and punctuation,
 * - the decoded (unescaped) value for string literals,
 * - the comment body (without the leading `///` and one optional space) for
 *   doc comments,
 * - the empty string for `eof`.
 */
export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
}

/** Result of lexing: the token stream plus recoverable errors. */
export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

/** Stable diagnostic codes emitted by the lexer. */
export const LEXER_CODES = {
  /** An unknown character that cannot start any token. */
  unexpectedChar: 'BR1001',
  /** A string literal that is never closed before end of line / file. */
  unterminatedString: 'BR1002',
  /** A backslash escape that is not one of \n \t \" \\. */
  invalidEscape: 'BR1003',
} as const;

function isIdentStart(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_'
  );
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Tokenize Bridge IDL source text.
 *
 * Always returns at least one token: a final `eof` token. On lexical errors
 * the lexer emits a diagnostic and continues after the offending character
 * (for unterminated strings it skips to the end of the line), so a single
 * pass can surface multiple errors.
 *
 * @param text - Raw Bridge IDL source.
 * @param filePath - Path used to attribute diagnostics.
 */
export function tokenize(text: string, filePath: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let column = 1;

  const error = (
    code: string,
    message: string,
    hint: string,
    atLine: number,
    atColumn: number,
  ): void => {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code,
      message,
      file: filePath,
      line: atLine,
      column: atColumn,
      hint,
    };
    diagnostics.push(diagnostic);
  };

  while (i < n) {
    const ch = text.charAt(i);

    // --- whitespace -------------------------------------------------------
    if (ch === '\n') {
      i++;
      line++;
      column = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      column++;
      continue;
    }

    // --- comments ---------------------------------------------------------
    if (ch === '/' && text.charAt(i + 1) === '/') {
      const startLine = line;
      const startColumn = column;
      i += 2;
      column += 2;
      const isDoc = text.charAt(i) === '/';
      if (isDoc) {
        i++;
        column++;
      }
      let body = '';
      while (i < n && text.charAt(i) !== '\n') {
        body += text.charAt(i);
        i++;
        column++;
      }
      if (isDoc) {
        // Strip exactly one leading space after `///` (canonical style).
        const content = body.startsWith(' ') ? body.slice(1) : body;
        tokens.push({ kind: 'doc', text: content, line: startLine, column: startColumn });
      }
      continue;
    }

    // --- string literals ----------------------------------------------------
    if (ch === '"') {
      const strLine = line;
      const strColumn = column;
      i++;
      column++;
      let value = '';
      let closed = false;
      while (i < n) {
        const c = text.charAt(i);
        if (c === '"') {
          closed = true;
          i++;
          column++;
          break;
        }
        if (c === '\n') {
          break; // strings are single-line; reported as unterminated below
        }
        if (c === '\\') {
          const esc = text.charAt(i + 1);
          if (esc === '' || esc === '\n') {
            i++;
            column++;
            break; // dangling backslash -> unterminated
          }
          i += 2;
          column += 2;
          if (esc === 'n') {
            value += '\n';
          } else if (esc === 't') {
            value += '\t';
          } else if (esc === '"') {
            value += '"';
          } else if (esc === '\\') {
            value += '\\';
          } else {
            value += esc;
            error(
              LEXER_CODES.invalidEscape,
              `Invalid escape sequence \`\\${esc}\` in string literal.`,
              'Valid escapes are \\n, \\t, \\" and \\\\.',
              strLine,
              column - 2,
            );
          }
          continue;
        }
        value += c;
        i++;
        column++;
      }
      if (!closed) {
        error(
          LEXER_CODES.unterminatedString,
          'Unterminated string literal.',
          'String literals must be closed with a double quote on the same line — Bridge strings cannot span lines.',
          strLine,
          strColumn,
        );
        // Recover: skip the remainder of the line.
        while (i < n && text.charAt(i) !== '\n') {
          i++;
          column++;
        }
      }
      tokens.push({ kind: 'string', text: value, line: strLine, column: strColumn });
      continue;
    }

    // --- identifiers & keywords ----------------------------------------------
    if (isIdentStart(ch)) {
      const startColumn = column;
      let word = '';
      while (i < n && isIdentPart(text.charAt(i))) {
        word += text.charAt(i);
        i++;
        column++;
      }
      tokens.push({
        kind: KEYWORDS.has(word) ? 'keyword' : 'ident',
        text: word,
        line,
        column: startColumn,
      });
      continue;
    }

    // --- numbers --------------------------------------------------------------
    if (isDigit(ch)) {
      const startColumn = column;
      let num = '';
      while (i < n && isDigit(text.charAt(i))) {
        num += text.charAt(i);
        i++;
        column++;
      }
      // Optional fractional part: 3.14 (a bare trailing dot is not a number).
      if (text.charAt(i) === '.' && isDigit(text.charAt(i + 1))) {
        num += '.';
        i++;
        column++;
        while (i < n && isDigit(text.charAt(i))) {
          num += text.charAt(i);
          i++;
          column++;
        }
      }
      tokens.push({ kind: 'number', text: num, line, column: startColumn });
      continue;
    }

    // --- arrow ---------------------------------------------------------------
    if (ch === '-' && text.charAt(i + 1) === '>') {
      tokens.push({ kind: 'punct', text: '->', line, column });
      i += 2;
      column += 2;
      continue;
    }

    // --- punctuation -----------------------------------------------------------
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', text: ch, line, column });
      i++;
      column++;
      continue;
    }

    // --- anything else is an error (recover by skipping one character) --------
    error(
      LEXER_CODES.unexpectedChar,
      `Unexpected character \`${ch}\`.`,
      'This character cannot appear in a Bridge file — remove it or check the Bridge IDL grammar.',
      line,
      column,
    );
    i++;
    column++;
  }

  tokens.push({ kind: 'eof', text: '', line, column });
  return { tokens, diagnostics };
}
