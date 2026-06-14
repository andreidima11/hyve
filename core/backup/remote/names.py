"""Validate remote backup archive file names."""

from __future__ import annotations

import re

_UPLOAD_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.hyvebak(?:\.enc)?$")


def is_backup_filename(name: str) -> bool:
    base = (name or "").strip().replace("\\", "/").split("/")[-1]
    return base.startswith(("hyve-", "pre-restore-")) and (
        base.endswith(".hyvebak") or base.endswith(".hyvebak.enc")
    )


def is_archive_filename(name: str) -> bool:
    base = (name or "").strip().replace("\\", "/").split("/")[-1]
    return base.endswith(".hyvebak") or base.endswith(".hyvebak.enc")


def validate_upload_name(name: str) -> str:
    """Accept any safe local archive basename (for import from another server)."""
    raw = (name or "").strip().replace("\\", "/")
    if not raw or "/" in raw or ".." in raw.split("/"):
        raise ValueError("backup.invalid_path")
    base = raw.split("/")[-1]
    if not is_archive_filename(base) or not _UPLOAD_NAME_RE.match(base):
        raise ValueError("backup.invalid_path")
    return base


def validate_remote_name(name: str) -> str:
    raw = (name or "").strip().replace("\\", "/")
    if not raw or "/" in raw or ".." in raw.split("/"):
        raise ValueError("backup.invalid_path")
    base = raw.split("/")[-1]
    if not is_backup_filename(base):
        raise ValueError("backup.invalid_path")
    return base
