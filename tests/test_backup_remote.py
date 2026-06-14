"""Encryption and remote upload tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from cryptography.fernet import Fernet

import core.auth as auth
import core.settings as settings_mod
from core.backup.encryption import decrypt_file, encrypt_file, is_encrypted_name
from core.backup.service import BackupService
from core.http.app import create_app


def test_encrypt_decrypt_roundtrip(tmp_path: Path, monkeypatch):
    key_file = tmp_path / "backup_archive.key"
    monkeypatch.setenv("HYVE_BACKUP_ENCRYPTION_KEY", "")
    import core.backup.encryption as enc

    monkeypatch.setattr(enc, "_KEY_PATH", key_file)
    monkeypatch.setattr(enc, "_FERNET", None)

    src = tmp_path / "sample.hyvebak"
    src.write_bytes(b"hyve-backup-test-data")
    enc_path = encrypt_file(src)
    assert is_encrypted_name(enc_path.name)
    out = tmp_path / "plain.hyvebak"
    decrypt_file(enc_path, out)
    assert out.read_bytes() == b"hyve-backup-test-data"


def test_decrypt_with_explicit_key(tmp_path: Path, monkeypatch):
    """Imported encrypted backup can be opened with the source server's key."""
    import core.backup.encryption as enc

    source_key = Fernet.generate_key()
    dest_key_file = tmp_path / "backup_archive.key"
    monkeypatch.setenv("HYVE_BACKUP_ENCRYPTION_KEY", "")
    monkeypatch.setattr(enc, "_KEY_PATH", dest_key_file)
    monkeypatch.setattr(enc, "_FERNET", None)
    dest_key_file.write_bytes(Fernet.generate_key())

    src = tmp_path / "sample.hyvebak"
    src.write_bytes(b"hyve-backup-migrated")
    enc_path = tmp_path / "sample.hyvebak.enc"
    enc_path.write_bytes(Fernet(source_key).encrypt(src.read_bytes()))

    out = tmp_path / "plain.hyvebak"
    decrypt_file(enc_path, out, key=source_key.decode("utf-8"))
    assert out.read_bytes() == b"hyve-backup-migrated"


def test_create_encrypted_backup(tmp_path: Path, monkeypatch):
    root = tmp_path / "hyve"
    root.mkdir()
    backups = root / "output" / "backups"
    backups.mkdir(parents=True)
    (root / "config.json").write_text(json.dumps({"setup_complete": True}), encoding="utf-8")

    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(
        json.dumps({"setup_complete": True, "backup": {"encrypt_at_rest": True}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_file))
    settings_mod.reload_config()

    key_file = tmp_path / "backup_archive.key"
    import core.backup.encryption as enc

    monkeypatch.setattr(enc, "_KEY_PATH", key_file)
    monkeypatch.setattr(enc, "_FERNET", None)

    service = BackupService(root=root, backups_dir=backups)

    def _fake_create(path, options):
        path.write_bytes(b"archive-bytes")
        from core.backup.manifest import BackupManifest

        return BackupManifest(
            format_version=1,
            created_at="2026-01-01T00:00:00+00:00",
            hyve_version="0.9.6.4",
            alembic_revision=None,
            options={},
        )

    with patch.object(service.coordinator, "create_backup", side_effect=_fake_create):
        result = service.create_backup()
    assert result["encrypted"] is True
    assert is_encrypted_name(result["path"])
    assert not (backups / "hyve-test.hyvebak").exists()


def test_remote_s3_upload_mock(tmp_path: Path, monkeypatch):
    root = tmp_path / "hyve"
    backups = root / "output" / "backups"
    backups.mkdir(parents=True)
    archive = backups / "hyve-remote.hyvebak"
    archive.write_bytes(b"x")

    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(
        json.dumps(
            {
                "backup": {
                    "remote": {
                        "enabled": True,
                        "provider": "s3",
                        "retention_count": 2,
                        "s3": {"bucket": "my-bucket", "prefix": "hyve/"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_file))
    settings_mod.reload_config()

    uploaded = {}

    class _Client:
        def upload_file(self, filename, bucket, key):
            uploaded["bucket"] = bucket
            uploaded["key"] = key

        def list_objects_v2(self, **kwargs):
            return {"Contents": [], "IsTruncated": False}

    monkeypatch.setenv("HYVE_BACKUP_S3_ACCESS_KEY", "ak")
    monkeypatch.setenv("HYVE_BACKUP_S3_SECRET_KEY", "sk")
    with patch("core.backup.remote.s3._client", return_value=_Client()):
        from core.backup.remote import upload_backup
        from core.backup.config_store import get_backup_config

        result = upload_backup(archive, get_backup_config())
    assert result["bucket"] == "my-bucket"
    assert uploaded["key"] == "hyve/hyve-remote.hyvebak"


@pytest.fixture()
def backup_client(tmp_path, monkeypatch):
    root = tmp_path / "hyve"
    root.mkdir()
    backups = root / "output" / "backups"
    backups.mkdir(parents=True)
    service = BackupService(root=root, backups_dir=backups)
    bundle = create_app()
    admin = MagicMock()
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_admin] = lambda: admin
    from core.backup.service import get_backup_service

    bundle.app.dependency_overrides[get_backup_service] = lambda: service
    return TestClient(bundle.app), service


def test_validate_remote_name():
    from core.backup.remote.names import is_backup_filename, validate_remote_name

    assert is_backup_filename("hyve-20260101T000000Z.hyvebak")
    assert is_backup_filename("pre-restore-20260101T000000Z.hyvebak.enc")
    assert not is_backup_filename("evil.hyvebak")
    assert not is_backup_filename("hyve-evil.tar.gz")
    assert validate_remote_name("hyve-20260101T000000Z.hyvebak") == "hyve-20260101T000000Z.hyvebak"
    with pytest.raises(ValueError, match="backup.invalid_path"):
        validate_remote_name("../etc/passwd")
    with pytest.raises(ValueError, match="backup.invalid_path"):
        validate_remote_name("hyve-evil.tar.gz")


def test_list_s3_archives_mock(monkeypatch):
    class _Client:
        def list_objects_v2(self, **kwargs):
            return {
                "Contents": [
                    {"Key": "hyve/hyve-a.hyvebak", "Size": 100, "LastModified": None},
                    {"Key": "hyve/readme.txt", "Size": 1, "LastModified": None},
                    {"Key": "hyve/pre-restore-b.hyvebak.enc", "Size": 200, "LastModified": None},
                ],
                "IsTruncated": False,
            }

    monkeypatch.setenv("HYVE_BACKUP_S3_ACCESS_KEY", "ak")
    monkeypatch.setenv("HYVE_BACKUP_S3_SECRET_KEY", "sk")
    with patch("core.backup.remote.s3._client", return_value=_Client()):
        from core.backup.remote.s3 import list_s3_archives

        rows = list_s3_archives({"bucket": "b", "prefix": "hyve/"})
    assert len(rows) == 2
    names = {row["name"] for row in rows}
    assert names == {"hyve-a.hyvebak", "pre-restore-b.hyvebak.enc"}


def test_pull_remote_archive_api(backup_client, monkeypatch, tmp_path):
    client, service = backup_client
    archive_name = "hyve-remote-pull.hyvebak"
    pulled = {"name": archive_name, "path": archive_name, "size": 12, "provider": "s3"}

    monkeypatch.setattr(service, "pull_remote_archive", lambda name, overwrite=False: pulled)
    res = client.post("/api/backup/remote/pull", json={"name": archive_name})
    assert res.status_code == 200
    assert res.json()["name"] == archive_name


def test_list_remote_archives_api(backup_client, monkeypatch):
    client, service = backup_client
    rows = [{"name": "hyve-x.hyvebak", "size": 1, "provider": "s3"}]
    monkeypatch.setattr(service, "list_remote_archives", lambda: rows)
    res = client.get("/api/backup/remote/archives")
    assert res.status_code == 200
    assert res.json()["archives"] == rows


def test_restore_from_remote_uses_local_when_present(backup_client, monkeypatch, tmp_path):
    client, service = backup_client
    root = service.root
    backups = service.backups_dir
    name = "hyve-local-restore.hyvebak"
    local = backups / name
    local.write_bytes(b"local-archive")
    pull_called = {"count": 0}

    def _pull(name, overwrite=False):
        pull_called["count"] += 1
        return {"path": name}

    restore_called: list[str] = []

    def _restore(path, **kwargs):
        restore_called.append(path)
        return {"restored_files": 1, "files": ["config.json"], "dry_run": False}

    monkeypatch.setattr(service, "pull_remote_archive", _pull)
    monkeypatch.setattr(service, "restore", _restore)
    result = service.restore_from_remote(name)
    assert pull_called["count"] == 0
    assert restore_called == [name]
    assert "remote_pull" not in result


def test_remote_test_api(backup_client, monkeypatch):
    client, service = backup_client
    monkeypatch.setattr(service, "test_remote_connection", lambda: {"ok": True, "provider": "s3"})
    res = client.post("/api/backup/remote/test")
    assert res.status_code == 200
    assert res.json()["ok"] is True
