#!/usr/bin/env bash
# Daily-use launcher: build the frontend (if needed) and serve everything on :8765.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

if [ ! -f dist/index.html ]; then
  echo "Building frontend…"
  npm install
  npm run build
fi

exec .venv/bin/python app.py
