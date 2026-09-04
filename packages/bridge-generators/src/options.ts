/**
 * Options for {@link generate}. Kept in its own module so the public API
 * surface mirrors the spec exactly.
 */

import type { TargetLanguage } from './mappings';

export interface GenerateOptions {
  /** Target language. */
  language: TargetLanguage;
  /** Overrides the derived module/package name (defaults to `ir.name`). */
  packageName?: string;
  /** Generate service traits/clients (default true). */
  generateServices?: boolean;
  /** Generate event envelopes (default true). */
  generateEvents?: boolean;
}
