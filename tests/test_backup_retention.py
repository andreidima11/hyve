"""Retention and backup settings tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import core.auth as auth
import core.settings as settings_mod
from core.backup.config_store import get_backup_config, save_backup_config
from core.backup.retention import apply_retention
from core.backup.service import BackupService
from core.http.app import create_app


def test_apply_retention_keeps_newest_hyve_and_pre_restore(tmp_path: Path):
    backups = tmp_path / "backups"
    backups.mkdir()
    for i in range(5):
        (backups / f"hyve-{i}.hyvebak").write_bytes(b"x")
    for i in range(4):
        (backups / f"pre-restore-{i}.hyvebak").write_bytes(b"x")

    deleted = apply_retention(backups, retention_count=2, pre_restore_retention_count=1)
    remaining = sorted(p.name for p in backups.glob("*.hyvebak"))
    assert len(remaining) == 3
    assert len(deleted) == 6


def test_save_backup_config_persists(tmp_path: Path, monkeypatch):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"setup_complete": True}), encoding="utf-8")
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_file))
    settings_mod.reload_config()

    saved = save_backup_config(
        {
            "schedule_interval": "daily",
            "retention_count": 7,
            "pre_restore_retention_count": 2,
            "include_optional": True,
        }
    )
    assert saved["schedule_interval"] == "daily"
    assert saved["retention_count"] == 7
    assert saved["include_optional"] is True
    assert get_backup_config()["retention_count"] == 7


@pytest.fixture()
def backup_env(tmp_path, monkeypatch):
    root = tmp_path / "hyve"
    root.mkdir()
    backups = root / "output" / "backups"
    backups.mkdir(parents=True)
    (root / "config.json").write_text(json.dumps({"setup_complete": True}), encoding="utf-8")

    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({"setup_complete": True, "backup": {"retention_count": 5}}), encoding="utf-8")
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_file))
    settings_mod.reload_config()

    service = BackupService(root=root, backups_dir=backups)
    bundle = create_app()
    admin = MagicMock()
    admin.username = "admin"
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_admin] = lambda: admin
    from core.backup.service import get_backup_service

    bundle.app.dependency_overrides[get_backup_service] = lambda: service
    return TestClient(bundle.app), service, backups


def test_backup_settings_api(backup_env, monkeypatch):
    client, service, _backups = backup_env
    monkeypatch.setattr(
        "core.backup.schedule.schedule_backup_job",
        lambda: None,
    )
    res = client.post(
        "/api/backup/settings",
        json={
            "schedule_interval": "weekly",
            "retention_count": 8,
            "pre_restore_retention_count": 2,
            "include_optional": True,
            "include_frigate_media": False,
            "refetch_addons": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["schedule_interval"] == "weekly"
    assert body["retention_count"] == 8

    status = client.get("/api/backup/status")
    assert status.status_code == 200
    assert status.json()["settings"]["schedule_interval"] == "weekly"


def test_backup_delete_archive(backup_env):
    client, service, backups = backup_env
    archive = backups / "hyve-test.hyvebak"
    archive.write_bytes(b"fake")

    res = client.request("DELETE", "/api/backup/archives", json={"path": "hyve-test.hyvebak"})
    assert res.status_code == 200, res.text
    assert not archive.exists()


def test_backup_delete_missing_returns_404(backup_env):
    client, _, _ = backup_env
    res = client.request("DELETE", "/api/backup/archives", json={"path": "missing.hyvebak"})
    assert res.status_code == 404
