#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

pkg update -y
pkg install -y nodejs-lts tmux
npm install --omit=dev
[ -f config.json ] || cp config.example.json config.json
printf '%s\n' 'Setup complete. Create .env from .env.example, keep DRY_RUN=1, then run ./termux-run.sh.'
