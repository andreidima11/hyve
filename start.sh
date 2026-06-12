#!/bin/bash
cd "$(dirname "$0")" || exit 1
# Prefer .venv (Python 3.13 + current deps); legacy ./venv may ship pymammotion 0.0.x.
if [ -x "./.venv/bin/python" ]; then
  exec ./.venv/bin/python main.py "$@"
fi
if [ -x "./venv/bin/python" ]; then
  exec ./venv/bin/python main.py "$@"
fi
exec python3 main.py "$@"
