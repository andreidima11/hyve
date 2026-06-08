"""Entity registry — persistent entity_id keyed by unique_id."""

from __future__ import annotations

import pytest
from sqlalchemy import text

import database
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
