# Security Policy

## Reporting a vulnerability

We take the security of Bridge seriously. If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, report it privately using one of these channels:

1. GitHub private vulnerability reporting: Security tab → "Report a vulnerability".
2. Contact the repository owner via GitHub.

Include as much of the following as possible: a description of the vulnerability, steps to reproduce, affected versions, potential impact, and any suggested mitigation.

You can expect an initial response within 72 hours. We will keep you informed of progress toward a fix and coordinate disclosure timing with you.

## Scope

In scope:

- The Bridge compiler, CLI, generators, and local registry.
- The registry service (`@bridge/registry-service`) and its HTTP API —
  authentication (OIDC/static tokens), multi-tenancy isolation, artifact
  signing, audit log, rate limiting, and its storage drivers (in-memory,
  PostgreSQL).
- The dashboard (`dashboard/`) — its client against the registry service,
  demo/live data handling, and any server-rendered surface.
- Vulnerabilities allowing arbitrary code execution, path traversal, or denial of service via malicious `.bridge` files or registry payloads.
- Supply chain issues in release artifacts.

Out of scope:

- Vulnerabilities in generated code that require the generated code's own runtime dependencies.
- Social engineering attacks.

## Design principles

Bridge treats schemas, registry payloads, and generated artifacts as **untrusted input**. The compiler must never execute code contained in schemas. Generated artifacts are data, not trusted code, until they pass through the consumer's own review and build pipeline.
