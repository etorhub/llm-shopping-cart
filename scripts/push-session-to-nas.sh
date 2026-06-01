#!/usr/bin/env bash
# Copia la session.json (i opcionalment orders.json) del PC al NAS.
# Edita aquestes 3 variables amb les dades del teu NAS:
NAS_USER="usuari"
NAS_HOST="192.168.1.x"
NAS_PATH="/volume1/docker/bonpreu-mcp"

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$HERE/session.json" ]; then
  echo "No hi ha session.json. Executa primer:  node main.js --login --head"
  exit 1
fi

echo "Copiant session.json -> $NAS_HOST ..."
scp "$HERE/session.json" "$NAS_USER@$NAS_HOST:$NAS_PATH/session/session.json"

if [ -f "$HERE/data/orders.json" ]; then
  echo "Copiant orders.json -> $NAS_HOST ..."
  scp "$HERE/data/orders.json" "$NAS_USER@$NAS_HOST:$NAS_PATH/data/orders.json"
fi

echo "Fet. El servidor del NAS llegirà la nova sessió a la propera operació."
