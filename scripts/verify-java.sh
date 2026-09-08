#!/usr/bin/env bash
# scripts/verify-java.sh — compile-check + round-trip the generated Java
# for every example.
#
# Regenerates code on the fly (scripts/generate-all.mjs), compiles each
# examples/*/generated/java tree, and runs the generated RoundTripTest.
# Prefers javac (JDK); falls back to the Eclipse batch compiler via the
# ECJ_JAR environment variable (`java -jar "$ECJ_JAR"`). When neither is
# available this skips gracefully (exit 0) — CI, which has a JDK,
# enforces the same checks.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mode=""
if command -v javac >/dev/null 2>&1; then
  mode="javac"
elif [ -n "${ECJ_JAR:-}" ] && [ -f "${ECJ_JAR}" ]; then
  mode="ecj"
fi

if [ -z "$mode" ]; then
  echo "Java compiler not available (javac or ECJ_JAR) — skipping (CI covers this)"
  exit 0
fi

node scripts/generate-all.mjs || exit 1

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

status=0
for pkg in examples/*/generated/java; do
  [ -d "$pkg" ] || continue
  echo "== $pkg"
  out="$work/$(echo "$pkg" | tr / _)"
  mkdir -p "$out"

  sources="$(find "$pkg/src" -name '*.java')"
  if [ -z "$sources" ]; then
    echo "no Java sources generated — FAIL"
    status=1
    continue
  fi

  if [ "$mode" = "javac" ]; then
    # shellcheck disable=SC2086
    javac -d "$out" $sources || { status=1; continue; }
  else
    # shellcheck disable=SC2086
    java -jar "${ECJ_JAR}" -17 -nowarn -d "$out" $sources || { status=1; continue; }
  fi

  # Derived from the tree layout: src/test/java/bridge/x/v1/RoundTripTest.java
  test_rel="$(find "$pkg/src/test/java" -name 'RoundTripTest.java' 2>/dev/null | head -n 1)"
  if [ -n "$test_rel" ]; then
    fqcn="$(echo "${test_rel#"$pkg/src/test/java/"}" | sed 's/\.java$//; s#/#.#g')"
    java -cp "$out" "$fqcn" || status=1
  else
    echo "no RoundTripTest generated (struct-less contract) — compile check only"
  fi
done

if [ "$status" -eq 0 ]; then
  echo "Java verification: PASS"
else
  echo "Java verification: FAIL"
fi
exit "$status"
