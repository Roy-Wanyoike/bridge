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

Exits non-zero on any mismatch. Part of scripts/verify-serialization.sh.
"""
import base64
import datetime as _dt
import json
import re
import struct
import unittest
from pathlib import Path

import cbor2
import msgpack

VECTORS = Path(__file__).resolve().parent.parent.parent / "vectors" / "vectors.json"

RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")

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
        dt = _dt.datetime.fromisoformat(node["iso"].replace("Z", "+00:00"))
        # Python datetime is microsecond-precise; the committed vectors only
        # use nanosecond values that are multiples of 1000.
        return {"__ts__": (int(dt.timestamp()), dt.microsecond * 1000)}
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
        return {"t": "timestamp", "iso": _iso(value.seconds, value.nanoseconds)}
    if isinstance(value, _dt.datetime):  # cbor2 decodes tag 1 semantically
        return {"t": "timestamp", "iso": _iso(int(value.timestamp()), value.microsecond * 1000)}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        # Sign decides the tag: Bridge canonical forms use u64 for >= 0.
        return {"t": "u64" if value >= 0 else "i64", "v": str(value)}
    if isinstance(value, float):
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


def _iso(secs, nanos):
    if nanos == 0:
        return _dt.datetime.fromtimestamp(secs, tz=_dt.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    dt = _dt.datetime.fromtimestamp(secs, tz=_dt.timezone.utc)
    frac = f"{nanos / 1_000_000_000:.9f}".split(".")[1].rstrip("0")
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + "." + frac + "Z"


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


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


class Verify(unittest.TestCase):
    def setUp(self):
        self.vectors = json.loads(VECTORS.read_text())["vectors"]

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
            if fmt == "msgpack":
                decoded = value_to_model(msgpack.unpackb(raw, raw=False))
            else:
                decoded = value_to_model(cbor2.loads(raw))
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
