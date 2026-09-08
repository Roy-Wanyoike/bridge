#!/usr/bin/env bash
# Create the BRIDGE audit label set (idempotent).
set -euo pipefail
GH_TOKEN="${GH_TOKEN:?}"
REPO="Roy-Wanyoike/bridge"
api() { curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/$1" -d "$2"; }

declare -a LABELS=(
  '{"name":"area:compiler","color":"1d76db","description":"bridge-core: lexer/parser/semantic/IR/fuzz"}'
  '{"name":"area:cli","color":"5319e7","description":"bridge command line interface"}'
  '{"name":"area:generators","color":"f9d0c4","description":"code generation backends"}'
  '{"name":"area:serialization","color":"fbca04","description":"wire formats: JSON/msgpack/CBOR"}'
  '{"name":"area:registry","color":"006b75","description":"contract registry + HTTP service"}'
  '{"name":"area:dashboard","color":"c2e0c6","description":"Next.js registry console"}'
  '{"name":"area:ci","color":"ededed","description":"GitHub Actions / CI pipelines"}'
  '{"name":"area:release","color":"d93f0b","description":"tagging, binaries, containers, npm"}'
  '{"name":"area:docs","color":"0075ca","description":"documentation"}'
  '{"name":"kind:bug","color":"ee0701","description":"something is broken"}'
  '{"name":"kind:security","color":"b60205","description":"security vulnerability or hardening"}'
  '{"name":"kind:a11y","color":"7057ff","description":"accessibility"}'
  '{"name":"kind:hygiene","color":"ffffff","description":"cleanup / dead code / repo hygiene"}'
  '{"name":"priority:critical","color":"b60205","description":"blocks production"}'
  '{"name":"priority:high","color":"d93f0b","description":"fix before first release"}'
  '{"name":"priority:medium","color":"fbca04","description":"fix soon"}'
  '{"name":"priority:low","color":"0e8a16","description":"nice to have"}'
)
for l in "${LABELS[@]}"; do
  code=$(api labels "$l")
  echo "$(echo "$l" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])') -> $code"
done
