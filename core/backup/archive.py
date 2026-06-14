"""Create and read ``.hyvebak`` archives."""

from __future__ import annotations

import shutil
import tarfile
import tempfile
from pathlib import Path

from core.backup.manifest import (
    DATA_PREFIX,
    FORMAT_VERSION,
    MANIFEST_NAME,
    BackupManifest,
    read_manifest,
    write_manifest,
)


def _add_file(tar: tarfile.TarFile, src: Path, arcname: str) -> None:
    tar.add(src, arcname=arcname, recursive=False)


def create_archive(
    manifest: BackupManifest,
    payload_files: list[tuple[Path, str]],
    dest: Path,
) -> Path:
    """Write ``dest`` (``.hyvebak``) with manifest + ``data/`` tree."""
    dest = dest.resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="hyve-backup-") as tmp:
        tmp_path = Path(tmp)
        write_manifest(manifest, tmp_path / MANIFEST_NAME)
        for abs_path, rel in payload_files:
            out = tmp_path / DATA_PREFIX / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(abs_path, out)

        with tarfile.open(dest, "w:gz") as tar:
            tar.add(tmp_path / MANIFEST_NAME, arcname=MANIFEST_NAME)
            data_root = tmp_path / DATA_PREFIX
            if data_root.is_dir():
                for path in sorted(data_root.rglob("*")):
                    if path.is_file():
                        arc = DATA_PREFIX + path.relative_to(data_root).as_posix()
                        _add_file(tar, path, arc)

    return dest


def read_manifest_from_archive(archive: Path) -> BackupManifest:
    """Read ``manifest.json`` from a ``.hyvebak`` without extracting payload."""
    with tarfile.open(archive, "r:gz") as tar:
        member = tar.getmember(MANIFEST_NAME)
        extracted = tar.extractfile(member)
        if extracted is None:
            raise ValueError("manifest_unreadable")
        import json

        data = json.loads(extracted.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("manifest_not_object")
    manifest = BackupManifest.from_dict(data)
    if manifest.format_version != FORMAT_VERSION:
        raise ValueError(f"unsupported_format_version:{manifest.format_version}")
    return manifest


def extract_archive(archive: Path, dest_dir: Path) -> tuple[BackupManifest, Path]:
    """Extract archive to ``dest_dir``; return manifest and ``data/`` root."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(dest_dir, filter="data")

    manifest_path = dest_dir / MANIFEST_NAME
    manifest = read_manifest(manifest_path)
    data_root = dest_dir / DATA_PREFIX.rstrip("/")
    return manifest, data_root
