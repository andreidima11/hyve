"""Artifact-based Hyve self-update — download pre-built release tarballs."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from core.hyve_update_paths import normalize_rel_path, should_preserve_path

log = logging.getLogger(__name__)

MANIFEST_FORMAT_VERSION = 1
ARTIFACT_BASENAME = "hyve-{version}.tar.gz"
MANIFEST_BASENAME = "hyve-{version}.manifest.json"


class ArtifactUpdateError(Exception):
    def __init__(self, key: str, params: dict[str, Any] | None = None):
        self.key = key
        self.params = params or {}
        super().__init__(key)


def artifact_basename(version: str) -> str:
    return ARTIFACT_BASENAME.format(version=_normalize_version(version))


def manifest_basename(version: str) -> str:
    return MANIFEST_BASENAME.format(version=_normalize_version(version))


def _normalize_version(version: str) -> str:
    raw = str(version or "").strip()
    if raw.lower().startswith("v") and len(raw) > 1 and (raw[1].isdigit() or raw[1] == "."):
        return raw[1:]
    return raw


def _github_request(url: str, *, token: str = "") -> Any:
    from core.github_api import github_api_headers

    headers = dict(github_api_headers())
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(url, headers=headers)
    with urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _release_by_tag(repo: str, tag: str) -> dict[str, Any] | None:
    ver = _normalize_version(tag)
    for candidate in (tag, ver, f"v{ver}"):
        url = f"https://api.github.com/repos/{repo}/releases/tags/{candidate}"
        try:
            data = _github_request(url)
            if isinstance(data, dict):
                return data
        except HTTPError as exc:
            if exc.code == 404:
                continue
            raise
        except (URLError, TimeoutError, json.JSONDecodeError):
            return None
    return None


def fetch_artifact_metadata(repo: str, tag: str) -> dict[str, Any] | None:
    """Return download URLs + manifest for a tagged GitHub release, if present."""
    release = _release_by_tag(repo, tag)
    if not release:
        return None
    version = _normalize_version(str(release.get("tag_name") or tag))
    assets = release.get("assets") if isinstance(release.get("assets"), list) else []
    artifact_url = ""
    manifest_url = ""
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        url = str(asset.get("browser_download_url") or "")
        if name == artifact_basename(version):
            artifact_url = url
        elif name == manifest_basename(version):
            manifest_url = url
    if not artifact_url:
        return None
    manifest: dict[str, Any] = {}
    if manifest_url:
        try:
            req = Request(manifest_url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=60) as resp:
                manifest = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:
            log.debug("artifact manifest download failed for %s: %s", version, exc)
    return {
        "version": version,
        "tag": str(release.get("tag_name") or tag),
        "artifact_url": artifact_url,
        "manifest_url": manifest_url,
        "manifest": manifest if isinstance(manifest, dict) else {},
        "release_url": str(release.get("html_url") or ""),
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, dest: Path) -> None:
    from core.github_api import github_api_headers

    dest.parent.mkdir(parents=True, exist_ok=True)
    req = Request(url, headers=github_api_headers())
    with urlopen(req, timeout=300) as resp, dest.open("wb") as fh:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            fh.write(chunk)


def _verify_manifest(manifest: dict[str, Any], tarball: Path, *, version: str) -> None:
    expected_version = _normalize_version(str(manifest.get("version") or ""))
    if expected_version and expected_version != _normalize_version(version):
        raise ArtifactUpdateError(
            "updates.hyve_artifact_version_mismatch",
            {"expected": expected_version, "got": version},
        )
    expected_sha = str(manifest.get("sha256") or "").strip().lower()
    if expected_sha:
        actual = _sha256_file(tarball)
        if actual != expected_sha:
            raise ArtifactUpdateError(
                "updates.hyve_artifact_checksum_failed",
                {"expected": expected_sha[:12], "actual": actual[:12]},
            )


def _extract_tarball(tarball: Path, staging: Path) -> None:
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tarball, "r:gz") as archive:
        archive.extractall(staging, filter="data")


def _iter_staged_files(staging: Path) -> list[Path]:
    files: list[Path] = []
    for path in staging.rglob("*"):
        if path.is_file() and path.name != "release-manifest.json":
            files.append(path)
    return files


def _copy_staged_tree(staging: Path, root: Path, *, rollback_dir: Path | None = None) -> list[str]:
    """Copy staged release files into ``root``, preserving user/runtime paths."""
    replaced: list[str] = []
    for src in _iter_staged_files(staging):
        rel = normalize_rel_path(src.relative_to(staging))
        if should_preserve_path(rel):
            continue
        dest = root / rel
        if rollback_dir is not None and dest.is_file():
            backup = rollback_dir / rel
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, backup)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        replaced.append(rel)
    return replaced


def _rollback_tree(root: Path, rollback_dir: Path, replaced: list[str]) -> None:
    for rel in replaced:
        backup = rollback_dir / rel
        dest = root / rel
        if backup.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup, dest)
        elif dest.is_file():
            dest.unlink(missing_ok=True)


def _create_pre_update_backup(root: Path) -> dict[str, Any] | None:
    try:
        from core.backup.paths import BackupOptions
        from core.backup.service import BackupService

        svc = BackupService(root=root)
        return svc.create_backup(BackupOptions(), label="pre-update")
    except Exception as exc:
        log.warning("pre-update backup failed: %s", exc)
        return None


def _pip_install(root: Path) -> None:
    pip = root / ".venv" / "bin" / "pip"
    if not pip.is_file():
        pip = root / "venv" / "bin" / "pip"
    if not pip.is_file():
        pip_path = shutil.which("pip3") or shutil.which("pip")
        if not pip_path:
            raise ArtifactUpdateError("updates.hyve_pip_missing")
        pip = Path(pip_path)
    req = root / "requirements.txt"
    if not req.is_file():
        return
    proc = __import__("subprocess").run(
        [str(pip), "install", "-r", str(req)],
        cwd=str(root),
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise ArtifactUpdateError("updates.hyve_pip_failed", {"detail": detail})


def _run_migrations() -> None:
    from core.http.startup_migrations import run_startup_migrations

    run_startup_migrations()


def apply_artifact_update(
    *,
    root: Path,
    repo: str,
    tag: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Download, verify, and apply a pre-built release artifact."""
    meta = metadata or fetch_artifact_metadata(repo, tag)
    if not meta or not meta.get("artifact_url"):
        raise ArtifactUpdateError("updates.hyve_artifact_missing")

    version = _normalize_version(str(meta.get("version") or tag))
    updates_dir = root / "output" / "updates"
    updates_dir.mkdir(parents=True, exist_ok=True)
    tarball = updates_dir / artifact_basename(version)
    staging = updates_dir / "staging" / version
    rollback_dir = updates_dir / "rollback" / version

    pre_backup = _create_pre_update_backup(root)
    replaced: list[str] = []
    try:
        _download(str(meta["artifact_url"]), tarball)
        manifest = dict(meta.get("manifest") or {})
        if not manifest.get("sha256") and tarball.with_suffix(".manifest.json").is_file():
            manifest = json.loads(tarball.with_suffix(".manifest.json").read_text(encoding="utf-8"))
        _verify_manifest(manifest, tarball, version=version)
        _extract_tarball(tarball, staging)
        if rollback_dir.exists():
            shutil.rmtree(rollback_dir)
        rollback_dir.mkdir(parents=True, exist_ok=True)
        replaced = _copy_staged_tree(staging, root, rollback_dir=rollback_dir)
        _pip_install(root)
        _run_migrations()
    except Exception:
        log.warning("artifact update failed — rolling back %d file(s)", len(replaced))
        if replaced:
            _rollback_tree(root, rollback_dir, replaced)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    return {
        "version": version,
        "mode": "artifact",
        "files_updated": len(replaced),
        "pre_update_backup": pre_backup,
    }
