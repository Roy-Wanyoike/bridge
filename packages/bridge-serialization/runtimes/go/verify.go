// Cross-language serialization verifier (Go runtime).
//
// Implements the Tagged-JSON model mapping from docs/SERIALIZATION.md:
// every golden vector carries a `model` (tagged representation) plus the
// canonical bytes for MessagePack and CBOR. This verifier asserts, per
// vector and per format:
//
//  1. ENCODE — the model encodes through the hand-rolled canonical writer
//     below to the exact bytes of the vector (byte identity with every
//     other language; the wire spec pins minimal int encodings, bytewise
//     sorted map keys, timestamp96 ext and tag 1 + binary64 epochs).
//  2. DECODE — vmihailenco/msgpack/v5 and fxamacker/cbor/v2 accept the
//     Bridge canonical bytes and the decoded value maps back to the exact
//     tagged model (u64/i64 exact via digits, bytes via base64, timestamps
//     via (seconds, nanos)).
//
// Exit code 0 = all vectors pass. Run via scripts/verify-serialization.sh.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/vmihailenco/msgpack/v5"
)

// ---------------------------------------------------------------------------
// Tagged model
// ---------------------------------------------------------------------------

type Node struct {
	T     string
	Bool  bool
	Str   string
	F64   float64
	Arr   []Node
	Map   []Pair // sorted bytewise by key at parse time
	B64   string
	Secs  int64
	Nanos int32
}

type Pair struct {
	Key string
	Val Node
}

// UnmarshalJSON parses the polymorphic tagged node; V is re-dispatched on T.
func (n *Node) UnmarshalJSON(data []byte) error {
	var raw struct {
		T   string          `json:"t"`
		V   json.RawMessage `json:"v"`
		B64 string          `json:"b64"`
		ISO string          `json:"iso"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	n.T = raw.T
	n.B64 = raw.B64
	switch n.T {
	case "null":
	case "bool":
		return json.Unmarshal(raw.V, &n.Bool)
	case "i64":
		if err := json.Unmarshal(raw.V, &n.Str); err != nil {
			return err
		}
		v, err := strconv.ParseInt(n.Str, 10, 64)
		if err != nil {
			return err
		}
		n.Secs, n.Nanos = v, 0
	case "u64":
		if err := json.Unmarshal(raw.V, &n.Str); err != nil {
			return err
		}
		v, err := strconv.ParseUint(n.Str, 10, 64)
		if err != nil {
			return err
		}
		n.Secs, n.Nanos = int64(v), 1
	case "f64":
		return json.Unmarshal(raw.V, &n.F64)
	case "str", "decimal", "uuid", "enum":
		return json.Unmarshal(raw.V, &n.Str)
	case "bytes":
		rawBytes, err := base64.StdEncoding.DecodeString(n.B64)
		if err != nil {
			return err
		}
		n.Nanos = -1
		n.Arr = bytesToNodes(rawBytes)
	case "timestamp":
		t, err := time.Parse(time.RFC3339Nano, strings.Replace(raw.ISO, "Z", "+00:00", 1))
		if err != nil {
			return err
		}
		n.Secs, n.Nanos = t.Unix(), int32(t.Nanosecond())
	case "array", "set":
		var inner []Node
		if err := json.Unmarshal(raw.V, &inner); err != nil {
			return err
		}
		n.Arr = inner
	case "map":
		var inner map[string]Node
		if err := json.Unmarshal(raw.V, &inner); err != nil {
			return err
		}
		keys := make([]string, 0, len(inner))
		for k := range inner {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		n.Map = make([]Pair, 0, len(keys))
		for _, k := range keys {
			n.Map = append(n.Map, Pair{Key: k, Val: inner[k]})
		}
	default:
		return fmt.Errorf("unknown tagged type %q", n.T)
	}
	return nil
}

func bytesToNodes(b []byte) []Node {
	out := make([]Node, len(b))
	for i, c := range b {
		out[i] = Node{T: "byte", Secs: int64(c)}
	}
	return out
}

func bytesOf(n Node) []byte {
	out := make([]byte, len(n.Arr))
	for i, c := range n.Arr {
		out[i] = byte(c.Secs)
	}
	return out
}

type Vector struct {
	ID      string `json:"id"`
	Model   Node   `json:"model"`
	Msgpack string `json:"msgpack"`
	Cbor    string `json:"cbor"`
}

type VectorFile struct {
	Profile string   `json:"profile"`
	Vectors []Vector `json:"vectors"`
}

// ---------------------------------------------------------------------------
// Model equality
// ---------------------------------------------------------------------------

func nodeEqual(a, b Node) bool {
	// Sets are plain arrays on the wire: normalize both sides before
	// comparing (the encode check still proves the sorted dedup order).
	if a.T == "set" {
		a.T = "array"
	}
	if b.T == "set" {
		b.T = "array"
	}
	if a.T != b.T {
		return false
	}
	switch a.T {
	case "i64", "u64":
		// Value lives in Secs; Str is a parse-time artifact on one side only.
		if a.Secs != b.Secs || a.Nanos != b.Nanos {
			return false
		}
	case "str", "decimal", "uuid", "enum":
		if a.Str != b.Str {
			return false
		}
	default:
		if a.Bool != b.Bool || a.Str != b.Str || a.Secs != b.Secs || a.Nanos != b.Nanos {
			return false
		}
	}
	if a.T == "f64" && math.Float64bits(a.F64) != math.Float64bits(b.F64) {
		return false
	}
	if len(a.Arr) != len(b.Arr) {
		return false
	}
	for i := range a.Arr {
		if !nodeEqual(a.Arr[i], b.Arr[i]) {
			return false
		}
	}
	if len(a.Map) != len(b.Map) {
		return false
	}
	for i := range a.Map {
		if a.Map[i].Key != b.Map[i].Key || !nodeEqual(a.Map[i].Val, b.Map[i].Val) {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Canonical wire writer (shared forms with the TypeScript reference codecs)
// ---------------------------------------------------------------------------

func writeHead(out []byte, major byte, arg uint64) []byte {
	m := major << 5
	switch {
	case arg < 24:
		return append(out, m|byte(arg))
	case arg <= 0xff:
		return append(out, m|24, byte(arg))
	case arg <= 0xffff:
		return append(out, m|25, byte(arg>>8), byte(arg))
	case arg <= 0xffffffff:
		return append(out, m|26, byte(arg>>24), byte(arg>>16), byte(arg>>8), byte(arg))
	default:
		out = append(out, m|27)
		return appendBigU64(out, arg)
	}
}

// encodeNode writes the canonical wire form. cborMode selects the CBOR
// leaf constants (major 0/1 ints, f4/f5/f6 simples, tag 1 + binary64 epoch);
// otherwise the MessagePack constants are used (fixint, c0/c2/c3, 0xcb,
// timestamp96 ext).
func encodeNode(out []byte, n Node, cborMode bool) []byte {
	switch n.T {
	case "null":
		if cborMode {
			return append(out, 0xf6)
		}
		return append(out, 0xc0)
	case "bool":
		if cborMode {
			if n.Bool {
				return append(out, 0xf5)
			}
			return append(out, 0xf4)
		}
		if n.Bool {
			return append(out, 0xc3)
		}
		return append(out, 0xc2)
	case "i64":
		v := n.Secs
		if cborMode {
			// major 1, argument = -1 - v
			arg := uint64(-1 - v)
			return writeHead(out, 1, arg)
		}
		switch {
		case v >= -32:
			return append(out, byte(int8(v)))
		case v >= math.MinInt8:
			return append(out, 0xd0, byte(int8(v)))
		case v >= math.MinInt16:
			return append(out, 0xd1, byte(uint16(v)>>8), byte(uint16(v)))
		case v >= math.MinInt32:
			u := uint32(v)
			return append(out, 0xd2, byte(u>>24), byte(u>>16), byte(u>>8), byte(u))
		default:
			out = append(out, 0xd3)
			return appendBigU64(out, uint64(v))
		}
	case "u64":
		v := uint64(n.Secs)
		if cborMode {
			return writeHead(out, 0, v)
		}
		switch {
		case v < 0x80:
			return append(out, byte(v))
		case v <= 0xff:
			return append(out, 0xcc, byte(v))
		case v <= 0xffff:
			return append(out, 0xcd, byte(v>>8), byte(v))
		case v <= 0xffffffff:
			return append(out, 0xce, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
		default:
			out = append(out, 0xcf)
			return appendBigU64(out, v)
		}
	case "f64":
		bits := math.Float64bits(n.F64)
		if cborMode {
			out = append(out, 0xfb)
		} else {
			out = append(out, 0xcb)
		}
		for i := 7; i >= 0; i-- {
			out = append(out, byte(bits>>(8*uint(i))))
		}
		return out
	case "str":
		if cborMode {
			out = writeHead(out, 3, uint64(len(n.Str)))
			return append(out, n.Str...)
		}
		switch {
		case len(n.Str) < 32:
			out = append(out, 0xa0|byte(len(n.Str)))
		case len(n.Str) <= 0xff:
			out = append(out, 0xd9, byte(len(n.Str)))
		case len(n.Str) <= 0xffff:
			out = append(out, 0xda, byte(len(n.Str)>>8), byte(len(n.Str)))
		default:
			out = append(out, 0xdb)
			out = appendBigU64(out, uint64(len(n.Str)))
		}
		return append(out, n.Str...)
	case "bytes":
		raw := bytesOf(n)
		if cborMode {
			out = writeHead(out, 2, uint64(len(raw)))
		} else {
			switch {
			case len(raw) < 256:
				out = append(out, 0xc4, byte(len(raw)))
			case len(raw) <= 0xffff:
				out = append(out, 0xc5, byte(len(raw)>>8), byte(len(raw)))
			default:
				out = append(out, 0xc6)
				out = appendBigU64(out, uint64(len(raw)))
			}
		}
		return append(out, raw...)
	case "timestamp":
		if cborMode {
			// tag 1 + binary64 epoch seconds (Bridge canonical form)
			out = append(out, 0xc1, 0xfb)
			epoch := float64(n.Secs) + float64(n.Nanos)/1e9
			bits := math.Float64bits(epoch)
			for i := 7; i >= 0; i-- {
				out = append(out, byte(bits>>(8*uint(i))))
			}
			return out
		}
		out = append(out, 0xc7, 12, 0xff) // ext8, len 12, type -1
		nanos := uint32(n.Nanos)
		for i := 3; i >= 0; i-- {
			out = append(out, byte(nanos>>(8*uint(i))))
		}
		return appendBigU64(out, uint64(n.Secs))
	case "byte":
		return append(out, byte(n.Secs))
	case "array", "set":
		if cborMode {
			out = writeHead(out, 4, uint64(len(n.Arr)))
		} else {
			switch {
			case len(n.Arr) < 16:
				out = append(out, 0x90|byte(len(n.Arr)))
			case len(n.Arr) <= 0xffff:
				out = append(out, 0xdc, byte(len(n.Arr)>>8), byte(len(n.Arr)))
			default:
				out = append(out, 0xdd)
				out = appendBigU64(out, uint64(len(n.Arr)))
			}
		}
		for _, item := range n.Arr {
			out = encodeNode(out, item, cborMode)
		}
		return out
	case "map":
		if cborMode {
			out = writeHead(out, 5, uint64(len(n.Map)))
		} else {
			switch {
			case len(n.Map) < 16:
				out = append(out, 0x80|byte(len(n.Map)))
			case len(n.Map) <= 0xffff:
				out = append(out, 0xde, byte(len(n.Map)>>8), byte(len(n.Map)))
			default:
				out = append(out, 0xdf)
				out = appendBigU64(out, uint64(len(n.Map)))
			}
		}
		for _, pair := range n.Map {
			if cborMode {
				out = writeHead(out, 3, uint64(len(pair.Key)))
				out = append(out, pair.Key...)
			} else {
				out = encodeNode(out, Node{T: "str", Str: pair.Key}, false)
			}
			out = encodeNode(out, pair.Val, cborMode)
		}
		return out
	}
	panic("unreachable tagged type " + n.T)
}

func appendBigU64(out []byte, v uint64) []byte {
	for i := 7; i >= 0; i-- {
		out = append(out, byte(v>>(8*uint(i))))
	}
	return out
}

// ---------------------------------------------------------------------------
// Decoded Go value -> tagged model
// ---------------------------------------------------------------------------

func toModel(v interface{}) (Node, error) {
	switch t := v.(type) {
	case nil:
		return Node{T: "null"}, nil
	case bool:
		return Node{T: "bool", Bool: t}, nil
	case uint64:
		return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
	case int64:
		return Node{T: "i64", Secs: t}, nil
	case uint8:
		return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
	case uint16:
		return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
	case uint32:
		return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
	case int8:
		if t >= 0 {
			return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
		}
		return Node{T: "i64", Secs: int64(t)}, nil
	case int16:
		if t >= 0 {
			return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
		}
		return Node{T: "i64", Secs: int64(t)}, nil
	case int32:
		if t >= 0 {
			return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
		}
		return Node{T: "i64", Secs: int64(t)}, nil
	case int:
		if t >= 0 {
			return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
		}
		return Node{T: "i64", Secs: int64(t)}, nil
	case uint:
		return Node{T: "u64", Secs: int64(t), Nanos: 1}, nil
	case float64:
		return Node{T: "f64", F64: t}, nil
	case float32:
		return Node{T: "f64", F64: float64(t)}, nil
	case string:
		return Node{T: "str", Str: t}, nil
	case []byte:
		n := Node{T: "bytes", Nanos: -1}
		n.Arr = bytesToNodes(t)
		return n, nil
	case time.Time:
		return Node{T: "timestamp", Secs: t.Unix(), Nanos: int32(t.Nanosecond())}, nil
	case cbor.Tag:
		if t.Number != 1 {
			return Node{}, fmt.Errorf("unexpected cbor tag %d", t.Number)
		}
		epoch, ok := t.Content.(float64)
		if !ok {
			return Node{}, fmt.Errorf("tag 1 content %T is not float64", t.Content)
		}
		secs := int64(epoch)
		nanos := int32(math.Round((epoch - float64(secs)) * 1e9))
		if nanos >= 1_000_000_000 {
			secs, nanos = secs+1, 0
		}
		return Node{T: "timestamp", Secs: secs, Nanos: nanos}, nil
	case []interface{}:
		n := Node{T: "array"}
		for _, item := range t {
			inner, err := toModel(item)
			if err != nil {
				return Node{}, err
			}
			n.Arr = append(n.Arr, inner)
		}
		return n, nil
	case map[interface{}]interface{}:
		converted := make(map[string]interface{}, len(t))
		for k, v := range t {
			ks, ok := k.(string)
			if !ok {
				return Node{}, fmt.Errorf("non-string map key %T", k)
			}
			converted[ks] = v
		}
		return toModel(converted)
	case map[string]interface{}:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		n := Node{T: "map"}
		for _, k := range keys {
			inner, err := toModel(t[k])
			if err != nil {
				return Node{}, err
			}
			n.Map = append(n.Map, Pair{Key: k, Val: inner})
		}
		return n, nil
	}
	return Node{}, fmt.Errorf("unexpected decoded type %T", v)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

var failures = 0

func fail(id, format string, format2 string, args ...interface{}) {
	failures++
	fmt.Printf("FAIL [%s/%s]: %s\n", id, format, fmt.Sprintf(format2, args...))
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: read vectors: %v\n", err)
		os.Exit(2)
	}
	var file VectorFile
	if err := json.Unmarshal(data, &file); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: parse vectors: %v\n", err)
		os.Exit(2)
	}

	for _, vector := range file.Vectors {
		check(vector, "msgpack", vector.Msgpack)
		check(vector, "cbor", vector.Cbor)
		fmt.Printf("  %-24s ok\n", vector.ID)
	}
	if failures > 0 {
		fmt.Fprintf(os.Stderr, "\n%d failure(s)\n", failures)
		os.Exit(1)
	}
	fmt.Printf("\ngo runtime: %d vectors, both formats, all checks PASS\n", len(file.Vectors))
}

func check(vector Vector, formatName, hexStr string) {
	raw, err := hexDecode(hexStr)
	if err != nil {
		fail(vector.ID, formatName, "bad hex: %v", err)
		return
	}
	// 1. ENCODE: the canonical writer reproduces the vector bytes.
	encoded := encodeNode(nil, vector.Model, formatName == "cbor")
	if !bytes.Equal(encoded, raw) {
		fail(vector.ID, formatName, "encode mismatch\n  want %x\n   got %x", raw, encoded)
		return
	}
	// 2. DECODE: the reference library reads the bytes into the model.
	var decoded interface{}
	if formatName == "msgpack" {
		dec := msgpack.NewDecoder(bytes.NewReader(raw))
		v, err := dec.DecodeInterface()
		if err != nil {
			fail(vector.ID, formatName, "msgpack decode: %v", err)
			return
		}
		decoded = v
	} else {
		decMode, err := cbor.DecOptions{}.DecMode()
		if err != nil {
			fail(vector.ID, formatName, "cbor decmode: %v", err)
			return
		}
		var v interface{}
		if err := decMode.Unmarshal(raw, &v); err != nil {
			fail(vector.ID, formatName, "cbor decode: %v", err)
			return
		}
		decoded = v
	}
	model, err := toModel(decoded)
	if err != nil {
		fail(vector.ID, formatName, "toModel: %v", err)
		return
	}
	if !nodeEqual(model, vector.Model) {
		fail(vector.ID, formatName, "decoded model != vector model\n  want %+v\n   got %+v",
			vector.Model, model)
	}
}

func hexDecode(s string) ([]byte, error) {
	const digits = "0123456789abcdef"
	if len(s)%2 != 0 {
		return nil, fmt.Errorf("odd hex length")
	}
	out := make([]byte, len(s)/2)
	for i := 0; i < len(out); i++ {
		hi := strings.IndexByte(digits, lower(s[2*i]))
		lo := strings.IndexByte(digits, lower(s[2*i+1]))
		if hi < 0 || lo < 0 {
			return nil, fmt.Errorf("bad hex at byte %d", i)
		}
		out[i] = byte(hi)<<4 | byte(lo)
	}
	return out, nil
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'F' {
		return c - 'A' + 'a'
	}
	return c
}
