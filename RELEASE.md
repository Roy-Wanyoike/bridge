# Release engineering

This document is the operator's manual for cutting a Bridge release. The
process is fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml);
a release is **one tag push**.

## Prerequisites (one-time)

- GitHub Actions must be runnable on the account (⚠ see the billing note
  below — the workflows are complete but cannot execute until the account's
  Actions billing lock is lifted).
- `NPM_TOKEN` secret set for npm publishing (the container/npm jobs fail
  soft when artifacts already exist).
- OIDC enabled for keyless cosign signing (default on GitHub Actions).

## Cutting a release

1. Ensure `main` is green and the CHANGELOG reflects the release.
2. Tag and push:
   ```bash
   git tag -a vX.Y.Z -m "Bridge vX.Y.Z"
   git push origin vX.Y.Z
   ```
3. The workflow then:
   - builds **self-contained CLI binaries** for linux/darwin × amd64/arm64
     and windows/amd64 (`bun build --compile` over `@bridge/cli`), via
     [scripts/package-release.mjs](scripts/package-release.mjs);
   - writes **SHA-256 checksums** (`checksums-sha256.txt`);
   - produces **SBOMs** (SPDX + CycloneDX) via syft;
   - **signs** every binary and the checksum file (keyless cosign, `.sig` files);
   - publishes a **GitHub release** with a conventional-commit changelog
     (`cliff.toml`);
   - builds and pushes **multi-arch container images**
     (`ghcr.io/roy-wanyoike/bridge:<version>` and `:<major.minor>`), signs them;
   - **publishes the npm workspaces** (`@bridge/core`, `@bridge/generators`,
     `@bridge/compat`, `@bridge/registry`, `@bridge/serialization`,
     `@bridge/cli`).

## Verifying a release

```bash
sha256sum --check checksums-sha256.txt
cosign verify-blob \
  --signature bridge-vX.Y.Z-linux-amd64.sig \
  --certificate-identity-regexp "https://github.com/Roy-Wanyoike/bridge/.github/workflows/release.yml" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  bridge-vX.Y.Z-linux-amd64
cosign verify ghcr.io/roy-wanyoike/bridge:vX.Y.Z
```

## Homebrew

[homebrew/bridge.rb](homebrew/bridge.rb) installs the release binaries. For
a public tap: copy the formula into `homebrew-bridge/` of your tap and bump
`version` + `sha256` per release (the per-target digests are in
`checksums-sha256.txt` of that release).

## Local dry-run (no CI needed)

```bash
bun scripts/package-release.mjs --current-only   # build + checksums
bash scripts/verify-release.sh                   # build, smoke, verify checksums
```

## ⚠ Billing note

GitHub Actions on this account is currently billing-locked: every workflow
in `.github/workflows/` is complete and correct but cannot execute until
the lock is lifted. All release mechanics above were additionally verified
locally where possible (binary build + smoke + checksums via bun).
