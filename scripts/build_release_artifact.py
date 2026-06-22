#!/usr/bin/env python3
"""Build a pre-built Hyve release artifact for GitHub Releases.

Creates:
  output/releases/hyve-{version}.tar.gz
  output/releases/hyve-{version}.manifest.json

The tarball contains application code + pre-built frontend assets. User data,
venv, logs, and databases are excluded and preserved on the server during apply.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import core.settings as settings  # noqa: E402
from core.hyve_update_artifact import MANIFEST_FORMAT_VERSION  # noqa: E402

SKIP_DIR_NAMES = frozenset({".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})
SKIP_FILE_SUFFIXES = frozenset({".pyc", ".pyo"})
BUILD_EXCLUDE_PREFIXES = (
    "core/logs/",
    "core/automations/",
    "static/generated/",
    "output/",
    "logs/",
    "tests/",
)
INCLUDE_TOP_LEVEL = (
    "core",
    "components",
    "routers",
    "integrations",
    "brain",
    "static",
    "migrations",
    "scripts",
    "addons",
    "custom_components",
    "main.py",
    "requirements.txt",
    "alembic.ini",
    "package.json",
    "package-lock.json",
    "install.sh",
)


def _run(cmd: list[str], *, cwd: Path = ROOT) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _should_skip(rel: str) -> bool:
    normalized = rel.replace("\\", "/")
    for prefix in BUILD_EXCLUDE_PREFIXES:
        if normalized.startswith(prefix):
            return True
    parts = normalized.split("/")
    if any(part in SKIP_DIR_NAMES for part in parts):
        return True
    if Path(normalized).suffix in SKIP_FILE_SUFFIXES:
        return True
    return False


def _iter_release_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for top in INCLUDE_TOP_LEVEL:
        path = root / top
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            if not _should_skip(rel):
                files.append(path)
            continue
        if not path.is_dir():
            continue
        for candidate in path.rglob("*"):
            if not candidate.is_file():
                continue
            rel = candidate.relative_to(root).as_posix()
            if _should_skip(rel):
                continue
            files.append(candidate)
    return sorted(files, key=lambda p: p.as_posix())


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def build_artifact(*, skip_build: bool = False, out_dir: Path | None = None) -> tuple[Path, Path]:
    version = str(settings.RELEASE_VERSION)
    if not skip_build:
        npm = shutil_which("npm")
        if npm:
            if (ROOT / "package-lock.json").is_file():
                _run([npm, "ci"], cwd=ROOT)
            else:
                _run([npm, "install"], cwd=ROOT)
            _run([npm, "run", "js:build"], cwd=ROOT)
            _run([npm, "run", "css:build"], cwd=ROOT)
        else:
            print("WARN: npm not found — building artifact without fresh frontend assets")

    dist_app = ROOT / "static" / "dist" / "app.js"
    if not dist_app.is_file():
        raise RuntimeError("static/dist/app.js missing — run npm run js:build first")

    release_dir = (out_dir or ROOT / "output" / "releases").resolve()
    release_dir.mkdir(parents=True, exist_ok=True)
    tarball = release_dir / f"hyve-{version}.tar.gz"
    manifest_path = release_dir / f"hyve-{version}.manifest.json"

    files = _iter_release_files(ROOT)
    with tarfile.open(tarball, "w:gz") as archive:
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            archive.add(path, arcname=rel)

    manifest = {
        "format_version": MANIFEST_FORMAT_VERSION,
        "version": version,
        "sha256": _sha256_file(tarball),
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "file_count": len(files),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Built {tarball} ({tarball.stat().st_size} bytes, {len(files)} files)")
    print(f"Manifest {manifest_path}")
    return tarball, manifest_path


def shutil_which(name: str) -> str | None:
    from shutil import which

    return which(name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Hyve release artifact")
    parser.add_argument("--skip-build", action="store_true", help="Skip npm js/css build")
    parser.add_argument("--out-dir", type=Path, default=None, help="Output directory")
    args = parser.parse_args()
    try:
        build_artifact(skip_build=args.skip_build, out_dir=args.out_dir)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
