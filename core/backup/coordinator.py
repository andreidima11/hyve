"""Orchestrate Hyve backup creation and restore."""

from __future__ import annotations

import logging
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from core.backup.addon_restore import AddonRestoreCoordinator
from core.backup.addons_policy import list_addon_slugs_with_data, slugs_needing_artifact_refetch
from core.backup.archive import create_archive, extract_archive
from core.backup.manifest import BackupManifest, build_manifest, sha256_file
from core.backup.paths import BackupOptions, collect_backup_entries
from core.backup.sqlite_snapshot import is_sqlite_archive_path, read_alembic_revision, snapshot_sqlite

log = logging.getLogger("backup")

ROOT = Path(__file__).resolve().parents[2]


@dataclass
class RestoreResult:
    restored_files: list[str] = field(default_factory=list)
    pre_restore_backups: list[str] = field(default_factory=list)
    refetch_slugs: list[str] = field(default_factory=list)
    refetch_log: list[str] = field(default_factory=list)


class BackupCoordinator:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or ROOT).resolve()

    def create_backup(
        self,
        dest: Path,
        options: BackupOptions | None = None,
    ) -> BackupManifest:
        options = options or BackupOptions()
        entries = collect_backup_entries(self.root, options)

        with tempfile.TemporaryDirectory(prefix="hyve-backup-staging-") as tmp:
            staging = Path(tmp)
            payload: list[tuple[Path, str]] = []
            alembic_revision: str | None = None

            for abs_path, rel in entries:
                if is_sqlite_archive_path(rel):
                    staged = staging / rel
                    snapshot_sqlite(abs_path, staged)
                    payload.append((staged, rel))
                    if rel == "users.db":
                        alembic_revision = read_alembic_revision(staged)
                else:
                    payload.append((abs_path, rel))

            if alembic_revision is None:
                users_db = self.root / "users.db"
                if users_db.is_file():
                    alembic_revision = read_alembic_revision(users_db)

            addon_slugs = list_addon_slugs_with_data(self.root)
            hyve_version = self._hyve_version()
            manifest = build_manifest(
                hyve_version=hyve_version,
                alembic_revision=alembic_revision,
                options={
                    "include_optional": options.include_optional,
                    "include_frigate_media": options.include_frigate_media,
                },
                file_entries=[(rel, path) for path, rel in payload],
                addons_meta={
                    "included_slugs": addon_slugs,
                    "refetch_on_restore": slugs_needing_artifact_refetch(addon_slugs),
                },
            )
            create_archive(manifest, payload, dest)

        log.info("Created backup %s (%d files)", dest, len(manifest.files))
        return manifest

    def verify_archive(self, archive: Path) -> BackupManifest:
        with tempfile.TemporaryDirectory(prefix="hyve-backup-verify-") as tmp:
            manifest, data_root = extract_archive(archive, Path(tmp))
            for entry in manifest.files:
                path = data_root / entry.path
                if not path.is_file():
                    raise FileNotFoundError(f"missing_in_archive:{entry.path}")
                digest = sha256_file(path)
                if digest != entry.sha256:
                    raise ValueError(f"checksum_mismatch:{entry.path}")
            return manifest

    def restore_backup(
        self,
        archive: Path,
        *,
        options: BackupOptions | None = None,
        refetch_addons: bool = False,
        dry_run: bool = False,
    ) -> RestoreResult:
        options = options or BackupOptions()
        result = RestoreResult()

        with tempfile.TemporaryDirectory(prefix="hyve-backup-restore-") as tmp:
            manifest, data_root = extract_archive(archive, Path(tmp))
            for entry in manifest.files:
                src = data_root / entry.path
                if not src.is_file():
                    raise FileNotFoundError(f"missing_in_archive:{entry.path}")
                digest = sha256_file(src)
                if digest != entry.sha256:
                    raise ValueError(f"checksum_mismatch:{entry.path}")

                dest = self.root / entry.path
                if dry_run:
                    result.restored_files.append(entry.path)
                    continue

                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.is_file() and self._is_critical(entry.path):
                    backup_path = self.root / self._pre_restore_name(entry.path)
                    backup_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(dest, backup_path)
                    result.pre_restore_backups.append(
                        backup_path.relative_to(self.root).as_posix()
                    )

                if is_sqlite_archive_path(entry.path):
                    snapshot_sqlite(src, dest)
                else:
                    shutil.copy2(src, dest)
                result.restored_files.append(entry.path)

        coordinator = AddonRestoreCoordinator(self.root)
        plan = coordinator.plan(manifest.addons)
        result.refetch_slugs = plan.refetch_slugs
        if refetch_addons and not dry_run:
            result.refetch_log = coordinator.refetch_artifacts(plan.refetch_slugs)

        log.info(
            "Restored %d files from %s (refetch=%s)",
            len(result.restored_files),
            archive,
            result.refetch_slugs,
        )
        return result

    @staticmethod
    def _is_critical(rel: str) -> bool:
        critical = {
            "users.db",
            "config.json",
            "secrets/integration_entries.key",
            "core/.secret_key",
            ".env",
        }
        return rel in critical

    @staticmethod
    def _pre_restore_name(rel: str) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safe = rel.replace("/", "__")
        return f".hyve-pre-restore/{safe}.{stamp}"

    @staticmethod
    def _hyve_version() -> str:
        try:
            from core.settings import RELEASE_VERSION

            return RELEASE_VERSION
        except ImportError:
            return "unknown"
