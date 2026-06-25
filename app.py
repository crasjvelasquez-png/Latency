#!/usr/bin/env python3
import argparse
import ctypes
import ctypes.util
import errno
import fcntl
import json
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
ABLETONOSC_HOST = "127.0.0.1"
ABLETONOSC_PORT = 11000
RESPONSE_PORT = 11001
WEB_PORT = 8799
WEB_PORT_MAX = 8899
API_SCHEMA_VERSION = 1
API_APP_ID = "latency-manager"

_scan_lock = threading.Lock()


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


def abletonosc_online():
    try:
        OSCRequest(timeout=0.6).send("/live/test")
        return True
    except Exception:
        return False


def _abletonosc_check():
    """Returns (is_online, error_code_or_None) — distinguishes port conflicts from offline."""
    try:
        OSCRequest(timeout=0.6).send("/live/test")
        return True, None
    except ResponsePortConflict:
        return False, "port_conflict"
    except Exception:
        return False, None


def ableton_running():
    try:
        result = subprocess.run(
            ["pgrep", "-x", "Live"],
            capture_output=True, text=True, timeout=1.0,
        )
        return result.returncode == 0
    except Exception:
        return False


def latency_handler_available():
    try:
        OSCRequest(timeout=2.0).send("/live/song/export/latency")
        return True
    except RuntimeError:
        return False


def _latency_handler_check(osc_online):
    if not osc_online:
        return False, None
    try:
        OSCRequest(timeout=2.0).send("/live/song/export/latency")
        return True, None
    except ResponsePortConflict:
        return False, "response_port_conflict"
    except RuntimeError as exc:
        return False, str(exc) or "Latency export handler is unavailable."
    except TimeoutError:
        return False, "Timed out waiting for the latency export handler."
    except Exception as exc:
        return False, str(exc) or "Latency export handler is unavailable."
    except (TimeoutError, Exception):
        return False


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
    response = OSCRequest(timeout=5.0).send("/live/song/export/latency")
    output_path = Path(response["args"][0]) if response and response["args"] else REPORT_PATH

    deadline = time.time() + 3.0
    while time.time() < deadline:
        if output_path.exists() and output_path.stat().st_mtime > before_time:
            break
        time.sleep(0.05)

    if not output_path.exists():
        raise FileNotFoundError("AbletonOSC did not create the latency report.")

    with output_path.open() as fh:
        report = json.load(fh)

    try:
        CACHED_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(output_path), str(CACHED_REPORT_PATH))
    except Exception:
        print(f"Copying latency report to cache failed (non-fatal): {CACHED_REPORT_PATH}")

    # If AbletonOSC handler couldn't provide buffer_size, fall back to CoreAudio
    if not isinstance(report.get("buffer_size"), (int, float)) or report.get("buffer_size", 0) <= 0:
        report["buffer_size"] = _get_coreaudio_buffer_size()

    return summarize_report(report)


def load_cached_report():
    try:
        with CACHED_REPORT_PATH.open() as fh:
            report = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return summarize_report(report)


def scan_error_payload(message, code, status_code=502):
    status = build_status_payload(include_cached_report=True)
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
    if status.get("cached_report"):
        payload["cached_report"] = status["cached_report"]
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
    report["total_latency_samples"] = sum(int(d.get("latency_samples") or 0) for d in devices)
    report["total_latency_ms"] = round(sum(float(d.get("latency_ms") or 0) for d in devices), 3)
    return report


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
        return

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
                "endpoints": ["/api/status", "/api/scan", "/api/onboarding", "/api/last-scan"],
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
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/scan":
            if not self._local_request():
                self.write_json(403, {"error": "Forbidden", "code": "forbidden"})
                return
            if not _scan_lock.acquire(blocking=False):
                self.write_json(429, {"error": "A scan is already in progress.", "code": "scan_in_progress"})
                return
            try:
                self.write_json(200, export_latency_report())
            except ResponsePortConflict as exc:
                status, payload = scan_error_payload(str(exc), "response_port_conflict")
                self.write_json(status, payload)
            except TimeoutError:
                status, payload = scan_error_payload(
                    "AbletonOSC is not responding. Is Ableton Live running with AbletonOSC enabled?",
                    "osc_timeout",
                )
                self.write_json(status, payload)
            except ConnectionRefusedError:
                status, payload = scan_error_payload("Cannot reach AbletonOSC on port 11000.", "osc_offline")
                self.write_json(status, payload)
            except FileNotFoundError:
                status, payload = scan_error_payload("Latency report file was not created by AbletonOSC.", "report_not_found")
                self.write_json(status, payload)
            except json.JSONDecodeError:
                status, payload = scan_error_payload("Latency report contains invalid JSON.", "invalid_json")
                self.write_json(status, payload)
            except Exception as exc:
                status, payload = scan_error_payload(str(exc), "unknown")
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
    OSCRequest(timeout=3.0).send("/live/api/reload")


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
    args = parser.parse_args()

    if args.reload_abletonosc:
        reload_abletonosc()
        print("AbletonOSC reload requested.")
        return

    serve_dashboard(requested_port=args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    main()
