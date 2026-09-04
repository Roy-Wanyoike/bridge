/**
 * Audit sinks.
 *
 * The file sink appends one JSON object per line (JSONL) with
 * `fs.appendFileSync` — no fsync, so a hard crash can lose the tail of the
 * log but never corrupts earlier lines (appends of <4KiB are effectively
 * atomic on local POSIX filesystems). The file is the source of truth:
 * `tail()` re-reads it at request time, so entries survive restarts.
 *
 * A torn final line (crash mid-append) is skipped when reading.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry, AuditSink } from './types';

/** Clamp a requested tail size into `0..max`. */
export function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.min(Math.max(Math.trunc(limit), 0), max);
}

/** Append-only JSONL audit file. */
export class FileAuditSink implements AuditSink {
  public constructor(public readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  public append(entry: AuditEntry): void {
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Up to `limit` most recent entries, oldest → newest. */
  public tail(limit: number): AuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Torn line from a crash mid-append: skip, never fail the read.
      }
    }
    return entries.slice(-clampLimit(limit, Number.MAX_SAFE_INTEGER));
  }
}

/** In-memory sink (the default when no `audit` option is given). */
export class MemoryAuditSink implements AuditSink {
  private readonly entries: AuditEntry[] = [];

  public append(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  public tail(limit: number): AuditEntry[] {
    return this.entries.slice(-clampLimit(limit, Number.MAX_SAFE_INTEGER));
  }
}
