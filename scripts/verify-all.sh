#!/usr/bin/env bash
# scripts/verify-all.sh — regenerate + verify generated code for every example.
#
# Runs the full local verification suite in sequence and prints a summary.
# Exit status: 0 when every check passes, 1 if any check fails.
#
#   node scripts/generate-all.mjs   (run by each verifier; idempotent)
#   scripts/verify-python.sh        — ast.parse + import + round-trip
#   scripts/verify-ts.sh            — workspace tsc over generated packages
#   scripts/verify-go.sh            — go vet + go build (skips w/o toolchain)
#   scripts/verify-rust.sh          — cargo check + clippy (skips w/o toolchain)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

overall=0
results=""

run() {
  local name="$1"
  shift
  if "$@"; then
    results+="PASS  ${name}"$'\n'
  else
    results+="FAIL  ${name}"$'\n'
    overall=1
  fi
}

run "generate-all"  node scripts/generate-all.mjs
run "verify-python" bash scripts/verify-python.sh
run "verify-ts"     bash scripts/verify-ts.sh
run "verify-go"     bash scripts/verify-go.sh
run "verify-rust"   bash scripts/verify-rust.sh

echo
echo "===== SUMMARY ====="
printf "%s" "$results"
exit "$overall"
