"""Add-on → integration config entry sync."""

from addons import integration_sync, registry, state_store
from core.http.startup_migrations import run_startup_migrations
from integrations import config_entries
from sqlalchemy import text
import core.database as database


def _fresh(monkeypatch, tmp_path):
    entries_db = tmp_path / "integration_entries.sqlite"
    monkeypatch.setattr(config_entries, "_DB_PATH", entries_db)
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM addon_state"))
        conn.commit()


def test_integration_key_for_frigate():
    assert integration_sync.integration_key_for("frigate") == "frigate"


def test_set_addon_enabled_syncs_config_entry(tmp_path, monkeypatch):
    _fresh(monkeypatch, tmp_path)

    state_store.save_state("frigate", {
        "installed": True,
        "enabled": False,
        "version": "0.17.1",
        "config": {"port": 5005},
        "watchdog": False,
    })

    integration_sync.sync_from_addon_state("frigate")
    registry.set_addon_enabled("frigate", True)

    entries = config_entries.list_entries("frigate")
    assert len(entries) == 1
    assert entries[0]["enabled"] is True
    assert entries[0]["data"].get("port") == 5005


def test_update_addon_config_syncs_config_entry(tmp_path, monkeypatch):
    _fresh(monkeypatch, tmp_path)

    state_store.save_state("mosquitto", {
        "installed": True,
        "enabled": True,
        "version": "2.0",
        "config": {"port": 1883},
        "watchdog": False,
    })

    registry.update_addon_config("mosquitto", {"port": 1884, "host": "localhost"})

    entries = config_entries.list_entries("mosquitto")
    assert len(entries) == 1
    assert entries[0]["data"].get("port") == 1884
    assert entries[0]["data"].get("host") == "localhost"
