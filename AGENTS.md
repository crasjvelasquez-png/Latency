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

## AbletonOSC Device Schema

Fields returned per device in `report.get("devices", [])` (verified from AbletonOSC latency handler export):

| Field | Type | Description |
|---|---|---|
| `device_name` | string | Display name (e.g. "Pro-Q 3 (VST3)") |
| `class_name` | string | Live proxy class (e.g. "VstPluginProxy", "AuPluginProxy", "MaxAudioEffect") |
| `format` | string | Plugin format (e.g. "VST3", "VST2", "VST/VST3", "Audio Unit") |
| `track_name` | string | Name of the parent track |
| `track_index` | int | 0-based track index |
| `active` | bool or null | Device active state; null when unknown |
| `latency_available` | bool | Whether latency data could be read |
| `latency_samples` | int | Reported latency in samples |
| `latency_ms` | float | Reported latency in milliseconds |

Additionally, via `annotate_track_kinds()` (app.py), each device dict gains:
- `track_kind` — one of: `"audio"`, `"instrument"`, `"group"`, `"return"`, `"unknown"`
- `track_kind_label` — human-readable label (e.g. "Audio track", "Instrument track")
- `track_kind_source` — how the kind was inferred (e.g. "device_type", "name", "fallback")

## AbletonOSC Field Requests

The following fields would be useful additions to the AbletonOSC latency handler export. These are **not** currently available and should be requested from the AbletonOSC maintainer rather than blocked on:

- `device_type` — Ableton `Device.type` enum (e.g. "MIDI_Effect", "AudioEffect", "Instrument", "Undefined"). Would replace heuristic `_infer_track_kind` device_type logic.
- `track_type` — Ableton `Track.type` enum (e.g. "MIDI", "Audio", "Return", "Group", "Master"). Would eliminate macOS-specific name heuristics in `_infer_track_kind`.
- `chain_index` — Position of the device within its parent chain (device chain or drum rack pad chain). 0-based, ordered by signal flow.
- `chain_name` — Name of the parent chain when device is nested (e.g. "Chain 1", "Pad 6"). Otherwise null.
- `device_id` — Persistent numeric ID from Ableton's `Device._id` attribute. Useful for deduplication across scans.

## AbletonOSC Endpoints Needed

**Status: BLOCKED** — The following endpoints were verified as missing from AbletonOSC during a live Ableton Live 12 Suite session (see test results below). Phase 6 (device actions from the latency dashboard) cannot proceed until these are added to AbletonOSC.

### Gating Test Results

| OSC Address | Args | Result |
|---|---|---|
| `/live/device/get/set_device` | `0, 0` | `RuntimeError: Unknown OSC address` |
| `/live/track/get/num_tracks` | (none) | `RuntimeError: Unknown OSC address` |

Both gating tests failed. The phase is therefore **BLOCKED** per the hard gate requirement.

### What Exists Today

The following related endpoints were verified as working during the same session:

- `/live/test` — AbletonOSC health check (returns `ok`).
- `/live/song/get/num_tracks` — Returns total track count (usable as a substitute for the missing `/live/track/get/num_tracks`).
- `/live/track/get/name` `[track_index]` — Returns track name.
- `/live/track/get/num_devices` `[track_index]` — Returns device count on a track.
- `/live/track/get/devices/name` `[track_index]` — Returns tuple of device names on a track.
- `/live/device/get/name` `[track_index, device_index]` — Returns device name.
- `/live/device/get/num_parameters` `[track_index, device_index]` — Returns parameter count.
- `/live/device/get/parameters/name` `[track_index, device_index]` — Returns tuple of parameter names.
- `/live/device/get/parameter/value` `[track_index, device_index, param_index]` — Returns parameter value.
- `/live/view/set/selected_device` `[track_index, device_index]` — **Works for selecting/locating a device in Live's UI.**

### What Is Missing (Blocking Phase 6)

| Needed Capability | Required OSC Address(es) | Notes |
|---|---|---|
| **Locate/select device** | `/live/device/get/set_device` or equivalent | `/live/view/set/selected_device` exists and works, but there is no dedicated device-selection endpoint that matches the gating requirement. |
| **Device bypass/enable** | `/live/device/get/enabled` and `/live/device/set/enabled` | The first parameter of most devices is "Device On" (verified via `/live/device/get/parameters/name`), but there is no dedicated `enabled` property endpoint. Setting parameter values via `/live/device/set/parameter/value` does not return an OSC response (fire-and-forget), requiring backend changes to support one-way commands. |
| **Track freeze** | `/live/track/get/freeze` and `/live/track/set/freeze` (or `/live/track/get/frozen` / `/live/track/set/frozen`) | All variants returned `Unknown OSC address`. No freeze/unfreeze capability exists in AbletonOSC. |

### Recommended Next Steps

1. Request the AbletonOSC maintainer add the missing endpoints above.
2. If implementing bypass via parameter 0, note that `OSCRequest.send` must be extended to support fire-and-forget commands (no response expected).
3. Re-run the gating tests (`/live/device/get/set_device` and `/live/track/get/num_tracks`) after AbletonOSC updates. Only proceed with Phase 6 implementation if both respond successfully, or if the project maintainers explicitly relax the gating condition based on verified alternative endpoints.

## Implementation Notes
- Keep backend changes in `app.py` unless there is a clear need to split modules; there are no existing package boundaries.
- Keep frontend changes framework-free and dependency-free unless explicitly requested.
- Plugin grouping logic exists in both `app.py` (`normalize_plugin_name`) and `static/app.js` (`pluginKey`); update both if grouping semantics change.
