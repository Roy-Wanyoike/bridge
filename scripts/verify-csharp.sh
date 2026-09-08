#!/usr/bin/env bash
# scripts/verify-csharp.sh — build + round-trip the generated C# for every
# example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), then runs
# `dotnet build` and `dotnet run` (the generated RoundTripTest entry
# point) in each examples/*/generated/csharp project. Without the .NET
# SDK this skips gracefully (exit 0) — CI, which has dotnet installed,
# enforces the same checks.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v dotnet >/dev/null 2>&1; then
  echo ".NET SDK not available — skipping (CI covers this)"
  exit 0
fi

node scripts/generate-all.mjs || exit 1

status=0
for pkg in examples/*/generated/csharp; do
  [ -d "$pkg" ] || continue
  echo "== $pkg"
  (cd "$pkg" && dotnet build -v q) || { status=1; continue; }
  (cd "$pkg" && dotnet run --no-build) || status=1
done

if [ "$status" -eq 0 ]; then
  echo "C# verification: PASS"
else
  echo "C# verification: FAIL"
fi
exit "$status"
