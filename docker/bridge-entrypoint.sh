#!/bin/sh
# docker/bridge-entrypoint.sh — routes the image ENTRYPOINT:
#   bridge <args>       (default; the Bridge CLI)
#   service <args>      starts bridge-registry-service
set -e

if [ "${1:-}" = "service" ]; then
  shift
  exec bridge-registry-service "$@"
fi

exec bridge "$@"
