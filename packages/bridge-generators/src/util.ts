/**
 * Small shared utilities for the generators.
 */

import type { GeneratedFile } from './gen/input';

/**
 * Creates a GeneratedFile with a normalized path: relative, POSIX-style,
 * no leading `./`, no duplicate slashes. Path normalization is part of the
 * determinism guarantee.
 */
export function generatedFile(path: string, content: string): GeneratedFile {
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  return { path: normalized, content };
}

/** Joins non-empty blocks with a blank line. */
export function joinBlocks(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n\n');
}
