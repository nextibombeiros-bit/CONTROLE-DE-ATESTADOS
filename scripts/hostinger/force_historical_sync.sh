#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 https://seu-dominio [data-inicio-iso] [data-fim-iso]"
  exit 1
fi

BASE_URL="${1%/}"
START="${2:-2020-01-01T00:00:00.000Z}"
FINISH="${3:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"

curl -fsS -X POST "$BASE_URL/api/sync-nexti" \
  -H "Content-Type: application/json" \
  -d "{\"startLastUpdate\":\"$START\",\"finishLastUpdate\":\"$FINISH\",\"pageSize\":500}"

echo
