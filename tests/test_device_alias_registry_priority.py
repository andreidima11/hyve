"""YAML aliases must not override SQLite device_registry names."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from integrations import device_aliases


def test_yaml_alias_skipped_when_registry_has_display_name():
    ieee = "0xa4c138fe8b1226ab"
    entities = [{
        "entity_id": "switch.lampa_birou_state",
        "name": "releu_dormitor2 state_l3",
        "domain": "switch",
        "source": "mosquitto",
        "attributes": {"device_id": ieee, "device_name": "releu_dormitor2"},
    }]

    with patch.object(
        device_aliases,
        "all_aliases",
        return_value={"mosquitto": {ieee: "Lampa Birou"}},
    ):
        with patch(
            "core.device_registry.get_device",
            return_value={
                "device_id": ieee,
                "name": "releu_dormitor2",
                "name_by_user": True,
            },
        ):
            device_aliases.apply_to_entities("mosquitto", entities)

    assert entities[0]["name"] == "releu_dormitor2 state_l3"
    assert entities[0]["attributes"]["device_name"] == "releu_dormitor2"


def test_reconcile_pushes_registry_when_z2m_has_wrong_human_name():
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        bridge._z2m_devices = [
            {"ieee_address": ieee, "friendly_name": "Lampa Birou", "type": "EndDevice"},
        ]

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="releu_dormitor2",
                ):
                    with patch(
                        "core.device_registry.get_device",
                        return_value={
                            "device_id": ieee,
                            "name": "releu_dormitor2",
                            "name_by_user": True,
                        },
                    ):
                        await bridge._reconcile_z2m_friendly_names([
                            {"ieee_address": ieee, "friendly_name": "Lampa Birou", "type": "EndDevice"},
                        ])

        assert renamed == [("Lampa Birou", "releu_dormitor2", True)]

    import asyncio

    asyncio.run(run())


def test_reconcile_uses_ieee_from_when_z2m_forgot_friendly_name():
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="releu_dormitor2",
                ):
                    with patch("core.device_registry.get_device", return_value=None):
                        await bridge._reconcile_z2m_friendly_names([
                            {"ieee_address": ieee, "friendly_name": ieee, "type": "EndDevice"},
                        ])

        assert renamed == [(ieee, "releu_dormitor2", True)]

    import asyncio

    asyncio.run(run())


def test_reconcile_pushes_registry_when_z2m_forgot_friendly_name_without_name_by_user():
    """Like telec2: registry has a label but name_by_user was never set."""
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0x94b216fffecb615b"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch("integrations.device_aliases.get_alias", return_value=None):
                    with patch(
                        "core.device_registry.get_device",
                        return_value={
                            "device_id": ieee,
                            "name": "telec2",
                            "name_by_user": False,
                            "z2m_friendly_name": "telec2",
                        },
                    ):
                        await bridge._reconcile_z2m_friendly_names([
                            {
                                "ieee_address": ieee,
                                "friendly_name": ieee,
                                "type": "EndDevice",
                            },
                        ])

        assert renamed == [(ieee, "telec2", True)]

    import asyncio

    asyncio.run(run())


def test_reconcile_does_not_push_stale_display_when_z2m_friendly_matches():
    """Regression: stale registry.name must not override a correct Z2M friendly."""
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="Lampa Birou",
                ):
                    with patch(
                        "integrations.device_aliases.set_alias",
                    ) as repair_yaml:
                        with patch(
                            "core.device_registry.set_device_name",
                        ) as repair_registry:
                            with patch(
                                "core.device_registry.get_device",
                                return_value={
                                    "device_id": ieee,
                                    "name": "Lampa Birou",
                                    "name_by_user": True,
                                    "z2m_friendly_name": "releu dormitor 2",
                                },
                            ):
                                await bridge._reconcile_z2m_friendly_names([
                                    {
                                        "ieee_address": ieee,
                                        "friendly_name": "releu dormitor 2",
                                        "type": "EndDevice",
                                    },
                                ])

        assert renamed == []
        repair_registry.assert_called_once()
        repair_yaml.assert_called_once_with("mosquitto", ieee, "releu dormitor 2")

    import asyncio

    asyncio.run(run())


def test_reconcile_does_not_push_stale_yaml_when_z2m_matches_registry():
    """Regression: stale YAML 'Lampa Birou' must not rename Z2M when registry is correct."""
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="Lampa Birou",
                ):
                    with patch(
                        "integrations.device_aliases.set_alias",
                    ) as repair_yaml:
                        with patch(
                            "core.device_registry.get_device",
                            return_value={
                                "device_id": ieee,
                                "name": "releu_dormitor2",
                                "name_by_user": True,
                            },
                        ):
                            await bridge._reconcile_z2m_friendly_names([
                                {
                                    "ieee_address": ieee,
                                    "friendly_name": "releu dormitor 2",
                                    "type": "EndDevice",
                                },
                            ])

        assert renamed == []
        repair_yaml.assert_called_once_with("mosquitto", ieee, "releu_dormitor2")

    import asyncio

    asyncio.run(run())


def test_reconcile_does_not_push_stale_registry_when_z2m_matches_yaml():
    """Regression: stale SQLite 'Lampa Birou' must not rename a correct Z2M friendly."""
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="releu dormitor 2",
                ):
                    with patch(
                        "core.device_registry.get_device",
                        return_value={
                            "device_id": ieee,
                            "name": "Lampa Birou",
                            "name_by_user": True,
                        },
                    ):
                        with patch(
                            "core.device_registry.set_device_name",
                        ) as repair:
                            await bridge._reconcile_z2m_friendly_names([
                                {
                                    "ieee_address": ieee,
                                    "friendly_name": "releu dormitor 2",
                                    "type": "EndDevice",
                                },
                            ])

        assert renamed == []
        repair.assert_called_once()

    import asyncio

    asyncio.run(run())


def test_reconcile_prefers_registry_over_stale_yaml_alias():
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        ieee = "0xa4c138fe8b1226ab"
        renamed: list[tuple[str, str, bool]] = []

        async def fake_rename(from_name, to_name, *, homeassistant_rename=False):
            renamed.append((from_name, to_name, homeassistant_rename))

        with patch.object(bridge, "_wait_for_mqtt_client", return_value=True):
            with patch.object(bridge, "request_z2m_device_rename", side_effect=fake_rename):
                with patch(
                    "integrations.device_aliases.get_alias",
                    return_value="Lampa Birou",
                ):
                    with patch(
                        "core.device_registry.get_device",
                        return_value={
                            "device_id": ieee,
                            "name": "releu_dormitor2",
                            "name_by_user": True,
                        },
                    ):
                        await bridge._reconcile_z2m_friendly_names([
                            {"ieee_address": ieee, "friendly_name": ieee, "type": "EndDevice"},
                        ])

        assert renamed == [(ieee, "releu_dormitor2", True)]

    import asyncio

    asyncio.run(run())


def test_mosquitto_yaml_ignores_non_ieee_device_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    yaml_path = tmp_path / "device_aliases.yaml"
    yaml_path.write_text(
        "aliases:\n"
        "  mosquitto:\n"
        "    '0xa4c138fe8b1226ab': releu_dormitor2\n"
        "    Old Lamp: New Lamp\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(device_aliases, "_ALIASES_PATH", yaml_path)
    device_aliases.reload()

    aliases = device_aliases.all_aliases().get("mosquitto") or {}
    assert aliases == {"0xa4c138fe8b1226ab": "releu_dormitor2"}
    assert "Old Lamp" not in aliases
