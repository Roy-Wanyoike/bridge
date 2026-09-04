# Serialization: cross-language round-trip specification

Bridge values must survive the trip between languages byte-for-byte. This
document pins the wire encoding for every Bridge primitive and collection;
`@bridge/serialization` implements it in TypeScript, and three independent
reference runtimes — Go, Rust, Python — verify the same **executable golden
vectors** ([`vectors/vectors.json`](../packages/bridge-serialization/vectors/vectors.json))
on every run of `scripts/verify-serialization.sh`.

## The golden vectors

Each of the 40 vectors carries:

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `id`       | Stable name (e.g. `int_beyond_2p53`, `map_unicode_keys`).             |
| `model`    | The value in **tagged representation** (below) — no ambiguities.      |
| `json`     | The canonical JSON text (integers as exact digits).                   |
| `msgpack`  | The exact MessagePack bytes, hex.                                     |
| `cbor`     | The exact CBOR bytes, hex.                                            |

Every runtime must (1) encode the model to those exact bytes and (2) decode
those bytes back to the model. 40 vectors × 2 formats × 2 directions = 160
checks per runtime, all byte-exact.

## Tagged representation (the model)

JSON cannot distinguish i64 from f64, bytes from strings, or a timestamp
from a string — so the vectors carry an explicit tagged form:

| Tagged                        | Bridge value                  |
| ----------------------------- | ----------------------------- |
| `{"t":"null"}`                | null                          |
| `{"t":"bool","v":true}`       | boolean                       |
| `{"t":"i64","v":"-42"}`       | signed 64-bit integer (digits)|
| `{"t":"u64","v":"42"}`        | unsigned 64-bit integer       |
| `{"t":"f64","v":3.14}`        | binary64 float                |
| `{"t":"str","v":"hello"}`     | string                        |
| `{"t":"decimal","v":"19.99"}` | decimal (textual, never float)|
| `{"t":"uuid","v":"550e8400-…"}`| uuid (textual)               |
| `{"t":"enum","v":"high"}`     | enum variant (never ordinal)  |
| `{"t":"bytes","b64":"AAEC/w=="}` | binary (base64)            |
| `{"t":"timestamp","iso":"2024-06-04T15:40:00Z"}` | timestamp  |
| `{"t":"array","v":[…]}`       | list                          |
| `{"t":"set","v":[…]}`         | set (sorted + deduped)        |
| `{"t":"map","v":{"k":…}}`     | map (string keys)             |

The tagged model is also the integration seam for generated code: language
generators map Bridge types onto these same semantics.

## Canonical wire rules (both formats)

1. **Integers** — i64/u64 always encoded as integers, never floats. The
   canonical range is ±2^63; values beyond 2^53 (e.g. `9007199254740993`)
   are covered by vectors and MUST NOT pass through `double`.
2. **Floats** — always binary64 (`0xcb` msgpack / `0xfb` cbor) on encode;
   decoders widen half/single forms leniently (interoperability).
3. **Map keys** — strings only, sorted by **UTF-8 byte order** (plain
   bytewise — deliberately NOT RFC 8949 §4.2 length-first; one order shared
   by all formats and languages).
4. **Undefined/absent** — map entries whose value is `undefined` are dropped
   (absent optional). Explicit `null` is preserved.
5. **Sets** — encoded as sorted, deduped arrays. Decoders return a plain
   array; set-typed fields re-apply sorting/dedup at the model layer.
6. **Decimals/uuids/enums** — textual; never parsed to floats or ordinals.

### MessagePack specifics

- Canonical timestamp: **timestamp96** — `c7 0c ff` + 12-byte payload,
  big-endian `u32 nanos` then `i64 seconds` (verified byte-compatible with
  Python `msgpack` and Go `vmihailenco/msgpack/v5` decoders). Decoders must
  also accept timestamp 32/64 forms.
- Bytes: `bin` family (`c4`–`c6`), never str.
- Minimal-length encodings for ints and str/bin/array/map heads.

### CBOR specifics

- Canonical timestamp: **tag 1** with binary64 epoch-seconds content
  (`c1 fb …`). Decoders must also accept integer contents (RFC 8949 §3.4.2
  preferred form).
- Minimal-length arguments everywhere (RFC 8949 preferred serialization).
- Only definite lengths; tags other than 1 are decode errors.

## Verification matrix

`scripts/verify-serialization.sh` runs, per language:

| Runtime | Encode byte-identity | Decode via reference library            |
| ------- | -------------------- | --------------------------------------- |
| TypeScript | `@bridge/serialization` codecs | same package + 80 node:test assertions |
| Go     | hand-rolled canonical writer (`runtimes/go/verify.go`) | `vmihailenco/msgpack/v5` + `fxamacker/cbor/v2` |
| Rust   | hand-rolled canonical writer (`runtimes/rust/src/main.rs`) | `rmpv` + `ciborium` |
| Python | canonical writer via stdlib `struct` + libs | `msgpack` + `cbor2` |

All 160 checks pass in all four languages: the same model produces the same
bytes everywhere, and every reference decoder reads Bridge bytes back to the
same value. This is the guarantee generated serializers build on.

## Adding a vector

1. Add the value to `packages/bridge-serialization/scripts/generate-vectors.mjs`.
2. `node scripts/generate-vectors.mjs` — regenerates `vectors/vectors.json`
   deterministically.
3. `npm test --workspace @bridge/serialization` — the TS vector suite covers it.
4. Run `scripts/verify-serialization.sh` — the Go/Rust/Python runtimes cover it.
