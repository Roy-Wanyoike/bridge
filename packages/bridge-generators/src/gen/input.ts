/**
 * Shared input type for the per-language generators.
 *
 * Each language module exports a `generate<Language>(input)` function that
 * turns an analyzed Bridge IR package into a deterministic list of files.
 */

import type { IRPackage } from '@bridge/core';
import type { RenderContext, TargetLanguage } from '../mappings';

export type { TargetLanguage } from '../mappings';

/** Resolved options handed to every language generator. */
export interface GeneratorInput {
  /** The IR package to generate from. Array order is defensively sorted. */
  readonly ir: IRPackage;
  /** Language to generate. */
  readonly language: TargetLanguage;
  /** Resolved package name: `options.packageName ?? ir.name`. */
  readonly packageName: string;
  /** Whether service traits/clients should be generated (default true). */
  readonly generateServices: boolean;
  /** Whether event envelopes should be generated (default true). */
  readonly generateEvents: boolean;
  /** Rendering context (language + package name + local type names). */
  readonly render: RenderContext;
}

/** A generated file: relative POSIX path (no leading `./`) + content. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}
