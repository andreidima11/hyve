"""High-level backup operations for API and CLI."""

from __future__ import annotations

import logging
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core.backup.archive import read_manifest_from_archive
from core.backup.config_store import get_backup_config, save_backup_config
from core.backup.coordinator import BackupCoordinator, RestoreResult
from core.backup.encryption import (
    decrypt_file,
    encrypt_file,
    encryption_available,
    encryption_key_status,
    export_encryption_key,
    is_encrypted_name,
)
from core.backup.maintenance import maintenance_mode
from core.backup.paths import BackupOptions
from core.backup.remote import (
    download_remote_archive,
    list_remote_archives,
    remote_configured,
    remote_enabled,
    test_remote,
    upload_backup,
)
from core.backup.retention import apply_retention

log = logging.getLogger("backup.service")

ROOT = Path(__file__).resolve().parents[2]


@dataclass
class BackupArchiveInfo:
    name: str
    path: str
    size: int
    created_at: str
    hyve_version: str
    file_count: int
    alembic_revision: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LastOperation:
    kind: str = ""
    status: str = ""
    at: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class BackupService:
    def __init__(self, root: Path | None = None, backups_dir: Path | None = None) -> None:
        self.root = (root or ROOT).resolve()
        self.backups_dir = (backups_dir or self.root / "output" / "backups").resolve()
        self.coordinator = BackupCoordinator(self.root)
        self._last_operation = LastOperation()

    def list_archives(self) -> list[BackupArchiveInfo]:
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        out: list[BackupArchiveInfo] = []
        patterns = ("*.hyvebak", "*.hyvebak.enc")
        paths: list[Path] = []
        for pattern in patterns:
            paths.extend(self.backups_dir.glob(pattern))
        for path in sorted(set(paths), key=lambda p: p.stat().st_mtime, reverse=True):
            if is_encrypted_name(path.name):
                out.append(
                    BackupArchiveInfo(
                        name=path.name,
                        path=self._relative_archive_path(path),
                        size=path.stat().st_size,
                        created_at=datetime.fromtimestamp(
                            path.stat().st_mtime, tz=timezone.utc
                        ).replace(microsecond=0).isoformat(),
                        hyve_version="encrypted",
                        file_count=0,
                    )
                )
                continue
            try:
                manifest = read_manifest_from_archive(path)
            except Exception as exc:
                log.warning("Skipping unreadable backup %s: %s", path.name, exc)
                continue
            out.append(
                BackupArchiveInfo(
                    name=path.name,
                    path=self._relative_archive_path(path),
                    size=path.stat().st_size,
                    created_at=manifest.created_at,
                    hyve_version=manifest.hyve_version,
                    file_count=len(manifest.files),
                    alembic_revision=manifest.alembic_revision,
                )
            )
        return out

    def create_backup(
        self,
        options: BackupOptions | None = None,
        *,
        label: str | None = None,
    ) -> dict[str, Any]:
        options = options or BackupOptions()
        dest = self._new_archive_path(label=label, prefix="hyve")
        manifest = self.coordinator.create_backup(dest, options)
        final_path = dest
        cfg = get_backup_config()
        encrypted = False
        if cfg.get("encrypt_at_rest"):
            if not encryption_available():
                raise RuntimeError("backup.encryption_unavailable")
            enc_path = encrypt_file(dest)
            dest.unlink(missing_ok=True)
            final_path = enc_path
            encrypted = True
        remote_result: dict[str, Any] | None = None
        if remote_enabled(cfg):
            try:
                remote_result = upload_backup(final_path, cfg)
            except Exception as exc:
                log.warning("Remote backup upload failed: %s", exc)
                remote_result = {"error": str(exc)}
        deleted = self._apply_retention()
        payload = {
            "path": self._relative_archive_path(final_path),
            "files": len(manifest.files),
            "created_at": manifest.created_at,
            "hyve_version": manifest.hyve_version,
            "alembic_revision": manifest.alembic_revision,
            "retention_deleted": deleted,
            "encrypted": encrypted,
            "remote": remote_result,
        }
        self._record("create", "ok", payload)
        return payload

    def verify(self, archive_ref: str, *, decryption_key: str | None = None) -> dict[str, Any]:
        archive, cleanup = self._open_archive(archive_ref, decryption_key=decryption_key)
        try:
            manifest = self.coordinator.verify_archive(archive)
        finally:
            self._cleanup_temp(cleanup)
        payload = {
            "ok": True,
            "path": archive_ref,
            "files": len(manifest.files),
            "created_at": manifest.created_at,
            "hyve_version": manifest.hyve_version,
        }
        self._record("verify", "ok", payload)
        return payload

    def restore(
        self,
        archive_ref: str,
        *,
        options: BackupOptions | None = None,
        refetch_addons: bool = False,
        dry_run: bool = False,
        auto_pre_backup: bool = True,
        decryption_key: str | None = None,
    ) -> dict[str, Any]:
        options = options or BackupOptions()
        archive, cleanup = self._open_archive(archive_ref, decryption_key=decryption_key)
        pre_restore_path: str | None = None

        if dry_run:
            try:
                result = self.coordinator.restore_backup(
                    archive,
                    options=options,
                    refetch_addons=refetch_addons,
                    dry_run=True,
                )
            finally:
                self._cleanup_temp(cleanup)
            payload = self._restore_payload(result, pre_restore_path=None, dry_run=True)
            self._record("restore", "dry_run", payload)
            return payload

        with maintenance_mode("restore"):
            if auto_pre_backup:
                pre = self.create_pre_restore_backup()
                pre_restore_path = pre["path"]
            try:
                result = self.coordinator.restore_backup(
                    archive,
                    options=options,
                    refetch_addons=refetch_addons,
                )
            except Exception as exc:
                self._record(
                    "restore",
                    "failed",
                    {"error": str(exc), "pre_restore_backup": pre_restore_path},
                )
                raise
            finally:
                self._cleanup_temp(cleanup)

        payload = self._restore_payload(
            result,
            pre_restore_path=pre_restore_path,
            dry_run=False,
        )
        self._record("restore", "ok", payload)
        return payload

    def rollback(self, archive_ref: str, *, decryption_key: str | None = None) -> dict[str, Any]:
        archive, cleanup = self._open_archive(archive_ref, decryption_key=decryption_key)
        try:
            with maintenance_mode("rollback"):
                result = self.coordinator.restore_backup(archive)
        finally:
            self._cleanup_temp(cleanup)
        payload = self._restore_payload(result, pre_restore_path=None, dry_run=False)
        self._record("rollback", "ok", payload)
        return payload

    def test_remote_connection(self) -> dict[str, Any]:
        cfg = get_backup_config()
        return test_remote(cfg)

    def list_remote_archives(self) -> list[dict[str, Any]]:
        cfg = get_backup_config()
        if not remote_enabled(cfg) or not remote_configured(cfg):
            raise ValueError("backup.remote_not_configured")
        return list_remote_archives(cfg)

    def pull_remote_archive(self, name: str, *, overwrite: bool = False) -> dict[str, Any]:
        from core.backup.remote.names import validate_remote_name

        cfg = get_backup_config()
        if not remote_enabled(cfg) or not remote_configured(cfg):
            raise ValueError("backup.remote_not_configured")
        filename = validate_remote_name(name)
        dest = self.backups_dir / filename
        if dest.exists() and not overwrite:
            raise ValueError("backup.remote_already_exists")
        result = download_remote_archive(filename, dest, cfg)
        result["path"] = self._relative_archive_path(dest)
        self._record("remote_pull", "ok", result)
        return result

    def restore_from_remote(
        self,
        name: str,
        *,
        options: BackupOptions | None = None,
        refetch_addons: bool = False,
        dry_run: bool = False,
        auto_pre_backup: bool = True,
        overwrite: bool = False,
        decryption_key: str | None = None,
    ) -> dict[str, Any]:
        from core.backup.remote.names import validate_remote_name

        filename = validate_remote_name(name)
        dest = self.backups_dir / filename
        pull: dict[str, Any] | None = None
        if not dest.exists() or overwrite:
            pull = self.pull_remote_archive(name, overwrite=overwrite)
            archive_ref = pull["path"]
        else:
            archive_ref = self._relative_archive_path(dest)
        restore = self.restore(
            archive_ref,
            options=options,
            refetch_addons=refetch_addons,
            dry_run=dry_run,
            auto_pre_backup=auto_pre_backup,
            decryption_key=decryption_key,
        )
        if pull:
            restore["remote_pull"] = pull
        return restore

    def create_pre_restore_backup(self) -> dict[str, Any]:
        dest = self._new_archive_path(prefix="pre-restore")
        manifest = self.coordinator.create_backup(dest, BackupOptions())
        return {
            "path": self._relative_archive_path(dest),
            "files": len(manifest.files),
            "created_at": manifest.created_at,
        }

    def delete_archive(self, archive_ref: str) -> dict[str, Any]:
        path = self._resolve_archive_path(archive_ref)
        name = path.name
        path.unlink()
        payload = {"deleted": self._relative_archive_path(path), "name": name}
        self._record("delete", "ok", payload)
        return payload

    def resolve_archive_download(self, archive_ref: str) -> Path:
        return self._resolve_archive_path(archive_ref)

    def import_uploaded_archive(
        self,
        temp_path: Path,
        original_name: str,
        *,
        overwrite: bool = False,
    ) -> dict[str, Any]:
        import shutil

        from core.backup.remote.names import validate_upload_name

        filename = validate_upload_name(original_name)
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        dest = self.backups_dir / filename
        if dest.exists() and not overwrite:
            raise ValueError("backup.upload_already_exists")
        if dest.exists():
            dest.unlink()
        shutil.move(str(temp_path), dest)
        payload = {
            "path": self._relative_archive_path(dest),
            "name": dest.name,
            "size": dest.stat().st_size,
        }
        self._record("upload", "ok", payload)
        return payload

    def get_settings(self) -> dict[str, Any]:
        return get_backup_config(redact_secrets=True)

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        saved = save_backup_config(updates)
        from core.backup.schedule import schedule_backup_job

        schedule_backup_job()
        return saved

    def get_encryption_key(self) -> dict[str, str]:
        return export_encryption_key()

    def status(self) -> dict[str, Any]:
        from core.backup.maintenance import get_status

        maint = get_status()
        cfg = get_backup_config(redact_secrets=True)
        return {
            "maintenance": maint.active,
            "maintenance_reason": maint.reason,
            "backups_dir": str(self.backups_dir.relative_to(self.root)),
            "archives": [a.to_dict() for a in self.list_archives()],
            "last_operation": self._last_operation.to_dict(),
            "settings": cfg,
            "encryption_available": encryption_available(),
            "encryption_key": encryption_key_status(),
            "remote_enabled": remote_enabled(cfg),
            "remote_configured": remote_configured(cfg),
        }

    def _apply_retention(self) -> list[str]:
        cfg = get_backup_config()
        return apply_retention(
            self.backups_dir,
            retention_count=int(cfg.get("retention_count") or 10),
            pre_restore_retention_count=int(cfg.get("pre_restore_retention_count") or 3),
        )

    def _restore_payload(
        self,
        result: RestoreResult,
        *,
        pre_restore_path: str | None,
        dry_run: bool,
    ) -> dict[str, Any]:
        return {
            "restored_files": len(result.restored_files),
            "files": result.restored_files,
            "pre_restore_backup": pre_restore_path,
            "critical_backups": result.pre_restore_backups,
            "refetch_slugs": result.refetch_slugs,
            "refetch_log": result.refetch_log,
            "dry_run": dry_run,
        }

    def _record(self, kind: str, status: str, detail: dict[str, Any]) -> None:
        self._last_operation = LastOperation(
            kind=kind,
            status=status,
            at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            detail=detail,
        )

    def _new_archive_path(self, *, prefix: str, label: str | None = None) -> Path:
        self.backups_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safe_label = ""
        if label:
            safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in label.strip())
            safe = safe.strip("-")[:40]
            if safe:
                safe_label = f"-{safe}"
        return self.backups_dir / f"{prefix}{safe_label}-{stamp}.hyvebak"

    def _relative_archive_path(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.backups_dir.resolve()).as_posix()
        except ValueError:
            return path.name

    def _resolve_archive_path(self, archive_ref: str) -> Path:
        ref = (archive_ref or "").strip().replace("\\", "/")
        if not ref or ".." in ref.split("/"):
            raise ValueError("backup.invalid_path")
        if not (ref.endswith(".hyvebak") or ref.endswith(".hyvebak.enc")):
            raise ValueError("backup.invalid_path")
        candidate = (self.backups_dir / ref).resolve()
        if not candidate.is_relative_to(self.backups_dir.resolve()):
            raise ValueError("backup.invalid_path")
        if not candidate.is_file():
            raise FileNotFoundError(f"backup.not_found:{ref}")
        return candidate

    def _open_archive(
        self,
        archive_ref: str,
        *,
        decryption_key: str | None = None,
    ) -> tuple[Path, Path | None]:
        path = self._resolve_archive_path(archive_ref)
        if not is_encrypted_name(path.name):
            return path, None
        tmp = Path(tempfile.mkdtemp(prefix="hyve-backup-decrypt-")) / "archive.hyvebak"
        key = (decryption_key or "").strip() or None
        decrypt_file(path, tmp, key=key)
        return tmp, tmp

    @staticmethod
    def _cleanup_temp(path: Path | None) -> None:
        if not path:
            return
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            path.parent.rmdir()
        except OSError:
            pass


_default_service: BackupService | None = None


def get_backup_service() -> BackupService:
    global _default_service
    if _default_service is None:
        _default_service = BackupService()
    return _default_service
