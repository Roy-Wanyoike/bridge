import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RegistryError } from './errors';

const HEX64_RE = /^[a-f0-9]{64}$/;

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/**
 * Atomically write `data` to `filePath`: the payload lands in a hidden
 * same-directory `*.tmp` file first and is then `rename`d into place, so
 * readers never observe a half-written file. The tmp file is removed on
 * failure — a healthy store contains no `.tmp` leftovers.
 */
export function atomicWriteFile(filePath: string, data: string): void {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new RegistryError('io', `Cannot create directory ${dir}`, err);
  }
  const tmp = join(dir, `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; the original error below matters more
    }
    throw new RegistryError('io', `Cannot write ${filePath}`, err);
  }
}

/** Read a UTF-8 file; `null` on ENOENT; `'io'` RegistryError on anything else. */
export function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw new RegistryError('io', `Cannot read ${filePath}`, err);
  }
}

/**
 * Parse a JSON file: `null` when it does not exist, the parsed value on
 * success, `'corrupt'` RegistryError on invalid JSON, `'io'` on other
 * filesystem failures.
 */
export function parseJsonFile<T>(filePath: string): T | null {
  const text = readFileOrNull(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new RegistryError('corrupt', `${filePath} contains invalid JSON`, err);
  }
}

/**
 * List a directory with `Dirent`s; `null` when it does not exist (or the
 * path is a file); `'io'` RegistryError on anything else.
 */
export function readdirDirentsOrNull(dirPath: string): Dirent[] | null {
  try {
    return readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
    throw new RegistryError('io', `Cannot list ${dirPath}`, err);
  }
}

/** `existsSync` that never throws. */
export function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Defensive gate: any hash that is about to be used in a filesystem path
 * (computed or read back from stored data) must be a plain 64-character
 * lowercase hex SHA-256 digest. This makes path traversal via a tampered
 * pointer or meta file (`"hash": "../../etc/passwd"`) impossible.
 */
export function assertSha256Hex(hash: unknown, what: string): string {
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) {
    throw new RegistryError(
      'corrupt',
      `${what}: expected a 64-character lowercase hex SHA-256 digest, got ${JSON.stringify(hash)}`,
    );
  }
  return hash;
}
