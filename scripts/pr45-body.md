Fixes #45

## Summary
Generated services are deployable as-is — this PR hardens every emitted artifact:

1. **Request body caps (DoS guard)** — all six server backends now reject bodies > 1 MiB with `413 payload_too_large` (added to the canonical wire error table, so 413 appears in every language's status map):
   - Rust: rejects the declared Content-Length **before** allocating (the `vec![0u8; content_length]` OOM path is gone); writes the 413 envelope, then returns
   - Go: `http.MaxBytesReader(w, r.Body, bridgeMaxBodyBytes)`
   - Java: `readNBytes(MAX_BODY_BYTES + 1)` helper, null -> 413
   - Python: Content-Length gate before `rfile.read`
2. **Doc-comment injection** — `*/` escaped in JSDoc/Javadoc, `"""` escaped in Python docstrings
3. **Validation parity** — full-match semantics in every language for `@email`/`@url`/`@uuid`/`@pattern` (java `.matches()`, python `re.fullmatch`, csharp `^(?:...)` + `\z` wrap; go/ts already anchored)
4. **2xx parity** — Rust clients accept the full 2xx range (`(200..300).contains(&status)`)
5. **Java uint64** — exact `BigInteger` decode (no `Double.parseDouble` clamp), full-range `expectUnsigned`, `Long.toUnsignedString` encoding
6. **Python null/default parity** — explicit JSON null no longer bypasses field defaults

## Validation (local — GitHub CI is billing-locked; owner must clear Settings -> Billing)
- npm run build: 0 errors
- npm test: **684/684 PASS** (9 packages; generators 32/32 incl. 7 new hardening tests)
- scripts/verify-rust.sh (cargo + clippy over all examples): PASS (after fixing an E0382 reborrow in the emitted parser — follow-up commit)
- [UNVERIFIED] dotnet/go/javac compile legs — no toolchains in sandbox; CI covers when unlocked
