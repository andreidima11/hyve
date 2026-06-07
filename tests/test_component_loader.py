from __future__ import annotations

from pathlib import Path

import pytest

from integrations.component_loader import discover_component_classes, manifest_meta
from integrations.component_paths import BUNDLED_COMPONENTS_DIR
from integrations.loader import IntegrationManager
from integrations.manifest import load_manifest


def test_load_open_meteo_manifest():
    manifest = load_manifest(BUNDLED_COMPONENTS_DIR / "open_meteo")
    assert manifest is not None
    assert manifest["domain"] == "open_meteo"
    assert manifest["name"] == "Open Meteo"


def test_discover_bundled_open_meteo_component():
    classes = discover_component_classes(force=True)
    assert "open_meteo" in classes
    assert classes["open_meteo"].label == "Open Meteo"
    meta = manifest_meta("open_meteo")
    assert meta is not None
    assert meta["origin"] == "bundled"


def test_discover_bundled_sun_component():
    classes = discover_component_classes(force=True)
    assert "sun" in classes
    assert classes["sun"].label == "Sun"
    assert manifest_meta("sun")["origin"] == "bundled"


def test_sun_calculator_find_next_event():
    from datetime import datetime, timezone

    from integrations.component_import import import_sibling
    from integrations.component_paths import BUNDLED_COMPONENTS_DIR

    calc = import_sibling(BUNDLED_COMPONENTS_DIR / "sun", "calculator")
    now = datetime(2024, 6, 15, 12, 0, tzinfo=timezone.utc)
    nxt = calc.find_next_event(now, 44.4268, 26.1025, -0.833, rising=False)
    assert nxt is not None
    assert nxt > now


def test_sun_legacy_shim_exports():
    from integrations.providers import sun as sun_shim

    assert sun_shim.SunEntity.slug == "sun"
    assert callable(sun_shim.ensure_default_entry)
    assert callable(sun_shim._find_next_event)


def test_integration_manager_prefers_component_over_legacy_provider():
    manager = IntegrationManager()
    cls = manager.get_class("open_meteo")
    assert cls is not None
    assert cls.__module__.endswith("entity") or "open_meteo" in cls.__module__


def test_integration_manager_discovers_builtin_integration_classes():
    manager = IntegrationManager()
    slugs = set(manager.classes())
    assert {"pago", "fusion_solar", "open_meteo", "ariston_net", "mosquitto", "sun"}.issubset(slugs)


def test_integration_manager_dynamically_loads_provider_modules(tmp_path: Path):
    provider_file = tmp_path / "demo_provider.py"
    provider_file.write_text(
        "from integrations.base import BaseEntity\n"
        "\n"
        "class DemoEntity(BaseEntity):\n"
        "    slug = 'demo'\n"
        "    label = 'Demo'\n"
        "\n"
        "    async def fetch_entities(self):\n"
        "        return {'value': 1}\n"
        "\n"
        "    def extract_entities(self, payload):\n"
        "        return [{'entity_id': 'demo.sensor', 'name': 'Demo', 'state': '1', 'domain': 'sensor', 'source': 'demo', 'aliases': [], 'unit': '', 'controllable': False}]\n",
        encoding="utf-8",
    )

    manager = IntegrationManager(tmp_path)
    discovered = manager.discover(force=True)

    assert "demo" in discovered
    assert discovered["demo"].label == "Demo"


def test_all_bundled_entity_integrations_discovered():
    classes = discover_component_classes(force=True)
    expected = {
        "open_meteo",
        "sun",
        "pago",
        "fusion_solar",
        "ariston_net",
        "eon_romania",
        "reteleelectrice",
        "hyve_scenes",
        "frigate",
        "midea_ac",
        "xiaomi_home",
        "roborock",
        "tapo",
        "reolink",
        "mosquitto",
        "demo_sensor",
    }
    missing = expected - set(classes)
    assert not missing, f"missing components: {missing}"


def test_mosquitto_and_xiaomi_extract_modules_load():
    from integrations.component_import import import_sibling
    from integrations.component_paths import BUNDLED_COMPONENTS_DIR

    mq = import_sibling(BUNDLED_COMPONENTS_DIR / "mosquitto", "extract")
    xh = import_sibling(BUNDLED_COMPONENTS_DIR / "xiaomi_home", "extract")
    assert callable(mq.extract_mosquitto_candidates)
    assert callable(xh.extract_xiaomi_home_candidates)
    assert mq.extract_mosquitto_candidates({}) == []
    assert xh.extract_xiaomi_home_candidates({}) == []


def test_component_extract_reexport_matches_local_module():
    from integrations.component_import import import_sibling
    from integrations.component_paths import BUNDLED_COMPONENTS_DIR
    from integrations.extractors import extract_pago_candidates as legacy_pago

    local = import_sibling(BUNDLED_COMPONENTS_DIR / "pago", "extract")
    payload = {"facturi": [], "vehicule": [], "abonament": {}, "conturi_facturi": [], "carduri": [], "plati": []}
    assert legacy_pago(payload) == local.extract_pago_candidates(payload)


def test_custom_component_overrides_bundled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    bundled = tmp_path / "components" / "override_demo"
    bundled.mkdir(parents=True)
    bundled.joinpath("manifest.json").write_text(
        '{"domain":"override_demo","name":"Bundled","version":"1.0.0"}',
        encoding="utf-8",
    )
    bundled.joinpath("entity.py").write_text(
        "from integrations.base import BaseEntity\n"
        "class BundledEntity(BaseEntity):\n"
        "    slug = 'override_demo'\n"
        "    label = 'Bundled'\n"
        "    async def fetch_entities(self): return {}\n"
        "    def extract_entities(self, p): return []\n",
        encoding="utf-8",
    )
    custom = tmp_path / "custom"
    custom.mkdir()
    override = custom / "override_demo"
    override.mkdir()
    override.joinpath("manifest.json").write_text(
        '{"domain":"override_demo","name":"Custom","version":"1.0.0"}',
        encoding="utf-8",
    )
    override.joinpath("entity.py").write_text(
        "from integrations.base import BaseEntity\n"
        "class CustomEntity(BaseEntity):\n"
        "    slug = 'override_demo'\n"
        "    label = 'Custom'\n"
        "    async def fetch_entities(self): return {}\n"
        "    def extract_entities(self, p): return []\n",
        encoding="utf-8",
    )

    import integrations.component_loader as cl

    monkeypatch.setattr(cl, "component_search_paths", lambda: [("bundled", bundled.parent), ("custom", custom)])

    classes = cl.discover_component_classes(force=True)
    assert classes["override_demo"].label == "Custom"
    assert manifest_meta("override_demo")["origin"] == "custom"
