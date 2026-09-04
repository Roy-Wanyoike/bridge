/**
 * Executable golden-vector check for the TypeScript codecs themselves: every
 * committed vector must encode byte-identically and decode back to the exact
 * tagged model. The Go/Rust/Python runtimes assert the same vectors — this is
 * the TypeScript side of the cross-language contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeCbor, decodeMsgpack, encodeCbor, encodeMsgpack, valueFromTagged, valueToTagged } from '../index';

const vectorsPath = join(__dirname, '..', '..', 'vectors', 'vectors.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')).vectors as Array<{
  id: string;
  model: unknown;
  msgpack: string;
  cbor: string;
}>;

test('golden vectors: 40 vectors covering the wire profile', () => {
  assert.equal(vectors.length, 40);
});

for (const vector of vectors) {
  test(`vector ${vector.id} encodes and decodes byte-identically`, () => {
    const value = valueFromTagged(vector.model);
    const mp = Buffer.from(encodeMsgpack(value)).toString('hex');
    const cb = Buffer.from(encodeCbor(value)).toString('hex');
    assert.equal(mp, vector.msgpack, `${vector.id} msgpack bytes`);
    assert.equal(cb, vector.cbor, `${vector.id} cbor bytes`);

    // Sets decode back as plain arrays (they encode as sorted, deduped
    // arrays), so the round-trip comparison normalizes set -> array.
    const setsAsArrays = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(setsAsArrays);
      if (node !== null && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (record.t === 'set') return { t: 'array', v: setsAsArrays(record.v) };
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(record)) out[k] = setsAsArrays(v);
        return out;
      }
      return node;
    };
    const decodedMp = setsAsArrays(valueToTagged(decodeMsgpack(Buffer.from(vector.msgpack, 'hex'))));
    const decodedCb = setsAsArrays(valueToTagged(decodeCbor(Buffer.from(vector.cbor, 'hex'))));
    assert.deepEqual(decodedMp, setsAsArrays(vector.model), `${vector.id} msgpack round-trip`);
    assert.deepEqual(decodedCb, setsAsArrays(vector.model), `${vector.id} cbor round-trip`);
  });
}
