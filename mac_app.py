#!/usr/bin/env python3
import subprocess
import sys
import threading

import webview

from app import WEB_PORT, start_dashboard_server


APP_NAME = "Latency"
APP_BUNDLE_ID = "com.c4milo.Latency"


def _activate_existing_instance():
    subprocess.Popen(
        [
            "osascript",
            "-e",
            f'tell application id "{APP_BUNDLE_ID}" to activate',
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    try:
        server, _port, url, _instance_lock = start_dashboard_server(WEB_PORT)
    except SystemExit:
        _activate_existing_instance()
        return 0

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        webview.create_window(APP_NAME, url, width=1280, height=860, min_size=(980, 680))
        webview.start(gui="cocoa")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
