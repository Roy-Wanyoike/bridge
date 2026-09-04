/**
 * Hand-rolled argument parser — zero dependencies.
 *
 * Supports:
 *   - positional arguments, in order;
 *   - boolean long flags   `--json`, `--force`;
 *   - boolean short flags  `-w`;
 *   - value options        `--out dir`, `--out=dir`, `--language typescript`;
 *   - `--` terminator (everything after it is positional).
 *
 * Unknown flags and missing values throw {@link UsageError} (exit 2).
 */
import { UsageError } from './errors';

export interface ParsedArgs {
  /** Positional arguments in the order given. */
  readonly positionals: readonly string[];
  /** Boolean flags seen (long names as written, short flags as `-w`). */
  readonly flags: ReadonlySet<string>;
  /** Value options seen; repeated options keep the last value. */
  readonly values: ReadonlyMap<string, string>;
}

export interface ArgSpec {
  /** Long boolean flags accepted, e.g. `['--json', '--force']`. */
  readonly flags?: readonly string[];
  /** Short boolean flags accepted, e.g. `['-w']`. */
  readonly shortFlags?: readonly string[];
  /** Long options that require a value, e.g. `['--out', '--registry']`. */
  readonly options?: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: ArgSpec, command: string): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();

  const boolFlags = new Set<string>([...(spec.flags ?? []), ...(spec.shortFlags ?? [])]);
  const valueOptions = new Set<string>(spec.options ?? []);

  const addFlag = (name: string): void => {
    if (!boolFlags.has(name)) {
      throw new UsageError(`unknown option '${name}' for 'bridge ${command}'`);
    }
    flags.add(name);
  };

  /** Handle a value option; returns the index of the last consumed token. */
  const addValue = (name: string, inline: string | undefined, tokens: readonly string[], i: number): number => {
    if (!valueOptions.has(name)) {
      if (boolFlags.has(name)) throw new UsageError(`option '${name}' does not take a value`);
      throw new UsageError(`unknown option '${name}' for 'bridge ${command}'`);
    }
    if (inline !== undefined) {
      values.set(name, inline);
      return i;
    }
    const next = tokens[i + 1];
    if (next === undefined) throw new UsageError(`option '${name}' requires a value`);
    values.set(name, next);
    return i + 1;
  };

  let onlyPositionals = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const name = token.slice(0, eq);
        const inline = token.slice(eq + 1);
        i = addValue(name, inline, argv, i);
      } else if (valueOptions.has(token)) {
        i = addValue(token, undefined, argv, i);
      } else {
        addFlag(token);
      }
      continue;
    }
    if (token.length > 1 && token.charCodeAt(0) === 45 /* '-' */) {
      addFlag(token);
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags, values };
}

/** All positional arguments, checked to be within [min, max]. */
export function positionals(args: ParsedArgs, command: string, usage: string, min: number, max: number): string[] {
  if (args.positionals.length < min || args.positionals.length > max) {
    throw new UsageError(`usage: bridge ${command} ${usage}`);
  }
  return [...args.positionals];
}
