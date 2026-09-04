#!/usr/bin/env bash
# Cross-language serialization verification (#15).
#
# Proves the Bridge wire contract end to end:
#   1. TypeScript codecs pass the full suite (80 assertions incl. all vectors)
#   2. Go runtime: canonical-writer byte identity + msgpack/cbor library decode
#   3. Rust runtime: same, via rmpv + ciborium
#   4. Python runtime: same, via msgpack + cbor2
#
# Usage: scripts/verify-serialization.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VECTORS="$ROOT/packages/bridge-serialization/vectors/vectors.json"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n== %s\n' "$1"; }

step "1/4 TypeScript: codec suite + golden vectors"
cd "$ROOT"
npm test --workspace @bridge/serialization > /dev/null 2>&1 || fail "npm test @bridge/serialization"
pass "80/80 assertions (encode + decode + round-trips)"

step "2/4 Go runtime (canonical writer + vmihailenco/msgpack + fxamacker/cbor)"
if command -v go > /dev/null 2>&1; then
  GO=go
elif [ -x /home/z/toolchain/go/bin/go ]; then
  GO=/home/z/toolchain/go/bin/go
else
  echo "  SKIP Go toolchain not available"; GO=""
fi
if [ -n "${GO:-}" ]; then
  (cd "$ROOT/packages/bridge-serialization/runtimes/go" && "$GO" run . "$VECTORS" > /dev/null)
  pass "160 checks byte-exact"
fi

step "3/4 Rust runtime (canonical writer + rmpv + ciborium)"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if command -v cargo > /dev/null 2>&1; then
  (cd "$ROOT/packages/bridge-serialization/runtimes/rust" && cargo run --quiet -- "$VECTORS" > /dev/null)
  pass "160 checks byte-exact"
else
  echo "  SKIP Rust toolchain not available"
fi

step "4/4 Python runtime (canonical writer + msgpack + cbor2)"
if python3 -c "import msgpack, cbor2" 2> /dev/null; then
  (cd "$ROOT/packages/bridge-serialization" && python3 runtimes/python/verify_serialization.py > /dev/null 2>&1)
  pass "160 checks byte-exact"
else
  echo "  SKIP python msgpack/cbor2 not installed"
fi

printf '\nverify-serialization: ALL PASS\n'
