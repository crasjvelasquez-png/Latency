#!/usr/bin/env python3
import argparse
import copy
import ctypes
import ctypes.util
import errno
import fcntl
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from pythonosc import dispatcher, osc_server, udp_client


def _resource_root():
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        return Path(bundled_root)
    return Path(__file__).resolve().parent


ROOT = _resource_root()
STATIC_DIR = ROOT / "static"
REPORT_PATH = Path("/tmp/abletonosc-latency-report.json")
APP_SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "LatencyManager"
CACHED_REPORT_PATH = APP_SUPPORT_DIR / "abletonosc-latency-report.json"
LOCK_FILE = APP_SUPPORT_DIR / "latency_manager.lock"
SETTINGS_PATH = APP_SUPPORT_DIR / "settings.json"
DEFAULT_SETTINGS = {
    "auto_refresh": False,
    "refresh_interval": 30,
    "grouping": "channel",
    "workflow_mode": "standard",
}


def load_settings():
    try:
        if not SETTINGS_PATH.exists():
            return dict(DEFAULT_SETTINGS)
        with SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)

        settings = dict(DEFAULT_SETTINGS)
        if isinstance(data.get("auto_refresh"), bool):
            settings["auto_refresh"] = data["auto_refresh"]

        if isinstance(data.get("refresh_interval"), int) and data["refresh_interval"] in [5, 10, 30, 60]:
            settings["refresh_interval"] = data["refresh_interval"]

        if data.get("grouping") in ["channel", "plugin"]:
            settings["grouping"] = data["grouping"]

        if isinstance(data.get("workflow_mode"), str):
            settings["workflow_mode"] = data["workflow_mode"]

        return settings
    except Exception as exc:
        logger.warning(f"Reading settings failed, using defaults: {exc}")
        return dict(DEFAULT_SETTINGS)


def save_settings(settings):
    validated = dict(DEFAULT_SETTINGS)
    if isinstance(settings.get("auto_refresh"), bool):
        validated["auto_refresh"] = settings["auto_refresh"]

    if isinstance(settings.get("refresh_interval"), int) and settings["refresh_interval"] in [5, 10, 30, 60]:
        validated["refresh_interval"] = settings["refresh_interval"]

    if settings.get("grouping") in ["channel", "plugin"]:
        validated["grouping"] = settings["grouping"]

    if isinstance(settings.get("workflow_mode"), str):
        validated["workflow_mode"] = settings["workflow_mode"]

    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with SETTINGS_PATH.open("w", encoding="utf-8") as f:
            json.dump(validated, f, indent=2)
        return True
    except Exception as exc:
        logger.error(f"Writing settings failed: {exc}")
        return False


ABLETONOSC_HOST = "127.0.0.1"
ABLETONOSC_PORT = 11000
RESPONSE_PORT = 11001
WEB_PORT = 8799
WEB_PORT_MAX = 8899
API_SCHEMA_VERSION = 1
API_APP_ID = "latency-manager"

OSC_HEALTH_TIMEOUT = 0.6
OSC_HANDLER_TIMEOUT = 2.0
OSC_EXPORT_TIMEOUT = 5.0
OSC_RELOAD_TIMEOUT = 1.5
REPORT_POLL_TIMEOUT = 3.0
REPORT_POLL_INTERVAL = 0.05
SUBPROCESS_TIMEOUT = 1.0

logger = logging.getLogger("latency-manager")

_scan_lock = threading.Lock()
_osc_lock = threading.Lock()
_report_cache = {"path": None, "mtime_ns": None, "report": None}
_last_status_payload = None


class ResponsePortConflict(OSError):
    """Raised when the OSC response port is already bound by another process."""


class OSCRequest:
    def __init__(self, timeout=3.0):
        self.timeout = timeout
        self.response = None
        self.event = threading.Event()

    def _handler(self, address, *args):
        self.response = {"address": address, "args": args}
        self.event.set()

    def send(self, address, *args):
        with _osc_lock:
            return self._send_locked(address, *args)

    def _send_locked(self, address, *args):
        disp = dispatcher.Dispatcher()
        disp.map(address, self._handler)
        disp.map("/live/error", self._handler)

        try:
            server = osc_server.ThreadingOSCUDPServer((ABLETONOSC_HOST, RESPONSE_PORT), disp)
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE:
                raise ResponsePortConflict(
                    f"Response port {RESPONSE_PORT} is already in use. "
                    "Another instance of LatencyManager may be running."
                ) from exc
            raise

        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = udp_client.SimpleUDPClient(ABLETONOSC_HOST, ABLETONOSC_PORT)
            client.send_message(address, list(args))
            if not self.event.wait(self.timeout):
                raise TimeoutError("No response from AbletonOSC on port 11000.")
            if self.response and self.response["address"] == "/live/error":
                message = self.response["args"][0] if self.response["args"] else "Unknown AbletonOSC error"
                raise RuntimeError(str(message))
            return self.response
        finally:
            server.shutdown()
            server.server_close()


RECOVERY_ACTIONS = {
    "ready": ["Run a scan."],
    "live_closed": ["Open Ableton Live.", "Load the Live set you want to scan."],
    "abletonosc_missing": [
        "Install AbletonOSC into Live's MIDI Remote Scripts folder.",
        "Enable AbletonOSC in Live Settings > Link, Tempo & MIDI.",
        f"Confirm UDP port {ABLETONOSC_PORT} is reachable on {ABLETONOSC_HOST}.",
    ],
    "response_port_conflict": [
        "Quit the other LatencyManager instance or process using the response port.",
        f"Free UDP port {RESPONSE_PORT} and retry.",
    ],
    "latency_handler_missing": [
        "Install or update the AbletonOSC latency export handler.",
        "Run python3 app.py --reload-abletonosc after updating AbletonOSC.",
    ],
    "automation_permission_missing": [
        "Allow Automation access when macOS prompts.",
        "Enable Automation for your terminal or launcher in System Settings > Privacy & Security > Automation.",
    ],
    "scan_failed": ["Retry the scan.", "Open diagnostics and verify the reported paths, ports, and permissions."],
}


def _abletonosc_check():
    """Returns (is_online, error_code_or_None) — distinguishes port conflicts from offline."""
    try:
        OSCRequest(timeout=OSC_HEALTH_TIMEOUT).send("/live/test")
        return True, None
    except ResponsePortConflict:
        return False, "port_conflict"
    except Exception:
        return False, None


def ableton_running():
    try:
        result = subprocess.run(
            ["pgrep", "-x", "Live"],
            capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT,
        )
        return result.returncode == 0
    except Exception:
        return False


def _latency_handler_check(osc_online):
    if not osc_online:
        return False, None
    try:
        OSCRequest(timeout=OSC_HANDLER_TIMEOUT).send("/live/song/export/latency")
        return True, None
    except ResponsePortConflict:
        return False, "response_port_conflict"
    except RuntimeError as exc:
        return False, str(exc) or "Latency export handler is unavailable."
    except TimeoutError:
        return False, "Timed out waiting for the latency export handler."
    except Exception as exc:
        return False, str(exc) or "Latency export handler is unavailable."
def automation_permission_granted():
    script = (
        'tell application "System Events" to tell process "Live" '
        'to get name of window 1'
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=2.0,
        )
        return result.returncode == 0
    except Exception:
        return False


def _abletonosc_script_paths():
    candidates = [
        Path.home() / "Music" / "Ableton" / "User Library" / "Remote Scripts" / "AbletonOSC",
        Path.home() / "Music" / "Ableton" / "User Library" / "Remote Scripts" / "AbletonOSC-main",
    ]
    return [
        {
            "path": str(path),
            "exists": path.exists(),
        }
        for path in candidates
    ]


def _connection_state(live_running, osc_online, osc_error, handler_available, automation_permission):
    if not live_running:
        return "live_closed"
    if osc_error == "port_conflict":
        return "response_port_conflict"
    if not osc_online:
        return "abletonosc_missing"
    if not handler_available:
        return "latency_handler_missing"
    if not automation_permission:
        return "automation_permission_missing"
    return "ready"


def _diagnostics_payload(status):
    state = status["connection_state"]
    return {
        "state": state,
        "paths": {
            "app_root": str(ROOT),
            "static_dir": str(STATIC_DIR),
            "default_report": str(REPORT_PATH),
            "cached_report": str(CACHED_REPORT_PATH),
            "current_project": (status.get("current_project") or {}).get("path") or "",
            "abletonosc_candidates": _abletonosc_script_paths(),
        },
        "ports": {
            "abletonosc_host": ABLETONOSC_HOST,
            "abletonosc_port": ABLETONOSC_PORT,
            "response_port": RESPONSE_PORT,
            "web_port_default": WEB_PORT,
        },
        "permissions": {
            "automation": status["automation_permission"],
        },
        "checks": {
            "live_running": status["live_running"],
            "abletonosc_online": status["abletonosc_online"],
            "latency_handler_available": status["latency_handler_available"],
            "report_exists": status["report_exists"],
        },
        "errors": {
            "abletonosc_error": status.get("abletonosc_error"),
            "latency_handler_error": status.get("latency_handler_error"),
        },
        "recovery_actions": RECOVERY_ACTIONS.get(state, RECOVERY_ACTIONS["scan_failed"]),
    }


def build_status_payload(include_cached_report=False):
    global _last_status_payload
    live_running = ableton_running()
    osc_online, osc_error = _abletonosc_check() if live_running else (False, None)
    handler_available, handler_error = _latency_handler_check(osc_online)
    automation_permission = automation_permission_granted() if live_running else False
    current_project = _get_current_live_set() if live_running else None
    payload = {
        "live_running": live_running,
        "abletonosc_online": osc_online,
        "latency_handler_available": handler_available,
        "automation_permission": automation_permission,
        "report_exists": CACHED_REPORT_PATH.exists(),
        "last_scan_time": _get_last_scan_time(),
        "current_project": current_project,
    }
    if osc_error:
        payload["abletonosc_error"] = osc_error
    if handler_error:
        payload["latency_handler_error"] = handler_error
    payload["connection_state"] = _connection_state(
        live_running,
        osc_online,
        osc_error,
        handler_available,
        automation_permission,
    )
    payload["recovery_actions"] = RECOVERY_ACTIONS.get(payload["connection_state"], RECOVERY_ACTIONS["scan_failed"])
    payload["diagnostics"] = _diagnostics_payload(payload)
    if include_cached_report:
        cached = load_cached_report()
        if cached:
            payload["cached_report"] = cached
    _last_status_payload = payload
    return payload


def run_onboarding_checks():
    status = build_status_payload()
    checks = {
        "ableton_running": status["live_running"],
        "abletonosc_reachable": status["abletonosc_online"],
        "handler_available": status["latency_handler_available"],
        "automation_permission": status["automation_permission"],
        "connection_state": status["connection_state"],
        "diagnostics": status["diagnostics"],
    }
    checks["all_passed"] = all(checks[k] for k in ("ableton_running", "abletonosc_reachable", "handler_available", "automation_permission"))
    return checks


def _get_coreaudio_buffer_size():
    """Query the default output device buffer frame size via CoreAudio on macOS.

    Enumerates audio devices and reads the buffer frame size from the first
    device that responds (the value is a global HAL property shared across all
    devices on macOS).
    """
    try:
        lib = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AudioToolbox"))
    except Exception:
        return None

    def _fourcc(s):
        return (ord(s[0]) << 24) | (ord(s[1]) << 16) | (ord(s[2]) << 8) | ord(s[3])

    kAudioObjectSystemObject = 1

    class AudioObjectPropertyAddress(ctypes.Structure):
        _fields_ = [
            ("mSelector", ctypes.c_uint32),
            ("mScope", ctypes.c_uint32),
            ("mElement", ctypes.c_uint32),
        ]

    AudioObjectGetPropertyDataSize = lib.AudioObjectGetPropertyDataSize
    AudioObjectGetPropertyDataSize.argtypes = [
        ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p,
    ]
    AudioObjectGetPropertyDataSize.restype = ctypes.c_int

    AudioObjectGetPropertyData = lib.AudioObjectGetPropertyData
    AudioObjectGetPropertyData.argtypes = [
        ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
    ]
    AudioObjectGetPropertyData.restype = ctypes.c_int

    # List all audio devices
    addr = AudioObjectPropertyAddress()
    addr.mSelector = _fourcc("dev#")
    addr.mScope = 0
    addr.mElement = 0

    dev_size = ctypes.c_uint32()
    if AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, ctypes.byref(addr), 0, None, ctypes.byref(dev_size)) != 0:
        return None

    count = dev_size.value // ctypes.sizeof(ctypes.c_uint32)
    DeviceIDs = ctypes.c_uint32 * count
    devices = DeviceIDs()
    if AudioObjectGetPropertyData(kAudioObjectSystemObject, ctypes.byref(addr), 0, None, ctypes.byref(dev_size), ctypes.byref(devices)) != 0:
        return None

    # Buffer frame size is a global HAL property — return it from any device
    for i in range(count):
        buf_addr = AudioObjectPropertyAddress()
        buf_addr.mSelector = _fourcc("fsiz")
        buf_addr.mScope = 1  # output scope
        buf_addr.mElement = 0
        buf_size = ctypes.c_uint32()
        sz = ctypes.c_uint32(ctypes.sizeof(buf_size))
        if AudioObjectGetPropertyData(devices[i], ctypes.byref(buf_addr), 0, None, ctypes.byref(sz), ctypes.byref(buf_size)) == 0:
            result = buf_size.value
            if result > 0:
                return result

    return None


def export_latency_report():
    before_time = time.time()
    response = OSCRequest(timeout=OSC_EXPORT_TIMEOUT).send("/live/song/export/latency")
    output_path = Path(response["args"][0]) if response and response["args"] else REPORT_PATH

    deadline = time.time() + REPORT_POLL_TIMEOUT
    while time.time() < deadline:
        if output_path.exists() and output_path.stat().st_mtime > before_time:
            break
        time.sleep(REPORT_POLL_INTERVAL)

    if not output_path.exists():
        raise FileNotFoundError("AbletonOSC did not create the latency report.")

    with output_path.open() as fh:
        report = json.load(fh)

    # If AbletonOSC handler couldn't provide buffer_size, fall back to CoreAudio
    if not isinstance(report.get("buffer_size"), (int, float)) or report.get("buffer_size", 0) <= 0:
        report["buffer_size"] = _get_coreaudio_buffer_size()

    current_project = _get_current_live_set()
    if current_project:
        report["project"] = current_project
    report["timestamp"] = datetime.now(timezone.utc).isoformat()

    try:
        CACHED_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CACHED_REPORT_PATH.open("w") as fh_cache:
            json.dump(report, fh_cache, indent=2)
    except Exception as exc:
        print(f"Writing latency report to cache failed (non-fatal): {exc}")

    return summarize_report(report)


def load_cached_report():
    global _report_cache
    try:
        mtime_ns = CACHED_REPORT_PATH.stat().st_mtime_ns
        cache_path = str(CACHED_REPORT_PATH)
        if _report_cache["path"] == cache_path and _report_cache["mtime_ns"] == mtime_ns:
            return _report_cache["report"]
        with CACHED_REPORT_PATH.open() as fh:
            report = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    processed = summarize_report(report)
    _report_cache = {"path": cache_path, "mtime_ns": mtime_ns, "report": processed}
    return processed


def compare_reports(baseline, current):
    if not baseline or not current:
        return None
    
    # Check if they are from the same project
    proj_base = baseline.get("project")
    proj_curr = current.get("project")
    
    # If one has project info and the other doesn't, they are different.
    # If both have no project info, we can assume they are the same (e.g. if project detection is disabled/fails)
    if (proj_base is None) != (proj_curr is None):
        return None
        
    if proj_base and proj_curr:
        base_path = proj_base.get("path")
        curr_path = proj_curr.get("path")
        if base_path and curr_path:
            if base_path != curr_path:
                return None
        else:
            base_name = proj_base.get("name")
            curr_name = proj_curr.get("name")
            if base_name != curr_name:
                return None

    # Calculate PDC Change
    base_pdc = float(baseline.get("pdc_latency_ms") or 0)
    curr_pdc = float(current.get("pdc_latency_ms") or 0)
    pdc_delta = curr_pdc - base_pdc
    
    pdc_change_label = "No change"
    pdc_change_status = "neutral"
    
    if pdc_delta < -0.05:
        pdc_change_label = f"Improved by {abs(pdc_delta):.1f} ms"
        pdc_change_status = "improved"
    elif pdc_delta > 0.05:
        pdc_change_label = f"Worsened by {pdc_delta:.1f} ms"
        pdc_change_status = "worsened"
    elif abs(pdc_delta) > 0.005:
        if pdc_delta < 0:
            pdc_change_label = f"Improved by {abs(pdc_delta):.2f} ms"
            pdc_change_status = "improved"
        else:
            pdc_change_label = f"Worsened by {pdc_delta:.2f} ms"
            pdc_change_status = "worsened"
            
    # Whether the suggested fix improved the bottleneck
    prev_bottleneck = baseline.get("bottleneck_track")
    bottleneck_improved = False
    bottleneck_message = "No previous bottleneck track detected"
    bottleneck_status = "neutral"
    
    if prev_bottleneck:
        prev_track_index = prev_bottleneck.get("track_index")
        prev_track_name = prev_bottleneck.get("track_name")
        prev_latency = float(prev_bottleneck.get("total_latency_ms") or 0)
        
        # Find the track in the current report
        curr_track = None
        for t in current.get("tracks_summary", []):
            if t.get("track_index") == prev_track_index:
                curr_track = t
                break
                
        curr_latency = float(curr_track.get("total_latency_ms") or 0) if curr_track else 0.0
        track_delta = curr_latency - prev_latency
        
        if track_delta < -0.05:
            bottleneck_improved = True
            bottleneck_message = f"Improved bottleneck track “{prev_track_name}” by {abs(track_delta):.1f} ms"
            bottleneck_status = "improved"
        elif track_delta > 0.05:
            bottleneck_improved = False
            bottleneck_message = f"Worsened bottleneck track “{prev_track_name}” by {track_delta:.1f} ms"
            bottleneck_status = "worsened"
        elif abs(track_delta) > 0.005:
            if track_delta < 0:
                bottleneck_improved = True
                bottleneck_message = f"Improved bottleneck track “{prev_track_name}” by {abs(track_delta):.2f} ms"
                bottleneck_status = "improved"
            else:
                bottleneck_improved = False
                bottleneck_message = f"Worsened bottleneck track “{prev_track_name}” by {track_delta:.2f} ms"
                bottleneck_status = "worsened"
        else:
            bottleneck_improved = False
            bottleneck_message = f"No change on bottleneck track “{prev_track_name}”"
            bottleneck_status = "neutral"
            
    # Added/Removed latency-inducing devices
    base_devices = baseline.get("devices", [])
    curr_devices = current.get("devices", [])
    
    base_unmatched = list(base_devices)
    curr_unmatched = list(curr_devices)
    
    added_devices = []
    removed_devices = []
    
    # 1st pass: exact match (track_index, track_name, device_name, latency_samples)
    for i in range(len(curr_unmatched) - 1, -1, -1):
        curr = curr_unmatched[i]
        match_idx = -1
        for j, prev in enumerate(base_unmatched):
            if (prev.get("track_index") == curr.get("track_index") and
                prev.get("track_name") == curr.get("track_name") and
                prev.get("device_name") == curr.get("device_name") and
                prev.get("latency_samples") == curr.get("latency_samples")):
                match_idx = j
                break
        if match_idx >= 0:
            base_unmatched.pop(match_idx)
            curr_unmatched.pop(i)
            
    # 2nd pass: loose match (track_index, track_name, device_name) - to find changed ones
    for i in range(len(curr_unmatched) - 1, -1, -1):
        curr = curr_unmatched[i]
        match_idx = -1
        for j, prev in enumerate(base_unmatched):
            if (prev.get("track_index") == curr.get("track_index") and
                prev.get("track_name") == curr.get("track_name") and
                prev.get("device_name") == curr.get("device_name")):
                match_idx = j
                break
        if match_idx >= 0:
            base_unmatched.pop(match_idx)
            curr_unmatched.pop(i)
            
    # Any remaining in curr_unmatched are added
    for d in curr_unmatched:
        added_devices.append({
            "device_name": d.get("device_name") or "Unnamed Device",
            "track_name": d.get("track_name") or "Unnamed Track",
            "latency_ms": float(d.get("latency_ms") or 0),
            "latency_samples": int(d.get("latency_samples") or 0)
        })
        
    # Any remaining in base_unmatched are removed
    for d in base_unmatched:
        removed_devices.append({
            "device_name": d.get("device_name") or "Unnamed Device",
            "track_name": d.get("track_name") or "Unnamed Track",
            "latency_ms": float(d.get("latency_ms") or 0),
            "latency_samples": int(d.get("latency_samples") or 0)
        })
        
    # Changed tracks and plugins
    changed_tracks = []
    changed_plugins = []
    
    # Match tracks by index
    base_tracks = {t.get("track_index"): t for t in baseline.get("tracks_summary", [])}
    curr_tracks = {t.get("track_index"): t for t in current.get("tracks_summary", [])}
    
    for idx, curr_t in curr_tracks.items():
        if idx in base_tracks:
            base_t = base_tracks[idx]
            latency_diff = float(curr_t.get("total_latency_ms", 0)) - float(base_t.get("total_latency_ms", 0))
            device_diff = int(curr_t.get("device_count", 0)) - int(base_t.get("device_count", 0))
            if abs(latency_diff) > 0.005 or device_diff != 0:
                changed_tracks.append({
                    "track_name": curr_t.get("track_name") or "Unnamed Track",
                    "track_index": idx,
                    "old_latency_ms": float(base_t.get("total_latency_ms") or 0),
                    "new_latency_ms": float(curr_t.get("total_latency_ms") or 0),
                    "old_device_count": int(base_t.get("device_count") or 0),
                    "new_device_count": int(curr_t.get("device_count") or 0),
                })
                
    # Match plugins by key
    def get_plugin_group_key(p):
        return f"{p.get('device_name')}|{p.get('format')}"
        
    base_plugins = {get_plugin_group_key(p): p for p in baseline.get("plugins", [])}
    curr_plugins = {get_plugin_group_key(p): p for p in current.get("plugins", [])}
    
    for key, curr_p in curr_plugins.items():
        if key in base_plugins:
            base_p = base_plugins[key]
            latency_diff = float(curr_p.get("max_latency_ms", 0)) - float(base_p.get("max_latency_ms", 0))
            count_diff = int(curr_p.get("instance_count", 0)) - int(base_p.get("instance_count", 0))
            if abs(latency_diff) > 0.005 or count_diff != 0:
                changed_plugins.append({
                    "device_name": curr_p.get("device_name") or "Unnamed Device",
                    "format": curr_p.get("format") or "Unknown",
                    "old_max_latency_ms": float(base_p.get("max_latency_ms") or 0),
                    "new_max_latency_ms": float(curr_p.get("max_latency_ms") or 0),
                    "old_instance_count": int(base_p.get("instance_count") or 0),
                    "new_instance_count": int(curr_p.get("instance_count") or 0),
                })
                
    return {
        "pdc_change_label": pdc_change_label,
        "pdc_change_status": pdc_change_status,
        "pdc_delta_ms": pdc_delta,
        "bottleneck_improved": bottleneck_improved,
        "bottleneck_message": bottleneck_message,
        "bottleneck_status": bottleneck_status,
        "added_devices": added_devices,
        "removed_devices": removed_devices,
        "changed_tracks": changed_tracks,
        "changed_plugins": changed_plugins,
    }


def scan_error_payload(message, code, status_code=502, status=None):
    status = copy.deepcopy(status or _last_status_payload or {})
    cached = load_cached_report()
    payload = {
        "error": message,
        "code": code,
        "connection_state": "scan_failed",
        "underlying_connection_state": status.get("connection_state"),
        "diagnostics": status.get("diagnostics"),
        "recovery_actions": RECOVERY_ACTIONS["scan_failed"],
    }
    if payload["diagnostics"]:
        payload["diagnostics"]["state"] = "scan_failed"
        payload["diagnostics"]["underlying_state"] = status.get("connection_state")
        payload["diagnostics"]["recovery_actions"] = RECOVERY_ACTIONS["scan_failed"]
    if cached:
        payload["cached_report"] = cached
    return status_code, payload


PLUGIN_FORMAT_LABELS = (
    "audio unit",
    "au",
    "vst",
    "vst2",
    "vst3",
    "vst/vst3",
)


PLUGIN_NAME_ALIASES = {
    "fabfilter pro-q 3": "pro-q 3",
    "fabfilter pro-q 4": "pro-q 4",
    "fabfilter pro-q": "pro-q",
    "fabfilter pro-c 2": "pro-c 2",
    "fabfilter pro-c": "pro-c",
    "fabfilter pro-l 2": "pro-l 2",
    "fabfilter pro-l": "pro-l",
    "fabfilter pro-mb": "pro-mb",
    "fabfilter pro-ds": "pro-ds",
    "fabfilter pro-g": "pro-g",
    "fabfilter pro-r": "pro-r",
    "fabfilter saturn 2": "saturn 2",
    "fabfilter saturn": "saturn",
    "fabfilter timeless 3": "timeless 3",
    "fabfilter timeless 2": "timeless 2",
    "fabfilter timeless": "timeless",
    "fabfilter volcano 3": "volcano 3",
    "fabfilter volcano 2": "volcano 2",
    "fabfilter volcano": "volcano",
    "fabfilter twin 3": "twin 3",
    "fabfilter twin 2": "twin 2",
    "fabfilter twin": "twin",
    "fabfilter one": "one",
    "fabfilter simplon": "simplon",
    "fabfilter micro": "micro",
}

_VERSION_BUILD_RE = [
    (re.compile(r"\bv\d+(?:\.\d+)*\b", re.IGNORECASE), ""),
    (re.compile(r"\b\d+(?:\.\d+)+\b"), ""),
    (re.compile(r"\bx(?:64|86)\b", re.IGNORECASE), ""),
    (re.compile(r"\(\d{2}-bit\)", re.IGNORECASE), ""),
    (re.compile(r"\s*\(build\s+\d+\)", re.IGNORECASE), ""),
]


def normalize_plugin_name(name):
    normalized = str(name or "Unnamed Device").strip().lower()

    for pattern, repl in _VERSION_BUILD_RE:
        normalized = pattern.sub(repl, normalized)

    normalized = " ".join(normalized.split())

    format_stripped = normalized
    for label in PLUGIN_FORMAT_LABELS:
        format_stripped = format_stripped.removesuffix(f" ({label})").removesuffix(f" [{label}]")
        format_stripped = format_stripped.removesuffix(f" - {label}").removesuffix(f" {label}")
    format_stripped = " ".join(format_stripped.split())
    if format_stripped in PLUGIN_NAME_ALIASES:
        normalized = PLUGIN_NAME_ALIASES[format_stripped]

    for label in PLUGIN_FORMAT_LABELS:
        normalized = normalized.removesuffix(f" ({label})").removesuffix(f" [{label}]")
        normalized = normalized.removesuffix(f" - {label}").removesuffix(f" {label}")

    return " ".join(normalized.split()) or "unnamed device"


def normalize_plugin_key(device):
    return normalize_plugin_name(device.get("device_name"))


TRACK_KIND_LABELS = {
    "audio": "Audio track",
    "group": "Group",
    "instrument": "Instrument track",
    "return": "Return track",
    "unknown": "Unknown track",
}


def _device_type_value(device):
    try:
        return int(device.get("type"))
    except (TypeError, ValueError):
        return None


def _infer_track_kind(track, devices):
    name = str(track.get("name") or "").strip()
    lowered = name.lower()
    device_types = {_device_type_value(device) for device in devices}

    if 1 in device_types:
        return "instrument", "device_type"

    if len(name) == 1 and name.isalpha() and name.isupper():
        return "return", "name"

    if "midi" in lowered or "instrument" in lowered:
        return "instrument", "name"

    if "audio" in lowered:
        return "audio", "name"

    if any(token in lowered for token in ("group", "bus", "buss", "submaster", "stem")):
        return "group", "name"

    if devices or 2 in device_types:
        return "audio", "device_type"

    return "unknown", "fallback"


def annotate_track_kinds(report):
    tracks = report.get("tracks", [])
    devices = report.get("devices", [])
    devices_by_track = defaultdict(list)
    for device in devices:
        devices_by_track[device.get("track_index")].append(device)

    track_kinds = {}
    for track in tracks:
        kind, source = _infer_track_kind(track, devices_by_track.get(track.get("index"), []))
        track["track_kind"] = kind
        track["track_kind_label"] = TRACK_KIND_LABELS[kind]
        track["track_kind_source"] = source
        track_kinds[track.get("index")] = (kind, source)

    for device in devices:
        kind, source = track_kinds.get(device.get("track_index"), ("unknown", "fallback"))
        device["track_kind"] = kind
        device["track_kind_label"] = TRACK_KIND_LABELS[kind]
        device["track_kind_source"] = source


def summarize_report(report):
    annotate_track_kinds(report)
    groups = {}
    devices = report.get("devices", [])
    for device in devices:
        key = normalize_plugin_key(device)
        group = groups.setdefault(
            key,
            {
                "device_name": device.get("device_name") or "Unnamed Device",
                "class_name": device.get("class_name") or "Unknown",
                "format": device.get("format") or "Unknown",
                "class_names": [],
                "formats": [],
                "instance_count": 0,
                "max_latency_samples": 0,
                "max_latency_ms": 0,
                "total_latency_samples": 0,
                "total_latency_ms": 0,
                "active_count": 0,
                "unknown_active_count": 0,
                "latency_available": False,
                "tracks": [],
                "instances": [],
            },
        )

        samples = int(device.get("latency_samples") or 0)
        ms = float(device.get("latency_ms") or 0)
        class_name = device.get("class_name") or "Unknown"
        format_name = device.get("format") or "Unknown"
        if class_name not in group["class_names"]:
            group["class_names"].append(class_name)
        if format_name not in group["formats"]:
            group["formats"].append(format_name)
        group["class_name"] = " / ".join(group["class_names"])
        group["format"] = " / ".join(group["formats"])
        group["instance_count"] += 1
        group["max_latency_samples"] = max(group["max_latency_samples"], samples)
        group["max_latency_ms"] = max(group["max_latency_ms"], ms)
        group["total_latency_samples"] += samples
        group["total_latency_ms"] += ms
        group["latency_available"] = group["latency_available"] or bool(device.get("latency_available"))
        if device.get("active") is True:
            group["active_count"] += 1
        elif device.get("active") is None:
            group["unknown_active_count"] += 1

        track_label = device.get("track_name") or "Unnamed Track"
        instance = dict(device)
        try:
            instance["track_number"] = int(device.get("track_index")) + 1
        except (TypeError, ValueError):
            instance["track_number"] = None
        if track_label not in group["tracks"]:
            group["tracks"].append(track_label)
        group["instances"].append(instance)

    for group in groups.values():
        group["impact_score"] = round(group["max_latency_ms"] * group["instance_count"], 3)

    ranked = sorted(
        groups.values(),
        key=lambda item: (
            item["impact_score"],
            item["max_latency_samples"],
            item["total_latency_samples"],
            item["instance_count"],
        ),
        reverse=True,
    )

    report["plugins"] = ranked
    report["top_plugins"] = ranked[:10]
    report["latency_device_count"] = len([d for d in devices if int(d.get("latency_samples") or 0) > 0])
    cumulative_samples = sum(int(d.get("latency_samples") or 0) for d in devices)
    cumulative_ms = round(sum(float(d.get("latency_ms") or 0) for d in devices), 3)
    # Backward-compatible names: these are cumulative across every track, not PDC overhead.
    report["total_latency_samples"] = cumulative_samples
    report["total_latency_ms"] = cumulative_ms
    report["cumulative_latency_samples"] = cumulative_samples
    report["cumulative_latency_ms"] = cumulative_ms

    tracks = {}
    for device in devices:
        track_index = device.get("track_index")
        key = (str(track_index), device.get("track_name") or "Unnamed Track")
        summary = tracks.setdefault(key, {
            "track_name": device.get("track_name") or "Unnamed Track",
            "track_index": track_index,
            "track_kind": device.get("track_kind") or "unknown",
            "track_kind_label": device.get("track_kind_label") or TRACK_KIND_LABELS["unknown"],
            "total_latency_samples": 0,
            "total_latency_ms": 0,
            "device_count": 0,
            "is_bottleneck": False,
        })
        summary["total_latency_samples"] += int(device.get("latency_samples") or 0)
        summary["total_latency_ms"] += float(device.get("latency_ms") or 0)
        summary["device_count"] += 1

    tracks_summary = sorted(
        tracks.values(),
        key=lambda item: (item["total_latency_samples"], item["total_latency_ms"], item["device_count"]),
        reverse=True,
    )
    for item in tracks_summary:
        item["total_latency_ms"] = round(item["total_latency_ms"], 3)
    bottleneck = tracks_summary[0] if tracks_summary else None
    if bottleneck:
        bottleneck["is_bottleneck"] = True
    report["tracks_summary"] = tracks_summary
    report["bottleneck_track"] = dict(bottleneck) if bottleneck else None
    report["pdc_latency_samples"] = bottleneck["total_latency_samples"] if bottleneck else 0
    report["pdc_latency_ms"] = bottleneck["total_latency_ms"] if bottleneck else 0
    report["recommendations"] = generate_recommendations(report)
    _build_signal_path(report)
    return report


def _build_track_slots(track_devices):
    # 1. Separate top-level and nested devices
    top_level = []
    nested = []
    
    for d in track_devices:
        path = d.get("path") or []
        if len(path) <= 1:
            top_level.append(d)
        else:
            nested.append(d)
            
    # Sort top-level by device_index
    top_level.sort(key=lambda x: x.get("device_index") or 0)
    
    slots = []
    slots_by_name = {}
    
    for d in top_level:
        slot = {
            "type": "device",
            "device_name": d.get("device_name") or "Unnamed Device",
            "class_name": d.get("class_name"),
            "format": d.get("format"),
            "latency_samples": d.get("latency_samples") or 0,
            "latency_ms": d.get("latency_ms") or 0.0,
            "active": d.get("active"),
            "latency_available": d.get("latency_available", True),
            "device_index": d.get("device_index"),
        }
        slots.append(slot)
        slots_by_name[d.get("device_name")] = slot
        
    # Group nested devices under parent Rack
    for d in nested:
        path = d.get("path") or []
        parent_name = path[0]
        
        if parent_name not in slots_by_name:
            # Create a placeholder Rack slot
            parent_slot = {
                "type": "rack",
                "device_name": parent_name,
                "class_name": "AudioEffectGroupDevice", # fallback
                "format": "Live Device",
                "latency_samples": 0,
                "latency_ms": 0.0,
                "active": True,
                "latency_available": True,
                "device_index": d.get("device_index") or 0,
                "chains": {}
            }
            slots.append(parent_slot)
            slots_by_name[parent_name] = parent_slot
            
        parent_slot = slots_by_name[parent_name]
        parent_slot["type"] = "rack"
        if "chains" not in parent_slot:
            parent_slot["chains"] = {}
            
        chain_name = path[1] if len(path) >= 2 else "Chain"
        
        # Check if chain_index/chain_name is genuinely supplied in nested device
        chain_index = d.get("chain_index")
        chain_name_opt = d.get("chain_name") or chain_name
        
        if chain_name_opt not in parent_slot["chains"]:
            parent_slot["chains"][chain_name_opt] = {
                "chain_name": chain_name_opt,
                "chain_index": chain_index, # preserved only when genuinely supplied
                "devices": []
            }
            
        nested_device = {
            "device_name": d.get("device_name") or "Unnamed Device",
            "class_name": d.get("class_name"),
            "format": d.get("format"),
            "latency_samples": d.get("latency_samples") or 0,
            "latency_ms": d.get("latency_ms") or 0.0,
            "active": d.get("active"),
            "latency_available": d.get("latency_available", True),
            "device_index": d.get("device_index") or 0,
            "chain_index": chain_index, # preserved only when genuinely supplied
            "chain_name": d.get("chain_name") # preserved only when genuinely supplied
        }
        parent_slot["chains"][chain_name_opt]["devices"].append(nested_device)
        
    # Post-process Rack slots to convert chains dict to a list
    for slot in slots:
        if slot["type"] == "rack":
            chains_list = []
            for c_name, c_data in slot["chains"].items():
                c_data["devices"].sort(key=lambda x: x.get("device_index") or 0)
                chains_list.append(c_data)
                
            # Sort chains: use chain_index if present, otherwise by chain_name
            chains_list.sort(key=lambda x: (x["chain_index"] if x.get("chain_index") is not None else -1, x["chain_name"]))
            slot["chains"] = chains_list
            
            # Latency of the Rack is the maximum latency of its parallel chains
            rack_samples = 0
            rack_ms = 0.0
            for chain in chains_list:
                chain_samples = sum(dev.get("latency_samples") or 0 for dev in chain["devices"])
                chain_ms = sum(dev.get("latency_ms") or 0.0 for dev in chain["devices"])
                rack_samples = max(rack_samples, chain_samples)
                rack_ms = max(rack_ms, chain_ms)
                
            slot["rack_internal_latency_samples"] = rack_samples
            slot["rack_internal_latency_ms"] = round(rack_ms, 3)
            
    # Sort slots by device_index
    slots.sort(key=lambda x: x.get("device_index") or 0)
    return slots


def _build_signal_path(report):
    tracks = report.get("tracks") or []
    devices = report.get("devices") or []
    
    # 1. Group devices by track_index
    devices_by_track = defaultdict(list)
    for device in devices:
        t_idx = device.get("track_index")
        if t_idx is not None:
            devices_by_track[t_idx].append(device)
            
    # 2. Extract and classify tracks
    structured_tracks = []
    structured_returns = []
    structured_main = None
    
    bottleneck_track = report.get("bottleneck_track")
    bottleneck_idx = bottleneck_track.get("track_index") if bottleneck_track else None
    
    for track in tracks:
        t_idx = track.get("index")
        t_name = track.get("name") or "Unnamed Track"
        
        # Check track kinds/types
        t_kind = track.get("track_kind") or "unknown"
        t_type = track.get("track_type") # only use if genuinely supplied
        
        is_main = False
        is_return = False
        
        if t_type is not None:
            if str(t_type).lower() == "master" or t_type == 4:
                is_main = True
            elif str(t_type).lower() == "return" or t_type == 3:
                is_return = True
        else:
            if t_kind == "return" or (len(t_name) == 1 and t_name.isalpha() and t_name.isupper()):
                is_return = True
            elif t_name.lower() in ("master", "main") or t_kind == "master":
                is_main = True
                
        # Build device chain (slots) for this track
        track_devices = devices_by_track.get(t_idx, [])
        slots = _build_track_slots(track_devices)
        
        # Calculate accumulated latency
        accum_samples = 0
        accum_ms = 0.0
        for slot in slots:
            slot_samples = slot.get("latency_samples") or 0
            slot_ms = slot.get("latency_ms") or 0.0
            
            if slot.get("type") == "rack":
                slot_samples += slot.get("rack_internal_latency_samples") or 0
                slot_ms += slot.get("rack_internal_latency_ms") or 0.0
                
            accum_samples += slot_samples
            accum_ms += slot_ms
            
            slot["accumulated_samples"] = accum_samples
            slot["accumulated_ms"] = round(accum_ms, 3)
            
        is_bottleneck = (t_idx == bottleneck_idx) if t_idx is not None else False
        
        # Preserving routing fields only if genuinely supplied in track/devices
        output_routing = track.get("output_routing") or track.get("output_track_index")
        routing_label = None
        if output_routing is not None:
            dest_track = next((t for t in tracks if t.get("index") == output_routing), None)
            if dest_track:
                routing_label = dest_track.get("name") or f"Track {output_routing}"
            else:
                routing_label = "Main" if str(output_routing).lower() == "main" else f"Track {output_routing}"
        
        parent_track_idx = track.get("parent_track_index") or track.get("group_track_index")
        group_track_name = None
        if parent_track_idx is not None:
            parent_track = next((t for t in tracks if t.get("index") == parent_track_idx), None)
            if parent_track:
                group_track_name = parent_track.get("name")
                
        track_data = {
            "index": t_idx,
            "name": t_name,
            "track_kind": t_kind,
            "track_kind_label": track.get("track_kind_label") or "Track",
            "track_type": t_type, # preserved only when genuinely supplied
            "device_count": len(track_devices),
            "total_latency_samples": track.get("latency_samples") or 0,
            "total_latency_ms": round(float((track.get("latency_samples") or 0) / report.get("sample_rate", 44100) * 1000), 3) if track.get("latency_samples") is not None else 0.0,
            "slots": slots,
            "is_bottleneck": is_bottleneck,
            "output_routing": output_routing,
            "routing_label": routing_label,
            "parent_track_index": parent_track_idx,
            "group_track_name": group_track_name
        }
        
        if "latency_ms" in track:
            track_data["total_latency_ms"] = float(track["latency_ms"])
        elif len(slots) > 0:
            track_data["total_latency_ms"] = slots[-1]["accumulated_ms"]
            track_data["total_latency_samples"] = slots[-1]["accumulated_samples"]
            
        if is_main:
            structured_main = track_data
        elif is_return:
            structured_returns.append(track_data)
        else:
            structured_tracks.append(track_data)
            
    def _sort_key(t):
        return (not t["is_bottleneck"], -t["total_latency_samples"], t["index"] if t["index"] is not None else 0)
        
    structured_tracks.sort(key=_sort_key)
    structured_returns.sort(key=_sort_key)
    
    has_routing = any(t.get("output_routing") is not None or t.get("parent_track_index") is not None for t in structured_tracks + structured_returns)
    
    report["signal_path"] = {
        "routing_available": has_routing,
        "tracks": structured_tracks,
        "returns": structured_returns,
        "main": structured_main,
        "pdc_bottleneck_track_index": bottleneck_idx
    }



def is_numeric(val):
    if val is None or val == "":
        return False
    try:
        float(val)
        return True
    except (ValueError, TypeError):
        return False


def get_track_key(track_index, track_name):
    if track_index is not None and str(track_index).strip() != "" and not isinstance(track_index, bool):
        try:
            float(track_index)
            val = float(track_index)
            if val.is_integer():
                return f"channel:{int(val)}"
            return f"channel:{val}"
        except (ValueError, TypeError):
            pass
    name = track_name or "Unnamed Track"
    return f"channel:{name}"


def generate_recommendations(report):
    recommendations = []
    
    current_pdc_samples = report.get("pdc_latency_samples", 0)
    current_pdc_ms = report.get("pdc_latency_ms", 0.0)
    devices = report.get("devices", [])
    tracks_summary = report.get("tracks_summary", [])
    
    if current_pdc_samples > 0:
        track_latencies_samples = {}
        track_latencies_ms = {}
        for t in tracks_summary:
            t_index = t.get("track_index")
            t_name = t.get("track_name") or "Unnamed Track"
            t_key = get_track_key(t_index, t_name)
            track_latencies_samples[t_key] = t.get("total_latency_samples", 0)
            track_latencies_ms[t_key] = t.get("total_latency_ms", 0.0)
            
        bottleneck_recs = []
        
        # 1. Device recommendations
        for d in devices:
            d_samples = int(d.get("latency_samples") or 0)
            if d_samples <= 0:
                continue
            d_ms = float(d.get("latency_ms") or 0.0)
            
            t_index = d.get("track_index")
            t_name = d.get("track_name") or "Unnamed Track"
            t_key = get_track_key(t_index, t_name)
            
            # Calculate new PDC if this device is removed
            new_t_samples = max(0, track_latencies_samples.get(t_key, 0) - d_samples)
            new_t_ms = max(0.0, track_latencies_ms.get(t_key, 0.0) - d_ms)
            
            other_max_samples = max([lat for tk, lat in track_latencies_samples.items() if tk != t_key] or [0])
            other_max_ms = max([lat for tk, lat in track_latencies_ms.items() if tk != t_key] or [0.0])
            
            new_pdc_samples = max(new_t_samples, other_max_samples)
            new_pdc_ms = max(new_t_ms, other_max_ms)
            
            pdc_reduction_samples = max(0, current_pdc_samples - new_pdc_samples)
            pdc_reduction_ms = max(0.0, current_pdc_ms - new_pdc_ms)
            
            d_name = d.get("device_name") or "Unnamed Device"
            
            rec = {
                "type": "bottleneck",
                "title": f"Freeze or remove {d_name} on {t_name}",
                "message": f"Estimated PDC: {current_pdc_ms:.1f} ms → {new_pdc_ms:.1f} ms\nRescan to verify",
                "action_type": "device_removal",
                "device_name": d_name,
                "plugin_names": [d_name],
                "track_name": t_name,
                "track_index": t_index,
                "target_key": t_key,
                "latency_samples": d_samples,
                "latency_ms": d_ms,
                "original_pdc_samples": current_pdc_samples,
                "original_pdc_ms": current_pdc_ms,
                "estimated_new_pdc_samples": new_pdc_samples,
                "estimated_new_pdc_ms": new_pdc_ms,
                "estimated_pdc_reduction_samples": pdc_reduction_samples,
                "estimated_pdc_reduction_ms": pdc_reduction_ms,
            }
            bottleneck_recs.append(rec)
            
        # 2. Track recommendations
        for t in tracks_summary:
            t_samples = int(t.get("total_latency_samples") or 0)
            if t_samples <= 0:
                continue
            t_ms = float(t.get("total_latency_ms") or 0.0)
            
            t_index = t.get("track_index")
            t_name = t.get("track_name") or "Unnamed Track"
            t_key = get_track_key(t_index, t_name)
            
            # Calculate new PDC if this track is frozen (its latency becomes 0)
            other_max_samples = max([lat for tk, lat in track_latencies_samples.items() if tk != t_key] or [0])
            other_max_ms = max([lat for tk, lat in track_latencies_ms.items() if tk != t_key] or [0.0])
            
            new_pdc_samples = max(0, other_max_samples)
            new_pdc_ms = max(0.0, other_max_ms)
            
            pdc_reduction_samples = max(0, current_pdc_samples - new_pdc_samples)
            pdc_reduction_ms = max(0.0, current_pdc_ms - new_pdc_ms)
            
            rec = {
                "type": "bottleneck",
                "title": f"Freeze or flatten {t_name}",
                "message": f"Estimated PDC: {current_pdc_ms:.1f} ms → {new_pdc_ms:.1f} ms\nRescan to verify",
                "action_type": "track_freeze",
                "track_name": t_name,
                "track_index": t_index,
                "target_key": t_key,
                "latency_samples": t_samples,
                "latency_ms": t_ms,
                "original_pdc_samples": current_pdc_samples,
                "original_pdc_ms": current_pdc_ms,
                "estimated_new_pdc_samples": new_pdc_samples,
                "estimated_new_pdc_ms": new_pdc_ms,
                "estimated_pdc_reduction_samples": pdc_reduction_samples,
                "estimated_pdc_reduction_ms": pdc_reduction_ms,
            }
            bottleneck_recs.append(rec)
            
            # Sort bottleneck recommendations
        bottleneck_recs.sort(key=lambda r: (
            -r["estimated_pdc_reduction_samples"],
            -r["latency_samples"],
            r["track_index"] if r["track_index"] is not None else 999999,
            r.get("device_name", "")
        ))
        
        # Take the top 5 unique-ish bottleneck recommendations
        recommendations.extend(bottleneck_recs[:5])

    # Check format recommendations
    multi_format = [
        plugin for plugin in report.get("plugins", [])
        if any("vst" in fmt.lower() for fmt in plugin.get("formats", []))
        and any(fmt.lower() in ("au", "audio unit") for fmt in plugin.get("formats", []))
    ]
    if multi_format:
        names = ", ".join(plugin["device_name"] for plugin in multi_format[:3])
        recommendations.append({
            "type": "format",
            "title": "Compare available plugin formats",
            "message": f"{names} appear as both VST and AU. Compare reported latency before choosing a format.",
            "plugin_names": [plugin["device_name"] for plugin in multi_format[:3]],
        })
    return recommendations


def _get_last_scan_time():
    try:
        mtime = CACHED_REPORT_PATH.stat().st_mtime
        return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
    except FileNotFoundError:
        return None


def _get_current_live_set():
    live_set = _get_current_live_set_from_files()
    if live_set:
        return live_set
    return _get_current_live_set_from_window()


def _get_current_live_set_from_files():
    try:
        pids = subprocess.run(
            ["pgrep", "-x", "Live"],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.0,
        ).stdout.splitlines()
    except Exception:
        return None

    live_sets = []
    for pid in pids:
        try:
            output = subprocess.run(
                ["lsof", "-Fn", "-p", pid],
                check=True,
                capture_output=True,
                text=True,
                timeout=1.5,
            ).stdout.splitlines()
        except Exception:
            continue

        for line in output:
            if not line.startswith("n"):
                continue
            path = line[1:]
            if path.lower().endswith(".als"):
                live_sets.append(path)

    if not live_sets:
        return None

    path = live_sets[-1]
    return {
        "name": Path(path).name,
        "path": path,
    }


def _get_current_live_set_from_window():
    script = 'tell application "System Events" to tell process "Live" to get name of window 1'
    try:
        title = subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.5,
        ).stdout.strip()
    except Exception:
        return None

    if not title:
        return None

    return {
        "name": title,
        "path": "",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format, *args):
        logger.info("%s - %s", self.address_string(), format % args)

    def write_json(self, status, payload):
        payload = dict(payload)
        payload.setdefault("api_schema_version", API_SCHEMA_VERSION)
        payload.setdefault("app_id", API_APP_ID)
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _local_request(self):
        # Cross-origin fetch/XHR must send a CORS preflight before attaching
        # non-safelisted headers. Because this server never responds to OPTIONS
        # with permissive CORS headers, the preflight fails and the browser
        # blocks the real request. Plain form POSTs cannot set this header.
        return self.headers.get("X-Requested-With") == "latency-manager"

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/schema":
            self.write_json(200, {
                "schema_version": API_SCHEMA_VERSION,
                "app_id": API_APP_ID,
                "transport": "local-only",
                "endpoints": ["/api/status", "/api/scan", "/api/onboarding", "/api/last-scan", "/api/settings"],
            })
            return
        if path == "/api/status":
            self.write_json(200, build_status_payload(include_cached_report=True))
            return
        if path == "/api/onboarding":
            self.write_json(200, run_onboarding_checks())
            return
        if path == "/api/last-scan":
            cached = load_cached_report()
            self.write_json(200, {"report": cached})
            return
        if path == "/api/settings":
            self.write_json(200, load_settings())
            return
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/settings":
            if not self._local_request():
                self.write_json(403, {"error": "Forbidden", "code": "forbidden"})
                return
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                try:
                    body = self.rfile.read(content_length).decode("utf-8")
                    data = json.loads(body)
                except Exception:
                    self.write_json(400, {"error": "Invalid JSON", "code": "invalid_json"})
                    return
            else:
                data = {}

            if data.get("reset") is True:
                save_settings(DEFAULT_SETTINGS)
                self.write_json(200, load_settings())
                return

            current = load_settings()
            if "auto_refresh" in data:
                current["auto_refresh"] = data["auto_refresh"]
            if "refresh_interval" in data:
                current["refresh_interval"] = data["refresh_interval"]
            if "grouping" in data:
                current["grouping"] = data["grouping"]
            if "workflow_mode" in data:
                current["workflow_mode"] = data["workflow_mode"]

            save_settings(current)
            self.write_json(200, load_settings())
            return

        if path == "/api/scan":
            if not self._local_request():
                self.write_json(403, {"error": "Forbidden", "code": "forbidden"})
                return
            if not _scan_lock.acquire(blocking=False):
                self.write_json(429, {"error": "A scan is already in progress.", "code": "scan_in_progress"})
                return
            scan_status = copy.deepcopy(_last_status_payload or {})
            try:
                baseline = load_cached_report()
                new_report = export_latency_report()
                comparison = compare_reports(baseline, new_report)
                if comparison:
                    new_report["comparison"] = comparison
                    new_report["previous_report"] = baseline
                self.write_json(200, new_report)
            except ResponsePortConflict as exc:
                status, payload = scan_error_payload(str(exc), "response_port_conflict", status=scan_status)
                self.write_json(status, payload)
            except TimeoutError:
                status, payload = scan_error_payload(
                    "AbletonOSC is not responding. Is Ableton Live running with AbletonOSC enabled?",
                    "osc_timeout", status=scan_status,
                )
                self.write_json(status, payload)
            except ConnectionRefusedError:
                status, payload = scan_error_payload("Cannot reach AbletonOSC on port 11000.", "osc_offline", status=scan_status)
                self.write_json(status, payload)
            except FileNotFoundError:
                status, payload = scan_error_payload("Latency report file was not created by AbletonOSC.", "report_not_found", status=scan_status)
                self.write_json(status, payload)
            except json.JSONDecodeError:
                status, payload = scan_error_payload("Latency report contains invalid JSON.", "invalid_json", status=scan_status)
                self.write_json(status, payload)
            except Exception as exc:
                status, payload = scan_error_payload(str(exc), "unknown", status=scan_status)
                self.write_json(status, payload)
            finally:
                _scan_lock.release()
            return
        if path == "/api/open-ableton":
            if not self._local_request():
                self.write_json(403, {"error": "Forbidden", "code": "forbidden"})
                return
            try:
                subprocess.Popen(["open", "-a", "Ableton Live"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.write_json(200, {"ok": True})
            except Exception as exc:
                self.write_json(500, {"error": str(exc), "code": "open_failed"})
            return
        if path == "/api/reload-osc":
            if not self._local_request():
                self.write_json(403, {"error": "Forbidden", "code": "forbidden"})
                return
            try:
                reload_abletonosc()
                self.write_json(200, {"ok": True})
            except Exception as exc:
                self.write_json(502, {"error": str(exc), "code": "reload_failed"})
            return
        self.write_json(404, {"error": "Not found", "code": "not_found"})


def reload_abletonosc():
    OSCRequest(timeout=OSC_RELOAD_TIMEOUT).send("/live/api/reload")


def create_web_server(requested_port):
    ports = [requested_port]
    ports.extend(port for port in range(8800, WEB_PORT_MAX + 1) if port != requested_port)

    last_error = None
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            return server, port
        except OSError as exc:
            last_error = exc
            if exc.errno != errno.EADDRINUSE:
                raise

    raise OSError(
        "No available local ports in range %d-%d. Last bind error: %s"
        % (min(requested_port, 8800), WEB_PORT_MAX, last_error)
    )


def _read_instance_info():
    try:
        with LOCK_FILE.open() as fh:
            data = json.load(fh)
            if isinstance(data, dict):
                return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return {}


def _acquire_instance_lock(port=None, url=None):
    APP_SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_FILE, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        info = _read_instance_info()
        lock.close()
        message = "Latency is already running."
        existing_url = info.get("url")
        if existing_url:
            message = f"{message} Existing dashboard: {existing_url}"
        raise SystemExit(message)
    lock.seek(0)
    lock.truncate()
    lock.write(json.dumps({
        "pid": os.getpid(),
        "port": port,
        "url": url,
        "app": "Latency",
    }))
    lock.flush()
    return lock


def start_dashboard_server(requested_port=WEB_PORT, acquire_lock=True):
    server, port = create_web_server(requested_port)
    url = f"http://127.0.0.1:{port}"
    instance_lock = _acquire_instance_lock(port=port, url=url) if acquire_lock else None
    return server, port, url, instance_lock


def serve_dashboard(requested_port=WEB_PORT, open_browser=True):
    server, _port, url, _instance_lock = start_dashboard_server(requested_port)
    print(f"Latency running at {url}")
    if open_browser:
        subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description="Ableton Live latency dashboard")
    parser.add_argument("--reload-abletonosc", action="store_true", help="Ask AbletonOSC to reload its Python handlers")
    parser.add_argument("--port", type=int, default=WEB_PORT)
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    parser.add_argument("--verbose", action="store_true", help="Log HTTP requests and diagnostic details")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.reload_abletonosc:
        reload_abletonosc()
        print("AbletonOSC reload requested.")
        return

    serve_dashboard(requested_port=args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    main()
