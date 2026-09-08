#!/usr/bin/env bash
# scripts/verify-release.sh — verify the locally-buildable release pieces.
#
# - builds a binary for the current platform (bun compile)
# - runs `bridge version` and `bridge help` from the binary
# - checks the checksums file matches the built binaries (missing file = FAIL)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not available — skipping (CI covers this)"
  exit 0
fi

status=0

bun scripts/package-release.mjs --current-only || status=1

bin=$(ls dist/release/bridge-* 2>/dev/null | grep -v checksums | head -n 1)
if [ -n "${bin:-}" ] && [ -x "$bin" ]; then
  echo "== smoke: $bin version"
  "$bin" version || status=1
  echo "== smoke: $bin help"
  "$bin" help >/dev/null || status=1
else
  echo "no binary produced — FAIL"
  status=1
fi

if [ -f dist/release/checksums-sha256.txt ]; then
  echo "== checksums"
  if (cd dist/release && sha256sum --quiet --check checksums-sha256.txt); then
    echo "checksums OK"
  else
    echo "checksums mismatch — FAIL"
    status=1
  fi
else
  echo "dist/release/checksums-sha256.txt missing — FAIL"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Release verification: PASS"
else
  echo "Release verification: FAIL"
fi
exit "$status"
