/**
 * `bridge.json` project configuration loader.
 *
 * Shape: `{ "version": 1, "source": "bridge.bridge", "out": "generated" }`
 * — written by `bridge init`, consumed implicitly by commands that take
 * input files when none are given on the command line.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError, describeError } from './errors';

export const CONFIG_FILE = 'bridge.json';

export interface BridgeConfig {
  /** Config schema version; only 1 exists today. */
  version: number;
  /** Contract source file, relative to the config directory. */
  source: string;
  /** Default output directory for generated code. */
  out: string;
}

/**
 * Load `bridge.json` from `dir` (default: the current working directory).
 * Returns `null` when the file does not exist; throws a {@link CliError}
 * when it exists but is unreadable or malformed.
 */
export function loadConfig(dir: string = process.cwd()): BridgeConfig | null {
  const file = path.join(dir, CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return null;
    throw new CliError(`cannot read ${file}: ${describeError(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new CliError(`${file} is not valid JSON: ${describeError(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CliError(`${file} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1) {
    throw new CliError(`${file}: unsupported config version ${JSON.stringify(obj['version'])} (expected 1)`);
  }
  if (typeof obj['source'] !== 'string' || obj['source'].length === 0) {
    throw new CliError(`${file}: "source" must be a non-empty string`);
  }
  if (obj['out'] !== undefined && (typeof obj['out'] !== 'string' || obj['out'].length === 0)) {
    throw new CliError(`${file}: "out" must be a non-empty string when present`);
  }
  return {
    version: 1,
    source: obj['source'],
    out: typeof obj['out'] === 'string' ? obj['out'] : 'generated',
  };
}
