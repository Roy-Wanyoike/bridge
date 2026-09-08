/**
 * The Bridge dynamic value model — the language-neutral object graph that
 * every serialization format encodes.
 *
 * Every Bridge IR primitive maps onto one of these values (see
 * docs/SERIALIZATION.md for the authoritative table):
 *
 *   IR primitive          BridgeValue
 *   ------------          --------------------------------
 *   bool                  boolean
 *   int8..int64           bigint (signed 64-bit range)
 *   uint8..uint64         bigint (unsigned 64-bit range)
 *   float32/float64       number (always encoded as 64-bit float)
 *   string                string (UTF-8)
 *   uuid                  string (canonical lowercase hyphenated form)
 *   decimal               string (base-10 fixed-point text)
 *   bytes                 Uint8Array
 *   timestamp             BridgeTimestamp
 *   list<T>               BridgeValue[]
 *   set<T>                BridgeSet (sorted + deduped on construction)
 *   map<string,T>         BridgeMap (string keys only)
 *   optional<T>           absent map key (None) or the inner value (Some)
 *   nullable<T>           the value, or `null`
 *   enum                  string (variant name — never an ordinal)
 *   tagged union          BridgeMap with a `kind` string field
 *
 * Encoding rules per format are intentionally strict so that five runtimes
 * (TypeScript, Go, Rust, Python + the JSON contract) produce byte-identical
 * output. Anything not representable throws — it never silently degrades.
 */

export const MIN_I64 = -(2n ** 63n);
export const MAX_I64 = 2n ** 63n - 1n;
export const MAX_U64 = 2n ** 64n - 1n;

const SECS_PER_DAY = 86_400n;

/** Hinnant's days_from_civil — proleptic Gregorian, exact for any year. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const mp = (m + 9) % 12; // March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146_097 + doe - 719_468;
}

/** Inverse of {@link daysFromCivil}. Day counts for int64-second timestamps stay below 2^53, so fixed-width numbers are exact. */
function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zAdj = z + 719_468;
  const era = Math.floor(zAdj / 146_097);
  const doe = zAdj - era * 146_097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}

/** 64-bit Unix timestamp: whole seconds + non-negative nanosecond offset. */
export class BridgeTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;

  constructor(seconds: bigint | number, nanos = 0) {
    const sec = BigInt(seconds);
    if (sec < MIN_I64 || sec > MAX_I64) {
      throw new RangeError(`timestamp seconds out of int64 range: ${sec}`);
    }
    if (!Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999) {
      throw new RangeError(`timestamp nanos out of range: ${nanos}`);
    }
    this.seconds = sec;
    this.nanos = nanos;
  }

  /**
   * Build from an RFC 3339 string (e.g. `2024-06-04T17:00:00Z`).
   *
   * Parsed arithmetically (proleptic Gregorian, no `Date.parse`): the full
   * int64-second range is accepted, years render with more (or fewer, signed)
   * than four digits outside `0000`–`9999`, offsets `±HH:MM` are honored, and
   * fractional seconds carry up to nanosecond (9-digit) precision exactly.
   */
  static fromISO(iso: string): BridgeTimestamp {
    const match =
      /^(-?\d{4,})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
        iso,
      );
    if (!match) {
      throw new RangeError(`invalid RFC 3339 timestamp: ${iso}`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (
      month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59 || second > 59
    ) {
      throw new RangeError(`invalid RFC 3339 timestamp: ${iso}`);
    }
    const frac = match[7];
    if (frac !== undefined && frac.length > 9) {
      throw new RangeError(`timestamp fraction exceeds nanosecond precision: ${iso}`);
    }
    const nanos = frac === undefined || frac === '' ? 0 : Number(frac) * 10 ** (9 - frac.length);
    let seconds =
      BigInt(daysFromCivil(year, month, day)) * SECS_PER_DAY +
      BigInt(hour) * 3600n +
      BigInt(minute) * 60n +
      BigInt(second);
    if (match[8] !== undefined) {
      const offset =
        BigInt(Number(match[9])) * 3600n + BigInt(Number(match[10])) * 60n;
      seconds -= match[8] === '+' ? offset : -offset;
    }
    return new BridgeTimestamp(seconds, nanos);
  }

  /**
   * RFC 3339 in UTC, rendered arithmetically from (seconds, nanos) — exact
   * over the whole int64-second domain (years beyond ±9999 render with
   * expanded/signed digit groups). Fractional seconds are emitted only when
   * non-zero, at full nanosecond precision. For negative seconds the offset
   * normalizes onto the pre-epoch day (e.g. `-1s + 0.5s` →
   * `1969-12-31T23:59:59.5Z`).
   */
  toISO(): string {
    const days = floorDiv(this.seconds, SECS_PER_DAY);
    const secsOfDay = Number(this.seconds - days * SECS_PER_DAY); // [0, 86399]
    const { y, m, d } = civilFromDays(Number(days));
    const year = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
    const head =
      `${year}-${pad2(m)}-${pad2(d)}T${pad2(Math.floor(secsOfDay / 3600))}:` +
      `${pad2(Math.floor(secsOfDay / 60) % 60)}:${pad2(secsOfDay % 60)}`;
    if (this.nanos === 0) return `${head}Z`;
    const frac = String(this.nanos).padStart(9, '0').replace(/0+$/, '');
    return `${head}.${frac}Z`;
  }

  equals(other: BridgeTimestamp): boolean {
    return this.seconds === other.seconds && this.nanos === other.nanos;
  }
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  return r < 0n ? q - 1n : q;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A set<T> value. Bridge sets are homogeneous (every element has the same
 * value family — a property guaranteed by the IR type system) and are stored
 * in canonical order with duplicates removed at construction time. On the
 * wire a set is a plain array; only the producer-side canonicalization makes
 * it deterministic across languages.
 */
export class BridgeSet {
  readonly entries: BridgeValue[];

  constructor(entries: Iterable<BridgeValue>) {
    const sorted = [...entries].sort(compareValues);
    const deduped: BridgeValue[] = [];
    for (const entry of sorted) {
      const prev = deduped[deduped.length - 1];
      if (prev === undefined || !valueEquals(prev, entry)) deduped.push(entry);
    }
    if (deduped.length > 1) {
      const family = valueFamily(deduped[0] as BridgeValue);
      for (const entry of deduped) {
        if (valueFamily(entry) !== family) {
          throw new TypeError(
            `BridgeSet must be homogeneous: mixed ${family} and ${valueFamily(entry)}`,
          );
        }
      }
    }
    this.entries = deduped;
  }

  equals(other: BridgeSet): boolean {
    if (this.entries.length !== other.entries.length) return false;
    return this.entries.every((e, i) => valueEquals(e, other.entries[i] as BridgeValue));
  }
}

/** String-keyed object map. `undefined` values are treated as absent keys. */
export type BridgeMap = { readonly [key: string]: BridgeValue | undefined };

export type BridgeValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | BridgeTimestamp
  | BridgeSet
  | readonly BridgeValue[]
  | BridgeMap;

/** Coarse family used for set-homogeneity checks and error messages. */
export type ValueFamily =
  | 'null' | 'bool' | 'int' | 'float' | 'string' | 'bytes'
  | 'timestamp' | 'set' | 'array' | 'map';

export function valueFamily(value: BridgeValue): ValueFamily {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return 'float';
  if (typeof value === 'string') return 'string';
  if (value instanceof Uint8Array) return 'bytes';
  if (value instanceof BridgeTimestamp) return 'timestamp';
  if (value instanceof BridgeSet) return 'set';
  if (Array.isArray(value)) return 'array';
  return 'map';
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Total order over same-family values (used by BridgeSet):
 * ints and floats numerically, strings and bytes by UTF-8 byte order,
 * timestamps by (seconds, nanos), arrays lexicographically element-wise,
 * maps by (sorted key list, then values in key order). Cross-family
 * comparison throws — sets are homogeneous by contract.
 */
export function compareValues(a: BridgeValue, b: BridgeValue): number {
  const fa = valueFamily(a);
  const fb = valueFamily(b);
  if (fa !== fb) {
    throw new TypeError(`cannot order mixed value families: ${fa} vs ${fb}`);
  }
  switch (fa) {
    case 'null':
      return 0;
    case 'bool':
      return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    case 'int': {
      const x = a as bigint;
      const y = b as bigint;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 'float':
      return (a as number) - (b as number);
    case 'string':
      return utf8Compare(a as string, b as string);
    case 'bytes':
      return Buffer.compare(a as Uint8Array, b as Uint8Array);
    case 'timestamp': {
      const ta = a as BridgeTimestamp;
      const tb = b as BridgeTimestamp;
      if (ta.seconds !== tb.seconds) return ta.seconds < tb.seconds ? -1 : 1;
      return ta.nanos - tb.nanos;
    }
    case 'set':
      return compareValues((a as BridgeSet).entries, (b as BridgeSet).entries);
    case 'array': {
      const aa = a as readonly BridgeValue[];
      const ba = b as readonly BridgeValue[];
      const n = Math.min(aa.length, ba.length);
      for (let i = 0; i < n; i++) {
        const c = compareValues(aa[i] as BridgeValue, ba[i] as BridgeValue);
        if (c !== 0) return c;
      }
      return aa.length - ba.length;
    }
    case 'map': {
      const ma = a as BridgeMap;
      const mb = b as BridgeMap;
      const ka = sortedMapKeys(ma);
      const kb = sortedMapKeys(mb);
      const keyOrder = compareValues(ka, kb);
      if (keyOrder !== 0) return keyOrder;
      for (const key of ka) {
        const va = (ma[key] ?? null) as BridgeValue;
        const vb = (mb[key] ?? null) as BridgeValue;
        const c = compareValues(va, vb);
        if (c !== 0) return c;
      }
      return 0;
    }
  }
}

/** Map keys in UTF-8 byte order, excluding absent (`undefined`) entries. */
export function sortedMapKeys(map: BridgeMap): string[] {
  return Object.keys(map)
    .filter((k) => map[k] !== undefined)
    .sort(utf8Compare);
}

/** Structural equality over BridgeValues (never identity). */
export function valueEquals(a: BridgeValue, b: BridgeValue): boolean {
  if (a === b) return true;
  const fa = valueFamily(a);
  const fb = valueFamily(b);
  // Sets decode back as plain arrays (they encode as sorted, deduped arrays),
  // so a BridgeSet is value-equal to the array of its entries.
  if (fa === 'set' && fb === 'array') return valueEquals((a as BridgeSet).entries, b);
  if (fa === 'array' && fb === 'set') return valueEquals(a, (b as BridgeSet).entries);
  if (fa !== fb) return false;
  switch (fa) {
    case 'timestamp':
      return (a as BridgeTimestamp).equals(b as BridgeTimestamp);
    case 'set':
      return (a as BridgeSet).equals(b as BridgeSet);
    case 'bytes':
      return Buffer.compare(a as Uint8Array, b as Uint8Array) === 0;
    case 'array': {
      const aa = a as readonly BridgeValue[];
      const ba = b as readonly BridgeValue[];
      return aa.length === ba.length && aa.every((v, i) => valueEquals(v, ba[i] as BridgeValue));
    }
    case 'map': {
      const ma = a as BridgeMap;
      const mb = b as BridgeMap;
      const ka = sortedMapKeys(ma);
      const kb = sortedMapKeys(mb);
      if (ka.length !== kb.length) return false;
      return ka.every((k, i) => {
        if (k !== kb[i]) return false;
        return valueEquals(ma[k] as BridgeValue, mb[k] as BridgeValue);
      });
    }
    default:
      return false; // same-family primitives that reach here differ
  }
}

/** Throw a descriptive error when a value cannot be represented on the wire. */
export function unsupported(what: string, value: BridgeValue): never {
  throw new TypeError(`unsupported Bridge value for ${what}: ${inspectKind(value)}`);
}

function inspectKind(value: BridgeValue): string {
  if (value === null) return 'null';
  if (value instanceof BridgeTimestamp || value instanceof BridgeSet) return value.constructor.name;
  if (value instanceof Uint8Array) return `bytes(len=${value.length})`;
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === 'object') {
    return `map(keys=${Object.keys(value as BridgeMap).length})`;
  }
  return `${typeof value}(${String(value)})`;
}
