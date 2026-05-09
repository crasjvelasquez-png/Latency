#!/usr/bin/env python3
import argparse
import errno
import fcntl
import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from pythonosc import dispatcher, osc_server, udp_client


ROOT = Path(__file__).resolve().parent
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
            rais

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


def run_onboarding_checks():
    checks = {}
    checks["ableton_running"] = ableton_running()

    if checks["ableton_running"]:
        checks["abletonosc_reachable"] = abletonosc_online()
    else:
        checks["abletonosc_reachable"] = False

    if checks["abletonosc_reachable"]:
        checks["handler_available"] = latency_handler_available()
    else:
        checks["handler_available"] = False

    if checks["ableton_running"]:
        checks["automation_permission"] = automation_permission_granted()
    else:
        checks["automation_permission"] = False

    checks["all_passed"] = all(v for k, v in checks.items() if k != "all_passed")
    return checks


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
        shutil.copy2(str(output_path), str(CACHED_REPORT_PATH))
    except Exception:
        print(f"Copying latency report to cache failed (non-fatal): {CACHED_REPORT_PATH}")

    return summarize_report(report)


PLUGIN_FORMAT_LABELS = (
    "audio unit",
    "au",
    "vst",
    "vst2",
    "vst3",
    "vst/vst3",
)


def normalize_plugin_name(name):
    normalized = str(name or "Unnamed Device").strip().lower()
    for label in PLUGIN_FORMAT_LABELS:
        normalized = normalized.removesuffix(f" ({label})").removesuffix(f" [{label}]")
        normalized = normalized.removesuffix(f" - {label}").removesuffix(f" {label}")
    return " ".join(normalized.split()) or "unnamed device"


def normalize_plugin_key(device):
    return normalize_plugin_name(device.get("device_name"))


def summarize_report(report):
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

    ranked = sorted(
        groups.values(),
        key=lambda item: (
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
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
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
        if path == "/api/status":
            live_running = ableton_running()
            osc_online, osc_error = _abletonosc_check() if live_running else (False, None)
            payload = {
                "live_running": live_running,
                "abletonosc_online": osc_online,
                "latency_handler_available": latency_handler_available() if osc_online else False,
                "automation_permission": automation_permission_granted() if live_running else False,
                "report_exists": CACHED_REPORT_PATH.exists(),
                "last_scan_time": _get_last_scan_time(),
                "current_project": _get_current_live_set(),
            }
            if osc_error:
                payload["abletonosc_error"] = osc_error
            self.write_json(200, payload)
            return
        if path == "/api/onboarding":
            self.write_json(200, run_onboarding_checks())
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
                self.write_json(502, {"error": str(exc), "code": "response_port_conflict"})
            except TimeoutError:
                self.write_json(502, {"error": "AbletonOSC is not responding. Is Ableton Live running with AbletonOSC enabled?", "code": "osc_timeout"})
            except ConnectionRefusedError:
                self.write_json(502, {"error": "Cannot reach AbletonOSC on port 11000.", "code": "osc_offline"})
            except FileNotFoundError:
                self.write_json(502, {"error": "Latency report file was not created by AbletonOSC.", "code": "report_not_found"})
            except json.JSONDecodeError:
                self.write_json(502, {"error": "Latency report contains invalid JSON.", "code": "invalid_json"})
            except Exception as exc:
                self.write_json(502, {"error": str(exc), "code": "unknown"})
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


def _acquire_instance_lock():
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise SystemExit(
            "LatencyManager is already running. "
            "Quit the existing instance before starting a new one."
        )
    lock.write(str(os.getpid()))
    lock.flush()
    return lock


def main():
    parser = argparse.ArgumentParser(description="Ableton Live latency dashboard")
    parser.add_argument("--reload-abletonosc", action="store_true", help="Ask AbletonOSC to reload its Python handlers")
    parser.add_argument("--port", type=int, default=WEB_PORT)
    args = parser.parse_args()

    if args.reload_abletonosc:
        reload_abletonosc()
        print("AbletonOSC reload requested.")
        return

    APP_SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
    _instance_lock = _acquire_instance_lock()  # noqa: F841 — held for process lifetime

    os.chdir(STATIC_DIR)
    server, port = create_web_server(args.port)
    print(f"LatencyManager running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
