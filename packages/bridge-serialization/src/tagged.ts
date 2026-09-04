/**
 * Tagged JSON ↔ BridgeValue.
 *
 * JSON cannot distinguish int64 from float64, bytes from strings, or a
 * timestamp from a string — exactly the ambiguities the Bridge wire spec
 * pins down. The golden-vector fixtures therefore use this explicit tagged
 * representation (see docs/SERIALIZATION.md §Tagged vectors), and every
 * language runtime implements the same mapping. This module is the
 * TypeScript reference implementation of that mapping.
 *
 *   {"t":"null"}                                → null
 *   {"t":"bool","v":true}                       → boolean
 *   {"t":"i64","v":"9007199254740993"}          → bigint (string of digits)
 *   {"t":"u64","v":"18446744073709551615"}      → bigint (string of digits)
 *   {"t":"f64","v":3.14}                        → number
 *   {"t":"str","v":"hello"}                     → string
 *   {"t":"decimal","v":"19.99"}                 → string (decimal is textual)
 *   {"t":"uuid","v":"550e8400-…"}               → string
 *   {"t":"enum","v":"high"}                     → string (never an ordinal)
 *   {"t":"bytes","b64":"AAEC/w=="}              → Uint8Array
 *   {"t":"timestamp","iso":"2024-06-04T17:00:00Z"} → BridgeTimestamp
 *   {"t":"array","v":[ …tagged… ]}              → BridgeValue[]
 *   {"t":"set","v":[ …tagged… ]}                → BridgeSet (sorted + deduped)
 *   {"t":"map","v":{"k": …tagged…, …}}          → BridgeMap (omitted key =
 *                                                 absent optional; {"t":"null"}
 *                                                 = explicit null)
 */
import {
  BridgeSet,
  BridgeTimestamp,
  BridgeMap,
  BridgeValue,
  MAX_I64,
  MAX_U64,
  MIN_I64,
  sortedMapKeys,
} from './types';

export interface TaggedValue {
  t: string;
  v?: unknown;
  b64?: string;
  iso?: string;
}

export function valueFromTagged(tagged: unknown): BridgeValue {
  const node = tagged as TaggedValue;
  if (node === null || typeof node !== 'object' || typeof node.t !== 'string') {
    throw new TypeError(`tagged value must be an object with a string "t" field`);
  }
  switch (node.t) {
    case 'null':
      return null;
    case 'bool':
      return assertBool(node.v);
    case 'i64': {
      const v = BigInt(assertDigits(node.v));
      if (v < MIN_I64 || v > MAX_I64) throw new RangeError(`i64 out of range: ${v}`);
      return v;
    }
    case 'u64': {
      const v = BigInt(assertDigits(node.v));
      if (v < 0n || v > MAX_U64) throw new RangeError(`u64 out of range: ${v}`);
      return v;
    }
    case 'f64': {
      const v = node.v;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(`f64 value must be a finite JSON number`);
      }
      return v;
    }
    case 'str':
    case 'decimal':
    case 'uuid':
    case 'enum':
      if (typeof node.v !== 'string') throw new TypeError(`${node.t} value must be a string`);
      return node.v;
    case 'bytes':
      return new Uint8Array(Buffer.from(assertB64(node.b64), 'base64'));
    case 'timestamp':
      return BridgeTimestamp.fromISO(assertIso(node.iso));
    case 'array': {
      if (!Array.isArray(node.v)) throw new TypeError(`array value must be a JSON array`);
      return node.v.map(valueFromTagged);
    }
    case 'set': {
      if (!Array.isArray(node.v)) throw new TypeError(`set value must be a JSON array`);
      return new BridgeSet(node.v.map(valueFromTagged));
    }
    case 'map': {
      if (node.v === null || typeof node.v !== 'object' || Array.isArray(node.v)) {
        throw new TypeError(`map value must be a JSON object`);
      }
      const out: Record<string, BridgeValue | undefined> = {};
      for (const [key, inner] of Object.entries(node.v as Record<string, unknown>)) {
        out[key] = inner === undefined ? undefined : valueFromTagged(inner);
      }
      return out as BridgeMap;
    }
    default:
      throw new TypeError(`unknown tagged type: ${node.t}`);
  }
}


/**
 * Inverse of {@link valueFromTagged}: renders a BridgeValue as the tagged
 * JSON model. Map keys are emitted in canonical (bytewise-sorted) order and
 * absent-optional keys are omitted, so identical values produce identical
 * models — this is the representation golden vectors carry.
 */
export function valueToTagged(value: BridgeValue): TaggedValue {
  if (value === null) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'bool', v: value };
  if (typeof value === 'bigint') {
    if (value < 0n) return { t: 'i64', v: value.toString() };
    return { t: 'u64', v: value.toString() };
  }
  if (typeof value === 'number') return { t: 'f64', v: value };
  if (typeof value === 'string') return { t: 'str', v: value };
  if (value instanceof Uint8Array) return { t: 'bytes', b64: Buffer.from(value).toString('base64') };
  if (value instanceof BridgeTimestamp) return { t: 'timestamp', iso: value.toISO() };
  if (value instanceof BridgeSet) return { t: 'set', v: value.entries.map(valueToTagged) };
  if (Array.isArray(value)) return { t: 'array', v: value.map(valueToTagged) };
  if (typeof value === 'object') {
    const out: Record<string, TaggedValue> = {};
    for (const key of sortedMapKeys(value as BridgeMap)) {
      const inner = (value as BridgeMap)[key];
      out[key] = inner === undefined ? { t: 'absent' } : valueToTagged(inner);
    }
    return { t: 'map', v: out };
  }
  throw new TypeError(`unsupported Bridge value: ${String(value)}`);
}

function assertBool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`bool value must be a JSON boolean`);
  return v;
}

function assertDigits(v: unknown): string {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) {
    throw new TypeError(`i64/u64 value must be a string of digits`);
  }
  return v;
}

function assertB64(v: unknown): string {
  if (typeof v !== 'string') throw new TypeError(`bytes value must carry base64 "b64"`);
  return v;
}

function assertIso(v: unknown): string {
  if (typeof v !== 'string') throw new TypeError(`timestamp value must carry RFC 3339 "iso"`);
  return v;
}
