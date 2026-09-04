/**
 * `bridge help [command]` — usage text.
 */
import { ParsedArgs, positionals } from '../args';
import { UsageError } from '../errors';
import { out } from '../output';
import { COMMAND_HELP, GENERAL_USAGE } from '../usage';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'help', '[command]', 0, 1);
  const command = pos[0];
  if (command === undefined) {
    out(GENERAL_USAGE);
    return;
  }
  const help = COMMAND_HELP[command];
  if (help === undefined) {
    throw new UsageError(`unknown command '${command}' — run 'bridge help' to list commands`);
  }
  out(help);
}
