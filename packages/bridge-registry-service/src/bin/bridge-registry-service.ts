/**
 * CLI entry: `bridge-registry-service`.
 *
 * No top-level side effects — `main()` runs only when this file is
 * executed directly, so importing the compiled module is always
 * side-effect free.
 *
 * Storage: in-memory by default, PostgreSQL via `--driver postgres
 * --pg-dsn ...` (migrations in `migrations/` are applied on boot).
 * Auth: static bearer tokens via `--token secret=tenant:role`; OIDC via
 * `--oidc-issuer/--oidc-audience` (+ optional `--oidc-jwks-url`).
 * Signing: `--signing-key <kid>=<pem-file>` (repeatable; required mode).
 */

import { readFileSync } from 'node:fs';
import { start } from '../server';
import { InMemoryDriver } from '../storage/memory';
import { PostgresDriver } from '../storage/postgres/driver';
import type { RegistryRole, RegistryServiceOptions, RegistryTokenInfo, StorageDriver } from '../types';

const USAGE = `bridge-registry-service — multi-tenant Bridge contract registry

Usage:
  bridge-registry-service [options]

Options:
  --port <n>                     TCP port to bind (default: 4350; 0 = auto-assign)
  --host <addr>                  Interface to bind (default: all interfaces)
  --driver <memory|postgres>     Storage driver (default: memory)
  --pg-dsn <dsn>                 PostgreSQL DSN (postgres/postgresql://user:pass@host/db)
  --token <secret>=<org>:<role>  Static bearer token; repeatable.
                                 role: read | write | admin
  --oidc-issuer <url>            OIDC issuer (iss claim)
  --oidc-audience <aud>          OIDC audience (aud claim)
  --oidc-jwks-url <url>          JWKS URL (default: <issuer>/.well-known/jwks.json)
  --signing-key <kid>=<pemfile>  ed25519 public key (PEM/SPKI) for publish
                                 signature verification; repeatable. When any
                                 key is configured, signed publishes are
                                 REQUIRED unless --signing-optional is passed.
  --signing-optional             Allow unsigned publishes when keys are set
  --audit <file.jsonl>           Mirror audit entries to an append-only JSONL
                                 file (entries always also go to the driver)
  -h, --help                     Show this help

Environment (equivalents):
  BRIDGE_REGISTRY_PORT, BRIDGE_REGISTRY_DRIVER, PG_DSN,
  BRIDGE_REGISTRY_TOKEN (repeatable via ';': secret=org:role;secret2=org:role)

Examples:
  bridge-registry-service --token dev-acme=acme:write --token ro=acme:read
  bridge-registry-service --driver postgres --pg-dsn postgres://bridge@localhost/bridge

Health:   curl http://127.0.0.1:4350/healthz
API doc:  curl http://127.0.0.1:4350/v1/openapi.json
Publish:  curl -X PUT -H 'Authorization: Bearer dev-acme' \\
            --data-binary @payments.ir.json \\
            http://127.0.0.1:4350/v1/orgs/acme/projects/payments/contracts/payments.v1
`;

/** Internal marker for command-line misuse (distinct from runtime errors). */
class UsageError extends Error {}

interface Config {
  port: number;
  host?: string;
  driver: 'memory' | 'postgres';
  pgDsn?: string;
  tokens: Record<string, RegistryTokenInfo>;
  oidc?: { issuer: string; audience: string; jwksUrl?: string };
  signingKeys: Record<string, string>;
  signingOptional: boolean;
  auditFile?: string;
}

function envTokens(): Record<string, RegistryTokenInfo> {
  const raw = process.env['BRIDGE_REGISTRY_TOKEN'];
  const out: Record<string, RegistryTokenInfo> = {};
  if (raw === undefined) return out;
  for (const spec of raw.split(';')) {
    const eq = spec.indexOf('=');
    if (eq <= 0) continue;
    const secret = spec.slice(0, eq);
    const rest = spec.slice(eq + 1);
    const colon = rest.lastIndexOf(':');
    if (colon <= 0) continue;
    out[secret] = { tenant: rest.slice(0, colon), role: rest.slice(colon + 1) as RegistryRole };
  }
  return out;
}

function parseArgs(argv: string[]): Config {
  const config: Config = {
    port: Number(process.env['BRIDGE_REGISTRY_PORT'] ?? 4350),
    driver: (process.env['BRIDGE_REGISTRY_DRIVER'] as Config['driver']) ?? 'memory',
    pgDsn: process.env['PG_DSN'],
    tokens: envTokens(),
    signingKeys: {},
    signingOptional: false,
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) config.port = 4350;

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
      case '--driver': {
        const d = value();
        if (d !== 'memory' && d !== 'postgres') {
          throw new UsageError(`--driver must be 'memory' or 'postgres', got '${d}'`);
        }
        config.driver = d;
        break;
      }
      case '--pg-dsn':
        config.pgDsn = value();
        break;
      case '--token': {
        const spec = value();
        const eq = spec.indexOf('=');
        if (eq <= 0) {
          throw new UsageError(`--token expects <secret>=<org>:<role>, got '${spec}'`);
        }
        const secret = spec.slice(0, eq);
        const rest = spec.slice(eq + 1);
        const colon = rest.lastIndexOf(':');
        const org = colon > 0 ? rest.slice(0, colon) : rest;
        const role = colon > 0 ? rest.slice(colon + 1) : '';
        if (secret.length === 0 || org.length === 0 || !['read', 'write', 'admin'].includes(role)) {
          throw new UsageError(`--token expects <secret>=<org>:<role> with role read|write|admin, got '${spec}'`);
        }
        config.tokens[secret] = { tenant: org, role: role as RegistryRole };
        break;
      }
      case '--oidc-issuer':
        config.oidc = config.oidc ?? { issuer: value(), audience: '' };
        config.oidc.issuer = config.oidc.issuer || '';
        break;
      case '--oidc-audience':
        config.oidc = config.oidc ?? { issuer: '', audience: value() };
        config.oidc.audience = config.oidc.audience || '';
        break;
      case '--oidc-jwks-url':
        config.oidc = config.oidc ?? { issuer: '', audience: '' };
        config.oidc.jwksUrl = value();
        break;
      case '--signing-key': {
        const spec = value();
        const eq = spec.indexOf('=');
        if (eq <= 0) throw new UsageError(`--signing-key expects <kid>=<pemfile>, got '${spec}'`);
        const kid = spec.slice(0, eq);
        const pem = readFileSync(spec.slice(eq + 1), 'utf8');
        config.signingKeys[kid] = pem;
        break;
      }
      case '--signing-optional':
        config.signingOptional = true;
        break;
      case '--audit':
        config.auditFile = value();
        break;
      default:
        throw new UsageError(`unknown option '${arg}' (see --help)`);
    }
  }

  if (config.oidc !== undefined && (config.oidc.issuer.length === 0 || config.oidc.audience.length === 0)) {
    throw new UsageError('--oidc-issuer and --oidc-audience are both required');
  }
  if (config.driver === 'postgres' && config.pgDsn === undefined) {
    throw new UsageError('--driver postgres requires --pg-dsn (or PG_DSN)');
  }
  return config;
}

function buildDriver(config: Config): StorageDriver {
  if (config.driver === 'postgres') {
    return new PostgresDriver({ dsn: config.pgDsn! });
  }
  return new InMemoryDriver();
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

  try {
    const options: RegistryServiceOptions = {
      driver: buildDriver(config),
      auth: {
        tokens: Object.keys(config.tokens).length > 0 ? config.tokens : undefined,
        oidc:
          config.oidc !== undefined
            ? { issuer: config.oidc.issuer, audience: config.oidc.audience, jwksUrl: config.oidc.jwksUrl }
            : undefined,
      },
      signing:
        Object.keys(config.signingKeys).length > 0
          ? { keys: config.signingKeys, mode: config.signingOptional ? 'optional' : 'required' }
          : undefined,
      host: config.host,
    };
    if (config.auditFile !== undefined) {
      // Lazy import avoided on purpose: the FileAuditSink lives in audit.ts
      // and is part of this package.
      const { FileAuditSink } = require('../audit') as typeof import('../audit');
      const driverBackend = options.driver;
      options.audit = {
        append: async (entry) => {
          await (driverBackend as { appendAudit(e: unknown): Promise<void> }).appendAudit(entry);
          await new FileAuditSink(config.auditFile!).append(entry);
        },
        query: async (filter) => (driverBackend as { queryAudit(f: unknown): Promise<unknown[]> }).queryAudit(filter) as never,
      };
    }
    const server = start(options, config.port);
    server.on('error', (err) => {
      process.stderr.write(`bridge-registry-service: ${err.message}\n`);
      process.exit(1);
    });
    const shutdown = (): void => {
      server.close(() => process.exit(0));
      // Force-exit if graceful close hangs (open keep-alive sockets).
      setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    process.stderr.write(`bridge-registry-service: ${(err as Error).message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
