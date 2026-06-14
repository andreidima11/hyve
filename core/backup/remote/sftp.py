"""SFTP backup upload."""

from __future__ import annotations

import logging
import posixpath
from pathlib import Path
from typing import Any

from core.backup.remote import env_or_config

log = logging.getLogger("backup.remote.sftp")


def _connect(cfg: dict[str, Any]):
    try:
        import paramiko
    except ImportError as exc:
        raise RuntimeError("backup.remote.paramiko_missing") from exc

    host = str(cfg.get("host") or "").strip()
    if not host:
        raise ValueError("backup.remote.sftp_host_missing")
    port = int(cfg.get("port") or 22)
    username = str(cfg.get("username") or "").strip()
    password = env_or_config(cfg.get("password"), "HYVE_BACKUP_SFTP_PASSWORD")
    if not username:
        raise ValueError("backup.remote.sftp_username_missing")
    if not password:
        raise ValueError("backup.remote.sftp_password_missing")

    transport = paramiko.Transport((host, port))
    transport.connect(username=username, password=password)
    return transport, paramiko.SFTPClient.from_transport(transport)


def _remote_dir(cfg: dict[str, Any]) -> str:
    path = str(cfg.get("remote_path") or "/backups/hyve").strip() or "/backups/hyve"
    return path.rstrip("/")


def upload_to_sftp(local_path: Path, cfg: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
    transport, sftp = _connect(cfg)
    try:
        remote_dir = _remote_dir(cfg)
        _ensure_dir(sftp, remote_dir)
        remote_file = posixpath.join(remote_dir, local_path.name)
        sftp.put(str(local_path), remote_file)
        deleted = []
        if remote.get("upload_on_create", True):
            deleted = prune_sftp(cfg, int(remote.get("retention_count") or 0), sftp=sftp)
        return {"provider": "sftp", "path": remote_file, "remote_deleted": deleted}
    finally:
        try:
            sftp.close()
        except Exception:
            pass
        try:
            transport.close()
        except Exception:
            pass


def test_sftp(cfg: dict[str, Any]) -> dict[str, Any]:
    transport, sftp = _connect(cfg)
    try:
        remote_dir = _remote_dir(cfg)
        _ensure_dir(sftp, remote_dir)
        sftp.listdir(remote_dir)
        return {"ok": True, "provider": "sftp", "path": remote_dir}
    finally:
        try:
            sftp.close()
        except Exception:
            pass
        try:
            transport.close()
        except Exception:
            pass


def _ensure_dir(sftp, path: str) -> None:
    parts = [p for p in path.split("/") if p]
    cur = ""
    for part in parts:
        cur = f"{cur}/{part}"
        try:
            sftp.stat(cur)
        except OSError:
            sftp.mkdir(cur)


def _list_remote_files(sftp, remote_dir: str) -> list[str]:
    try:
        names = sftp.listdir(remote_dir)
    except OSError:
        return []
    out = []
    from core.backup.remote.names import is_backup_filename

    for name in names:
        if is_backup_filename(name):
            out.append(name)
    return sorted(out)


def list_sftp_archives(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    from core.backup.remote.names import is_backup_filename
    from datetime import datetime, timezone

    transport, sftp = _connect(cfg)
    try:
        remote_dir = _remote_dir(cfg)
        out: list[dict[str, Any]] = []
        for attr in sftp.listdir_attr(remote_dir):
            name = str(attr.filename)
            if not is_backup_filename(name):
                continue
            modified = None
            if attr.st_mtime:
                modified = datetime.fromtimestamp(attr.st_mtime, tz=timezone.utc).replace(
                    microsecond=0
                ).isoformat()
            out.append(
                {
                    "name": name,
                    "remote_key": posixpath.join(remote_dir, name),
                    "size": int(attr.st_size or 0),
                    "modified_at": modified,
                    "provider": "sftp",
                }
            )
        return sorted(out, key=lambda row: row.get("modified_at") or "", reverse=True)
    finally:
        try:
            sftp.close()
        except Exception:
            pass
        try:
            transport.close()
        except Exception:
            pass


def download_from_sftp(cfg: dict[str, Any], name: str, dest: Path) -> Path:
    from core.backup.remote.names import validate_remote_name

    filename = validate_remote_name(name)
    transport, sftp = _connect(cfg)
    try:
        remote_dir = _remote_dir(cfg)
        remote_file = posixpath.join(remote_dir, filename)
        dest.parent.mkdir(parents=True, exist_ok=True)
        sftp.get(remote_file, str(dest))
        return dest
    finally:
        try:
            sftp.close()
        except Exception:
            pass
        try:
            transport.close()
        except Exception:
            pass


def prune_sftp(cfg: dict[str, Any], retention_count: int, *, sftp=None) -> list[str]:
    if retention_count <= 0:
        return []
    close_transport = False
    transport = None
    if sftp is None:
        transport, sftp = _connect(cfg)
        close_transport = True
    try:
        remote_dir = _remote_dir(cfg)
        files = _list_remote_files(sftp, remote_dir)
        to_delete = files[: max(0, len(files) - retention_count)]
        for name in to_delete:
            sftp.remove(posixpath.join(remote_dir, name))
        if to_delete:
            log.info("SFTP retention deleted %d file(s)", len(to_delete))
        return to_delete
    finally:
        if close_transport:
            try:
                sftp.close()
            except Exception:
                pass
            try:
                if transport:
                    transport.close()
            except Exception:
                pass
