/**
 * CLI entry: `bridge-registry-service`.
 *
 * No top-level side effects — `main()` runs only when this file is executed
 * directly (`require.main === module`), so importing the compiled module is
 * always side-effect free.
 */

import { RegistryStore } from '@bridge/registry';
import { start } from '../server';
import type { RegistryRole, RegistryTokenInfo } from '../types';

const USAGE = `bridge-registry-service — HTTP API over a Bridge contract registry

Usage:
  bridge-registry-service --store <dir> [options]

Options:
  --store <dir>              Registry store directory (required; created on first publish)
  --port <n>                 TCP port to bind (default: 4350; 0 = auto-assign)
  --host <addr>              Interface to bind (default: all interfaces)
  --audit <file>             Append-only JSONL audit log path (default: in-memory)
  --token <secret>=<tenant>:<role>   Bearer token; repeatable
                             role is one of: read | write | admin
  -h, --help                 Show this help

Examples:
  bridge-registry-service --store .bridge-registry \\
    --token dev-acme=acme:write --token ro=acme:read --audit audit.jsonl

Health check:            curl http://127.0.0.1:4350/health
Publish (write token):   curl -X PUT -H 'Authorization: Bearer dev-acme' \\
                           --data-binary @payments.ir.json \\
                           http://127.0.0.1:4350/api/v1/contracts/payments.v1
`;

/** Internal marker for command-line misuse (distinct from runtime errors). */
class UsageError extends Error {}

interface Config {
  store: string;
  port: number;
  host?: string;
  audit?: string;
  tokens: Record<string, RegistryTokenInfo>;
}

function parseArgs(argv: string[]): Config {
  const config: Config = { store: '', port: 4350, tokens: {} };
  const roles: RegistryRole[] = ['read', 'write', 'admin'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`option ${arg} requires a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h':
      case '--help':
        throw new UsageError('__HELP__');
      case '--store':
        config.store = value();
        break;
      case '--port': {
        const raw = value();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new UsageError(`--port must be an integer in [0, 65535], got '${raw}'`);
        }
        config.port = port;
        break;
      }
      case '--host':
        config.host = value();
        break;
      case '--audit':
        config.audit = value();
        break;
      case '--token': {
        const spec = value();
        const eq = spec.indexOf('=');
        if (eq <= 0) {
          throw new UsageError(`--token expects <secret>=<tenant>:<role>, got '${spec}'`);
        }
        const secret = spec.slice(0, eq);
        const rest = spec.slice(eq + 1);
        const colon = rest.lastIndexOf(':');
        const tenant = colon > 0 ? rest.slice(0, colon) : rest;
        const role = colon > 0 ? rest.slice(colon + 1) : '';
        if (secret.length === 0 || tenant.length === 0 || !roles.includes(role as RegistryRole)) {
          throw new UsageError(
            `--token expects <secret>=<tenant>:<role> with role read|write|admin, got '${spec}'`,
          );
        }
        config.tokens[secret] = { tenant, role: role as RegistryRole };
        break;
      }
      default:
        throw new UsageError(`unknown option '${arg}' (see --help)`);
    }
  }

  if (config.store === '') throw new UsageError('--store <dir> is required');
  return config;
}

function run(argv: string[]): number {
  let config: Config;
  try {
    config = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError && err.message === '__HELP__') {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`bridge-registry-service: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const server = start(
    {
      store: new RegistryStore(config.store),
      tokens: config.tokens,
      audit: config.audit,
      host: config.host,
    },
    config.port,
  );
  server.on('error', (err) => {
    process.stderr.write(`bridge-registry-service: ${err.message}\n`);
    process.exit(1);
  });
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
