"""Home automation add-on registry and config tests."""

import json
import subprocess
import time
from pathlib import Path

from addons import registry


def test_home_automation_addons_are_registered():
    addons = {item["slug"]: item for item in registry.list_available()}

    assert "mosquitto" in addons
    assert "zigbee2mqtt" in addons

    assert addons["mosquitto"]["install"]["method"] == "brew"
    assert addons["zigbee2mqtt"]["install"]["method"] == "npm"


def test_all_addons_use_on_demand_installs():
    for addon in registry.list_available():
        install = addon.get("install") or {}
        assert install.get("download_on_install") is True
        assert install.get("bundled") is False


def test_zigbee2mqtt_manifest_supports_local_config_and_web_ui():
    manifest = registry.get_manifest("zigbee2mqtt")

    assert manifest is not None
    schema_keys = {field["key"] for field in manifest.get("config_schema", [])}

    assert {"port", "mqtt_host", "mqtt_port", "web_port", "serial_port", "adapter"}.issubset(schema_keys)
    assert "host" not in schema_keys
    assert "webui_url" not in schema_keys

    web_ui = manifest.get("web_ui") or {}
    assert web_ui.get("host") == "localhost"
    assert web_ui.get("port_key") == "web_port"
    assert "url_key" not in web_ui

    start_command = manifest.get("start_command") or {}
    assert start_command.get("command") == "bash"

    install = manifest.get("install") or {}
    assert install.get("method") == "npm"
    requirements = install.get("requirements") or []
    packages = install.get("packages") or []
    assert any(str(pkg).startswith("pnpm@") for pkg in requirements)
    assert any(str(pkg).startswith("zigbee2mqtt@") for pkg in packages)


Z2M_RUN_SH = Path(__file__).resolve().parents[1] / "addons" / "available" / "zigbee2mqtt" / "run.sh"


def test_zigbee2mqtt_start_command_includes_adapter():
    from addons.process_manager import _effective_config, _resolve_args

    manifest = registry.get_manifest("zigbee2mqtt")
    assert manifest is not None
    merged = _effective_config(
        manifest,
        {
            "web_port": 8080,
            "mqtt_host": "localhost",
            "mqtt_port": 1883,
            "serial_port": "/dev/serial/by-id/usb-test",
            "adapter": "ember",
            "permit_join": False,
            "frontend_enabled": True,
        },
    )
    args = _resolve_args(manifest["start_command"]["args"], merged)
    assert args[6] == "/dev/serial/by-id/usb-test"
    assert args[7] == "ember"


def test_zigbee2mqtt_run_sh_writes_adapter(tmp_path):
    root = tmp_path / "hyve"
    addon_dir = root / "addons" / "available" / "zigbee2mqtt"
    addon_dir.mkdir(parents=True)
    (addon_dir / "run.sh").write_text(Z2M_RUN_SH.read_text(encoding="utf-8"), encoding="utf-8")

    proc = subprocess.Popen(
        ["bash", str(addon_dir / "run.sh"), "8080", "localhost", "1883", "", "", "/dev/ttyUSB0", "ember", "false", "true"],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        config = root / "output" / "addons" / "zigbee2mqtt" / "data" / "configuration.yaml"
        for _ in range(50):
            if config.is_file():
                break
            proc.poll()
            if proc.returncode is not None and not config.is_file():
                _, err = proc.communicate(timeout=1)
                raise AssertionError(f"config missing after exit {proc.returncode}: {err}")
            time.sleep(0.05)
        assert config.is_file()
        text = config.read_text(encoding="utf-8")
        assert "port: /dev/ttyUSB0" in text
        assert "adapter: ember" in text
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_zigbee2mqtt_run_sh_syntax():
    assert Z2M_RUN_SH.is_file()
    proc = subprocess.run(["bash", "-n", str(Z2M_RUN_SH)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_update_addon_preserves_existing_state(monkeypatch):
    slug = "piper"
    original_state = registry.get_state(slug)
    registry._save_addon_state(slug, {
        "installed": True,
        "enabled": True,
        "version": "old-version",
        "config": {"host": "192.168.1.5", "port": 10200, "voice": "ro_RO-mihai-medium"},
        "watchdog": True,
    })

    monkeypatch.setattr(registry, "_run_install_commands", lambda manifest: None)
    monkeypatch.setattr(registry, "_resolve_installed_version", lambda _m: "2024.11.0")
    monkeypatch.setattr(registry, "_resolve_channel_version", lambda _m, v: v)

    try:
        updated = registry.update_addon(slug)
        assert updated["installed"] is True
        assert updated["enabled"] is True
        assert updated["watchdog"] is True
        assert updated["config"]["host"] == "192.168.1.5"
        assert updated["version"] == registry.get_manifest(slug)["version"]
    finally:
        registry._save_addon_state(slug, original_state)


def test_downloadable_addons_build_real_install_commands():
    import sys

    mosquitto = registry.get_manifest("mosquitto")
    zigbee2mqtt = registry.get_manifest("zigbee2mqtt")

    mosq_cmds = registry._build_install_cmds(mosquitto["install"]["method"], mosquitto["install"])
    zigbee_cmd = registry._build_install_cmd(zigbee2mqtt["install"]["method"], zigbee2mqtt["install"])

    assert mosq_cmds
    if sys.platform.startswith("linux"):
        assert mosq_cmds[0][0] == "bash"
        assert "apt-get install -y mosquitto" in " ".join(mosq_cmds[0])
    else:
        assert mosq_cmds[0][:2] == ["brew", "install"]
    assert zigbee_cmd and zigbee_cmd[0] == "npm"


def test_process_manager_merges_config_defaults():
    from addons.process_manager import _effective_config, _resolve_args

    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None

    merged = _effective_config(manifest, {"port": 1883})
    assert merged["port"] == 1883
    assert merged["ws_port"] == 9001
    assert merged["allow_anonymous"] is True

    args = _resolve_args(manifest["start_command"]["args"], merged)
    assert "{ws_port}" not in args[2]
    assert args[2] == "9001"


def test_brew_installed_version_detects_mosquitto_binary(monkeypatch):
    manifest = registry.get_manifest("mosquitto")
    assert manifest is not None
    monkeypatch.setattr(
        registry,
        "_brew_installed_version",
        lambda pkg: "2.1.2" if pkg == "mosquitto" else None,
    )
    assert registry._resolve_installed_version(manifest) == "2.1.2"
    assert registry._detect_on_disk_install(manifest) == "2.1.2"
