"""Add-on state persistence in SQLite."""

import json

from sqlalchemy import text

import core.database as database
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


def _no_integration_entries(_domain: str):
    return []


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

    import core.settings as settings_mod
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
    monkeypatch.setattr(registry, "_docker_installed_version", lambda _image: None)
    monkeypatch.setattr(registry, "_brew_installed_version", lambda _pkg: None)
    monkeypatch.setattr(registry, "_brew_binary_path", lambda _pkg: None)
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)

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


def test_reconcile_frigate_remote_integration_does_not_mark_installed(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "frigate": {
            "enabled": True,
            "host": "192.168.0.101",
            "port": 8971,
            "rtsp_port": 8554,
            "webrtc_port": 8555,
        },
    }), encoding="utf-8")

    import core.settings as settings_mod
    from addons import registry

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(
        settings_mod,
        "_load_config_raw",
        lambda: json.loads(cfg_path.read_text(encoding="utf-8")),
    )
    monkeypatch.setattr(settings_mod, "CFG", {})
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(registry, "_docker_installed_version", lambda _image: None)
    monkeypatch.setattr(registry, "_brew_installed_version", lambda _pkg: None)
    monkeypatch.setattr(registry, "_brew_binary_path", lambda _pkg: None)
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)

    assert registry.reconcile_addon_state() == 0
    frigate = state_store.get_state("frigate")
    assert frigate["installed"] is False


def test_repair_clears_false_installed_docker_addon(tmp_path, monkeypatch):
    _fresh_addon_state()
    state_store.save_state("frigate", {
        "installed": True,
        "enabled": True,
        "version": "stable",
        "config": {"port": 8971},
        "watchdog": False,
    })

    import core.settings as settings_mod
    from addons import registry

    cfg_path = tmp_path / "config.json"
    cfg_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(settings_mod, "_load_config_raw", lambda: {})
    monkeypatch.setattr(settings_mod, "CFG", {})
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(registry, "_docker_installed_version", lambda _image: None)
    monkeypatch.setattr(registry, "_brew_installed_version", lambda _pkg: None)
    monkeypatch.setattr(registry, "_brew_binary_path", lambda _pkg: None)
    monkeypatch.setattr(registry, "_detect_on_disk_install", lambda _manifest: None)
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: True)
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)

    assert registry.reconcile_addon_state() == 1
    frigate = state_store.get_state("frigate")
    assert frigate["installed"] is False
    assert frigate["enabled"] is False


def test_repair_skips_docker_addon_when_daemon_unreachable(tmp_path, monkeypatch):
    _fresh_addon_state()
    state_store.save_state("cloudflared", {
        "installed": True,
        "enabled": True,
        "version": "latest",
        "config": {"origin_url": "http://192.168.0.10:8082", "tunnel_token": "tok"},
        "watchdog": False,
    })

    import core.settings as settings_mod
    from addons import registry

    cfg_path = tmp_path / "config.json"
    cfg_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(settings_mod, "_load_config_raw", lambda: {})
    monkeypatch.setattr(settings_mod, "CFG", {})
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(registry, "_detect_on_disk_install", lambda _manifest: None)
    monkeypatch.setattr(registry, "_docker_daemon_reachable", lambda: False)
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)

    assert registry.reconcile_addon_state() == 0
    cloudflared = state_store.get_state("cloudflared")
    assert cloudflared["installed"] is True
    assert cloudflared["config"]["origin_url"] == "http://192.168.0.10:8082"


def test_detect_on_disk_cloudflared_data_dir(tmp_path, monkeypatch):
    from addons import registry

    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(registry, "_docker_installed_version", lambda _image: None)
    data_dir = tmp_path / "output" / "addons" / "cloudflared" / "data"
    data_dir.mkdir(parents=True)
    (data_dir / "cert.pem").write_text("test", encoding="utf-8")

    manifest = registry.get_manifest("cloudflared")
    assert registry._detect_on_disk_install(manifest) == "latest"


def test_docker_installed_version_accepts_latest_tag_when_image_exists(monkeypatch):
    from addons import registry

    monkeypatch.setattr(registry, "_docker_image_exists", lambda _image: True)
    assert registry._docker_installed_version("cloudflare/cloudflared:latest") == "latest"


def test_reconcile_restores_brew_addon_when_binary_present(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text("{}", encoding="utf-8")

    import core.settings as settings_mod
    from addons import registry

    monkeypatch.setattr(settings_mod, "CONFIG_FILE", str(cfg_path))
    monkeypatch.setattr(settings_mod, "_load_config_raw", lambda: {})
    monkeypatch.setattr(settings_mod, "CFG", {})
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(
        registry,
        "_detect_on_disk_install",
        lambda manifest: "2.1.2" if manifest.get("slug") == "mosquitto" else None,
    )
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)

    assert state_store.get_state("mosquitto")["installed"] is False
    assert registry.reconcile_addon_state() == 1
    mosq = state_store.get_state("mosquitto")
    assert mosq["installed"] is True
    assert mosq["version"] == "2.1.2"


def test_reconcile_does_not_downgrade_installed(tmp_path, monkeypatch):
    _fresh_addon_state()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text("{}", encoding="utf-8")

    import core.settings as settings_mod
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
    monkeypatch.setattr(
        registry,
        "_detect_on_disk_install",
        lambda manifest: "2.0.18" if manifest.get("slug") == "mosquitto" else None,
    )
    monkeypatch.setattr("integrations.config_entries.list_entries", _no_integration_entries)
    assert registry.reconcile_addon_state() == 0
    assert state_store.get_state("mosquitto")["installed"] is True


def test_watchdog_persists_in_sqlite():
    _fresh_addon_state()
    state_store.save_state("mosquitto", {
        "installed": True,
        "enabled": True,
        "version": "2.1.2",
        "config": {"port": 1883},
        "watchdog": True,
    })
    loaded = state_store.get_state("mosquitto")
    assert loaded["watchdog"] is True

    from addons import registry

    registry.set_addon_watchdog("mosquitto", False)
    assert state_store.get_state("mosquitto")["watchdog"] is False
    registry.set_addon_watchdog("mosquitto", True)
    assert state_store.get_state("mosquitto")["watchdog"] is True


def test_get_watchdog_addons_without_enabled_flag():
    from addons import registry

    _fresh_addon_state()
    state_store.save_state("mosquitto", {
        "installed": True,
        "enabled": False,
        "version": "2.1.2",
        "config": {"port": 1883},
        "watchdog": True,
    })
    assert "mosquitto" in registry.get_watchdog_addons()
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
