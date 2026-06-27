#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> WhatsApp Auto Feeding — setup macOS"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang."
  echo "Install: brew install node   atau unduh dari https://nodejs.org"
  exit 1
fi

echo "Node $(node -v) · npm $(npm -v)"
npm install

if ! command -v ollama >/dev/null 2>&1; then
  echo ""
  echo "Ollama (opsional, untuk fallback AI):"
  echo "  brew install ollama"
  echo "  ollama pull qwen2.5:7b"
else
  echo "Ollama: $(ollama --version 2>/dev/null || echo ok)"
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Dibuat .env dari .env.example"
fi

echo ""
echo "Selesai. Jalankan:"
echo "  npm run desktop     # aplikasi GUI"
echo "  npm start           # CLI feeding"
echo "  npm run codex-login # login Codex (sekali)"
