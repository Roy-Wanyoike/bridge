#!/usr/bin/env bash
# scripts/verify-rust.sh — compile-check generated Rust for every example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), then runs
# `cargo check` (gating) and `cargo clippy` (reporting) in each
# examples/*/generated/rust crate. Without a local Rust toolchain this skips
# gracefully (exit 0) — CI, which has Rust installed, enforces the checks.
# Note: the generated crates depend on serde/serde_json, so the first
# `cargo check` may fetch dependencies.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo toolchain not available — skipping (CI covers this)"
  exit 0
fi

node scripts/generate-all.mjs || exit 1

status=0
for pkg in examples/*/generated/rust; do
  [ -f "$pkg/Cargo.toml" ] || continue
  echo "== $pkg"
  (cd "$pkg" && cargo check --quiet) || status=1
  # Informational: lint findings are printed, only compile errors gate.
  (cd "$pkg" && cargo clippy --quiet) || status=1
done

if [ "$status" -eq 0 ]; then
  echo "Rust verification: PASS"
else
  echo "Rust verification: FAIL"
fi
exit "$status"
