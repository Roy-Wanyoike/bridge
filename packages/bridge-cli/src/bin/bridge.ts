#!/usr/bin/env node
/**
 * `bridge` — the Bridge IDL command line interface.
 *
 * Zero runtime dependencies beyond @bridge/* workspace packages.
 */
import { main } from '../main';

main(process.argv.slice(2));
