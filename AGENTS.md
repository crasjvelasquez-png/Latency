# AGENTS.md

## Repo Shape
- `app.py` is the whole backend: a `ThreadingHTTPServer` serving `static/` plus `/api/status` and `/api/scan`.
- `static/index.html`, `static/app.js`, and `static/styles.css` are plain browser assets; there is no bundler, package manager, or frontend build step.
- Runtime integration is local Ableton Live via AbletonOSC: requests go to `127.0.0.1:11000`, replies bind `127.0.0.1:11001`.

## Commands
- Setup: `python3 -m pip install -r requirements.txt`.
- Run dashboard: `python3 app.py`, then open `http://127.0.0.1:8799`; if occupied, the app falls forward through ports `8800-8899`.
- Reload AbletonOSC handlers after installing/updating this tool: `python3 app.py --reload-abletonosc`.
- Focused syntax check: `python3 -m py_compile app.py`.

## Runtime Gotchas
- `/api/scan` requires Ableton Live running with AbletonOSC enabled; without it, expect timeout/offline errors rather than app failures.
- Scan export is read from `/tmp/abletonosc-latency-report.json` unless AbletonOSC returns another path.
- Last scan cache is written to `~/Library/Application Support/LatencyManager/abletonosc-latency-report.json`; preserve this location unless intentionally changing user-visible behavior.
- Current Live set detection is macOS-specific and uses `pgrep`, `lsof`, and `osascript`; avoid replacing it with cross-platform assumptions.

## Implementation Notes
- Keep backend changes in `app.py` unless there is a clear need to split modules; there are no existing package boundaries.
- Keep frontend changes framework-free and dependency-free unless explicitly requested.
- Plugin grouping logic exists in both `app.py` (`normalize_plugin_name`) and `static/app.js` (`pluginKey`); update both if grouping semantics change.
