"""Add-on state persistence in SQLite."""

import json

from sqlalchemy import text

import database
from addons import state_store
from core.http.startup_migrations import run_startup_migrations


def _fresh_addon_state():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM addon_state"))
        conn.commit()


def test_addon_state_round_trip():
    _fresh_addon_state()
    saved = state_store.save_state("frigate", {
        "installed": True,
        "enabled": True,
        "version": "0.17.1",
        "latest_version": "0.17.1",
        "config": {"port": 5005, "api_key": "secret"},
        "watchdog": True,
    })
    assert saved["installed"] is True
    assert saved["config"]["port"] == 5005

    loaded = state_store.get_state("frigate")
    assert loaded == saved


def test_addon_state_defaults_when_missing():
    _fresh_addon_state()
    assert state_store.get_state("nonexistent") == state_store.DEFAULT_STATE


def test_migrate_from_config_json(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "version": "0.8.13",
        "addons": {
            "mosquitto": {
                "installed": True,
                "enabled": True,
                "version": "2.0.18",
                "config": {"port": 1883},
                "watchdog": False,
            },
        },
    }), encoding="utf-8")

    monkeypatch.setattr(state_store.settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(
        state_store.settings_mod,
        "_load_config_raw",
        lambda: json.loads(cfg_path.read_text(encoding="utf-8")),
    )
    monkeypatch.setattr(state_store.settings_mod, "CFG", {})

    count = state_store.migrate_from_config_json()
    assert count == 1

    loaded = state_store.get_state("mosquitto")
    assert loaded["installed"] is True
    assert loaded["version"] == "2.0.18"
    assert loaded["config"]["port"] == 1883

    remaining = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert "addons" not in remaining


def test_addon_state_table_from_migrations():
    run_startup_migrations()

    with database.engine.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'")
            )
        }
        cols = {
            row[1] for row in conn.execute(text("PRAGMA table_info(addon_state)"))
        }
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()

    assert "addon_state" in tables
    assert {"slug", "installed", "enabled", "version", "config_json", "watchdog"}.issubset(cols)
    assert version == "007_addon_state"
