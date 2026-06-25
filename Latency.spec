# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules


block_cipher = None

a = Analysis(
    ["mac_app.py"],
    pathex=[],
    binaries=[],
    datas=[("static", "static")],
    hiddenimports=collect_submodules("webview"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Latency",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="universal2",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="Latency",
)

app = BUNDLE(
    coll,
    name="Latency.app",
    icon="assets/Latency.icns",
    bundle_identifier="com.c4milo.Latency",
    info_plist={
        "CFBundleDisplayName": "Latency",
        "CFBundleName": "Latency",
        "LSMinimumSystemVersion": "15.0",
        "NSAppleEventsUsageDescription": "Latency checks Ableton Live state and can ask AbletonOSC to reload handlers.",
        "NSAutomationAppleEventsUsageDescription": "Latency checks Ableton Live state and can ask AbletonOSC to reload handlers.",
    },
)
