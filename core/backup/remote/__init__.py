"""Upload Hyve backups to remote storage (S3-compatible, SFTP)."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("backup.remote")

VALID_PROVIDERS = frozenset({"none", "s3", "sftp"})


def _remote_cfg(config: dict[str, Any]) -> dict[str, Any]:
    remote = config.get("remote")
    return dict(remote) if isinstance(remote, dict) else {}


def remote_enabled(config: dict[str, Any]) -> bool:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    return bool(remote.get("enabled")) and provider in {"s3", "sftp"}


def remote_configured(config: dict[str, Any]) -> bool:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    if provider == "s3":
        return bool(str((remote.get("s3") or {}).get("bucket") or "").strip())
    if provider == "sftp":
        sftp = remote.get("sftp") or {}
        return bool(str(sftp.get("host") or "").strip() and str(sftp.get("username") or "").strip())
    return False


def list_remote_archives(config: dict[str, Any]) -> list[dict[str, Any]]:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    if provider == "s3":
        from core.backup.remote.s3 import list_s3_archives

        return list_s3_archives(remote.get("s3") or {})
    if provider == "sftp":
        from core.backup.remote.sftp import list_sftp_archives

        return list_sftp_archives(remote.get("sftp") or {})
    raise ValueError("backup.remote.unsupported_provider")


def download_remote_archive(name: str, dest: Path, config: dict[str, Any]) -> dict[str, Any]:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    if provider == "s3":
        from core.backup.remote.s3 import download_from_s3

        path = download_from_s3(remote.get("s3") or {}, name, dest)
    elif provider == "sftp":
        from core.backup.remote.sftp import download_from_sftp

        path = download_from_sftp(remote.get("sftp") or {}, name, dest)
    else:
        raise ValueError("backup.remote.unsupported_provider")
    return {
        "provider": provider,
        "name": path.name,
        "path": path.name,
        "size": path.stat().st_size,
    }


def upload_backup(local_path: Path, config: dict[str, Any]) -> dict[str, Any]:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    if not remote.get("enabled"):
        return {"skipped": True, "reason": "disabled"}
    if provider == "s3":
        from core.backup.remote.s3 import upload_to_s3

        return upload_to_s3(local_path, remote.get("s3") or {}, remote)
    if provider == "sftp":
        from core.backup.remote.sftp import upload_to_sftp

        return upload_to_sftp(local_path, remote.get("sftp") or {}, remote)
    raise ValueError("backup.remote.unsupported_provider")


def test_remote(config: dict[str, Any]) -> dict[str, Any]:
    remote = _remote_cfg(config)
    provider = str(remote.get("provider") or "none")
    if provider == "s3":
        from core.backup.remote.s3 import test_s3

        return test_s3(remote.get("s3") or {})
    if provider == "sftp":
        from core.backup.remote.sftp import test_sftp

        return test_sftp(remote.get("sftp") or {})
    raise ValueError("backup.remote.unsupported_provider")


def apply_remote_retention(config: dict[str, Any]) -> list[str]:
    remote = _remote_cfg(config)
    if not remote.get("enabled"):
        return []
    provider = str(remote.get("provider") or "none")
    limit = max(0, int(remote.get("retention_count") or 0))
    if limit <= 0:
        return []
    if provider == "s3":
        from core.backup.remote.s3 import prune_s3

        return prune_s3(remote.get("s3") or {}, limit)
    if provider == "sftp":
        from core.backup.remote.sftp import prune_sftp

        return prune_sftp(remote.get("sftp") or {}, limit)
    return []


def env_or_config(value: str | None, env_name: str) -> str:
    env = (os.environ.get(env_name) or "").strip()
    if env:
        return env
    return str(value or "").strip()
