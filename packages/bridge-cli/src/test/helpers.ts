/**
 * Shared helpers for the CLI e2e tests: spawn the compiled binary in
 * isolated temp directories and assert on exit codes / output text.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Compiled CLI entry point (dist/test/../bin/bridge.js). */
export const BIN = path.resolve(__dirname, '..', 'bin', 'bridge.js');

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly all: string;
}

export interface RunOptions {
  readonly cwd?: string;
  /** Extra environment variables layered over the inherited ones. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Spawn the CLI. BRIDGE_REGISTRY is always stripped first so tests are
 * immune to the outer environment.
 */
export function run(args: readonly string[], options: RunOptions = {}): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['BRIDGE_REGISTRY'];
  Object.assign(env, options.env);
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? -1, stdout, stderr, all: stdout + stderr };
}

/** Create a unique temp directory rooted under the OS temp dir. */
export function tmpdir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bridge-cli-${label}-`));
}

/** Write a file into a directory and return its path. */
export function writeFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Compiles cleanly (type + service, so generators emit service files). */
export const GOOD = `package shop.v1

type Money {
    amount: int64
    currency: string @length(3)
}

type Receipt {
    id: uuid
    total: Money
}

type GetReceiptRequest {
    id: uuid
}

service Shop {
    GetReceipt(GetReceiptRequest) -> Receipt
}
`;

/** Unknown type reference `money` with a close match `Money` → hint. */
export const BROKEN = `package shop.v1

type Money {
    amount: int64
}

type Payment {
    id: uuid
    amount: money
}
`;

/** Non-PascalCase type name → convention warning (BR2101). */
export const WARNY = `package shop.v1

type receipt_line {
    label: string
}
`;

/** Not canonically formatted (2-space indent, missing blank line). */
export const UGLY = `package shop.v1
type Money {
  amount: int64
}
`;

/** Syntactically invalid — the formatter cannot parse it. */
export const UNPARSEABLE = `package shop.v1

type Money {
    amount: int64
`;  // missing closing brace

export const PAYMENTS_V1 = `package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

/** Breaking evolution of PAYMENTS_V1: fields/type removed. */
export const PAYMENTS_BREAKING = `package payments.v1

type Money {
    amount: int64
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
}

type Payment {
    id: uuid
    amount: Money
    status: PaymentStatus
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    GetPayment(GetPaymentRequest) -> Payment
}
`;

/** Safe evolution: only an optional field is added. */
export const PAYMENTS_SAFE = `package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
    reference: string?
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
`;

/** Same shape as PAYMENTS_SAFE, published as payments.v2 (new version). */
export const PAYMENTS_V2 = PAYMENTS_SAFE.replace('package payments.v1', 'package payments.v2');
