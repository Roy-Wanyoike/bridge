# Multi-stage image for the Bridge CLI and registry service.
#
# The image carries the compiled workspace (TypeScript) and runs on a
# minimal Node runtime with production dependencies only.
# It is published multi-arch by .github/workflows/release.yml as
# ghcr.io/roy-wanyoike/bridge.
#
# Build locally:
#   docker build -t bridge:local .
#   docker run --rm bridge:local version
#   docker run --rm bridge:local service --help    # registry service
#
# Entrypoint paths below must match the emitted `tsc -b` output
# (rootDir: 'src' flattens src/bin/*.ts to dist/bin/*.js):
#   CLI      -> packages/bridge-cli/dist/bin/bridge.js
#   service  -> packages/bridge-registry-service/dist/bin/bridge-registry-service.js

# ---- build stage -----------------------------------------------------------
# Full install (devDependencies included): typescript is required to compile.
FROM node:22-bookworm-slim AS build
WORKDIR /build

# Manifests first for a cacheable npm ci layer.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/bridge-core/package.json packages/bridge-core/
COPY packages/bridge-generators/package.json packages/bridge-generators/
COPY packages/bridge-compat/package.json packages/bridge-compat/
COPY packages/bridge-registry/package.json packages/bridge-registry/
COPY packages/bridge-serialization/package.json packages/bridge-serialization/
COPY packages/bridge-registry-service/package.json packages/bridge-registry-service/
COPY packages/bridge-ffi/package.json packages/bridge-ffi/
COPY packages/bridge-lsp/package.json packages/bridge-lsp/
COPY packages/bridge-cli/package.json packages/bridge-cli/

RUN npm ci --no-audit --no-fund

COPY packages/bridge-core packages/bridge-core
COPY packages/bridge-generators packages/bridge-generators
COPY packages/bridge-compat packages/bridge-compat
COPY packages/bridge-registry packages/bridge-registry
COPY packages/bridge-serialization packages/bridge-serialization
COPY packages/bridge-registry-service packages/bridge-registry-service
COPY packages/bridge-ffi packages/bridge-ffi
COPY packages/bridge-lsp packages/bridge-lsp
COPY packages/bridge-cli packages/bridge-cli

# Builds every workspace incl. @bridge/serialization (published) and
# @bridge/registry-service (the `service` mode entrypoint).
RUN npm run build

# ---- production-dependencies stage -----------------------------------------
# Zero third-party runtime dependencies exist (all runtime imports are
# node:* builtins or @bridge/* workspace packages), so prod node_modules is
# just the workspace symlinks. npm ci --omit=dev creates them as RELATIVE
# links (node_modules/@bridge/core -> ../../packages/bridge-core), which keep
# resolving once node_modules/ and packages/ are copied side by side into /app.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/bridge-core/package.json packages/bridge-core/
COPY packages/bridge-generators/package.json packages/bridge-generators/
COPY packages/bridge-compat/package.json packages/bridge-compat/
COPY packages/bridge-registry/package.json packages/bridge-registry/
COPY packages/bridge-serialization/package.json packages/bridge-serialization/
COPY packages/bridge-registry-service/package.json packages/bridge-registry-service/
COPY packages/bridge-ffi/package.json packages/bridge-ffi/
COPY packages/bridge-lsp/package.json packages/bridge-lsp/
COPY packages/bridge-cli/package.json packages/bridge-cli/

RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="bridge"
LABEL org.opencontainers.image.description="Bridge — one contract, every language, zero interoperability drift."
LABEL org.opencontainers.image.source="https://github.com/Roy-Wanyoike/bridge"

WORKDIR /app
ENV NODE_ENV=production

# Production node_modules only (no typescript/@types/* — devDependencies are
# build-time). Symlinks into ../packages stay intact.
COPY --from=prod-deps /build/node_modules ./node_modules

# Runtime payload: manifests (full workspace set keeps every node_modules
# symlink valid) + compiled dist only. No src/, test/, tsconfig*, examples/.
# Registry-service migrations resolve at runtime relative to the compiled
# driver (dist/storage/postgres -> ../../../migrations), so they must sit at
# packages/bridge-registry-service/migrations.
COPY --from=build /build/packages/bridge-core/package.json packages/bridge-core/package.json
COPY --from=build /build/packages/bridge-core/dist packages/bridge-core/dist
COPY --from=build /build/packages/bridge-generators/package.json packages/bridge-generators/package.json
COPY --from=build /build/packages/bridge-generators/dist packages/bridge-generators/dist
COPY --from=build /build/packages/bridge-compat/package.json packages/bridge-compat/package.json
COPY --from=build /build/packages/bridge-compat/dist packages/bridge-compat/dist
COPY --from=build /build/packages/bridge-registry/package.json packages/bridge-registry/package.json
COPY --from=build /build/packages/bridge-registry/dist packages/bridge-registry/dist
COPY --from=build /build/packages/bridge-serialization/package.json packages/bridge-serialization/package.json
COPY --from=build /build/packages/bridge-serialization/dist packages/bridge-serialization/dist
COPY --from=build /build/packages/bridge-registry-service/package.json packages/bridge-registry-service/package.json
COPY --from=build /build/packages/bridge-registry-service/dist packages/bridge-registry-service/dist
COPY --from=build /build/packages/bridge-registry-service/migrations packages/bridge-registry-service/migrations
COPY --from=build /build/packages/bridge-ffi/package.json packages/bridge-ffi/package.json
COPY --from=build /build/packages/bridge-ffi/dist packages/bridge-ffi/dist
COPY --from=build /build/packages/bridge-lsp/package.json packages/bridge-lsp/package.json
COPY --from=build /build/packages/bridge-cli/package.json packages/bridge-cli/package.json
COPY --from=build /build/packages/bridge-cli/dist packages/bridge-cli/dist

COPY docker/bridge-entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod +x /usr/local/bin/bridge-entrypoint \
  && ln -s /app/packages/bridge-cli/dist/bin/bridge.js /usr/local/bin/bridge \
  && ln -s /app/packages/bridge-registry-service/dist/bin/bridge-registry-service.js /usr/local/bin/bridge-registry-service

# Non-root by default.
USER node

# Liveness for the long-running mode (service). The registry service exposes
# an unauthenticated GET /healthz -> 200 {"ok":true} (server.ts); bookworm-slim
# ships neither curl nor wget, so probe with Node's global fetch.
# It targets the documented default port 4350: if you override --port/--host
# (or run one-shot CLI commands, which exit immediately), override
# `docker run --health-cmd=...` to match.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4350/healthz').then(r=>{if(!r.ok)throw 0}).catch(()=>process.exit(1))" 2>/dev/null || exit 1

# Default: the CLI. `docker run ... service` starts the registry service.
# Note: the CLI has no --help flag (exits 2); `bridge help` prints usage.
ENTRYPOINT ["bridge-entrypoint"]
CMD ["help"]
