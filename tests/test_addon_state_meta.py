"""Hyve-internal addon state flags in config.__hyve_meta."""

from addons import registry as reg


def test_process_user_stopped_persists_in_config():
    slug = "mosquitto"
    reg._save_addon_state(slug, {
        "installed": True,
        "enabled": True,
        "version": "2.1.0",
        "config": {"port": 1883},
        "watchdog": True,
    })
    assert reg.is_process_user_stopped(slug) is False
    reg.set_process_user_stopped(slug, True)
    assert reg.is_process_user_stopped(slug) is True
    loaded = reg.get_state(slug)
    assert loaded["config"]["__hyve_meta"]["user_stopped_process"] is True
    reg.set_process_user_stopped(slug, False)
    assert reg.is_process_user_stopped(slug) is False
    assert "__hyve_meta" not in reg.get_state(slug).get("config", {})


def test_user_uninstalled_blocks_reconcile(monkeypatch):
    slug = "mosquitto"
    manifest = reg.get_manifest(slug)
    assert manifest

    reg.uninstall_addon(slug)
    assert reg.is_user_uninstalled(slug) is True

    monkeypatch.setattr(reg, "_detect_on_disk_install", lambda _m: "2.1.0")
    monkeypatch.setattr(reg, "list_available", lambda: [manifest])

    repaired = reg.reconcile_addon_state()
    assert repaired == 0
    assert reg.get_state(slug).get("installed") is False
