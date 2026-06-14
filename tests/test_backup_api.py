"""Admin backup API tests."""

from __future__ import annotations

import json
import sqlite3
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import core.auth as auth
import core.backup.maintenance as maintenance_mod
from core.backup.service import BackupService, get_backup_service
from core.http.app import create_app


def _init_users_db(path):
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"
    )
    conn.execute("INSERT INTO alembic_version (version_num) VALUES ('rev1')")
    conn.commit()
    conn.close()


@pytest.fixture()
def backup_env(tmp_path, monkeypatch):
    root = tmp_path / "hyve"
    root.mkdir()
    backups = root / "output" / "backups"
    backups.mkdir(parents=True)
    (root / "config.json").write_text(json.dumps({"setup_complete": True}), encoding="utf-8")
    _init_users_db(root / "users.db")

    service = BackupService(root=root, backups_dir=backups)

    bundle = create_app()
    admin = MagicMock()
    admin.username = "admin"
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_admin] = lambda: admin
    bundle.app.dependency_overrides[get_backup_service] = lambda: service
    client = TestClient(bundle.app)
    return client, service, root, backups


def test_backup_create_and_status(backup_env):
    client, _service, _root, backups = backup_env
    res = client.post("/api/backup/create", json={"label": "test"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["files"] >= 2
    assert (backups / body["path"]).is_file()

    status = client.get("/api/backup/status")
    assert status.status_code == 200
    data = status.json()
    assert data["maintenance"] is False
    assert len(data["archives"]) == 1


def test_backup_restore_with_pre_backup(backup_env):
    client, _service, root, backups = backup_env
    dash = root / "dashboards"
    dash.mkdir()
    (dash / "home.json").write_text('{"title":"Home"}', encoding="utf-8")

    created = client.post("/api/backup/create", json={})
    archive_path = created.json()["path"]

    (dash / "home.json").write_text('{"title":"Changed"}', encoding="utf-8")

    res = client.post(
        "/api/backup/restore",
        json={"path": archive_path, "auto_pre_backup": True},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["pre_restore_backup"]
    assert json.loads((dash / "home.json").read_text(encoding="utf-8"))["title"] == "Home"
    assert (backups / body["pre_restore_backup"]).is_file()
    assert (backups / archive_path).is_file()


def test_backup_encryption_key_export(backup_env, monkeypatch, tmp_path):
    client, _service, root, _backups = backup_env
    key_file = root / "secrets" / "backup_archive.key"
    key_file.parent.mkdir(parents=True, exist_ok=True)
    test_key = "test-fernet-key-placeholder-not-valid"
    key_file.write_text(test_key, encoding="utf-8")

    import core.backup.encryption as enc

    monkeypatch.setenv("HYVE_BACKUP_ENCRYPTION_KEY", "")
    monkeypatch.setattr(enc, "_KEY_PATH", key_file)
    monkeypatch.setattr(enc, "_FERNET", None)

    missing = client.get("/api/backup/encryption-key")
    # invalid fernet key in file - export still returns raw key string
    assert missing.status_code == 200
    assert missing.json()["key"] == test_key
    assert missing.json()["source"] == "file"

    status = client.get("/api/backup/status")
    assert status.status_code == 200
    assert status.json()["encryption_key"]["configured"] is True


def test_backup_encryption_key_missing(backup_env, monkeypatch, tmp_path):
    client, _service, root, _backups = backup_env
    import core.backup.encryption as enc

    key_file = tmp_path / "missing.key"
    monkeypatch.setenv("HYVE_BACKUP_ENCRYPTION_KEY", "")
    monkeypatch.setattr(enc, "_KEY_PATH", key_file)
    monkeypatch.setattr(enc, "_FERNET", None)

    res = client.get("/api/backup/encryption-key")
    assert res.status_code == 400
    assert res.json()["detail"]["key"] == "backup.encryption_key_missing"


def test_maintenance_blocks_api(backup_env):
    client, _, _, _ = backup_env
    with maintenance_mod.maintenance_mode("restore"):
        blocked = client.get("/api/updates/addons")
        assert blocked.status_code == 503
        assert blocked.json()["key"] == "backup.maintenance_active"
        maint = client.get("/api/backup/maintenance")
        assert maint.status_code == 200
        assert maint.json()["maintenance"] is True
        health = client.get("/api/health")
        assert health.status_code == 200

    ok = client.get("/api/updates/addons")
    assert ok.status_code in {200, 401, 403}


def test_backup_requires_admin(backup_env):
    _client, service, _root, _backups = backup_env

    def _raise_admin():
        raise HTTPException(403, "Admin only")

    bundle = create_app()
    bundle.app.dependency_overrides[auth.get_current_admin] = _raise_admin
    bundle.app.dependency_overrides[get_backup_service] = lambda: service

    client = TestClient(bundle.app)
    res = client.get("/api/backup/status")
    assert res.status_code == 403


def test_backup_download_and_upload(backup_env):
    client, _service, _root, backups = backup_env
    archive = backups / "hyve-export.hyvebak"
    archive.write_bytes(b"hyve-archive-bytes")

    dl = client.get("/api/backup/archives/download", params={"path": archive.name})
    assert dl.status_code == 200
    assert dl.content == b"hyve-archive-bytes"

    files = {"file": ("imported-from-remote.hyvebak", b"imported-bytes", "application/gzip")}
    up = client.post("/api/backup/archives/upload", files=files)
    assert up.status_code == 200, up.text
    assert up.json()["name"] == "imported-from-remote.hyvebak"
    assert (backups / "imported-from-remote.hyvebak").read_bytes() == b"imported-bytes"
