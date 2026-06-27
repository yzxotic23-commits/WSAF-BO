#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/setup-env.sh" 2>/dev/null || true

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama belum terinstall. Jalankan: brew install ollama"
  exit 1
fi

exec ollama "$@"
