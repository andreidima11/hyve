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


def test_reconcile_addon_state_from_integration_and_disk(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "zigbee2mqtt": {
            "enabled": True,
            "mqtt_host": "localhost",
            "mqtt_port": 1883,
            "web_port": 8080,
            "serial_port": "/dev/ttyUSB0",
        },
        "piper": {
            "enabled": False,
            "port": 10200,
            "voice": "ro_RO-mihai-medium",
        },
    }), encoding="utf-8")

    import settings as settings_mod
    from addons import registry

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(
        settings_mod,
        "_load_config_raw",
        lambda: json.loads(cfg_path.read_text(encoding="utf-8")),
    )
    monkeypatch.setattr(settings_mod, "CFG", {})

    models_dir = tmp_path / "piper_models"
    models_dir.mkdir()
    (models_dir / "test.onnx").write_text("x", encoding="utf-8")
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)

    z2m_prefix = tmp_path / "output/addons/zigbee2mqtt/runtime"
    pkg_dir = z2m_prefix / "node_modules" / "zigbee2mqtt"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "package.json").write_text(
        json.dumps({"version": "2.12.0"}),
        encoding="utf-8",
    )

    count = registry.reconcile_addon_state()
    assert count == 2

    z2m = state_store.get_state("zigbee2mqtt")
    assert z2m["installed"] is True
    assert z2m["enabled"] is True
    assert z2m["version"] == "2.12.0"
    assert z2m["config"]["serial_port"] == "/dev/ttyUSB0"

    piper = state_store.get_state("piper")
    assert piper["installed"] is True
    assert piper["config"]["voice"] == "ro_RO-mihai-medium"


def test_reconcile_does_not_downgrade_installed(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text("{}", encoding="utf-8")

    import settings as settings_mod
    from addons import registry

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(settings_mod, "_load_config_raw", lambda: {})
    monkeypatch.setattr(settings_mod, "CFG", {})

    state_store.save_state("mosquitto", {
        "installed": True,
        "enabled": True,
        "version": "2.0.18",
        "config": {"port": 1883},
        "watchdog": False,
    })

    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    assert registry.reconcile_addon_state() == 0
    assert state_store.get_state("mosquitto")["installed"] is True


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
