#!/usr/bin/env bash
# Jalankan sekali per sesi terminal:  source scripts/setup-env.sh
# (dari root proyek, atau: source "$(dirname "$0")/setup-env.sh")

for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [[ -d "$dir" ]] && [[ ":$PATH:" != *":$dir:"* ]]; then
    export PATH="$dir:$PATH"
  fi
done

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "PATH siap: node $(node -v), npm $(npm -v)"
else
  echo "Peringatan: Node.js belum di PATH. Install: brew install node"
fi

if command -v ollama >/dev/null 2>&1; then
  echo "Ollama: $(command -v ollama)"
else
  echo "Ollama belum di PATH (opsional). Install: brew install ollama"
fi
