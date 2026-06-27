#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Muat PATH Homebrew / lokal (non-fatal jika dijalankan tanpa source)
# shellcheck source=/dev/null
source "$ROOT/scripts/setup-env.sh" 2>/dev/null || true

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js tidak ditemukan. Install: brew install node"
  exit 1
fi

exec node index.js
