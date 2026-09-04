#!/usr/bin/env bash
# scripts/verify-go.sh — compile-check generated Go for every example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), then runs
# `go vet ./...` and `go build ./...` in each examples/*/generated/go module.
# Without a local Go toolchain this skips gracefully (exit 0) — CI, which has
# Go installed, enforces the same checks.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v go >/dev/null 2>&1; then
  echo "go toolchain not available — skipping (CI covers this)"
  exit 0
fi

node scripts/generate-all.mjs || exit 1

status=0
for pkg in examples/*/generated/go; do
  [ -f "$pkg/go.mod" ] || continue
  echo "== $pkg"
  (cd "$pkg" && go vet ./...) || status=1
  # Library-only modules: `go build ./...` compiles and discards, no artifacts.
  (cd "$pkg" && go build ./...) || status=1
done

if [ "$status" -eq 0 ]; then
  echo "Go verification: PASS"
else
  echo "Go verification: FAIL"
fi
exit "$status"
