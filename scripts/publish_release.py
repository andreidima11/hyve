#!/usr/bin/env python3
"""Push the current branch, tag, and create a GitHub release from CHANGELOG.md.

Usage:
    python scripts/publish_release.py              # uses core.settings.RELEASE_VERSION
    python scripts/publish_release.py 0.9.1        # explicit version
    python scripts/publish_release.py --skip-gate  # skip release_gate.py

Release notes are always taken from the matching ``## [X.Y.Z]`` section in CHANGELOG.md.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = ROOT / "CHANGELOG.md"
PYTHON = sys.executable


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=ROOT, check=check, text=True)


def _read_version(explicit: str | None) -> str:
    if explicit:
        return explicit.strip()
    sys.path.insert(0, str(ROOT))
    from core import settings  # noqa: WPS433

    return str(settings.RELEASE_VERSION)


def _changelog_section(version: str) -> str:
    if not CHANGELOG.is_file():
        raise RuntimeError(f"Missing {CHANGELOG.relative_to(ROOT)}")
    text = CHANGELOG.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        raise RuntimeError(f"No CHANGELOG section found for version {version}")
    body = match.group(1).strip()
    if not body:
        raise RuntimeError(f"CHANGELOG section for {version} is empty")
    return body


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish GitHub release from CHANGELOG.md")
    parser.add_argument("version", nargs="?", help="Release version (default: RELEASE_VERSION)")
    parser.add_argument("--skip-gate", action="store_true", help="Skip scripts/release_gate.py")
    parser.add_argument("--dry-run", action="store_true", help="Print notes only; do not push or release")
    args = parser.parse_args()

    version = _read_version(args.version)
    notes = _changelog_section(version)
    title = f"Hyve {version}"

    print(f"\nRelease: {title}\n")
    print("--- CHANGELOG notes ---")
    print(notes)
    print("--- end ---\n")

    if args.dry_run:
        return 0

    if not args.skip_gate:
        code = subprocess.call([PYTHON, "scripts/release_gate.py"], cwd=ROOT)
        if code != 0:
            return code

    _run(["git", "tag", "-a", version, "-m", title], check=False)
    _run(["git", "push", "-u", "origin", "HEAD"])
    _run(["git", "push", "origin", version])

    _run(
        [
            "gh",
            "release",
            "create",
            version,
            "--title",
            title,
            "--notes",
            notes,
        ]
    )
    print(f"\nPublished {title} (tag {version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
