"""Inventory of Hyve paths included in backup archives."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from core.backup.addons_policy import (
    AddonsBackupOptions,
    iter_addon_files,
    list_addon_slugs_with_data,
)

_KEEP_DIR_NAMES = frozenset({".gitkeep", "README.md"})


@dataclass
class BackupOptions:
    include_optional: bool = False
    include_frigate_media: bool = False
    addons: AddonsBackupOptions = field(default_factory=AddonsBackupOptions)

    def __post_init__(self) -> None:
        self.addons.include_frigate_media = self.include_frigate_media


# Tier A — critical (single files at project root or fixed paths).
CRITICAL_FILES = (
    "users.db",
    "jobs.sqlite",
    "scheduler_meta.sqlite",
    "config/integration_entries.sqlite",
    "config.json",
    "hyve.db",
    ".env",
    "derived_entities.json",
    "device_names.yaml",
    "config/device_aliases.yaml",
    "secrets/integration_entries.key",
    "core/.secret_key",
)

# Tier B — directories (user content).
USER_DIRS = (
    "dashboards",
    "core/automations",
    "comfyui_workflows",
    "custom_addons",
    "custom_components",
    "skills/generated",
)

# Tier C — optional heavy / reproducible data.
OPTIONAL_DIRS = (
    "chroma_db",
    "sessions",
    "static/generated",
    "piper_models",
)


def _iter_dir_files(root: Path, rel_dir: str) -> list[tuple[Path, str]]:
    base = root / rel_dir
    if not base.is_dir():
        return []
    out: list[tuple[Path, str]] = []
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        if path.name in _KEEP_DIR_NAMES and path.parent == base:
            continue
        if rel_dir == "static/generated" and "vendor" in path.parts:
            continue
        rel = path.relative_to(root).as_posix()
        out.append((path, rel))
    return out


def collect_backup_entries(
    root: Path,
    options: BackupOptions,
) -> list[tuple[Path, str]]:
    """Return ``(absolute_path, archive_relative_path)`` pairs to include."""
    entries: list[tuple[Path, str]] = []
    seen: set[str] = set()

    def _add(path: Path, rel: str) -> None:
        if rel in seen or not path.is_file():
            return
        seen.add(rel)
        entries.append((path, rel))

    for rel in CRITICAL_FILES:
        path = root / rel
        if path.is_file():
            _add(path, rel)

    for rel_dir in USER_DIRS:
        for path, rel in _iter_dir_files(root, rel_dir):
            _add(path, rel)

    if options.include_optional:
        for rel_dir in OPTIONAL_DIRS:
            for path, rel in _iter_dir_files(root, rel_dir):
                _add(path, rel)

    addon_slugs = list_addon_slugs_with_data(root)
    for slug in addon_slugs:
        for path in iter_addon_files(root, slug, options=options.addons):
            rel = path.relative_to(root).as_posix()
            _add(path, rel)

    return sorted(entries, key=lambda item: item[1])
