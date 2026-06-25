#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 -m py_compile app.py mac_app.py scripts/generate_icon.py
python3 -m pytest

python3 scripts/generate_icon.py
iconutil -c icns assets/Latency.iconset -o assets/Latency.icns

rm -rf build dist
python3 -m PyInstaller Latency.spec --noconfirm

codesign --deep --force --sign - dist/Latency.app

echo "Built dist/Latency.app"
