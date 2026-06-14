"""Prune old ``.hyvebak`` archives by retention policy."""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("backup.retention")


def _sorted_archives(backups_dir: Path, pattern: str) -> list[Path]:
    files = [p for p in backups_dir.glob(pattern) if p.is_file()]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def apply_retention(
    backups_dir: Path,
    *,
    retention_count: int,
    pre_restore_retention_count: int,
) -> list[str]:
    """Delete oldest archives beyond configured limits. Returns deleted file names."""
    backups_dir.mkdir(parents=True, exist_ok=True)
    deleted: list[str] = []

    hyve_files = _sorted_archives(backups_dir, "hyve-*.hyvebak")
    hyve_files += _sorted_archives(backups_dir, "hyve-*.hyvebak.enc")
    hyve_files = sorted(set(hyve_files), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in hyve_files[max(retention_count, 0) :]:
        try:
            path.unlink()
            deleted.append(path.name)
        except OSError as exc:
            log.warning("Failed to delete old backup %s: %s", path.name, exc)

    pre_files = _sorted_archives(backups_dir, "pre-restore-*.hyvebak")
    pre_files += _sorted_archives(backups_dir, "pre-restore-*.hyvebak.enc")
    pre_files = sorted(set(pre_files), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in pre_files[max(pre_restore_retention_count, 0) :]:
        try:
            path.unlink()
            deleted.append(path.name)
        except OSError as exc:
            log.warning("Failed to delete old pre-restore backup %s: %s", path.name, exc)

    if deleted:
        log.info("Retention removed %d archive(s): %s", len(deleted), ", ".join(deleted[:5]))
    return deleted
