"""Component i18n loader — translation file discovery and namespacing."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from integrations import component_i18n
from integrations.component_paths import BUNDLED_COMPONENTS_DIR, DEFAULT_CUSTOM_COMPONENTS_DIR


@pytest.fixture(autouse=True)
def _clear_component_i18n_cache():
    component_i18n.invalidate_cache()
    yield
    component_i18n.invalidate_cache()


def test_namespace_merge_for_configured_domain(monkeypatch, tmp_path: Path):
    component_dir = tmp_path / "demo_sensor"
    trans_dir = component_dir / "translations"
    trans_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "demo_sensor", "name": "Demo Sensor", "version": "0.1.0"}),
        encoding="utf-8",
    )
    (trans_dir / "ro.json").write_text(
        json.dumps({"config": {"title": "Senzor demo"}}),
        encoding="utf-8",
    )

    monkeypatch.setattr(component_i18n, "configured_domains", lambda: {"demo_sensor"})
    monkeypatch.setattr(component_i18n, "_component_dir_for_domain", lambda _slug: component_dir)

    payload = component_i18n.get_component_translations("ro")
    assert payload == {"components": {"demo_sensor": {"config": {"title": "Senzor demo"}}}}


def test_falls_back_to_english_when_lang_missing(monkeypatch, tmp_path: Path):
    component_dir = tmp_path / "roborock"
    trans_dir = component_dir / "translations"
    trans_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "roborock", "name": "Roborock", "version": "1.0.0"}),
        encoding="utf-8",
    )
    (trans_dir / "en.json").write_text(
        json.dumps({"config": {"title": "Roborock"}}),
        encoding="utf-8",
    )

    monkeypatch.setattr(component_i18n, "configured_domains", lambda: {"roborock"})
    monkeypatch.setattr(component_i18n, "_component_dir_for_domain", lambda _slug: component_dir)

    payload = component_i18n.get_component_translations("ro")
    assert payload["components"]["roborock"]["config"]["title"] == "Roborock"


def test_bundled_roborock_translations_exist():
    ro_path = BUNDLED_COMPONENTS_DIR / "roborock" / "translations" / "ro.json"
    assert ro_path.is_file()
    data = json.loads(ro_path.read_text(encoding="utf-8"))
    assert data["config"]["title"] == "Roborock"


def test_custom_demo_sensor_translations_exist():
    ro_path = DEFAULT_CUSTOM_COMPONENTS_DIR / "demo_sensor" / "translations" / "ro.json"
    assert ro_path.is_file()
    data = json.loads(ro_path.read_text(encoding="utf-8"))
    assert data["config"]["title"] == "Senzor demo"
