/**
 * `bridge version` — version information.
 */
import { GENERATOR_VERSION } from '@bridge/generators';
import { CLI_VERSION } from '../meta';
import { out } from '../output';

export function run(): void {
  out(`bridge ${CLI_VERSION}`);
  out(`generator ${GENERATOR_VERSION}`);
  out(`node ${process.version}`);
}
