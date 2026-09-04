/**
 * MessagePack codec for Bridge values — pure TypeScript, zero dependencies.
 *
 * Profile (see docs/SERIALIZATION.md):
 *  - nil 0xc0, bool 0xc2/0xc3
 *  - ints: minimal encoding; non-negative → unsigned family (0x00..0xcf),
 *    negative → signed family (0xe0..0xd3). Decoded integers are always
 *    returned as `bigint` (int64/uint64 are never floats).
 *  - floats: always 0xcb (binary64); float32/half are decoded but never
 *    emitted. Non-finite floats are rejected.
 *  - strings: fixstr/str8/str16/str32 (UTF-8 byte lengths)
 *  - bytes: bin8/bin16/bin32 (never legacy str-as-bin)
 *  - arrays: fixarray/array16/array32
 *  - maps: fixmap/map16/map32, keys sorted by UTF-8 bytes, string keys only;
 *    absent (undefined) entries are skipped
 *  - timestamps: ext type -1, canonical form timestamp96
 *    (0xc7 0x0c 0xff || nanos:u32 || seconds:i64). The 32- and 64-bit forms
 *    are accepted when decoding for interoperability.
 *  - anything else (unknown ext, non-string map keys, ints outside ±2^63 /
 *    u64) throws — this codec never emits non-canonical bytes.
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

export function encodeMsgpack(value: BridgeValue): Uint8Array {
  const w = new MsgpackWriter();
  w.write(value);
  return w.finish();
}

export function decodeMsgpack(bytes: Uint8Array): BridgeValue {
  const r = new MsgpackReader(bytes);
  const value = r.readValue();
  if (!r.atEnd()) {
    throw new Error(`msgpack: ${r.remaining()} trailing bytes after top-level value`);
  }
  return value;
}

const HEAD_TIMESTAMP96 = 0xc7; // ext8
const TIMESTAMP_EXT_TYPE = -1;

class MsgpackWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;

  write(value: BridgeValue): void {
    if (value === null) return this.byte(0xc0);
    if (typeof value === 'boolean') return this.byte(value ? 0xc3 : 0xc2);
    if (typeof value === 'bigint') return this.writeBigInt(value);
    if (typeof value === 'number') return this.writeFloat64(value);
    if (typeof value === 'string') return this.writeString(value);
    if (value instanceof Uint8Array) return this.writeBin(value);
    if (value instanceof BridgeTimestamp) return this.writeTimestamp(value);
    if (value instanceof BridgeSet) return this.writeArray(value.entries);
    if (Array.isArray(value)) return this.writeArray(value);
    if (value instanceof Map || value instanceof Set) {
      unsupported('msgpack', value); // plain Map/Set have no Bridge wire form
    }
    if (typeof value === 'object') return this.writeMap(value as BridgeMap);
    unsupported('msgpack', value);
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

  private writeU8(b: number): void {
    this.reserve(1)[0] = b;
  }

  private writeU16(v: number): void {
    const buf = this.reserve(2);
    buf.writeUInt16BE(v, 0);
  }

  private writeU32(v: number): void {
    const buf = this.reserve(4);
    buf.writeUInt32BE(v, 0);
  }

  private writeU64(v: bigint): void {
    const buf = this.reserve(8);
    buf.writeBigUInt64BE(v, 0);
  }

  private writeI64(v: bigint): void {
    const buf = this.reserve(8);
    buf.writeBigInt64BE(v, 0);
  }

  writeBigInt(v: bigint): void {
    if (v >= 0) {
      if (v <= MAX_U64) {
        if (v < 0x80) return this.byte(Number(v));
        if (v < 0x100) return this.byte(0xcc), this.writeU8(Number(v));
        if (v < 0x1_0000) return this.byte(0xcd), this.writeU16(Number(v));
        if (v < 0x1_0000_0000) return this.byte(0xce), this.writeU32(Number(v));
        return this.byte(0xcf), this.writeU64(v);
      }
    } else if (v >= MIN_I64) {
      if (v >= -32n) return this.byte(Number(v) & 0xff);
      if (v >= -128n) return this.byte(0xd0), this.writeU8(Number(v) & 0xff);
      if (v >= -32768n) return this.byte(0xd1), this.writeU16(Number(v) & 0xffff);
      if (v >= -2147483648n) return this.byte(0xd2), this.writeU32(Number(v) >>> 0);
      return this.byte(0xd3), this.writeI64(v);
    }
    throw new RangeError(`msgpack: integer out of 64-bit range: ${v}`);
  }

  writeFloat64(v: number): void {
    if (!Number.isFinite(v)) {
      throw new RangeError(`msgpack: non-finite float is not a Bridge value: ${v}`);
    }
    this.byte(0xcb);
    const buf = this.reserve(8);
    buf.writeDoubleBE(v, 0);
  }

  writeString(v: string): void {
    const bytes = Buffer.from(v, 'utf8');
    const n = bytes.length;
    if (n < 32) {
      this.byte(0xa0 | n);
    } else if (n < 0x100) {
      this.byte(0xd9);
      this.writeU8(n);
    } else if (n < 0x1_0000) {
      this.byte(0xda);
      this.writeU16(n);
    } else if (n <= 0xffff_ffff) {
      this.byte(0xdb);
      this.writeU32(n);
    } else {
      throw new RangeError(`msgpack: string exceeds 4 GiB (${n} bytes)`);
    }
    this.chunks.push(bytes);
    this.len += n;
  }

  writeBin(v: Uint8Array): void {
    const n = v.length;
    if (n < 0x100) {
      this.byte(0xc4);
      this.writeU8(n);
    } else if (n < 0x1_0000) {
      this.byte(0xc5);
      this.writeU16(n);
    } else if (n <= 0xffff_ffff) {
      this.byte(0xc6);
      this.writeU32(n);
    } else {
      throw new RangeError(`msgpack: bytes exceed 4 GiB (${n})`);
    }
    this.chunks.push(v);
    this.len += n;
  }

  writeTimestamp(t: BridgeTimestamp): void {
    this.byte(HEAD_TIMESTAMP96);
    this.writeU8(12); // ext payload length
    this.byte(TIMESTAMP_EXT_TYPE & 0xff); // 0xff
    const head = this.reserve(4);
    head.writeUInt32BE(t.nanos, 0);
    this.writeI64(t.seconds);
  }

  writeArray(items: readonly BridgeValue[]): void {
    const n = items.length;
    if (n < 16) {
      this.byte(0x90 | n);
    } else if (n < 0x1_0000) {
      this.byte(0xdc);
      this.writeU16(n);
    } else if (n <= 0xffff_ffff) {
      this.byte(0xdd);
      this.writeU32(n);
    } else {
      throw new RangeError(`msgpack: array exceeds 2^32-1 elements`);
    }
    for (const item of items) this.write(item);
  }

  writeMap(map: BridgeMap): void {
    const keys = sortedMapKeys(map);
    const n = keys.length;
    if (n < 16) {
      this.byte(0x80 | n);
    } else if (n < 0x1_0000) {
      this.byte(0xde);
      this.writeU16(n);
    } else if (n <= 0xffff_ffff) {
      this.byte(0xdf);
      this.writeU32(n);
    } else {
      throw new RangeError(`msgpack: map exceeds 2^32-1 entries`);
    }
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

class MsgpackReader {
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
      throw new Error(`msgpack: unexpected end of input (need ${n}, have ${this.remaining()})`);
    }
  }

  private u8(): number {
    this.need(1);
    return this.dv.getUint8(this.pos++);
  }

  private u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  private u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  private u64(): bigint {
    this.need(8);
    const v = this.dv.getBigUint64(this.pos);
    this.pos += 8;
    return v;
  }

  private i64(): bigint {
    this.need(8);
    const v = this.dv.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }

  private take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readValue(): BridgeValue {
    const head = this.u8();
    // Positive fixint
    if (head <= 0x7f) return BigInt(head);
    // Negative fixint
    if (head >= 0xe0) return BigInt(head - 0x100);
    switch (head >> 4) {
      case 0x8: return this.readMap(head & 0x0f);
      case 0x9: return this.readArray(head & 0x0f);
      case 0xa:
      case 0xb: return this.readStr(head & 0x1f);
    }
    switch (head) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return this.readBin(this.u8());
      case 0xc5: return this.readBin(this.u16());
      case 0xc6: return this.readBin(this.u32());
      case 0xc7: return this.readExt(this.u8());
      case 0xc8: return this.readExt(this.u16());
      case 0xc9: return this.readExt(this.u32());
      case 0xca: return this.readFloat('f32');
      case 0xcb: return this.readFloat('f64');
      case 0xcc: return BigInt(this.u8());
      case 0xcd: return BigInt(this.u16());
      case 0xce: return BigInt(this.u32());
      case 0xcf: return this.u64();
      case 0xd0: return BigInt(this.u8() - 0x100);
      case 0xd1: return BigInt(this.u16() - 0x1_0000);
      case 0xd2: return BigInt(this.u32() - 0x1_0000_0000);
      case 0xd3: return this.i64();
      case 0xd4: return this.readExtFixed(1);
      case 0xd5: return this.readExtFixed(2);
      case 0xd6: return this.readExtFixed(4);
      case 0xd7: return this.readExtFixed(8);
      case 0xd8: return this.readExtFixed(16);
      case 0xd9: return this.readStr(this.u8());
      case 0xda: return this.readStr(this.u16());
      case 0xdb: return this.readStr(this.u32());
      case 0xdc: return this.readArray(this.u16());
      case 0xdd: return this.readArray(this.u32());
      case 0xde: return this.readMap(this.u16());
      case 0xdf: return this.readMap(this.u32());
      default:
        throw new Error(`msgpack: unsupported header byte 0x${head.toString(16).padStart(2, '0')}`);
    }
  }

  private readFloat(kind: 'f32' | 'f64'): number {
    const width = kind === 'f32' ? 4 : 8;
    this.need(width);
    const v = kind === 'f32' ? this.dv.getFloat32(this.pos) : this.dv.getFloat64(this.pos);
    this.pos += width;
    if (!Number.isFinite(v)) {
      throw new Error('msgpack: non-finite float is not a Bridge value');
    }
    return v;
  }

  private readBin(n: number): Uint8Array {
    // copy so the decoded value owns its memory
    return new Uint8Array(this.take(n));
  }

  private readStr(n: number): string {
    return Buffer.from(this.take(n)).toString('utf8');
  }

  private readArray(n: number): BridgeValue[] {
    const out: BridgeValue[] = [];
    for (let i = 0; i < n; i++) out.push(this.readValue());
    return out;
  }

  private readMap(n: number): BridgeMap {
    const out: { [key: string]: BridgeValue } = {};
    for (let i = 0; i < n; i++) {
      const key = this.readValue();
      if (typeof key !== 'string') {
        throw new Error('msgpack: Bridge map keys must be strings');
      }
      out[key] = this.readValue();
    }
    return out;
  }

  private readExtFixed(len: number): BridgeValue {
    const type = this.u8() - 0x100; // i8
    return this.extValue(type, this.take(len));
  }

  private readExt(len: number): BridgeValue {
    const type = this.u8() - 0x100; // i8
    return this.extValue(type, this.take(len));
  }

  private extValue(type: number, data: Uint8Array): BridgeValue {
    if (type !== TIMESTAMP_EXT_TYPE) {
      throw new Error(`msgpack: unsupported ext type ${type} (only -1 timestamps)`);
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length === 4) {
      // timestamp 32: uint32 seconds
      return new BridgeTimestamp(BigInt(dv.getUint32(0)), 0);
    }
    if (data.length === 8) {
      // timestamp 64: nanos in upper 30 bits, seconds in lower 34 bits
      const packed = dv.getBigUint64(0);
      const nanos = Number(packed >> 34n);
      const seconds = packed & ((1n << 34n) - 1n);
      return new BridgeTimestamp(seconds, nanos);
    }
    if (data.length === 12) {
      // timestamp 96: uint32 nanos, int64 seconds
      const nanos = dv.getUint32(0);
      const seconds = dv.getBigInt64(4);
      return new BridgeTimestamp(seconds, nanos);
    }
    throw new Error(`msgpack: invalid timestamp ext payload length ${data.length}`);
  }
}


