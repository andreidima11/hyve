"""Legacy config.json → config entries migration tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from integrations import config_entries
from integrations.config_entries import migrate_from_cfg
from core import sqlite_sidecar


@pytest.fixture()
def isolated_entries_db(tmp_path, monkeypatch):
    db_path = tmp_path / "integration_entries.sqlite"
    monkeypatch.setattr(config_entries, "_DB_PATH", db_path)
    sqlite_sidecar.reset_initialized()
    config_entries._init()
    yield db_path
    sqlite_sidecar.reset_initialized()


def test_migrate_from_cfg_creates_entry_and_disables_legacy(isolated_entries_db, tmp_path, monkeypatch):
    cfg = {
        "open_meteo": {
            "enabled": True,
            "latitude": 44.43,
            "longitude": 26.10,
            "scan_interval": 600,
        }
    }
    saved: list[dict] = []

    def _fake_save(updated):
        saved.append(dict(updated))

    monkeypatch.setattr("settings.save_config", _fake_save)

    created = migrate_from_cfg(cfg, ["open_meteo"])
    assert created == 1
    entries = config_entries.list_entries("open_meteo")
    assert len(entries) == 1
    assert entries[0]["data"]["latitude"] == 44.43
    assert cfg["open_meteo"]["enabled"] is False
    assert saved and saved[0]["open_meteo"]["enabled"] is False


def test_migrate_from_cfg_idempotent_when_entry_exists(isolated_entries_db, monkeypatch):
    cfg = {"open_meteo": {"enabled": True, "latitude": 1.0, "longitude": 2.0}}
    monkeypatch.setattr("settings.save_config", lambda _: None)
    config_entries.create_entry(
        slug="open_meteo",
        title="Existing",
        data={"latitude": 1.0, "longitude": 2.0},
        schema=[],
        enabled=True,
    )
    created = migrate_from_cfg(cfg, ["open_meteo"])
    assert created == 0
    # Legacy cfg.enabled is not clobbered on repeat runs — entries.enabled is authoritative.
    assert cfg["open_meteo"]["enabled"] is True
    assert len(config_entries.list_entries("open_meteo")) == 1
