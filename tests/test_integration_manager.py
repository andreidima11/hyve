from __future__ import annotations

from pathlib import Path

from integrations.loader import IntegrationManager


def test_integration_manager_discovers_builtin_integrations():
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
