#!/usr/bin/env python3
"""Push the current branch, tag, and create a GitHub release from CHANGELOG.md.

Usage:
    python scripts/publish_release.py              # uses core.settings.RELEASE_VERSION
    python scripts/publish_release.py 0.9.1        # explicit version
    python scripts/publish_release.py --skip-gate  # skip release_gate.py

Release notes are always taken from the matching ``## [X.Y.Z]`` section in CHANGELOG.md.
If the GitHub release already exists, notes are updated in place (upsert).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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
    sys.path.insert(0, str(ROOT))
    from core.changelog_notes import changelog_section  # noqa: WPS433

    body = changelog_section(version)
    if not body:
        raise RuntimeError(f"No CHANGELOG section found for version {version}")
    return body


def _github_release_exists(version: str) -> bool:
    proc = subprocess.run(
        ["gh", "release", "view", version],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def _upsert_github_release(version: str, title: str, notes: str) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as fh:
        fh.write(notes)
        notes_path = fh.name
    try:
        if _github_release_exists(version):
            print(f"GitHub release {version} exists — updating notes.")
            _run(
                [
                    "gh",
                    "release",
                    "edit",
                    version,
                    "--title",
                    title,
                    "--notes-file",
                    notes_path,
                ]
            )
        else:
            _run(
                [
                    "gh",
                    "release",
                    "create",
                    version,
                    "--title",
                    title,
                    "--notes-file",
                    notes_path,
                ]
            )
    finally:
        Path(notes_path).unlink(missing_ok=True)


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

    print("\n==> Building release artifact")
    code = subprocess.call([PYTHON, "scripts/build_release_artifact.py", "--skip-build"], cwd=ROOT)
    if code != 0:
        return code

    tag_exists = subprocess.run(
        ["git", "rev-parse", version],
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).returncode == 0
    if tag_exists:
        print(f"Tag {version} already exists; skipping tag create.")
    else:
        _run(["git", "tag", "-a", version, "-m", title])
    _run(["git", "push", "-u", "origin", "HEAD"])
    _run(["git", "push", "origin", version])

    _upsert_github_release(version, title, notes)

    artifact = ROOT / "output" / "releases" / f"hyve-{version}.tar.gz"
    manifest = ROOT / "output" / "releases" / f"hyve-{version}.manifest.json"
    if artifact.is_file() and manifest.is_file():
        _run(
            [
                "gh",
                "release",
                "upload",
                version,
                str(artifact),
                str(manifest),
                "--clobber",
            ]
        )
    else:
        print(f"WARN: release artifact not found at {artifact}; skipping asset upload")

    print(f"\nPublished {title} (tag {version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
