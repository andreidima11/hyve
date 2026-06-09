from __future__ import annotations

from pathlib import Path

import pytest

from integrations.loader import IntegrationManager


def test_integration_manager_discovers_builtin_integrations():
    manager = IntegrationManager()

    slugs = set(manager.classes())

    assert {"pago", "fusion_solar", "open_meteo", "ariston_net", "mosquitto", "sun"}.issubset(slugs)


def test_integration_manager_dynamically_loads_component_modules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    component_dir = tmp_path / "custom_components" / "demo"
    component_dir.mkdir(parents=True)
    component_dir.joinpath("manifest.json").write_text(
        '{"domain":"demo","name":"Demo","version":"1.0.0"}',
        encoding="utf-8",
    )
    component_dir.joinpath("entity.py").write_text(
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

    import integrations.component_loader as cl

    monkeypatch.setattr(cl, "component_search_paths", lambda: [("custom", tmp_path / "custom_components")])

    manager = IntegrationManager()
    discovered = manager.discover(force=True)

    assert "demo" in discovered
    assert discovered["demo"].label == "Demo"
