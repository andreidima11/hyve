"""Entity registry — persistent entity_id keyed by unique_id."""

from __future__ import annotations

import pytest
from sqlalchemy import text

import core.database as database
from core import entity_registry
from core.http.startup_migrations import run_startup_migrations


@pytest.fixture(autouse=True)
def _fresh_registry():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM entity_registry"))
        conn.execute(text("DELETE FROM integration_entity_overrides"))
        conn.commit()
    entity_registry.reload()
    yield
    entity_registry.reload()


def test_register_and_apply_preserves_entity_id():
    entity_registry.register_entity({
        "unique_id": "mqtt:living_temp",
        "entity_id": "sensor.living_temperature",
        "domain": "sensor",
        "name": "Living Temperature",
        "source": "mosquitto",
    })
    entity_registry.reload()

    entities = [{
        "unique_id": "mqtt:living_temp",
        "entity_id": "sensor.0xabc_temperature",
        "domain": "sensor",
        "name": "0xABC Temperature",
        "source": "mosquitto",
        "attributes": {},
    }]
    entity_registry.sync_entities(entities)

    assert entities[0]["entity_id"] == "sensor.living_temperature"
    assert entities[0]["name"] == "Living Temperature"


def test_update_entity_id_migrates_overrides():
    entity_registry.register_entity({
        "unique_id": "mqtt:relay_l1",
        "entity_id": "switch.old_name_l1",
        "domain": "switch",
        "name": "Old Name L1",
        "source": "mosquitto",
    })
    entity_registry.reload()

    with database.engine.connect() as conn:
        conn.execute(text("""
            INSERT INTO integration_entity_overrides (entity_id, custom_name, aliases, selected)
            VALUES ('switch.old_name_l1', 'Kitchen relay', '[]', 1)
        """))
        conn.commit()

    updated = entity_registry.update_entry(
        "mqtt:relay_l1",
        entity_id="switch.kitchen_relay",
    )
    assert updated["entity_id"] == "switch.kitchen_relay"

    with database.engine.connect() as conn:
        row = conn.execute(
            text("SELECT custom_name, selected FROM integration_entity_overrides WHERE entity_id = :eid"),
            {"eid": "switch.kitchen_relay"},
        ).fetchone()
        old = conn.execute(
            text("SELECT 1 FROM integration_entity_overrides WHERE entity_id = 'switch.old_name_l1'"),
        ).fetchone()

    assert old is None
    assert row is not None
    assert row[0] == "Kitchen relay"
    assert row[1] == 1


def test_normalize_entity_id_rejects_bad_format():
    with pytest.raises(ValueError, match="domain.object_id"):
        entity_registry.normalize_entity_id("not-an-id")

    with pytest.raises(ValueError, match="unsupported domain"):
        entity_registry.normalize_entity_id("bogus.thing")


def test_dedupe_on_collision():
    entity_registry.register_entity({
        "unique_id": "mqtt:a",
        "entity_id": "sensor.room_temp",
        "domain": "sensor",
        "name": "A",
        "source": "mosquitto",
    })
    entity_registry.reload()

    row = entity_registry.register_entity({
        "unique_id": "mqtt:b",
        "entity_id": "sensor.room_temp",
        "domain": "sensor",
        "name": "B",
        "source": "mosquitto",
    })
    assert row["entity_id"] == "sensor.room_temp_2"


def test_sync_registers_many_entities_in_one_commit():
    entities = [
        {
            "unique_id": f"z2m:0xabc:{prop}",
            "entity_id": f"sensor.lamp_{prop}",
            "domain": "sensor",
            "name": f"Lamp {prop}",
            "source": "mosquitto",
            "attributes": {"device_id": "0xabc"},
        }
        for prop in ("temp", "humidity", "battery", "state")
    ]
    entity_registry.sync_entities(entities)
    entity_registry.reload()
    for ent in entities:
        stored = entity_registry.get_by_unique_id(ent["unique_id"])
        assert stored is not None
        assert stored["entity_id"] == ent["entity_id"]


def test_sync_registers_new_entities():
    entities = [{
        "unique_id": "z2m:0xabc:state",
        "entity_id": "switch.lamp",
        "domain": "switch",
        "name": "Lamp",
        "source": "mosquitto",
        "attributes": {"device_id": "0xabc"},
    }]
    entity_registry.sync_entities(entities)
    entity_registry.reload()

    stored = entity_registry.get_by_unique_id("z2m:0xabc:state")
    assert stored is not None
    assert stored["entity_id"] == "switch.lamp"
    assert stored["device_id"] == "0xabc"


def test_migrate_custom_name_fills_empty_registry_name():
    entity_registry.register_entity({
        "unique_id": "mqtt:bed_light",
        "entity_id": "light.lampa_dormitor",
        "domain": "light",
        "name": "",
        "source": "mosquitto",
    })
    entity_registry.reload()

    with database.engine.connect() as conn:
        conn.execute(text("""
            INSERT INTO integration_entity_overrides (entity_id, custom_name, aliases, selected)
            VALUES ('light.lampa_dormitor', 'Lampa dormitor', '[]', 0)
        """))
        conn.commit()

    migrated = entity_registry.migrate_legacy_custom_name_overrides()
    assert migrated == 1

    row = entity_registry.get_by_entity_id("light.lampa_dormitor")
    assert row is not None
    assert row["name"] == "Lampa dormitor"

    with database.engine.connect() as conn:
        custom = conn.execute(
            text("SELECT custom_name FROM integration_entity_overrides WHERE entity_id = :eid"),
            {"eid": "light.lampa_dormitor"},
        ).fetchone()
    assert custom is not None
    assert custom[0] == ""


def test_apply_overrides_keeps_registry_friendly_name():
    from addons.entity_store import get_entity_store

    entity_registry.register_entity({
        "unique_id": "mqtt:bed_light",
        "entity_id": "light.lampa_dormitor",
        "domain": "light",
        "name": "Lampa dormitor",
        "source": "mosquitto",
    })
    entity_registry.reload()

    with database.engine.connect() as conn:
        conn.execute(text("""
            INSERT INTO integration_entity_overrides (entity_id, custom_name, aliases, selected)
            VALUES ('light.lampa_dormitor', 'Legacy Override Name', '[\"lampa mea\"]', 1)
        """))
        conn.commit()

    entities = [{
        "unique_id": "mqtt:bed_light",
        "entity_id": "light.lampa_dormitor",
        "domain": "light",
        "name": "Provider Name",
        "source": "mosquitto",
        "attributes": {},
    }]
    entity_registry.sync_entities(entities)
    get_entity_store().apply_overrides(entities)

    assert entities[0]["name"] == "Lampa dormitor"
    assert entities[0]["aliases"] == ["lampa mea"]
    assert entities[0]["selected"] is True
