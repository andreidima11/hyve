#!/usr/bin/env python3
"""Sync the app version from core.settings.RELEASE_VERSION into all satellite files.

Usage:
    # Sync current RELEASE_VERSION to all files:
    python scripts/bump_version.py

    # Set a new version and sync:
    python scripts/bump_version.py 0.2.6-ALPHA
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PY = ROOT / "core" / "settings.py"

# ── helpers ──────────────────────────────────────────────────────────────────

def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")

def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")

def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))

def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")

# ── read / write RELEASE_VERSION in settings.py ─────────────────────────────

_VERSION_RE = re.compile(r'^(RELEASE_VERSION\s*=\s*")([^"]+)(")', re.MULTILINE)

def get_current_version() -> str:
    m = _VERSION_RE.search(_read(SETTINGS_PY))
    if not m:
        raise RuntimeError("Cannot find RELEASE_VERSION in core/settings.py")
    return m.group(2)

def set_settings_version(version: str) -> None:
    text = _read(SETTINGS_PY)
    text, n = _VERSION_RE.subn(rf'\g<1>{version}\3', text)
    if n != 1:
        raise RuntimeError("Failed to update RELEASE_VERSION in core/settings.py")
    _write(SETTINGS_PY, text)

# ── satellite file updaters ──────────────────────────────────────────────────

def sync_config_json(version: str) -> None:
    path = ROOT / "config.json"
    data = _read_json(path)
    data["version"] = version
    _write_json(path, data)

def sync_package_json(version: str) -> None:
    path = ROOT / "package.json"
    data = _read_json(path)
    data["version"] = version
    _write_json(path, data)

def sync_package_lock_json(version: str) -> None:
    path = ROOT / "package-lock.json"
    data = _read_json(path)
    data["version"] = version
    if "packages" in data and "" in data["packages"]:
        data["packages"][""]["version"] = version
    _write_json(path, data)

def sync_build_gradle(version: str) -> None:
    path = ROOT / "android" / "HyveBridge" / "app" / "build.gradle.kts"
    text = _read(path)
    text = re.sub(
        r'(versionName\s*=\s*")[^"]+(")',
        rf'\g<1>{version}\2',
        text,
    )
    _write(path, text)

def sync_readme(version: str) -> None:
    path = ROOT / "README.md"
    text = _read(path)
    text = re.sub(
        r'(\*\*Current version:\*\* )[^\n]+',
        rf'\g<1>{version}',
        text,
    )
    text = re.sub(
        r'(Versiunea curentă:\s*`)[^`]+(`)',
        rf'\g<1>{version}\2',
        text,
    )
    _write(path, text)

# ── main ─────────────────────────────────────────────────────────────────────

SYNCERS = [
    ("core/settings.py", set_settings_version),
    ("config.json", sync_config_json),
    ("package.json", sync_package_json),
    ("package-lock.json", sync_package_lock_json),
    ("build.gradle.kts", sync_build_gradle),
    ("README.md", sync_readme),
]

def _normalize_version(version: str) -> str:
    v = version.strip()
    if v.lower().startswith("v"):
        v = v[1:]
    return v


def main() -> None:
    if len(sys.argv) > 1:
        new_version = _normalize_version(sys.argv[1])
    else:
        new_version = _normalize_version(get_current_version())

    old_version = get_current_version()
    print(f"Version: {old_version} → {new_version}")
    print()

    for label, fn in SYNCERS:
        try:
            fn(new_version)
            print(f"  ✅ {label}")
        except Exception as e:
            print(f"  ❌ {label}: {e}")

    print(f"\nDone. All files synced to {new_version}")

if __name__ == "__main__":
    main()
