//! Cross-language serialization verifier (Rust runtime).
//!
//! Implements the Tagged-JSON model mapping from docs/SERIALIZATION.md:
//! every golden vector carries a `model` (tagged representation) plus the
//! canonical bytes for MessagePack and CBOR. This verifier asserts, per
//! vector and per format:
//!
//! 1. ENCODE — the model maps onto this runtime's generic value tree
//!    (rmpv::Value / ciborium::Value) and encodes to the exact bytes of the
//!    vector (byte identity with every other language).
//! 2. DECODE — this runtime's decoder accepts those bytes and maps back to
//!    the tagged model (structural equality over exact ints, base64 bytes,
//!    RFC 3339 timestamps, sets-as-arrays, bytewise-sorted maps).
//!
//! Exit code 0 = all vectors pass. Run via scripts/verify-serialization.sh.

use serde_json::Value as Json;
use std::process::exit;


/// Tagged model node (parsed from the vector's `model` field).
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    Str(String),
    Bytes(Vec<u8>),
    Timestamp(i64, u32), // seconds, nanos
    Array(Vec<Node>),
    Set(Vec<Node>),
    Map(Vec<(String, Node)>), // canonical (bytewise-sorted) order
}

fn parse_model(json: &Json) -> Result<Node, String> {
    let t = json
        .get("t")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "tagged node missing t".to_string())?
        .to_string();
    Ok(match t.as_str() {
        "null" => Node::Null,
        "bool" => Node::Bool(json["v"].as_bool().ok_or("bool v")?),
        "i64" => Node::I64(
            json["v"]
                .as_str()
                .ok_or("i64 v")?
                .parse::<i64>()
                .map_err(|e| e.to_string())?,
        ),
        "u64" => Node::U64(
            json["v"]
                .as_str()
                .ok_or("u64 v")?
                .parse::<u64>()
                .map_err(|e| e.to_string())?,
        ),
        "f64" => {
            // Numeric JSON form normally; a decimal string (e.g. "-0.0")
            // carries values JSON numbers cannot round-trip exactly.
            let v = if let Some(n) = json["v"].as_f64() {
                n
            } else if let Some(s) = json["v"].as_str() {
                s.parse::<f64>().map_err(|e| format!("f64 v: {e}"))?
            } else {
                return Err("f64 v".to_string());
            };
            if !v.is_finite() {
                return Err("f64 v must be finite".to_string());
            }
            Node::F64(v)
        }
        "str" | "decimal" | "uuid" | "enum" => Node::Str(
            json["v"]
                .as_str()
                .ok_or("str v")?
                .to_string(),
        ),
        "bytes" => Node::Bytes(decode_b64(json["b64"].as_str().ok_or("b64")?)),
        "timestamp" => {
            let iso = json["iso"].as_str().ok_or("iso")?;
            parse_iso(iso)?
        }
        "array" | "set" => {
            let items = json["v"].as_array().ok_or("array v")?;
            let nodes = items.iter().map(parse_model).collect::<Result<Vec<_>, _>>()?;
            if t == "set" {
                Node::Set(nodes)
            } else {
                Node::Array(nodes)
            }
        }
        "map" => {
            let obj = json["v"].as_object().ok_or("map v")?;
            let mut pairs: Vec<(String, Node)> = obj
                .iter()
                .map(|(k, v)| parse_model(v).map(|node| (k.clone(), node)))
                .collect::<Result<Vec<_>, _>>()?;
            pairs.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            Node::Map(pairs)
        }
        other => return Err(format!("unknown tagged type {other}")),
    })
}

fn decode_b64(s: &str) -> Vec<u8> {
    // Small std-only base64 (standard alphabet, padding) — avoids a dep.
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            acc |= val(c).unwrap_or(0) << (18 - 6 * i);
        }
        let n = if chunk.len() == 4 { 3 } else { chunk.len() - 1 };
        for i in 0..n {
            out.push(((acc >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    out
}

fn parse_iso(iso: &str) -> Result<Node, String> {
    // Minimal RFC 3339 UTC parser for the vector shapes:
    // [sign]YYYY…-MM-DDTHH:MM:SS[.frac]Z — years beyond four digits
    // (expanded form) and negative years carry the int64-second extremes.
    let (neg_year, body) = match iso.strip_prefix('-') {
        Some(rest) => (1i64, rest),
        None => (0i64, iso),
    };
    let (date, rest) = body
        .split_once('T')
        .ok_or_else(|| format!("bad iso {iso}"))?;
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 {
        return Err(format!("bad iso date {iso}"));
    }
    let y: i64 = d[0].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    let y = if neg_year == 1 { -y } else { y };
    let mo: i64 = d[1].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    let da: i64 = d[2].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    let (time, _tz) = rest
        .split_once('Z')
        .or_else(|| rest.split_once('+'))
        .ok_or_else(|| format!("bad iso time {iso}"))?;
    let (hms, frac) = match time.split_once('.') {
        Some((h, f)) => (h, f),
        None => (time, ""),
    };
    let t: Vec<&str> = hms.split(':').collect();
    if t.len() != 3 {
        return Err(format!("bad iso time {iso}"));
    }
    let hh: i64 = t[0].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    let mi: i64 = t[1].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    let ss: i64 = t[2].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
    // Days since epoch via civil-date algorithm (Howard Hinnant's).
    let days = days_from_civil(y, mo, da);
    // i128 math: days * 86_400 overflows i64 exactly at the int64-second
    // extremes the vectors cover.
    let secs: i128 = days as i128 * 86_400 + hh as i128 * 3600 + mi as i128 * 60 + ss as i128;
    if secs < i64::MIN as i128 || secs > i64::MAX as i128 {
        return Err(format!("iso seconds out of int64 range: {iso}"));
    }
    let nanos: u32 = if frac.is_empty() {
        0
    } else {
        let padded = format!("{:0<9}", &frac[..frac.len().min(9)]);
        padded.parse().map_err(|e: std::num::ParseIntError| e.to_string())?
    };
    Ok(Node::Timestamp(secs as i64, nanos))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// Model -> generic wire value trees
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Decoded wire value -> tagged model
// ---------------------------------------------------------------------------

fn rmpv_to_model(value: &rmpv::Value) -> Result<Node, String> {
    Ok(match value {
        rmpv::Value::Nil => Node::Null,
        rmpv::Value::Boolean(b) => Node::Bool(*b),
        rmpv::Value::Integer(i) => {
            if let Some(u) = i.as_u64() {
                Node::U64(u)
            } else if let Some(s) = i.as_i64() {
                Node::I64(s)
            } else {
                return Err("integer out of range".into());
            }
        }
        rmpv::Value::F32(f) => {
            let v = *f as f64;
            if !v.is_finite() {
                return Err("non-finite float is not a Bridge value".into());
            }
            Node::F64(v)
        }
        rmpv::Value::F64(f) => {
            if !f.is_finite() {
                return Err("non-finite float is not a Bridge value".into());
            }
            Node::F64(*f)
        }
        rmpv::Value::String(s) => Node::Str(
            s.as_str()
                .ok_or("invalid utf8 string")?
                .to_string(),
        ),
        rmpv::Value::Binary(b) => Node::Bytes(b.clone()),
        rmpv::Value::Ext(code, data) => {
            if *code != -1 {
                return Err(format!("unexpected ext type {code}"));
            }
            match data.len() {
                4 => {
                    let secs = i32::from_be_bytes(data[..4].try_into().unwrap());
                    Node::Timestamp(secs as i64, 0)
                }
                8 => {
                    let packed = u64::from_be_bytes(data[..8].try_into().unwrap());
                    Node::Timestamp((packed & ((1 << 34) - 1)) as i64, (packed >> 34) as u32)
                }
                12 => {
                    let nanos = u32::from_be_bytes(data[..4].try_into().unwrap());
                    let secs = i64::from_be_bytes(data[4..].try_into().unwrap());
                    Node::Timestamp(secs, nanos)
                }
                n => return Err(format!("bad timestamp payload length {n}")),
            }
        }
        rmpv::Value::Array(items) => Node::Array(
            items
                .iter()
                .map(rmpv_to_model)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        rmpv::Value::Map(pairs) => {
            let mut out = Vec::new();
            for (k, v) in pairs {
                let key = match k {
                    rmpv::Value::String(s) => s
                        .as_str()
                        .ok_or("invalid utf8 key")?
                        .to_string(),
                    other => return Err(format!("non-string key {other:?}")),
                };
                out.push((key, rmpv_to_model(v)?));
            }
            Node::Map(out)
        }
        other => return Err(format!("unexpected rmpv value {other:?}")),
    })
}

fn ciborium_to_model(value: &ciborium::value::Value) -> Result<Node, String> {
    use ciborium::value::Value as C;
    Ok(match value {
        C::Null => Node::Null,
        C::Bool(b) => Node::Bool(*b),
        C::Integer(i) => {
            let n: i128 = (*i).into();
            if n >= 0 {
                Node::U64(n as u64)
            } else {
                Node::I64(n as i64)
            }
        }
        C::Float(f) => {
            if !f.is_finite() {
                return Err("non-finite float is not a Bridge value".into());
            }
            Node::F64(*f)
        }
        C::Text(s) => Node::Str(s.clone()),
        C::Bytes(b) => Node::Bytes(b.clone()),
        C::Tag(1, content) => {
            // Bridge epoch mapping: integer contents are exact (seconds, 0);
            // float contents split with FLOOR semantics so pre-1970
            // fractional epochs decode to the canonical (seconds, nanos)
            // pair (epoch -0.5 → -1s + 500000000ns), symmetric with the
            // canonical writer below.
            match **content {
                C::Integer(i) => {
                    let n: i128 = i.into();
                    if n < i64::MIN as i128 || n > i64::MAX as i128 {
                        return Err(format!("tag 1 integer epoch out of int64 range: {n}"));
                    }
                    Node::Timestamp(n as i64, 0)
                }
                C::Float(f) => {
                    if !f.is_finite() {
                        return Err("tag 1 epoch must be finite".into());
                    }
                    let floor = f.floor();
                    let mut secs = floor as i128;
                    let mut nanos = ((f - floor) * 1e9).round() as i128;
                    if nanos >= 1_000_000_000 {
                        secs += 1;
                        nanos = 0;
                    }
                    if secs < i64::MIN as i128 || secs > i64::MAX as i128 {
                        return Err(format!("tag 1 epoch out of int64 range: {secs}"));
                    }
                    Node::Timestamp(secs as i64, nanos as u32)
                }
                ref other => return Err(format!("tag 1 content {other:?}")),
            }
        }
        C::Array(items) => Node::Array(
            items
                .iter()
                .map(ciborium_to_model)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        C::Map(pairs) => {
            let mut out = Vec::new();
            for (k, v) in pairs {
                let key = match k {
                    C::Text(s) => s.clone(),
                    other => return Err(format!("non-string key {other:?}")),
                };
                out.push((key, ciborium_to_model(v)?));
            }
            Node::Map(out)
        }
        C::Tag(n, _) => return Err(format!("unexpected cbor tag {n}")),
        other => return Err(format!("unexpected cbor value {other:?}")),
    })
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

fn main() {
    let path = std::env::args().nth(1).expect("usage: verify <vectors.json>");
    let raw = std::fs::read_to_string(&path).expect("read vectors");
    let file: Json = serde_json::from_str(&raw).expect("parse vectors");
    let vectors = file["vectors"].as_array().expect("vectors array");

    let mut failures = 0;
    let mut checks = 0;
    for vector in vectors {
        let id = vector["id"].as_str().unwrap_or("?");
        let model = match parse_model(&vector["model"]) {
            Ok(m) => m,
            Err(e) => {
                println!("FAIL [{id}/model]: {e}");
                failures += 1;
                continue;
            }
        };
        for (format, hex_field) in [("msgpack", "msgpack"), ("cbor", "cbor")] {
            let bytes = match decode_hex(vector[hex_field].as_str().unwrap_or("")) {
                Ok(b) => b,
                Err(e) => {
                    println!("FAIL [{id}/{format}]: bad hex: {e}");
                    failures += 1;
                    continue;
                }
            };
            // 1. ENCODE: model -> canonical wire writer -> bytes == vector
            // bytes. The hand-rolled writer pins the Bridge canonical forms
            // (minimal int args, bytewise-sorted map keys, always-f64 floats,
            // timestamp96 / tag 1 integer-or-binary64 epoch) exactly like the Go runtime.
            let encoded: Vec<u8> = if format == "msgpack" {
                encode_msgpack(&model)
            } else {
                encode_cbor(&model)
            };
            checks += 1;
            if encoded != bytes {
                println!(
                    "FAIL [{id}/{format}]: encode mismatch\n  want {}\n   got {}",
                    hex(&bytes),
                    hex(&encoded)
                );
                failures += 1;
                continue;
            }
            // 2. DECODE: bytes -> generic value tree -> tagged model.
            let decoded = if format == "msgpack" {
                rmpv::decode::read_value(&mut std::io::Cursor::new(&bytes))
                    .map_err(|e| e.to_string())
                    .and_then(|v| rmpv_to_model(&v))
            } else {
                ciborium::de::from_reader::<ciborium::value::Value, _>(std::io::Cursor::new(&bytes))
                    .map_err(|e| e.to_string())
                    .and_then(|v| ciborium_to_model(&v))
            };
            checks += 1;
            match decoded {
                Ok(back) if normalize(&back) == normalize(&model) => {}
                Ok(back) => {
                    println!(
                        "FAIL [{id}/{format}]: decoded model != vector model\n  want {model:?}\n   got {back:?}"
                    );
                    failures += 1;
                }
                Err(e) => {
                    println!("FAIL [{id}/{format}]: decode: {e}");
                    failures += 1;
                }
            }
        }
        println!("  {id:<24} ok");
    }
    let (reject_checks, reject_failures) = run_rejects(&file);
    checks += reject_checks;
    failures += reject_failures;
    if failures > 0 {
        println!("\n{failures} failure(s) ({checks} checks)");
        exit(1);
    }
    println!(
        "\nrust runtime: {} vectors + {} rejects, both formats, {checks} checks PASS",
        vectors.len(),
        file["rejects"].as_array().map(|r| r.len()).unwrap_or(0),
    );
}

/// Reject vectors: decode must fail (or the decoded value must fall outside
/// the Bridge value model and the model mapper must throw). Returns
/// (checks, failures).
fn run_rejects(file: &Json) -> (usize, usize) {
    let mut checks = 0;
    let mut failures = 0;
    if let Some(rejects) = file["rejects"].as_array() {
        for reject in rejects {
            let id = reject["id"].as_str().unwrap_or("?");
            let format = reject["format"].as_str().unwrap_or("?");
            let bytes = match decode_hex(reject["hex"].as_str().unwrap_or("")) {
                Ok(b) => b,
                Err(e) => {
                    println!("FAIL [{id}/{format}]: bad hex: {e}");
                    failures += 1;
                    continue;
                }
            };
            checks += 1;
            let outcome: Result<Node, String> = if format == "msgpack" {
                rmpv::decode::read_value(&mut std::io::Cursor::new(&bytes))
                    .map_err(|e| e.to_string())
                    .and_then(|v| rmpv_to_model(&v))
            } else {
                ciborium::de::from_reader::<ciborium::value::Value, _>(std::io::Cursor::new(&bytes))
                    .map_err(|e| e.to_string())
                    .and_then(|v| ciborium_to_model(&v))
            };
            if outcome.is_ok() {
                println!("FAIL [{id}/{format}]: decoded to a Bridge value, expected rejection");
                failures += 1;
            }
            println!("  {id:<24} rejected");
        }
    }
    (checks, failures)
}

/// Sets decode back as plain arrays: normalize both sides for equality.
fn normalize(node: &Node) -> Node {
    match node {
        Node::Set(items) => Node::Array(items.iter().map(normalize).collect()),
        Node::Array(items) => Node::Array(items.iter().map(normalize).collect()),
        Node::Map(pairs) => Node::Map(
            pairs
                .iter()
                .map(|(k, v)| (k.clone(), normalize(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("bad hex char {}", c as char)),
        }
    }
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    Ok((0..b.len())
        .step_by(2)
        .map(|i| Ok(val(b[i])? << 4 | val(b[i + 1])?))
        .collect::<Result<Vec<u8>, String>>()?)
}

// ---------------------------------------------------------------------------
// Canonical wire writers (mirror the Go runtime byte-for-byte)
// ---------------------------------------------------------------------------

fn write_head(out: &mut Vec<u8>, major: u8, arg: u64, cbor_mode: bool) {
    let m = if cbor_mode { major << 5 } else { 0 }; // cbor uses major<<5; msgpack handled below
    let _ = m;
    match arg {
        0..=23 => {
            if cbor_mode {
                out.push((major << 5) | arg as u8);
            } else {
                out.push(msgpack_head(major, arg as u32));
            }
        }
        24..=0xff => {
            if cbor_mode {
                out.push((major << 5) | 24);
            } else {
                out.push(msgpack_head_ext(major, 8));
            }
            out.push(arg as u8);
        }
        0x100..=0xffff => {
            if cbor_mode {
                out.push((major << 5) | 25);
            } else {
                out.push(msgpack_head_ext(major, 9));
            }
            out.extend_from_slice(&(arg as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            if cbor_mode {
                out.push((major << 5) | 26);
            } else {
                out.push(msgpack_head_ext(major, 10));
            }
            out.extend_from_slice(&(arg as u32).to_be_bytes());
        }
        _ => {
            if cbor_mode {
                out.push((major << 5) | 27);
            } else {
                out.push(msgpack_head_ext(major, 11));
            }
            out.extend_from_slice(&arg.to_be_bytes());
        }
    }
}

/// MessagePack keeps type bits in the leading byte rather than a major prefix.
/// For the container/string families the head byte is `prefix | len`, so we
/// emit from the base constant; for the 1..4-byte extended forms the base
/// constants are cc..cf (uint), d0..d3 (int), d9..db (str), c4..c6 (bin),
/// 90/dc/dd (array), 80/de/df (map).
fn msgpack_head(major: u8, arg: u32) -> u8 {
    match major {
        2 => 0x40, // never hit (bytes handled separately)
        3 => 0xa0 | arg as u8,
        4 => 0x90 | arg as u8,
        5 => 0x80 | arg as u8,
        _ => unreachable!("msgpack head for major {major}"),
    }
}

fn msgpack_head_ext(major: u8, extra: u8) -> u8 {
    match (major, extra) {
        (3, 8) => 0xd9,
        (3, 9) => 0xda,
        (3, 10 | 11) => 0xdb,
        _ => 0xc0,
    }
}

fn push_be_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn encode_msgpack(node: &Node) -> Vec<u8> {
    let mut out = Vec::new();
    encode_msgpack_into(&mut out, node);
    out
}

fn encode_msgpack_into(out: &mut Vec<u8>, node: &Node) {
    match node {
        Node::Null => out.push(0xc0),
        Node::Bool(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
        Node::I64(v) => match *v {
            -32..=127 => out.push(*v as i8 as u8),
            -128..=127 => {
                out.push(0xd0);
                out.push(*v as i8 as u8);
            }
            -32768..=32767 => {
                out.push(0xd1);
                out.extend_from_slice(&(*v as i16).to_be_bytes());
            }
            -2_147_483_648..=2_147_483_647 => {
                out.push(0xd2);
                out.extend_from_slice(&(*v as i32).to_be_bytes());
            }
            _ => {
                out.push(0xd3);
                out.extend_from_slice(&v.to_be_bytes());
            }
        },
        Node::U64(v) => match *v {
            0..=0x7f => out.push(*v as u8),
            0x80..=0xff => {
                out.push(0xcc);
                out.push(*v as u8);
            }
            0x100..=0xffff => {
                out.push(0xcd);
                out.extend_from_slice(&(*v as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                out.push(0xce);
                out.extend_from_slice(&(*v as u32).to_be_bytes());
            }
            _ => {
                out.push(0xcf);
                out.extend_from_slice(&v.to_be_bytes());
            }
        },
        Node::F64(f) => {
            out.push(0xcb);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        Node::Str(s) => {
            let len = s.len();
            match len {
                0..=31 => out.push(0xa0 | len as u8),
                0x20..=0xff => {
                    out.push(0xd9);
                    out.push(len as u8);
                }
                0x100..=0xffff => {
                    out.push(0xda);
                    out.extend_from_slice(&(len as u16).to_be_bytes());
                }
                _ => {
                    out.push(0xdb);
                    out.extend_from_slice(&(len as u32).to_be_bytes());
                }
            }
            out.extend_from_slice(s.as_bytes());
        }
        Node::Bytes(b) => {
            let len = b.len();
            match len {
                0..=0xff => {
                    out.push(0xc4);
                    out.push(len as u8);
                }
                0x100..=0xffff => {
                    out.push(0xc5);
                    out.extend_from_slice(&(len as u16).to_be_bytes());
                }
                _ => {
                    out.push(0xc6);
                    out.extend_from_slice(&(len as u32).to_be_bytes());
                }
            }
            out.extend_from_slice(b);
        }
        Node::Timestamp(secs, nanos) => {
            out.extend_from_slice(&[0xc7, 12, 0xff]);
            out.extend_from_slice(&nanos.to_be_bytes());
            out.extend_from_slice(&secs.to_be_bytes());
        }
        Node::Array(items) | Node::Set(items) => {
            let len = items.len();
            match len {
                0..=15 => out.push(0x90 | len as u8),
                0x100..=0xffff => {
                    out.push(0xdc);
                    out.extend_from_slice(&(len as u16).to_be_bytes());
                }
                _ => {
                    out.push(0xdd);
                    out.extend_from_slice(&(len as u32).to_be_bytes());
                }
            }
            for item in items {
                encode_msgpack_into(out, item);
            }
        }
        Node::Map(pairs) => {
            let len = pairs.len();
            match len {
                0..=15 => out.push(0x80 | len as u8),
                0x100..=0xffff => {
                    out.push(0xde);
                    out.extend_from_slice(&(len as u16).to_be_bytes());
                }
                _ => {
                    out.push(0xdf);
                    out.extend_from_slice(&(len as u32).to_be_bytes());
                }
            }
            for (k, v) in pairs {
                encode_msgpack_into(out, &Node::Str(k.clone()));
                encode_msgpack_into(out, v);
            }
        }
    }
}

fn encode_cbor(node: &Node) -> Vec<u8> {
    let mut out = Vec::new();
    encode_cbor_into(&mut out, node);
    out
}

fn encode_cbor_into(out: &mut Vec<u8>, node: &Node) {
    match node {
        Node::Null => out.push(0xf6),
        Node::Bool(b) => out.push(if *b { 0xf5 } else { 0xf4 }),
        Node::I64(v) => {
            let arg = (-1 - *v) as u64; // major 1: -1 - n
            cbor_head(out, 1, arg);
        }
        Node::U64(v) => cbor_head(out, 0, *v),
        Node::F64(f) => {
            out.push(0xfb);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        Node::Str(s) => {
            cbor_head(out, 3, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Node::Bytes(b) => {
            cbor_head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
        Node::Timestamp(secs, nanos) => {
            out.push(0xc1); // tag 1
            if *nanos == 0 {
                // Whole seconds: integer epoch content (RFC 8949 §3.4.2
                // preferred form) — exact for the full int64 range.
                if *secs >= 0 {
                    cbor_head(out, 0, *secs as u64);
                } else {
                    cbor_head(out, 1, (-1 - *secs) as u64);
                }
                return;
            }
            // Fractional seconds: binary64 epoch (precision contract in
            // docs/SERIALIZATION.md).
            out.push(0xfb); // binary64 epoch seconds
            let epoch = *secs as f64 + *nanos as f64 / 1e9;
            out.extend_from_slice(&epoch.to_bits().to_be_bytes());
        }
        Node::Array(items) | Node::Set(items) => {
            cbor_head(out, 4, items.len() as u64);
            for item in items {
                encode_cbor_into(out, item);
            }
        }
        Node::Map(pairs) => {
            cbor_head(out, 5, pairs.len() as u64);
            for (k, v) in pairs {
                cbor_head(out, 3, k.len() as u64);
                out.extend_from_slice(k.as_bytes());
                encode_cbor_into(out, v);
            }
        }
    }
}

fn cbor_head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let m = major << 5;
    match arg {
        0..=23 => out.push(m | arg as u8),
        24..=0xff => {
            out.push(m | 24);
            out.push(arg as u8);
        }
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend_from_slice(&(arg as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(m | 26);
            out.extend_from_slice(&(arg as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&arg.to_be_bytes());
        }
    }
}
