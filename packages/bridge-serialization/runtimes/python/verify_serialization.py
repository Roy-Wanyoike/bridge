#!/usr/bin/env python3
"""Cross-language serialization verifier (Python runtime).

Implements the Tagged-JSON model mapping from docs/SERIALIZATION.md: every
golden vector carries a `model` (the tagged representation of the value) plus
the canonical bytes for MessagePack and CBOR. This verifier asserts, per
vector and per format:

1. ENCODE — the model maps to this runtime's value and encodes to the exact
   bytes of the vector (byte identity with every other language).
2. DECODE — this runtime's decoder accepts those bytes and maps back to the
   tagged model (structural equality, so value identity is unambiguous:
   i64/u64 keep exact digits, bytes are base64, timestamps are RFC 3339).

Reject vectors additionally assert that bytes outside the Bridge value model
(NaN/±Infinity floats, bignum content under timestamp tag 1) never produce a
Bridge value — the decode or the model mapping must raise.

Timestamps are handled with proleptic-Gregorian integer arithmetic (Howard
Hinnant's civil-date algorithms) — never `datetime`, whose year range stops
at 9999 and whose microsecond precision would lose sub-µs nanos — so the full
int64-second range and 9-digit fractions parse and render exactly (#46).

Exits non-zero on any mismatch. Part of scripts/verify-serialization.sh.
"""
import base64
import json
import math
import re
import struct
import unittest
from pathlib import Path

import cbor2
import msgpack

VECTORS = Path(__file__).resolve().parent.parent.parent / "vectors" / "vectors.json"

# Vector ISO strings are UTC ("Z") RFC 3339 with optional fraction; years
# carry 4+ digits with an optional sign (expanded form for int64 extremes).
RFC3339 = re.compile(r"^(-?\d{4,})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$")

SECS_PER_DAY = 86_400


# ---------------------------------------------------------------------------
# Proleptic-Gregorian calendar arithmetic (Howard Hinnant's algorithms)
# ---------------------------------------------------------------------------


def days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a civil date — exact for any year."""
    yy = y - 1 if m <= 2 else y
    era = yy // 400  # Python // is floor division, matching Hinnant's intent
    yoe = yy - era * 400  # [0, 399]
    mp = (m + 9) % 12  # March = 0
    doy = (153 * mp + 2) // 5 + d - 1  # [0, 365]
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy  # [0, 146096]
    return era * 146_097 + doe - 719_468


def civil_from_days(z: int) -> tuple[int, int, int]:
    """Inverse of days_from_civil."""
    z += 719_468
    era = z // 146_097
    doe = z - era * 146_097  # [0, 146096]
    yoe = (doe - doe // 1460 + doe // 36_524 - doe // 146_096) // 365  # [0, 399]
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)  # [0, 365]
    mp = (5 * doy + 2) // 153  # [0, 11]
    d = doy - (153 * mp + 2) // 5 + 1  # [1, 31]
    m = mp + 3 if mp < 10 else mp - 9  # [1, 12]
    return (y + 1 if m <= 2 else y), m, d


def parse_iso(iso: str) -> tuple[int, int]:
    """RFC 3339 (UTC) -> exact (seconds, nanos). Arithmetic; no float ever."""
    m = RFC3339.match(iso)
    if not m:
        raise ValueError(f"invalid RFC 3339 timestamp: {iso}")
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hour, minute, second = int(m.group(4)), int(m.group(5)), int(m.group(6))
    frac = m.group(7) or ""
    nanos = int(frac.ljust(9, "0")) if frac else 0
    secs = (
        days_from_civil(year, month, day) * SECS_PER_DAY
        + hour * 3600
        + minute * 60
        + second
    )
    return secs, nanos


def render_iso(secs: int, nanos: int) -> str:
    """Exact (seconds, nanos) -> RFC 3339 (UTC); negative seconds normalize
    onto the pre-epoch day (epoch -0.5s renders as 1969-12-31T23:59:59.5Z)."""
    days = secs // SECS_PER_DAY  # floor
    sod = secs - days * SECS_PER_DAY  # [0, 86399]
    y, m, d = civil_from_days(days)
    # 4-digit years stay zero-padded; outside that, expanded/signed rendering
    # (mirrors the TypeScript reference toISO).
    year = f"{y:04d}" if 0 <= y <= 9999 else ("-" + f"{-y:04d}" if y < 0 else str(y))
    head = (
        f"{year}-{m:02d}-{d:02d}"
        f"T{sod // 3600:02d}:{(sod // 60) % 60:02d}:{sod % 60:02d}"
    )
    if nanos == 0:
        return head + "Z"
    return f"{head}.{nanos:09d}".rstrip("0") + "Z"


# ---------------------------------------------------------------------------
# Tagged model -> wire value
# ---------------------------------------------------------------------------


def model_to_value(node):
    kind = node["t"]
    if kind == "null":
        return None
    if kind == "bool":
        return bool(node["v"])
    if kind in ("i64", "u64"):
        return int(node["v"])
    if kind == "f64":
        return float(node["v"])
    if kind in ("str", "decimal", "uuid", "enum"):
        return node["v"]
    if kind == "bytes":
        return base64.b64decode(node["b64"])
    if kind == "timestamp":
        return {"__ts__": parse_iso(node["iso"])}
    if kind == "array":
        return [model_to_value(v) for v in node["v"]]
    if kind == "set":
        return [model_to_value(v) for v in node["v"]]
    if kind == "map":
        # The model lists keys in canonical (bytewise) order; Python dicts
        # preserve that order so encoders reproduce the wire bytes.
        return {k: model_to_value(v) for k, v in node["v"].items()}
    raise ValueError(f"unknown tagged type {kind}")


# ---------------------------------------------------------------------------
# Decoded wire value -> tagged model
# ---------------------------------------------------------------------------


def value_to_model(value):
    if value is None:
        return {"t": "null"}
    if isinstance(value, msgpack.Timestamp):
        return {"t": "timestamp", "iso": render_iso(value.seconds, value.nanoseconds)}
    if isinstance(value, cbor2.CBORTag):  # tag 1 epoch (semantic decoding off)
        if value.tag != 1:
            raise TypeError(f"unexpected CBOR tag {value.tag}")
        content = value.value
        if isinstance(content, bool) or not isinstance(content, (int, float)):
            raise TypeError(f"tag 1 content must be an epoch number, got {type(content)!r}")
        if isinstance(content, int):
            secs, nanos = content, 0  # integer epochs are exact
        else:
            if not math.isfinite(content):
                raise TypeError("tag 1 epoch must be finite (NaN/±Inf rejected)")
            floor = math.floor(content)
            secs, nanos = floor, round((content - floor) * 1e9)
            if nanos == 1_000_000_000:  # rounding carried over
                secs, nanos = secs + 1, 0
        return {"t": "timestamp", "iso": render_iso(secs, nanos)}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        # Sign decides the tag: Bridge canonical forms use u64 for >= 0.
        return {"t": "u64" if value >= 0 else "i64", "v": str(value)}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("non-finite float is not a Bridge value")
        if value == 0 and math.copysign(1.0, value) < 0:
            # Negative zero loses its sign as a JSON number — the tagged
            # model pins the decimal string form ("-0.0").
            return {"t": "f64", "v": "-0.0"}
        return {"t": "f64", "v": value}
    if isinstance(value, str):
        return {"t": "str", "v": value}
    if isinstance(value, (bytes, bytearray)):
        return {"t": "bytes", "b64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, list):
        return {"t": "array", "v": [value_to_model(v) for v in value]}
    if isinstance(value, dict):
        return {"t": "map", "v": {k: value_to_model(v) for k, v in value.items()}}
    raise TypeError(f"unexpected decoded type {type(value)!r}")


# ---------------------------------------------------------------------------
# Wire encoders that reproduce Bridge canonical bytes
# ---------------------------------------------------------------------------


def mpack_encode(value):
    if isinstance(value, dict) and "__ts__" in value:
        secs, nanos = value["__ts__"]
        # Canonical Bridge msgpack timestamp form: timestamp96 — ext type -1,
        # 12-byte payload, big-endian u32 nanos then i64 seconds. Emitted as a
        # raw head because msgpack-python's ExtType API rejects code -1.
        return b"\xc7\x0c\xff" + struct.pack(">Iq", nanos, secs)
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda s: s.encode("utf-8"))
        return _mp_map_head(len(keys)) + b"".join(
            msgpack.packb(k) + mpack_encode(value[k]) for k in keys
        )
    if isinstance(value, list):
        return _mp_array_head(len(value)) + b"".join(mpack_encode(v) for v in value)
    return msgpack.packb(value)


def _mp_map_head(n):
    if n < 16:
        return bytes([0x80 | n])
    if n < 0x1_0000:
        return b"\xde" + struct.pack(">H", n)
    return b"\xdf" + struct.pack(">I", n)


def _mp_array_head(n):
    if n < 16:
        return bytes([0x90 | n])
    if n < 0x1_0000:
        return b"\xdc" + struct.pack(">H", n)
    return b"\xdd" + struct.pack(">I", n)


def cbor_encode(value):
    if isinstance(value, dict) and "__ts__" in value:
        secs, nanos = value["__ts__"]
        if nanos == 0:
            # Whole seconds: integer epoch content (RFC 8949 §3.4.2 preferred
            # form) — exact for the full int64-second range, no float detour.
            return cbor2.dumps(cbor2.CBORTag(1, secs))
        # Fractional seconds: binary64 epoch (documented precision contract).
        return cbor2.dumps(cbor2.CBORTag(1, secs + nanos / 1_000_000_000))
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda s: s.encode("utf-8"))
        return _cb_head(5, len(keys)) + b"".join(
            cbor2.dumps(k) + cbor_encode(value[k]) for k in keys
        )
    if isinstance(value, list):
        return _cb_head(4, len(value)) + b"".join(cbor_encode(v) for v in value)
    return cbor2.dumps(value)


def _cb_head(major, n):
    m = major << 5
    if n < 24:
        return bytes([m | n])
    if n < 0x100:
        return bytes([m | 24, n])
    if n < 0x1_0000:
        return bytes([m | 25]) + struct.pack(">H", n)
    return bytes([m | 26]) + struct.pack(">I", n)


def cbor_decode(raw: bytes):
    """cbor2.loads with tag 1 kept as a raw CBORTag: cbor2's built-in epoch
    semantics route int/float contents through `datetime`, whose year range
    (1..9999) and microsecond precision cannot carry the Bridge model."""
    return cbor2.loads(raw, semantic_decoders={1: lambda content, _immutable: cbor2.CBORTag(1, content)})


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


class Verify(unittest.TestCase):
    def setUp(self):
        vectors_file = json.loads(VECTORS.read_text())
        self.vectors = vectors_file["vectors"]
        self.rejects = vectors_file.get("rejects", [])

    def check(self, vector):
        model = vector["model"]
        wire_value = model_to_value(model)
        for fmt in ("msgpack", "cbor"):
            raw = bytes.fromhex(vector[fmt])

            # 1. Byte identity: canonical encode of the model == vector bytes.
            encoded = mpack_encode(wire_value) if fmt == "msgpack" else cbor_encode(wire_value)
            self.assertEqual(
                encoded.hex(), vector[fmt], f"[{vector['id']}/{fmt}] encode != vector bytes"
            )

            # 2. Decode identity: the reference library reads those bytes back
            #    into exactly the tagged model.
            decoded = value_to_model(
                msgpack.unpackb(raw, raw=False) if fmt == "msgpack" else cbor_decode(raw)
            )
            # Sets are plain arrays on the wire: normalize both sides before
            # comparing (the encode check above still proves sorted dedup).
            self.assertEqual(
                _sets_to_arrays(decoded),
                _sets_to_arrays(model),
                f"[{vector['id']}/{fmt}] decoded != tagged model",
            )

    def test_all_vectors(self):
        for vector in self.vectors:
            with self.subTest(vector=vector["id"]):
                self.check(vector)

    def test_reject_vectors(self):
        # Decode (or the model mapping) must raise: these bytes carry values
        # outside the Bridge model — NaN/±Infinity floats, bignum content
        # under timestamp tag 1. Either stage failing counts as a rejection.
        for reject in self.rejects:
            with self.subTest(reject=reject["id"]):
                raw = bytes.fromhex(reject["hex"])
                with self.assertRaises(Exception):
                    decoded = (
                        msgpack.unpackb(raw, raw=False)
                        if reject["format"] == "msgpack"
                        else cbor_decode(raw)
                    )
                    value_to_model(decoded)


def _sets_to_arrays(node):
    if isinstance(node, dict):
        if node.get("t") == "set":
            return {"t": "array", "v": [_sets_to_arrays(v) for v in node["v"]]}
        return {k: _sets_to_arrays(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_sets_to_arrays(v) for v in node]
    return node


if __name__ == "__main__":
    unittest.main(verbosity=1)
