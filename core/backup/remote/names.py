"""Validate remote backup archive file names."""

from __future__ import annotations


def is_backup_filename(name: str) -> bool:
    base = (name or "").strip().replace("\\", "/").split("/")[-1]
    return base.startswith(("hyve-", "pre-restore-")) and (
        base.endswith(".hyvebak") or base.endswith(".hyvebak.enc")
    )


def validate_remote_name(name: str) -> str:
    raw = (name or "").strip().replace("\\", "/")
    if not raw or "/" in raw or ".." in raw.split("/"):
        raise ValueError("backup.invalid_path")
    base = raw.split("/")[-1]
    if not is_backup_filename(base):
        raise ValueError("backup.invalid_path")
    return base
