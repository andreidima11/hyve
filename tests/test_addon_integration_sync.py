"""Add-on → integration config entry sync."""

from addons import integration_sync, registry, state_store
from core.http.startup_migrations import run_startup_migrations
from integrations import config_entries
from sqlalchemy import text
import core.database as database


def _fresh(monkeypatch, tmp_path):
    entries_db = tmp_path / "integration_entries.sqlite"
    monkeypatch.setattr(config_entries, "_DB_PATH", entries_db)
    monkeypatch.setattr("core.settings._load_config_raw", lambda: {})
    monkeypatch.setattr(registry, "_detect_on_disk_install", lambda _m: None)
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


def test_sync_enabled_to_addon_from_integration(tmp_path, monkeypatch):
    _fresh(monkeypatch, tmp_path)

    state_store.save_state("frigate", {
        "installed": True,
        "enabled": True,
        "version": "0.17.1",
        "config": {"port": 5005},
        "watchdog": False,
    })
    config_entries.create_entry("frigate", title="Frigate", data={"port": 5005}, schema=[], enabled=True)

    integration_sync.sync_enabled_to_addon("frigate", False)

    assert registry.get_state("frigate")["enabled"] is False
    entries = config_entries.list_entries("frigate")
    assert entries[0]["enabled"] is True


def test_reconcile_hints_uses_config_entry_not_legacy(tmp_path, monkeypatch):
    _fresh(monkeypatch, tmp_path)

    config_entries.create_entry(
        "mosquitto",
        title="Mosquitto",
        data={"port": 1883},
        schema=[],
        enabled=False,
    )
    manifest = registry.get_manifest("mosquitto")
    assert manifest
    raw = {"mosquitto": {"enabled": True, "port": 1999}}
    hints = registry._reconcile_hints(manifest, raw, "2.1.0")
    assert hints is not None
    assert hints["enabled"] is False
    assert hints["config"]["port"] == 1883
