"""Admin API for Hyve backup and restore."""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import core.auth as auth
import core.models as models
from core.backup.maintenance import get_status
from core.backup.paths import BackupOptions
from core.backup.service import BackupService, get_backup_service
from core.http.errors import error_detail

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backup", tags=["backup"])


class BackupCreateBody(BaseModel):
    include_optional: bool = False
    include_frigate_media: bool = False
    label: str | None = None


class BackupPathBody(BaseModel):
    path: str = Field(..., min_length=1)
    decryption_key: str | None = None


class BackupRestoreBody(BaseModel):
    path: str = Field(..., min_length=1)
    refetch_addons: bool = False
    dry_run: bool = False
    auto_pre_backup: bool = True
    include_optional: bool = False
    include_frigate_media: bool = False
    decryption_key: str | None = None


class BackupRemoteNameBody(BaseModel):
    name: str = Field(..., min_length=1)


class BackupRemotePullBody(BackupRemoteNameBody):
    overwrite: bool = False


class BackupRemoteRestoreBody(BaseModel):
    name: str = Field(..., min_length=1)
    refetch_addons: bool = False
    dry_run: bool = False
    auto_pre_backup: bool = True
    include_optional: bool = False
    include_frigate_media: bool = False
    overwrite: bool = False
    decryption_key: str | None = None


class BackupRemoteS3Body(BaseModel):
    bucket: str = ""
    prefix: str = "hyve/"
    region: str = ""
    endpoint_url: str = ""


class BackupRemoteSftpBody(BaseModel):
    host: str = ""
    port: int = 22
    username: str = ""
    password: str = ""
    remote_path: str = "/backups/hyve"


class BackupRemoteBody(BaseModel):
    enabled: bool = False
    provider: str = "none"
    upload_on_create: bool = True
    retention_count: int = Field(5, ge=0, le=100)
    s3: BackupRemoteS3Body = Field(default_factory=BackupRemoteS3Body)
    sftp: BackupRemoteSftpBody = Field(default_factory=BackupRemoteSftpBody)


class BackupSettingsBody(BaseModel):
    schedule_interval: str = "never"
    retention_count: int = Field(10, ge=1, le=100)
    pre_restore_retention_count: int = Field(3, ge=1, le=20)
    include_optional: bool = False
    include_frigate_media: bool = False
    refetch_addons: bool = False
    encrypt_at_rest: bool = False
    remote: BackupRemoteBody = Field(default_factory=BackupRemoteBody)


def _options(body: BackupCreateBody | BackupRestoreBody) -> BackupOptions:
    return BackupOptions(
        include_optional=body.include_optional,
        include_frigate_media=body.include_frigate_media,
    )


def _map_error(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        msg = str(exc)
        key = "backup.not_found"
        if msg.startswith("backup.not_found:"):
            return HTTPException(404, error_detail(key, {"path": msg.split(":", 1)[1]}))
        return HTTPException(404, error_detail(key))
    if isinstance(exc, ValueError):
        msg = str(exc)
        if msg.startswith("checksum_mismatch:"):
            return HTTPException(400, error_detail("backup.checksum_mismatch", {"path": msg.split(":", 1)[1]}))
        if msg.startswith("unsupported_format_version:"):
            return HTTPException(400, error_detail("backup.unsupported_format"))
        if msg in {"backup.invalid_path", "backup.decrypt_failed", "backup.upload_already_exists", "backup.encryption_key_missing"}:
            return HTTPException(400, error_detail(msg))
        if msg.startswith("backup.remote."):
            return HTTPException(400, error_detail(msg))
        return HTTPException(400, error_detail("backup.invalid_request", {"detail": msg}))
    if isinstance(exc, RuntimeError):
        msg = str(exc)
        if msg.startswith("backup."):
            return HTTPException(400, error_detail(msg))
    log.exception("Backup API error")
    return HTTPException(500, error_detail("backup.failed"))


@router.get("/status")
async def backup_status(
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    return service.status()


@router.get("/encryption-key")
async def backup_encryption_key(
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(service.get_encryption_key)
    except Exception as exc:
        raise _map_error(exc) from exc


@router.get("/maintenance")
async def backup_maintenance():
    """Public maintenance flag for clients (no auth — safe metadata only)."""
    status = get_status()
    return {"maintenance": status.active, "reason": status.reason}


@router.post("/create")
async def backup_create(
    body: BackupCreateBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(
            service.create_backup,
            _options(body),
            label=body.label,
        )
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/verify")
async def backup_verify(
    body: BackupPathBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(service.verify, body.path, decryption_key=body.decryption_key)
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/restore")
async def backup_restore(
    body: BackupRestoreBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(
            service.restore,
            body.path,
            options=_options(body),
            refetch_addons=body.refetch_addons,
            dry_run=body.dry_run,
            auto_pre_backup=body.auto_pre_backup,
            decryption_key=body.decryption_key,
        )
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/rollback")
async def backup_rollback(
    body: BackupPathBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(service.rollback, body.path, decryption_key=body.decryption_key)
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/settings")
async def backup_save_settings(
    body: BackupSettingsBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    interval = body.schedule_interval if body.schedule_interval in {"never", "daily", "weekly", "monthly"} else "never"
    try:
        return await asyncio.to_thread(
            service.save_settings,
            {
                "schedule_interval": interval,
                "retention_count": body.retention_count,
                "pre_restore_retention_count": body.pre_restore_retention_count,
                "include_optional": body.include_optional,
                "include_frigate_media": body.include_frigate_media,
                "refetch_addons": body.refetch_addons,
                "encrypt_at_rest": body.encrypt_at_rest,
                "remote": body.remote.model_dump(),
            },
        )
    except Exception as exc:
        raise _map_error(exc) from exc


@router.delete("/archives")
async def backup_delete_archive(
    body: BackupPathBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(service.delete_archive, body.path)
    except Exception as exc:
        raise _map_error(exc) from exc


@router.get("/archives/download")
async def backup_download_archive(
    path: str = Query(..., min_length=1),
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        archive = await asyncio.to_thread(service.resolve_archive_download, path)
    except Exception as exc:
        raise _map_error(exc) from exc
    return FileResponse(
        archive,
        media_type="application/gzip",
        filename=archive.name,
    )


@router.post("/archives/upload")
async def backup_upload_archive(
    file: UploadFile = File(...),
    overwrite: bool = False,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    temp_path: Path | None = None
    try:
        suffix = ".hyvebak"
        original = (file.filename or "upload.hyvebak").strip()
        if original.endswith(".hyvebak.enc"):
            suffix = ".hyvebak.enc"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = Path(tmp.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        return await asyncio.to_thread(
            service.import_uploaded_archive,
            temp_path,
            original,
            overwrite=overwrite,
        )
    except Exception as exc:
        if temp_path:
            temp_path.unlink(missing_ok=True)
        raise _map_error(exc) from exc


@router.post("/remote/test")
async def backup_test_remote(
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(service.test_remote_connection)
    except Exception as exc:
        raise _map_error(exc) from exc


@router.get("/remote/archives")
async def backup_list_remote_archives(
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        archives = await asyncio.to_thread(service.list_remote_archives)
        return {"archives": archives}
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/remote/pull")
async def backup_pull_remote(
    body: BackupRemotePullBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(
            service.pull_remote_archive,
            body.name,
            overwrite=body.overwrite,
        )
    except Exception as exc:
        raise _map_error(exc) from exc


@router.post("/remote/restore")
async def backup_restore_remote(
    body: BackupRemoteRestoreBody,
    _: models.User = Depends(auth.get_current_admin),
    service: BackupService = Depends(get_backup_service),
):
    try:
        return await asyncio.to_thread(
            service.restore_from_remote,
            body.name,
            options=BackupOptions(
                include_optional=body.include_optional,
                include_frigate_media=body.include_frigate_media,
            ),
            refetch_addons=body.refetch_addons,
            dry_run=body.dry_run,
            auto_pre_backup=body.auto_pre_backup,
            overwrite=body.overwrite,
            decryption_key=body.decryption_key,
        )
    except Exception as exc:
        raise _map_error(exc) from exc
