/**
 * CBOR codec for Bridge values — pure TypeScript, zero dependencies.
 *
 * Profile: a strict subset of RFC 8949 (definite lengths only, 64-bit
 * floats only). See docs/SERIALIZATION.md for the full table.
 *
 *  - unsigned ints: major 0, minimal-length argument (0x00..0x1b)
 *  - negative ints: major 1, encoded as -1-n (0x20..0x3b); int64 floor is
 *    -2^63 (n = 2^63-1). Decoded integers are always returned as `bigint`.
 *  - byte strings: major 2, definite length
 *  - text strings: major 3, definite length (UTF-8)
 *  - arrays: major 4, definite length
 *  - maps: major 5, definite length, string keys only, keys sorted by UTF-8
 *    bytes (NB: plain bytewise order, not RFC 8949 §4.2 canonical
 *    length-first order — one order across all three formats)
 *  - tags: only tag 1 (epoch date). Canonical content: an integer epoch
 *    (minimal-length major 0/1) when the nanosecond offset is zero — exact
 *    for the full int64-second range (RFC 8949 §3.4.2 preferred form) —
 *    otherwise 0xc1 0xfb <8-byte IEEE-754 binary64 epoch>. Decode is
 *    symmetric: float epochs split with floor semantics so pre-1970
 *    fractional timestamps round-trip (see timestampFromEpoch). Other tags
 *    are a decode error.
 *  - simple values: false 0xf4, true 0xf5, null 0xf6
 *  - floats: always 0xfb (binary64) on encode; 0xf9/0xfa are decoded
 *    (widened) for interoperability. Non-finite floats are rejected.
 *  - no indefinite lengths (ai=31), no bignum tags 2/3, no simple values
 *    other than the three above — they are all decode errors here.
 */
import {
  BridgeSet,
  BridgeTimestamp,
  BridgeMap,
  BridgeValue,
  MAX_U64,
  MIN_I64,
  sortedMapKeys,
  unsupported,
} from './types';

export function encodeCbor(value: BridgeValue): Uint8Array {
  const w = new CborWriter();
  w.write(value);
  return w.finish();
}

export function decodeCbor(bytes: Uint8Array): BridgeValue {
  const r = new CborReader(bytes);
  const value = r.readValue();
  if (!r.atEnd()) {
    throw new Error(`cbor: ${r.remaining()} trailing bytes after top-level value`);
  }
  return value;
}

class CborWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;

  write(value: BridgeValue): void {
    if (value === null) return this.head(7, 22);
    if (typeof value === 'boolean') return this.head(7, value ? 21 : 20);
    if (typeof value === 'bigint') return this.writeBigInt(value);
    if (typeof value === 'number') return this.writeFloat64(value);
    if (typeof value === 'string') return this.writeString(value);
    if (value instanceof Uint8Array) return this.writeBytes(value);
    if (value instanceof BridgeTimestamp) return this.writeTimestamp(value);
    if (value instanceof BridgeSet) return this.writeArray(value.entries);
    if (Array.isArray(value)) return this.writeArray(value);
    if (value instanceof Map || value instanceof Set) {
      unsupported('cbor', value); // plain Map/Set have no Bridge wire form
    }
    if (typeof value === 'object') return this.writeMap(value as BridgeMap);
    unsupported('cbor', value);
  }

  private reserve(n: number): Buffer {
    const buf = Buffer.allocUnsafe(n);
    this.chunks.push(buf);
    this.len += n;
    return buf;
  }

  private byte(b: number): void {
    this.reserve(1)[0] = b;
  }

  /** Write a type header (major type + argument) using minimal encoding. */
  private head(major: number, arg: number | bigint): void {
    const a = BigInt(arg);
    const m = major << 5;
    if (a < 24) {
      this.byte(m | Number(a));
      return;
    }
    if (a < 0x100) {
      this.byte(m | 24);
      this.reserve(1)[0] = Number(a);
      return;
    }
    if (a < 0x1_0000) {
      const buf = this.reserve(3);
      buf[0] = m | 25;
      buf.writeUInt16BE(Number(a), 1);
      return;
    }
    if (a < 0x1_0000_0000) {
      const buf = this.reserve(5);
      buf[0] = m | 26;
      buf.writeUInt32BE(Number(a), 1);
      return;
    }
    if (a <= 0xffff_ffff_ffff_ffffn) {
      const buf = this.reserve(9);
      buf[0] = m | 27;
      buf.writeBigUInt64BE(a, 1);
      return;
    }
    throw new RangeError(`cbor: argument out of 64-bit range: ${a}`);
  }

  writeBigInt(v: bigint): void {
    if (v >= 0) {
      if (v <= MAX_U64) return this.head(0, v);
    } else if (v >= MIN_I64) {
      return this.head(1, -1n - v);
    }
    throw new RangeError(`cbor: integer out of 64-bit range: ${v}`);
  }

  writeFloat64(v: number): void {
    if (!Number.isFinite(v)) {
      throw new RangeError(`cbor: non-finite float is not a Bridge value: ${v}`);
    }
    const buf = this.reserve(9);
    buf[0] = 0xfb;
    buf.writeDoubleBE(v, 1);
  }

  writeString(v: string): void {
    const bytes = Buffer.from(v, 'utf8');
    this.head(3, bytes.length);
    this.chunks.push(bytes);
    this.len += bytes.length;
  }

  writeBytes(v: Uint8Array): void {
    this.head(2, v.length);
    this.chunks.push(v);
    this.len += v.length;
  }

  writeTimestamp(t: BridgeTimestamp): void {
    this.head(6, 1); // tag 1 (epoch date)
    if (t.nanos === 0) {
      // Integer epoch — RFC 8949 §3.4.2 preferred serialization. Exact for
      // the full int64-second range (never passes through a float).
      if (t.seconds >= 0) return this.head(0, t.seconds);
      return this.head(1, -1n - t.seconds);
    }
    // Fractional seconds ride the binary64 epoch. Precision contract
    // (docs/SERIALIZATION.md): the value is rounded to the nearest
    // representable double — sub-µs nanos may be adjusted on decode. Decode
    // is symmetric (floor-split), so pre-1970 values round-trip.
    const epoch = Number(t.seconds) + t.nanos / 1e9;
    const buf = this.reserve(9);
    buf[0] = 0xfb;
    buf.writeDoubleBE(epoch, 1);
  }

  writeArray(items: readonly BridgeValue[]): void {
    this.head(4, items.length);
    for (const item of items) this.write(item);
  }

  writeMap(map: BridgeMap): void {
    const keys = sortedMapKeys(map);
    this.head(5, keys.length);
    for (const key of keys) {
      this.writeString(key);
      this.write(map[key] as BridgeValue);
    }
  }

  finish(): Uint8Array {
    const out = Buffer.concat(this.chunks.map((c) => Buffer.from(c)), this.len);
    this.chunks = [];
    this.len = 0;
    return out;
  }
}

const AI_ONE_BYTE = 24;

class CborReader {
  private dv: DataView;
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  atEnd(): boolean {
    return this.pos === this.bytes.length;
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number): void {
    if (this.remaining() < n) {
      throw new Error(`cbor: unexpected end of input (need ${n}, have ${this.remaining()})`);
    }
  }

  private u8(): number {
    this.need(1);
    return this.dv.getUint8(this.pos++);
  }

  private take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read an argument (additional info 0..27) after a header byte. */
  private arg(ai: number): bigint {
    if (ai < AI_ONE_BYTE) return BigInt(ai);
    switch (ai) {
      case 24: return BigInt(this.u8());
      case 25: {
        this.need(2);
        const v = this.dv.getUint16(this.pos);
        this.pos += 2;
        return BigInt(v);
      }
      case 26: {
        this.need(4);
        const v = this.dv.getUint32(this.pos);
        this.pos += 4;
        return BigInt(v);
      }
      case 27: {
        this.need(8);
        const v = this.dv.getBigUint64(this.pos);
        this.pos += 8;
        return v;
      }
      default:
        throw new Error(`cbor: unsupported additional info ${ai} (indefinite/reserved)`);
    }
  }

  readValue(): BridgeValue {
    const head = this.u8();
    const major = head >> 5;
    const ai = head & 0x1f;
    switch (major) {
      case 0: {
        const v = this.arg(ai);
        if (v > MAX_U64) throw new Error(`cbor: unsigned integer exceeds uint64: ${v}`);
        return v;
      }
      case 1: {
        const n = this.arg(ai);
        const v = -1n - n;
        if (v < MIN_I64) throw new Error(`cbor: negative integer below int64 floor: ${v}`);
        return v;
      }
      case 2: return new Uint8Array(this.take(Number(this.arg(ai))));
      case 3: return Buffer.from(this.take(Number(this.arg(ai)))).toString('utf8');
      case 4: return this.readArray(this.arg(ai));
      case 5: return this.readMap(this.arg(ai));
      case 6: return this.readTag(this.arg(ai));
      case 7: return this.readSimple(ai);
      default:
        throw new Error(`cbor: impossible major type ${major}`);
    }
  }

  private readArray(n: bigint): BridgeValue[] {
    const out: BridgeValue[] = [];
    for (let i = 0n; i < n; i++) out.push(this.readValue());
    return out;
  }

  private readMap(n: bigint): BridgeMap {
    const out: { [key: string]: BridgeValue } = {};
    for (let i = 0n; i < n; i++) {
      const key = this.readValue();
      if (typeof key !== 'string') {
        throw new Error('cbor: Bridge map keys must be strings');
      }
      out[key] = this.readValue();
    }
    return out;
  }

  private readTag(tag: bigint): BridgeValue {
    if (tag !== 1n) {
      throw new Error(`cbor: unsupported tag ${tag} (only tag 1 epoch dates)`);
    }
    const content = this.readValue();
    if (typeof content === 'number') {
      if (!Number.isFinite(content)) {
        throw new Error('cbor: tag 1 content must be a finite epoch (NaN/±Inf rejected)');
      }
      return timestampFromEpoch(content);
    }
    if (typeof content === 'bigint') {
      return new BridgeTimestamp(content, 0);
    }
    throw new Error(`cbor: tag 1 content must be a number, got ${typeof content}`);
  }

  private readSimple(ai: number): BridgeValue {
    if (ai < AI_ONE_BYTE) return this.simpleValue(ai);
    if (ai === 24) return this.simpleValue(this.u8());
    // 25/26/27 = half/single/double float
    this.need(ai === 25 ? 2 : ai === 26 ? 4 : 8);
    const v =
      ai === 25 ? halfToDouble(this.dv.getUint16(this.pos))
      : ai === 26 ? this.dv.getFloat32(this.pos)
      : this.dv.getFloat64(this.pos);
    this.pos += ai === 25 ? 2 : ai === 26 ? 4 : 8;
    if (!Number.isFinite(v)) {
      throw new Error('cbor: non-finite float is not a Bridge value');
    }
    return v;
  }

  private simpleValue(v: number): BridgeValue {
    if (v === 20) return false;
    if (v === 21) return true;
    if (v === 22) return null;
    throw new Error(`cbor: unsupported simple value ${v}`);
  }
}

/**
 * Split a binary64 epoch into (seconds, nanos) with FLOOR semantics — the
 * exact inverse of the fractional encoder above. Floor (not truncation) is
 * what makes pre-1970 fractional timestamps round-trip: epoch -0.5 →
 * seconds -1, nanos +500000000, mirroring the (seconds, nanos) pair the
 * encoder started from. This matches the decoders of every reference
 * runtime (Go's time.Unix normalization, Rust/Python floor-split hooks).
 */
function timestampFromEpoch(epoch: number): BridgeTimestamp {
  const floor = Math.floor(epoch);
  let seconds = BigInt(floor);
  let nanos = Math.round((epoch - floor) * 1e9);
  if (nanos === 1_000_000_000) {
    // rounding carried over (epoch like x.9999999999)
    nanos = 0;
    seconds += 1n;
  }
  return new BridgeTimestamp(seconds, nanos);
}

/** IEEE-754 binary16 → binary64 (decode-only convenience). */
function halfToDouble(bits: number): number {
  const sign = (bits >> 15) & 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  let value: number;
  if (exp === 0) {
    value = frac * 2 ** -24;
  } else if (exp === 31) {
    value = frac === 0 ? Infinity : NaN;
  } else {
    value = (1 + frac / 1024) * 2 ** (exp - 15);
  }
  return sign ? -value : value;
}
