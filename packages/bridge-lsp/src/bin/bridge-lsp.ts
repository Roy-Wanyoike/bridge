#!/usr/bin/env node
/**
 * `bridge-lsp` — Bridge IDL language server over stdio.
 *
 * Reads LSP-framed JSON-RPC from stdin, writes to stdout. Editors launch
 * this binary directly:
 *
 *   cmd = { 'bridge-lsp' }                          -- if installed globally / npm-linked
 *   cmd = { 'node', '<pkg>/dist/bin/bridge-lsp.js' } -- straight from a checkout
 */
import { createConnection } from '../connection';

createConnection(process.stdin, process.stdout);
