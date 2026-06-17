#!/usr/bin/env bash
# Wan Mobile - run script (macOS / Linux)
# First run creates a venv and installs deps; later runs just start the server.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  ./.venv/bin/python -m pip install --upgrade pip
  ./.venv/bin/python -m pip install -r requirements.txt
fi

if [ ! -f .env ]; then
  echo "No .env found - copy .env.example to .env and fill it in first."
  exit 1
fi

echo "Starting Wan Mobile on http://0.0.0.0:8000"
echo "On your phone (Tailscale up on both): http://<your-machine-tailscale-name>:8000"
exec ./.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
