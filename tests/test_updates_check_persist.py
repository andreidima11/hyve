"""Persisted update check timestamps."""

import core.hyve_update as hyve_update
from routers import updates as updates_router


def test_addons_last_check_persists_to_config(monkeypatch, tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text("{}", encoding="utf-8")
    saved = {}

    def _save(new_data):
        saved.update(new_data)
        return new_data

    monkeypatch.setattr("core.settings.CONFIG_FILE", cfg_file)
    monkeypatch.setattr("core.settings.CFG", {"updates": {}})
    monkeypatch.setattr("core.settings.save_config", _save)

    updates_router._last_check = {
        "outdated": [{"slug": "mosquitto"}],
        "checked_at": "2026-06-07T12:00:00",
    }
    updates_router._persist_addons_last_check()

    assert saved["updates"]["addons_last_check"]["checked_at"] == "2026-06-07T12:00:00"


def test_hyve_check_persists_to_config(monkeypatch, tmp_path):
    cfg_file = tmp_path / "config.json"
    saved = {}

    monkeypatch.setattr("core.settings.CONFIG_FILE", cfg_file)
    monkeypatch.setattr("core.settings.CFG", {"updates": {}})
    monkeypatch.setattr("core.settings.save_config", lambda data: saved.update(data) or data)

    hyve_update._last_hyve_check.clear()
    hyve_update._last_hyve_check.update({
        "latest": "0.9.7.0",
        "tag": "0.9.7.0",
        "release_url": None,
        "release_notes": "",
        "checked_at": "2026-06-07T12:00:00",
        "error": None,
    })
    hyve_update._persist_hyve_check()

    assert saved["updates"]["hyve_check"]["latest"] == "0.9.7.0"

    hyve_update._last_hyve_check.clear()
    hyve_update._last_hyve_check.update({
        "latest": None,
        "tag": None,
        "release_url": None,
        "release_notes": "",
        "checked_at": None,
        "error": None,
    })
    monkeypatch.setattr("core.settings.CFG", {"updates": saved["updates"]})
    hyve_update._hydrate_hyve_check()
    assert hyve_update._last_hyve_check["latest"] == "0.9.7.0"
