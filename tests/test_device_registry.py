"""Device registry — Z2M sync, rename, entity_id refresh."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from sqlalchemy import text

import database
from core import device_registry, entity_registry
from core.http.startup_migrations import run_startup_migrations
from integrations import device_aliases


@pytest.fixture(autouse=True)
def _fresh_tables():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM device_registry"))
        conn.execute(text("DELETE FROM entity_registry"))
        conn.execute(text("DELETE FROM integration_entity_overrides"))
        conn.commit()
    device_registry.reload()
    entity_registry.reload()
    yield
    device_registry.reload()
    entity_registry.reload()


def test_sync_z2m_devices_ignores_stale_yaml_when_z2m_has_human_name():
    ieee = "0xa4c138fe8b1226ab"

    with patch.object(device_aliases, "get_alias", return_value="Lampa Birou"):
        device_registry.sync_z2m_devices([
            {
                "ieee_address": ieee,
                "friendly_name": "releu_dormitor2",
                "definition": {"vendor": "Tuya", "model": "TS0003_switch_module_2"},
            }
        ], source="mosquitto")

    row = device_registry.get_device(ieee)
    assert row is not None
    assert row["name"] == "releu_dormitor2"
    assert row["name_by_user"] is False
    assert row["z2m_friendly_name"] == "releu_dormitor2"


def test_sync_z2m_devices_respects_user_name():
    device_registry.set_device_name(
        "0xa4c138fe8b1226ab",
        "My Lamp",
        source="mosquitto",
    )
    device_registry.reload()

    count = device_registry.sync_z2m_devices([
        {
            "ieee_address": "0xA4C138FE8B1226AB",
            "friendly_name": "Z2M Lamp",
            "definition": {"vendor": "IKEA", "model": "TRADFRI"},
        }
    ], source="mosquitto")

    assert count == 1
    row = device_registry.get_device("0xa4c138fe8b1226ab")
    assert row is not None
    assert row["name"] == "My Lamp"
    assert row["name_by_user"] is True
    assert row["manufacturer"] == "IKEA"
    assert row["model"] == "TRADFRI"
    assert row["z2m_friendly_name"] == "Z2M Lamp"


def test_sync_z2m_devices_imports_new_device():
    device_registry.sync_z2m_devices([
        {
            "ieee_address": "0x00124b002228a987",
            "friendly_name": "Relay Bedroom",
            "definition": {"vendor": "Tuya", "model": "TS011F"},
        }
    ], source="mosquitto")

    row = device_registry.get_device("0x00124b002228a987")
    assert row is not None
    assert row["name"] == "Relay Bedroom"
    assert row["name_by_user"] is False


def test_refresh_entity_names_from_stale_lampa_birou_prefix():
    ieee = "0xa4c138fe8b1226ab"
    entity_registry.register_entity({
        "unique_id": "mqtt:l3",
        "entity_id": "switch.lampa_birou_state_l3",
        "domain": "switch",
        "name": "Lampa Birou State L3",
        "device_id": ieee,
        "source": "mosquitto",
    })
    entity_registry.register_entity({
        "unique_id": "mqtt:l1",
        "entity_id": "switch.lampa_birou_state_l1",
        "domain": "switch",
        "name": "Lampa Birou State L1",
        "device_id": ieee,
        "source": "mosquitto",
    })
    entity_registry.reload()

    result = entity_registry.refresh_entity_ids_for_device_rename(
        ieee,
        old_friendly_names=["Lampa Birou"],
        new_friendly="Releu Dormitor 2",
    )

    assert result["updated"] >= 1
    assert result["names_updated"] >= 1
    row = entity_registry.get_by_unique_id("mqtt:l3")
    assert row is not None
    assert row["entity_id"] == "switch.releu_dormitor_2_state_l3"
    assert row["name"] == "Releu Dormitor 2 State L3"


def test_refresh_entity_ids_after_device_rename():
    ieee = "0x00124b002228a987"
    entity_registry.register_entity({
        "unique_id": "mqtt:relay_l3",
        "entity_id": "switch.releu_dormitor2_state_l3",
        "domain": "switch",
        "name": "Releu dormitor L3",
        "device_id": ieee,
        "source": "mosquitto",
    })
    entity_registry.reload()

    result = entity_registry.refresh_entity_ids_for_device_rename(
        ieee,
        old_friendly="releu_dormitor2",
        new_friendly="releu_dormitor2_n",
    )

    assert result["updated"] == 1
    row = entity_registry.get_by_unique_id("mqtt:relay_l3")
    assert row is not None
    assert row["entity_id"] == "switch.releu_dormitor2_n_state_l3"
    assert row["entity_id_user_set"] is False


def test_refresh_skips_user_edited_entity_ids():
    ieee = "0x00124b002228a987"
    entity_registry.register_entity({
        "unique_id": "mqtt:relay_l3",
        "entity_id": "switch.old_relay",
        "domain": "switch",
        "name": "Custom",
        "device_id": ieee,
        "source": "mosquitto",
    })
    entity_registry.update_entry("mqtt:relay_l3", entity_id="switch.custom_relay")
    entity_registry.reload()

    result = entity_registry.refresh_entity_ids_for_device_rename(
        ieee,
        old_friendly="releu_dormitor2",
        new_friendly="releu_dormitor2_n",
    )

    assert result["updated"] == 0
    assert result["skipped"] == 1
    row = entity_registry.get_by_unique_id("mqtt:relay_l3")
    assert row["entity_id"] == "switch.custom_relay"
    assert row["entity_id_user_set"] is True


def test_bridge_after_ha_rename_updates_registry():
    async def run():
        from components.mosquitto.bridge import MosquittoBridge

        ieee = "0xa4c138fe8b1226ab"
        entity_registry.register_entity({
            "unique_id": "mqtt:l3",
            "entity_id": "switch.old_lamp_state_l3",
            "domain": "switch",
            "name": "Old Lamp L3",
            "device_id": ieee,
            "source": "mosquitto",
        })
        entity_registry.reload()

        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="mosq1")
        device_registry.set_device_name(
            ieee,
            "Old Lamp",
            source="mosquitto",
            z2m_friendly_name="Old Lamp",
        )
        bridge._z2m_devices = [
            {"ieee_address": ieee, "friendly_name": "New Lamp"},
        ]

        with patch("routers.integrations.helpers.invalidate_all_entities_cache", lambda: None):
            with patch("core.mirror_nudge.nudge_entity_mirror", lambda key=None: None):
                await bridge._after_ha_rename({
                    "from": "Old Lamp",
                    "to": "New Lamp",
                    "homeassistant_rename": True,
                })

        dev = device_registry.get_device(ieee)
        assert dev is not None
        assert dev["name"] == "New Lamp"
        assert dev["z2m_friendly_name"] == "New Lamp"

        ent = entity_registry.get_by_unique_id("mqtt:l3")
        assert ent is not None
        assert ent["entity_id"] == "switch.new_lamp_state_l3"

    asyncio.run(run())


def test_resolve_device_id_from_z2m_devices():
    devices = [
        {"ieee_address": "0xA4C138FE8B1226AB", "friendly_name": "Kitchen Light"},
    ]
    assert device_registry.resolve_device_id_from_z2m_devices(
        "Kitchen Light",
        devices,
    ) == "0xa4c138fe8b1226ab"
    assert device_registry.resolve_device_id_from_z2m_devices(
        "0xA4C138FE8B1226AB",
        devices,
    ) == "0xa4c138fe8b1226ab"
