"""Build and validate backup manifest.json."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MANIFEST_NAME = "manifest.json"
FORMAT_VERSION = 1
DATA_PREFIX = "data/"


@dataclass
class ManifestFile:
    path: str
    sha256: str
    size: int


@dataclass
class BackupManifest:
    format_version: int
    created_at: str
    hyve_version: str
    alembic_revision: str | None
    options: dict[str, Any]
    files: list[ManifestFile] = field(default_factory=list)
    addons: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format_version": self.format_version,
            "created_at": self.created_at,
            "hyve_version": self.hyve_version,
            "alembic_revision": self.alembic_revision,
            "options": self.options,
            "files": [asdict(f) for f in self.files],
            "addons": self.addons,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BackupManifest:
        files = [
            ManifestFile(
                path=str(item["path"]),
                sha256=str(item["sha256"]),
                size=int(item["size"]),
            )
            for item in data.get("files") or []
        ]
        return cls(
            format_version=int(data.get("format_version", 0)),
            created_at=str(data.get("created_at", "")),
            hyve_version=str(data.get("hyve_version", "")),
            alembic_revision=data.get("alembic_revision"),
            options=dict(data.get("options") or {}),
            files=files,
            addons=dict(data.get("addons") or {}),
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_manifest(
    *,
    hyve_version: str,
    alembic_revision: str | None,
    options: dict[str, Any],
    file_entries: list[tuple[str, Path]],
    addons_meta: dict[str, Any],
) -> BackupManifest:
    files: list[ManifestFile] = []
    for rel, abs_path in sorted(file_entries, key=lambda x: x[0]):
        files.append(
            ManifestFile(
                path=rel,
                sha256=sha256_file(abs_path),
                size=abs_path.stat().st_size,
            )
        )
    return BackupManifest(
        format_version=FORMAT_VERSION,
        created_at=utc_now_iso(),
        hyve_version=hyve_version,
        alembic_revision=alembic_revision,
        options=options,
        files=files,
        addons=addons_meta,
    )


def write_manifest(manifest: BackupManifest, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps(manifest.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def read_manifest(path: Path) -> BackupManifest:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("manifest_not_object")
    manifest = BackupManifest.from_dict(data)
    if manifest.format_version != FORMAT_VERSION:
        raise ValueError(f"unsupported_format_version:{manifest.format_version}")
    return manifest
