"""
test_onboarding_gui.py — webview integration tests for onboarding UX.

Spins up the local HTTP server, opens a pywebview window at /?test=1 which
loads static/test_onboarding.js after app.js. The JS suite writes
window.testResults when done; this test polls for it and asserts all passed.
"""
import threading
import time

import pytest
import webview
from http.server import ThreadingHTTPServer

import app
from app import Handler


@pytest.fixture(scope="module")
def gui_test_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_onboarding_ui_flow(gui_test_server):
    port = gui_test_server.server_address[1]
    url = f"http://127.0.0.1:{port}/?test=1"

    test_results = {}
    error_occurred = None
    page_loaded = threading.Event()

    def on_loaded():
        page_loaded.set()

    def check_results(window):
        nonlocal error_occurred, test_results
        try:
            # Wait up to 5 s for the page (and all deferred scripts) to load.
            if not page_loaded.wait(timeout=5):
                error_occurred = "Timeout: page never fired loaded event"
                return

            # Give the JS test runner its initial delay (200 ms) plus headroom.
            time.sleep(0.5)

            # Poll for window.testResults for up to 20 s.
            for _ in range(200):
                time.sleep(0.1)
                res = window.evaluate_js("window.testResults || null")
                if res:
                    test_results = res
                    break
            else:
                # Capture any console errors to help diagnose
                hook_state = window.evaluate_js("typeof window.__onboardingTest")
                error_occurred = (
                    f"Timeout waiting for JS tests to finish. "
                    f"__onboardingTest type: {hook_state}"
                )
        except Exception as exc:
            error_occurred = str(exc)
        finally:
            window.destroy()

    window = webview.create_window(
        "Onboarding GUI Test", url, width=800, height=600
    )
    window.events.loaded += on_loaded
    webview.start(check_results, window)

    if error_occurred:
        pytest.fail(error_occurred)

    assert test_results.get("passed") is True, (
        "JS Onboarding tests failed:\n"
        + "\n".join(
            f"  {'PASSED' if d['passed'] else 'FAILED'}: {d['name']}"
            + (f"\n    → {d.get('error', '')}" if not d["passed"] else "")
            for d in test_results.get("details", [])
        )
    )

    print("\nOnboarding GUI Tests passed!")
    for detail in test_results.get("details", []):
        print(f"  ✓ {detail['name']}")
