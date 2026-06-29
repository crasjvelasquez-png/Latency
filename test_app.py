import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import app
from app import (
    API_APP_ID,
    API_SCHEMA_VERSION,
    Handler,
    normalize_plugin_key,
    normalize_plugin_name,
    summarize_report,
)


# ── Fixtures ──


def _base_report(**overrides):
    """Thin wrapper: returns a dict with 'devices' list, merging overrides."""
    base = {
        "devices": [],
        "sample_rate": 44100,
        "buffer_size": 256,
        "track_count": 2,
        "device_count": 2,
    }
    base.update(overrides)
    return base


def _device(**overrides):
    """Return a single device dict with sensible defaults."""
    d = {
        "device_name": "Test Plugin",
        "class_name": "VstPluginProxy",
        "format": "VST3",
        "track_name": "Track 1",
        "track_index": 0,
        "active": True,
        "latency_available": True,
        "latency_samples": 128,
        "latency_ms": 2.902,
    }
    d.update(overrides)
    return d


def _http_json(server, path, method="GET", headers=None):
    url = f"http://{server.server_address[0]}:{server.server_address[1]}{path}"
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=3) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


@pytest.fixture
def api_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def isolated_cache(tmp_path, monkeypatch):
    cache_path = tmp_path / "abletonosc-latency-report.json"
    monkeypatch.setattr(app, "CACHED_REPORT_PATH", cache_path)
    return cache_path


def _mock_status(monkeypatch, *, live=True, osc=True, handler=True, automation=True, osc_error=None):
    monkeypatch.setattr(app, "ableton_running", lambda: live)
    monkeypatch.setattr(app, "_abletonosc_check", lambda: (osc, osc_error))
    monkeypatch.setattr(app, "_latency_handler_check", lambda online: (handler if online else False, None))
    monkeypatch.setattr(app, "automation_permission_granted", lambda: automation)
    monkeypatch.setattr(app, "_get_current_live_set", lambda: {"name": "Set.als", "path": "/Sessions/Set.als"})
    monkeypatch.setattr(app, "_abletonosc_script_paths", lambda: [{"path": "/Remote Scripts/AbletonOSC", "exists": True}])


@pytest.fixture
def empty_report():
    return _base_report()


@pytest.fixture
def single_device_report():
    return _base_report(
        devices=[_device()],
        track_count=1,
        device_count=1,
    )


@pytest.fixture
def plugin_grouping_report():
    """Same plugin appearing with different format suffixes — must group."""
    return _base_report(
        devices=[
            _device(device_name="Pro-Q 3 (VST3)", format="VST3"),
            _device(device_name="Pro-Q 3 (AU)", format="Audio Unit"),
            _device(device_name="Pro-Q 3 [VST3]", format="VST3"),
            _device(device_name="Pro-Q 3 - VST3", format="VST3"),
            _device(device_name="Pro-Q 3 VST", format="VST"),
            _device(device_name="Pro-Q 3", format="AU"),
        ],
        track_count=6,
        device_count=6,
    )


@pytest.fixture
def mixed_plugin_report():
    """Multiple distinct plugins across tracks."""
    return _base_report(
        devices=[
            _device(device_name="Pro-Q 3 (VST3)", latency_samples=256, latency_ms=5.805, track_index=0, track_name="Track 1"),
            _device(device_name="Pro-Q 3 (AU)", latency_samples=0, latency_ms=0, track_index=1, track_name="Track 2"),
            _device(device_name="OTT (VST3)", latency_samples=512, latency_ms=11.610, track_index=0, track_name="Track 1"),
            _device(device_name="Serum (VST3)", latency_samples=64, latency_ms=1.451, track_index=2, track_name="Track 3"),
            _device(device_name="OTT (AU)", latency_samples=64, latency_ms=1.451, track_index=2, track_name="Track 3"),
        ],
        track_count=3,
        device_count=5,
    )


@pytest.fixture
def unknown_latency_report():
    """Devices with missing or malformed latency fields."""
    return _base_report(
        devices=[
            _device(device_name="A", latency_samples=None, latency_ms=None),
            _device(device_name="B", latency_samples="", latency_ms=""),
            _device(device_name="C", latency_samples=0, latency_ms=0),
            _device(device_name="D", latency_available=False, latency_samples=32, latency_ms=0.726),
        ],
        track_count=4,
        device_count=4,
    )


@pytest.fixture
def missing_fields_report():
    """Keys omitted entirely from device dicts."""
    return _base_report(
        devices=[
            {"device_name": "Bare"},
            _device(device_name="Full", latency_samples=64, latency_ms=1.451),
        ],
        track_count=2,
        device_count=2,
    )


@pytest.fixture
def inactive_devices_report():
    """Mix of active, inactive, and unknown-active devices — same base name so they group."""
    return _base_report(
        devices=[
            _device(device_name="Test Plugin (VST3)", active=True, latency_samples=128, latency_ms=2.902, track_index=0),
            _device(device_name="Test Plugin (AU)", active=False, latency_samples=256, latency_ms=5.805, track_index=1),
            _device(device_name="Test Plugin [VST3]", active=None, latency_samples=32, latency_ms=0.726, track_index=2),
            _device(device_name="Test Plugin", active=False, latency_samples=1024, latency_ms=23.220, track_index=3),
        ],
        track_count=4,
        device_count=4,
    )


@pytest.fixture
def stale_report(isolated_cache):
    """A report generated at a known timestamp to validate last-scan-time logic."""
    report = _base_report(
        devices=[_device(device_name="Stale Plugin", latency_samples=64, latency_ms=1.451)],
        track_count=1,
        device_count=1,
    )
    # Write it to the cache path so _get_last_scan_time can read it.
    app.CACHED_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(app.CACHED_REPORT_PATH, "w") as fh:
        json.dump(report, fh)
    return report


@pytest.fixture
def zero_latency_report():
    """All devices report zero latency."""
    return _base_report(
        devices=[
            _device(device_name="Zero A", latency_samples=0, latency_ms=0),
            _device(device_name="Zero B", latency_samples=0, latency_ms=0.0),
            _device(device_name="Zero C (VST3)", latency_samples=0, latency_ms=0),
        ],
    )


@pytest.fixture
def large_input_report():
    """Many instances that stress max / total / count logic."""
    devices = []
    for i in range(50):
        devices.append(
            _device(
                device_name="Repeated" if i % 2 == 0 else f"Unique_{i}",
                latency_samples=i * 10,
                latency_ms=round(i * 0.22, 3),
                track_index=i % 5,
            )
        )
    return _base_report(devices=devices, track_count=5, device_count=50)


@pytest.fixture
def missing_devices_report():
    """Report dict with no 'devices' key at all."""
    return {"sample_rate": 48000, "buffer_size": 512}


@pytest.fixture
def null_devices_report():
    """Report dict where 'devices' is null."""
    return {"devices": None, "sample_rate": 44100}


@pytest.fixture
def not_a_list_report():
    """Report where 'devices' is a string instead of a list."""
    return {"devices": "not-a-list", "track_count": 0}


# ── API status / scan ──


def test_api_status_reports_live_closed(api_server, isolated_cache, monkeypatch):
    _mock_status(monkeypatch, live=False, osc=False, handler=False, automation=False)
    status, payload = _http_json(api_server, "/api/status")

    assert status == 200
    assert payload["api_schema_version"] == API_SCHEMA_VERSION
    assert payload["app_id"] == API_APP_ID
    assert payload["connection_state"] == "live_closed"
    assert payload["live_running"] is False
    assert payload["diagnostics"]["state"] == "live_closed"
    assert payload["diagnostics"]["paths"]["cached_report"] == str(isolated_cache)
    assert payload["diagnostics"]["ports"]["abletonosc_port"] == app.ABLETONOSC_PORT


def test_api_status_reports_abletonosc_missing(api_server, isolated_cache, monkeypatch):
    _mock_status(monkeypatch, live=True, osc=False, handler=False, automation=True)
    status, payload = _http_json(api_server, "/api/status")

    assert status == 200
    assert payload["connection_state"] == "abletonosc_missing"
    assert payload["abletonosc_online"] is False
    assert "Install AbletonOSC" in payload["recovery_actions"][0]


def test_api_status_reports_latency_handler_missing(api_server, isolated_cache, monkeypatch):
    _mock_status(monkeypatch, live=True, osc=True, handler=False, automation=True)
    status, payload = _http_json(api_server, "/api/status")

    assert status == 200
    assert payload["connection_state"] == "latency_handler_missing"
    assert payload["latency_handler_available"] is False


def test_api_status_reports_automation_permission_missing(api_server, isolated_cache, monkeypatch):
    _mock_status(monkeypatch, live=True, osc=True, handler=True, automation=False)
    status, payload = _http_json(api_server, "/api/status")

    assert status == 200
    assert payload["connection_state"] == "automation_permission_missing"
    assert payload["diagnostics"]["permissions"]["automation"] is False


def test_api_scan_requires_local_header(api_server):
    status, payload = _http_json(api_server, "/api/scan", method="POST")

    assert status == 403
    assert payload["api_schema_version"] == API_SCHEMA_VERSION
    assert payload["code"] == "forbidden"


def test_api_schema_endpoint_documents_local_contract(api_server):
    status, payload = _http_json(api_server, "/api/schema")

    assert status == 200
    assert payload["api_schema_version"] == API_SCHEMA_VERSION
    assert payload["schema_version"] == API_SCHEMA_VERSION
    assert payload["app_id"] == API_APP_ID
    assert payload["transport"] == "local-only"
    assert "/api/status" in payload["endpoints"]


def test_api_scan_success_returns_summarized_report(api_server, isolated_cache, monkeypatch):
    report = _base_report(
        devices=[
            _device(device_name="Pro-Q 3 (VST3)", latency_samples=128, latency_ms=2.9),
            _device(device_name="Pro-Q 3 (AU)", latency_samples=64, latency_ms=1.45),
        ],
        device_count=2,
        track_count=1,
    )
    monkeypatch.setattr(app, "export_latency_report", lambda: summarize_report(report))

    status, payload = _http_json(
        api_server,
        "/api/scan",
        method="POST",
        headers={"X-Requested-With": "latency-manager"},
    )

    assert status == 200
    assert payload["total_latency_samples"] == 192
    assert len(payload["plugins"]) == 1
    assert payload["plugins"][0]["instance_count"] == 2


def test_api_scan_failure_keeps_cached_report(api_server, isolated_cache, monkeypatch):
    cached_report = _base_report(
        devices=[_device(device_name="Cached Plugin", latency_samples=256, latency_ms=5.8)],
        device_count=1,
        track_count=1,
    )
    isolated_cache.write_text(json.dumps(cached_report))
    _mock_status(monkeypatch, live=True, osc=True, handler=True, automation=True)
    app.build_status_payload()
    monkeypatch.setattr(app, "export_latency_report", lambda: (_ for _ in ()).throw(TimeoutError()))

    status, payload = _http_json(
        api_server,
        "/api/scan",
        method="POST",
        headers={"X-Requested-With": "latency-manager"},
    )

    assert status == 502
    assert payload["code"] == "osc_timeout"
    assert payload["connection_state"] == "scan_failed"
    assert payload["underlying_connection_state"] == "ready"
    assert payload["cached_report"]["plugins"][0]["device_name"] == "Cached Plugin"
    assert payload["diagnostics"]["state"] == "scan_failed"


# ── normalize_plugin_name ──


def test_normalize_strips_format_suffixes():
    assert normalize_plugin_name("Pro-Q 3 (VST3)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (AU)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (VST)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (VST2)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (VST/VST3)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (audio unit)") == "pro-q 3"


def test_normalize_strips_bracket_suffixes():
    assert normalize_plugin_name("Pro-Q 3 [VST3]") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 [AU]") == "pro-q 3"


def test_normalize_strips_dash_suffixes():
    assert normalize_plugin_name("Pro-Q 3 - VST3") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 - vst3") == "pro-q 3"


def test_normalize_strips_space_suffixes():
    assert normalize_plugin_name("Pro-Q 3 VST3") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 VST") == "pro-q 3"


def test_normalize_lowercases():
    assert normalize_plugin_name("PRO-Q 3 (VST3)") == "pro-q 3"


def test_normalize_collapses_whitespace():
    assert normalize_plugin_name("  Pro-Q   3  (VST3)  ") == "pro-q 3"


def test_normalize_empty_returns_unnamed():
    assert normalize_plugin_name("") == "unnamed device"
    assert normalize_plugin_name(None) == "unnamed device"


def test_normalize_format_only_name():
    """Name that is only a format label collapses after stripping; suffix removal leaves '(vst3)' → not 'unnamed device'."""
    assert normalize_plugin_name("(VST3)") == "(vst3)"


def test_normalize_key():
    assert normalize_plugin_key({"device_name": "Pro-Q 3 (VST3)"}) == "pro-q 3"
    assert normalize_plugin_key({}) == "unnamed device"


def test_normalize_strips_version_v_prefix():
    assert normalize_plugin_name("Plugin v2.1 (VST3)") == "plugin"
    assert normalize_plugin_name("Plugin v1.2.3.4 (AU)") == "plugin"


def test_normalize_strips_version_bare_number():
    assert normalize_plugin_name("Plugin 2.0.1 (VST3)") == "plugin"
    assert normalize_plugin_name("Plugin 1.2.3.4 (AU)") == "plugin"


def test_normalize_strips_architecture_suffix():
    assert normalize_plugin_name("Plugin x64 (VST3)") == "plugin"
    assert normalize_plugin_name("Plugin x86 (AU)") == "plugin"


def test_normalize_strips_bitness_suffix():
    assert normalize_plugin_name("Plugin (64-bit) (VST3)") == "plugin"
    assert normalize_plugin_name("Plugin (32-bit) (AU)") == "plugin"


def test_normalize_strips_build_id():
    assert normalize_plugin_name("Plugin (Build 12345) (VST3)") == "plugin"


def test_normalize_strips_build_date():
    assert normalize_plugin_name("Plugin 2024.06 (VST3)") == "plugin"


def test_normalize_alias_resolves_fabfilter():
    assert normalize_plugin_name("FabFilter Pro-Q 3") == "pro-q 3"
    assert normalize_plugin_name("FabFilter Pro-Q 3 (VST3)") == "pro-q 3"
    assert normalize_plugin_name("FabFilter Pro-Q 3 (AU)") == "pro-q 3"
    assert normalize_plugin_name("FabFilter Pro-Q 3 [VST3]") == "pro-q 3"


def test_normalize_alias_and_non_prefixed_merge():
    assert normalize_plugin_name("FabFilter Pro-Q 3 (VST3)") == "pro-q 3"
    assert normalize_plugin_name("Pro-Q 3 (VST3)") == "pro-q 3"


def test_normalize_alias_resolves_other_fabfilter():
    assert normalize_plugin_name("FabFilter Pro-C 2 (VST3)") == "pro-c 2"
    assert normalize_plugin_name("FabFilter Saturn 2") == "saturn 2"
    assert normalize_plugin_name("FabFilter Pro-L 2 (AU)") == "pro-l 2"


def test_normalize_idempotent():
    cases = [
        "Plugin v2.1 (VST3)",
        "Plugin 1.2.3.4 (AU)",
        "Plugin x64 (VST3)",
        "Plugin (64-bit) (VST3)",
        "Plugin (Build 12345) (VST3)",
        "Plugin 2024.06 (VST3)",
        "FabFilter Pro-Q 3 (VST3)",
        "FabFilter Pro-Q 3",
        "Pro-Q 3 (VST3)",
        "Pro-Q 3",
        "Pro-Q 3 - VST3",
        "Pro-Q 3 [VST3]",
        "Pro-Q 3 VST",
        "plugin",
        "pro-q 3",
        "unnamed device",
        "",
        None,
    ]
    for case in cases:
        first = normalize_plugin_name(case)
        second = normalize_plugin_name(first)
        assert first == second, f"Idempotency failed for {case!r}: {first!r} != {second!r}"


def test_normalize_combined_version_and_alias():
    assert normalize_plugin_name("FabFilter Pro-Q 3 v4.0 (VST3)") == "pro-q 3"


def test_normalize_empty_and_none_still_unnamed():
    assert normalize_plugin_name("") == "unnamed device"
    assert normalize_plugin_name(None) == "unnamed device"


# ── summarize_report: plugin grouping ──


def test_plugin_grouping_merges_suffix_variants(plugin_grouping_report):
    result = summarize_report(plugin_grouping_report)
    assert len(result["plugins"]) == 1
    group = result["plugins"][0]
    # group key is normalized ("pro-q 3") but device_name comes from the first device's raw name
    assert group["device_name"] == "Pro-Q 3 (VST3)"
    assert group["instance_count"] == 6
    assert set(group["formats"]) == {"VST3", "Audio Unit", "VST", "AU"}
    assert group["active_count"] == 6


def test_plugin_grouping_keeps_distinct_plugins_separate(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)
    names = [g["device_name"] for g in result["plugins"]]
    assert "Pro-Q 3 (VST3)" in names
    assert "OTT (VST3)" in names
    assert "Serum (VST3)" in names


def test_plugin_grouping_max_latency_per_group(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)
    ott = next(g for g in result["plugins"] if g["device_name"] == "OTT (VST3)")
    assert ott["max_latency_samples"] == 512
    assert ott["instance_count"] == 2
    assert ott["active_count"] == 2


def test_plugin_grouping_tracks_collected(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)
    ott = next(g for g in result["plugins"] if g["device_name"] == "OTT (VST3)")
    assert ott["tracks"] == ["Track 1", "Track 3"]
    assert len(ott["instances"]) == 2


# ── summarize_report: channel grouping / track_index ──


def test_track_index_none_handled():
    report = _base_report(
        devices=[_device(track_index=None, track_name="NoIndex")],
        device_count=1,
        track_count=1,
    )
    result = summarize_report(report)
    group = result["plugins"][0]
    assert group["instances"][0]["track_number"] is None
    assert "NoIndex" in group["tracks"]


def test_track_index_invalid_string():
    report = _base_report(
        devices=[_device(track_index="not_an_int", track_name="BadIndex")],
        device_count=1,
        track_count=1,
    )
    result = summarize_report(report)
    assert result["plugins"][0]["instances"][0]["track_number"] is None


def test_instances_contain_full_device_dict(single_device_report):
    result = summarize_report(single_device_report)
    instance = result["plugins"][0]["instances"][0]
    assert instance["device_name"] == "Test Plugin"
    assert instance["latency_samples"] == 128
    assert instance["track_number"] == 1  # track_index 0 + 1


# ── summarize_report: unknown / missing latency fields ──


def test_missing_latency_treated_as_zero(unknown_latency_report):
    result = summarize_report(unknown_latency_report)
    assert result["total_latency_samples"] == sum(
        s for s in [0, 0, 0, 32]
    )
    assert result["total_latency_ms"] == sum(
        ms for ms in [0, 0, 0, 0.726]
    )
    assert result["latency_device_count"] == 1  # only device D has > 0


def test_none_latency_becomes_zero(unknown_latency_report):
    result = summarize_report(unknown_latency_report)
    a = next(
        g for g in result["plugins"] if g["device_name"] == "A"
    )
    assert a["max_latency_samples"] == 0
    assert a["max_latency_ms"] == 0


def test_latency_available_false(unknown_latency_report):
    result = summarize_report(unknown_latency_report)
    d = next(
        g for g in result["plugins"] if g["device_name"] == "D"
    )
    assert d["latency_available"] is False  # False (overridden by device)
    # But it still participates in totals / max
    assert d["max_latency_samples"] == 32


def test_device_with_zero_latency_not_in_latency_count(unknown_latency_report):
    result = summarize_report(unknown_latency_report)
    assert result["latency_device_count"] == 1


# ── summarize_report: missing fields ──


def test_missing_fields_use_defaults(missing_fields_report):
    result = summarize_report(missing_fields_report)
    bare = next(g for g in result["plugins"] if g["device_name"] == "Bare")
    assert bare["instance_count"] == 1
    assert bare["max_latency_samples"] == 0
    assert bare["max_latency_ms"] == 0
    assert bare["active_count"] == 0
    assert bare["unknown_active_count"] == 1  # active is None → unknown
    assert bare["latency_available"] is False
    assert bare["class_name"] == "Unknown"
    assert bare["format"] == "Unknown"
    assert bare["tracks"] == ["Unnamed Track"]


def test_track_name_fallback():
    report = _base_report(
        devices=[_device(track_name=None, device_name="Foo")],
        device_count=1,
        track_count=1,
    )
    result = summarize_report(report)
    assert result["plugins"][0]["tracks"] == ["Unnamed Track"]


# ── summarize_report: inactive devices ──


def test_inactive_devices_counted_separately(inactive_devices_report):
    result = summarize_report(inactive_devices_report)
    group = result["plugins"][0]  # all same plugin name
    assert group["instance_count"] == 4
    assert group["active_count"] == 1       # only "Active One"
    assert group["unknown_active_count"] == 1  # "Null Three"


def test_inactive_devices_still_affect_latency(inactive_devices_report):
    """Inactive devices still contribute to max / total latency."""
    result = summarize_report(inactive_devices_report)
    group = result["plugins"][0]
    assert group["max_latency_samples"] == 1024  # from "Hidden"
    assert group["total_latency_samples"] == 128 + 256 + 32 + 1024
    assert group["max_latency_ms"] == 23.220
    assert group["total_latency_ms"] == round(2.902 + 5.805 + 0.726 + 23.220, 3)


# ── summarize_report: session-level stats ──


def test_total_latency_computed(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)
    expected = 256 + 0 + 512 + 64 + 64
    assert result["total_latency_samples"] == expected
    expected_ms = round(5.805 + 0 + 11.610 + 1.451 + 1.451, 3)
    assert result["total_latency_ms"] == expected_ms


def test_pdc_latency_uses_highest_track_total(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)

    assert result["pdc_latency_samples"] == 768
    assert result["pdc_latency_ms"] == pytest.approx(17.415)
    assert result["bottleneck_track"]["track_name"] == "Track 1"
    assert result["bottleneck_track"]["is_bottleneck"] is True
    assert result["tracks_summary"][0] == result["bottleneck_track"]
    assert sum(track["is_bottleneck"] for track in result["tracks_summary"]) == 1


def test_cumulative_latency_remains_backward_compatible(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)

    assert result["cumulative_latency_samples"] == result["total_latency_samples"]
    assert result["cumulative_latency_ms"] == result["total_latency_ms"]
    assert result["cumulative_latency_samples"] > result["pdc_latency_samples"]


def test_latency_device_count_only_counts_positive(mixed_plugin_report):
    result = summarize_report(mixed_plugin_report)
    # Pro-Q 3 (AU) has 0 latency → not counted
    assert result["latency_device_count"] == 4


def test_top_plugins_limited_to_10():
    report = _base_report(
        devices=[
            _device(device_name=f"Plugin_{i}", latency_samples=i * 10)
            for i in range(20)
        ],
        device_count=20,
        track_count=20,
    )
    result = summarize_report(report)
    assert len(result["top_plugins"]) == 10


def test_plugins_sorted_by_max_latency():
    report = _base_report(
        devices=[
            _device(device_name="A", latency_samples=10),
            _device(device_name="B", latency_samples=100),
            _device(device_name="C", latency_samples=50),
        ],
        device_count=3,
        track_count=3,
    )
    result = summarize_report(report)
    ordered = [g["device_name"] for g in result["plugins"]]
    assert ordered == ["B", "C", "A"]


def test_impact_score_equals_max_latency_ms_times_instance_count():
    report = _base_report(
        devices=[
            _device(device_name="X", latency_samples=100, latency_ms=5.0),
            _device(device_name="X", latency_samples=50, latency_ms=2.5),
            _device(device_name="X", latency_samples=200, latency_ms=10.0),
        ],
        device_count=3,
        track_count=3,
    )
    result = summarize_report(report)
    group = result["plugins"][0]
    assert group["instance_count"] == 3
    assert group["max_latency_ms"] == 10.0
    assert group["impact_score"] == 30.0


def test_plugins_sorted_by_impact_score():
    """30ms x 8 instances (240) beats 50ms x 1 instance (50)."""
    report = _base_report(
        devices=[
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="LowLatencyMany", latency_samples=30, latency_ms=30.0),
            _device(device_name="HighLatencyOne", latency_samples=50, latency_ms=50.0),
        ],
        device_count=9,
        track_count=9,
    )
    result = summarize_report(report)
    ordered = [g["device_name"] for g in result["plugins"]]
    assert ordered == ["LowLatencyMany", "HighLatencyOne"]


def test_zero_everything_impact_score_is_zero():
    report = _base_report(
        devices=[
            _device(device_name="Silent", latency_samples=0, latency_ms=0.0),
        ],
        device_count=1,
        track_count=1,
    )
    result = summarize_report(report)
    assert result["plugins"][0]["impact_score"] == 0.0


# ── malformed / edge-case reports ──


def test_missing_devices_key(missing_devices_report):
    result = summarize_report(missing_devices_report)
    assert result["plugins"] == []
    assert result["top_plugins"] == []
    assert result["latency_device_count"] == 0
    assert result["total_latency_samples"] == 0
    assert result["total_latency_ms"] == 0


def test_null_devices_key(null_devices_report):
    """When devices is explicitly None, report.get returns None → iterating raises TypeError."""
    with pytest.raises(TypeError):
        summarize_report(null_devices_report)


def test_devices_not_a_list(not_a_list_report):
    """When devices is not iterable, should either raise or gracefully handle."""
    with pytest.raises((TypeError, AttributeError)):
        summarize_report(not_a_list_report)


def test_empty_devices_list(empty_report):
    result = summarize_report(empty_report)
    assert result["plugins"] == []
    assert result["top_plugins"] == []
    assert result["total_latency_samples"] == 0
    assert result["total_latency_ms"] == 0


# ── stale report behavior ──


def test_stale_report_cached_file_readable(stale_report):
    assert app.CACHED_REPORT_PATH.exists()
    with open(app.CACHED_REPORT_PATH) as fh:
        data = json.load(fh)
    assert data["devices"][0]["device_name"] == "Stale Plugin"


def test_stale_report_not_overwritten_by_scenario(stale_report):
    """The stale fixture writes to cache; other tests should not break."""
    result = summarize_report(stale_report)
    assert result["total_latency_samples"] == 64
    assert len(result["plugins"]) == 1


# ── large input / robustness ──


def test_large_input_reports_correct_counts(large_input_report):
    result = summarize_report(large_input_report)
    distinct_plugins = len(result["plugins"])
    assert distinct_plugins == 26  # 1 "Repeated" + 25 "Unique_i"
    assert result["device_count"] == 50
    assert result["track_count"] == 5
    # Repeated should have 25 instances, max latency = 480
    repeated = next(g for g in result["plugins"] if g["device_name"] == "Repeated")
    assert repeated["instance_count"] == 25
    assert repeated["max_latency_samples"] == 480


def test_large_input_totals(large_input_report):
    result = summarize_report(large_input_report)
    total = sum(i * 10 for i in range(50))
    assert result["total_latency_samples"] == total
    assert result["latency_device_count"] == 49  # 0 latency not counted


# ── zero-latency edge cases ──


def test_zero_latency_report(zero_latency_report):
    result = summarize_report(zero_latency_report)
    assert result["total_latency_samples"] == 0
    assert result["total_latency_ms"] == 0
    assert result["latency_device_count"] == 0
    # "Zero A", "Zero B", "Zero C (VST3)" → all distinct after normalization
    assert len(result["plugins"]) == 3


# ── summarize_report: class_name and format merging ──


def test_class_names_merged():
    report = _base_report(
        devices=[
            _device(device_name="Multi (VST3)", class_name="VstPluginProxy", format="VST3"),
            _device(device_name="Multi (AU)", class_name="AuPluginProxy", format="Audio Unit"),
        ],
        device_count=2,
        track_count=2,
    )
    result = summarize_report(report)
    group = result["plugins"][0]
    assert group["class_name"] == "VstPluginProxy / AuPluginProxy"
    assert group["format"] == "VST3 / Audio Unit"


def test_single_device_does_not_double_join():
    result = summarize_report(
        _base_report(devices=[_device(class_name="VstPluginProxy")], device_count=1, track_count=1)
    )
    assert result["plugins"][0]["class_name"] == "VstPluginProxy"


# ── non-mutative behavior ──


def test_summarize_report_mutates_in_place_by_design():
    """summarize_report enriches the report dict in-place (adds plugins, totals, etc.)."""
    original = _base_report(
        devices=[_device(device_name="Original")],
        device_count=1,
        track_count=1,
    )
    before_keys = set(original.keys())
    summarize_report(original)
    after_keys = set(original.keys())
    # Verify new keys were added in-place
    assert after_keys - before_keys == {
        "plugins", "top_plugins", "latency_device_count",
        "total_latency_samples", "total_latency_ms",
        "cumulative_latency_samples", "cumulative_latency_ms",
        "tracks_summary", "bottleneck_track",
        "pdc_latency_samples", "pdc_latency_ms", "recommendations",
    }
    # Devices list should be unchanged
    assert len(original["devices"]) == 1
    assert original["devices"][0]["device_name"] == "Original"


def test_summarize_report_enriches_report_in_place():
    report = _base_report(devices=[_device()])
    result = summarize_report(report)
    assert "plugins" in result
    assert "top_plugins" in result
    assert "latency_device_count" in result
    assert "total_latency_samples" in result
    assert "total_latency_ms" in result


# ── /api/last-scan ──


def test_api_last_scan_returns_null_when_no_cache(api_server, isolated_cache):
    status, payload = _http_json(api_server, "/api/last-scan")

    assert status == 200
    assert payload["api_schema_version"] == API_SCHEMA_VERSION
    assert payload["report"] is None


def test_api_last_scan_returns_cached_report(api_server, isolated_cache):
    report = _base_report(
        devices=[_device(device_name="Cached Plugin", latency_samples=256, latency_ms=5.8)],
        device_count=1,
        track_count=1,
    )
    isolated_cache.write_text(json.dumps(report))

    status, payload = _http_json(api_server, "/api/last-scan")

    assert status == 200
    assert payload["api_schema_version"] == API_SCHEMA_VERSION
    assert payload["report"] is not None
    assert payload["report"]["plugins"][0]["device_name"] == "Cached Plugin"
    assert payload["report"]["plugins"][0]["instance_count"] == 1
