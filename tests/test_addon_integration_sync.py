"""Add-on → integration config.json sync."""

import json

from addons import integration_sync, registry, state_store
from core.http.startup_migrations import run_startup_migrations
from sqlalchemy import text
import core.database as database


def _fresh():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM addon_state"))
        conn.commit()


def test_integration_key_for_frigate():
    assert integration_sync.integration_key_for("frigate") == "frigate"


def test_set_addon_enabled_syncs_config_json(tmp_path, monkeypatch):
    _fresh()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({"frigate": {"enabled": False, "port": 5000}}), encoding="utf-8")

    import core.settings as settings_mod

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(
        settings_mod,
        "_load_config_raw",
        lambda: json.loads(cfg_path.read_text(encoding="utf-8")),
    )

    saved_cfg: dict = {}

    def _capture_save(patch):
        saved_cfg.update(patch)
        current = json.loads(cfg_path.read_text(encoding="utf-8"))
        for key, value in patch.items():
            if key in current and isinstance(current[key], dict) and isinstance(value, dict):
                current[key].update(value)
            else:
                current[key] = value
        cfg_path.write_text(json.dumps(current, indent=4), encoding="utf-8")
        settings_mod.CFG = settings_mod.load_config()
        return settings_mod.CFG

    monkeypatch.setattr(settings_mod, "save_config", _capture_save)

    state_store.save_state("frigate", {
        "installed": True,
        "enabled": False,
        "version": "0.17.1",
        "config": {"port": 5005},
        "watchdog": False,
    })

    registry.set_addon_enabled("frigate", True)

    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert data["frigate"]["enabled"] is True
    assert data["frigate"]["port"] == 5000


def test_update_addon_config_syncs_fields(tmp_path, monkeypatch):
    _fresh()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({"mosquitto": {"enabled": True}}), encoding="utf-8")

    import core.settings as settings_mod

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(
        settings_mod,
        "_load_config_raw",
        lambda: json.loads(cfg_path.read_text(encoding="utf-8")),
    )

    def _capture_save(patch):
        current = json.loads(cfg_path.read_text(encoding="utf-8"))
        for key, value in patch.items():
            if key in current and isinstance(current[key], dict) and isinstance(value, dict):
                current[key].update(value)
            else:
                current[key] = value
        cfg_path.write_text(json.dumps(current, indent=4), encoding="utf-8")
        settings_mod.CFG = settings_mod.load_config()
        return settings_mod.CFG

    monkeypatch.setattr(settings_mod, "save_config", _capture_save)

    state_store.save_state("mosquitto", {
        "installed": True,
        "enabled": True,
        "version": "2.0",
        "config": {"port": 1883},
        "watchdog": False,
    })

    registry.update_addon_config("mosquitto", {"port": 1884, "host": "localhost"})

    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert data["mosquitto"]["port"] == 1884
    assert data["mosquitto"]["host"] == "localhost"
