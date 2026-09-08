#!/usr/bin/env bash
# scripts/verify-all.sh — regenerate + verify generated code for every example.
#
# Runs the full local verification suite in sequence and prints a summary.
# Exit status: 0 when every check passed (skips allowed), 1 if any check
# failed or — with STRICT_SKIP=1 — if any check was skipped.
#
#   node scripts/generate-all.mjs   (run by each verifier; idempotent)
#   scripts/verify-python.sh        — ast.parse + import + round-trip
#   scripts/verify-ts.sh            — workspace tsc over generated packages
#   scripts/verify-go.sh            — go vet + go build (SKIP w/o toolchain)
#   scripts/verify-rust.sh          — cargo check + clippy (SKIP w/o toolchain)
#   scripts/verify-java.sh          — javac/ecj compile + round-trip (SKIP w/o)
#   scripts/verify-csharp.sh        — dotnet build + round-trip (SKIP w/o toolchain)
#
# Skip semantics: verifiers exit 77 (SKIP_EXITS-overridable) when their
# toolchain is missing; that is reported as SKIP, not PASS. Locally a skip
# leaves the overall result green; set STRICT_SKIP=1 (CI contexts) to fail
# on any skipped leg.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

overall=0
results=""

run() {
  local name="$1"
  shift
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then
    results+="PASS  ${name}"$'\n'
  elif [ "$rc" -eq 77 ]; then
    results+="SKIP  ${name}"$'\n'
    if [ "${STRICT_SKIP:-0}" = "1" ]; then
      overall=1
    fi
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
run "verify-java"   bash scripts/verify-java.sh
run "verify-csharp" bash scripts/verify-csharp.sh

echo
echo "===== SUMMARY ====="
printf "%s" "$results"
exit "$overall"
