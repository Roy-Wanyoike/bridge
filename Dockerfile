# Multi-stage image for the Bridge CLI and registry service.
#
# The image carries the compiled workspace (TypeScript) and runs on a
# minimal Node runtime. It is published multi-arch by
# .github/workflows/release.yml as ghcr.io/roy-wanyoike/bridge.
#
# Build locally:
#   docker build -t bridge:local .
#   docker run --rm bridge:local version
#   docker run --rm bridge:local service   # starts bridge-registry-service

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /build

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

RUN npm run build

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="bridge"
LABEL org.opencontainers.image.description="Bridge — one contract, every language, zero interoperability drift."
LABEL org.opencontainers.image.source="https://github.com/Roy-Wanyoike/bridge"

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY docker/bridge-entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod +x /usr/local/bin/bridge-entrypoint \
  && ln -s /app/packages/bridge-cli/dist/src/bin/bridge.js /usr/local/bin/bridge \
  && ln -s /app/packages/bridge-registry-service/dist/bin/bridge-registry-service.js /usr/local/bin/bridge-registry-service

# Non-root by default.
USER node

# Default: the CLI. `docker run ... service` starts the registry service.
ENTRYPOINT ["bridge-entrypoint"]
CMD ["--help"]
