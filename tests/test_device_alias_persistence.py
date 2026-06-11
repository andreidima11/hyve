"""Device alias survives entity registry sync and Z2M IEEE friendly_name."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import text

import core.database as database
from core import device_registry, entity_registry
from core.http.startup_migrations import run_startup_migrations
from integrations import device_aliases
from integrations.source_aliases import device_config_slugs_for_entity_source
from routers.integrations.helpers import group_entities_into_devices


@pytest.fixture(autouse=True)
def _fresh_tables():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM device_registry"))
        conn.execute(text("DELETE FROM entity_registry"))
        conn.commit()
    device_registry.reload()
    entity_registry.reload()
    yield
    device_registry.reload()
    entity_registry.reload()


def test_device_config_slugs_map_zigbee2mqtt_to_mosquitto():
    assert device_config_slugs_for_entity_source("zigbee2mqtt") == ("mosquitto", "zigbee2mqtt")
    assert device_config_slugs_for_entity_source("mosquitto") == ("mosquitto",)


def test_alias_applied_after_entity_registry_sync_for_zigbee2mqtt_source():
    ieee = "0xa4c138fe8b1226ab"
    alias = "Releu Dormitor 2"

    with patch.object(
        device_aliases,
        "all_aliases",
        return_value={"mosquitto": {ieee: alias}},
    ):
        entities = [{
            "entity_id": "switch.test_state_l3",
            "unique_id": "mqtt:test_l3",
            "name": f"{ieee} state_l3",
            "domain": "switch",
            "source": "zigbee2mqtt",
            "attributes": {"device_id": ieee, "device_name": ieee},
        }]
        entity_registry.register_entity({
            "unique_id": "mqtt:test_l3",
            "entity_id": "switch.test_state_l3",
            "domain": "switch",
            "name": f"{ieee} state_l3",
            "device_id": ieee,
            "source": "mosquitto",
        })
        entity_registry.reload()

        entity_registry.sync_entities(entities)
        assert entities[0]["name"] == f"{ieee} state_l3"

        for config_slug in device_config_slugs_for_entity_source("zigbee2mqtt"):
            device_aliases.apply_to_entities(config_slug, entities)

        assert entities[0]["attributes"]["device_name"] == alias
        assert entities[0]["name"] == f"{alias} state_l3"


def test_group_entities_uses_integration_alias_when_device_name_is_ieee():
    ieee = "0xa4c138fe8b1226ab"
    alias = "Releu Dormitor 2"
    entities = [{
        "entity_id": "switch.test",
        "name": f"{ieee} state_l3",
        "source": "mosquitto",
        "attributes": {"device_id": ieee, "device_name": ieee, "device_model": "3 gang switch module"},
    }]

    with patch.object(device_aliases, "get_alias", return_value=alias):
        devices = group_entities_into_devices(entities, integration_slug="mosquitto")

    assert len(devices) == 1
    assert devices[0]["name"] == alias
    assert devices[0]["model"] == "3 gang switch module"


def test_sync_z2m_devices_preserves_alias_when_friendly_is_ieee():
    ieee = "0xa4c138fe8b1226ab"
    alias = "Releu Dormitor 2"

    device_registry.set_device_name(ieee, alias, source="mosquitto", z2m_friendly_name=alias)
    device_registry.reload()

    with patch.object(device_aliases, "get_alias", return_value=alias):
        count = device_registry.sync_z2m_devices([
            {
                "ieee_address": ieee,
                "friendly_name": ieee,
                "definition": {"vendor": "Tuya", "model": "TS0003_switch_module_2"},
            }
        ], source="mosquitto")

    assert count == 1
    row = device_registry.get_device(ieee)
    assert row is not None
    assert row["name"] == alias
    assert row["name_by_user"] is True
    assert row["manufacturer"] == "Tuya"
    assert row["model"] == "TS0003_switch_module_2"
