"""Entity reference resolution helpers."""

from __future__ import annotations

import pytest
from sqlalchemy import text

import database
from core import entity_registry
from core.entity_refs import entity_ref_matches, live_entity_id, resolve_entity_reference
from core.http.startup_migrations import run_startup_migrations


@pytest.fixture(autouse=True)
def _fresh_registry():
    run_startup_migrations()
    with database.engine.connect() as conn:
        conn.execute(text("DELETE FROM entity_registry"))
        conn.commit()
    entity_registry.reload()
    yield
    entity_registry.reload()


def test_entity_ref_matches_by_unique_id():
    items = [{
        "entity_id": "switch.new_name_state_l3",
        "unique_id": "mqtt:relay_l3",
        "source": "mosquitto",
    }]
    assert entity_ref_matches("mqtt:relay_l3", "switch.new_name_state_l3", items=items)
    assert not entity_ref_matches("mqtt:relay_l3", "switch.old_name_state_l3", items=items)


def test_live_entity_id_from_unique_id():
    items = [{
        "entity_id": "switch.live_id",
        "unique_id": "mqtt:stable",
    }]
    assert live_entity_id("mqtt:stable", items) == "switch.live_id"


def test_resolve_entity_reference_registry_fallback():
    from core import entity_registry

    entity_registry.register_entity({
        "unique_id": "mqtt:registry_only",
        "entity_id": "sensor.registry_temp",
        "domain": "sensor",
        "name": "Registry temp",
        "source": "mosquitto",
    })
    entity_registry.reload()

    hit = resolve_entity_reference("mqtt:registry_only", items=[])
    assert hit is not None
    assert hit.get("entity_id") == "sensor.registry_temp"
