#!/usr/bin/env node
'use strict';
/**
 * bridge-fuzz — CLI for the Bridge IDL compiler fuzzer.
 *
 *   node bin/bridge-fuzz.js --iterations N --seed S
 *
 * Requires the compiled output of @bridge/core (run `npm run build -w @bridge/core`
 * or `npm run build` at the repo root first).
 */
const path = require('node:path');

let cli;
try {
  cli = require(path.join(__dirname, '..', 'dist', 'fuzz', 'cli.js'));
} catch (cause) {
  process.stderr.write(
    'bridge-fuzz: compiled @bridge/core output not found (dist/fuzz/cli.js).\n' +
      'Build first, e.g.: npm run build -w @bridge/core\n',
  );
  process.exit(2);
}

if (typeof cli !== 'object' || cli === null || typeof cli.runCli !== 'function') {
  process.stderr.write(
    'bridge-fuzz: dist/fuzz/cli.js has an unexpected module shape ' +
      '(expected an exported runCli function).\n' +
      'Rebuild @bridge/core, e.g.: npm run build -w @bridge/core\n',
  );
  process.exit(2);
}

process.exitCode = cli.runCli(process.argv.slice(2));
