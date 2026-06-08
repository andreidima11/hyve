"""Entity registry — mark user-set entity_id on manual PATCH."""

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
        conn.commit()
    entity_registry.reload()
    yield
    entity_registry.reload()


def test_manual_entity_id_edit_marks_user_set():
    entity_registry.register_entity({
        "unique_id": "mqtt:test",
        "entity_id": "sensor.room_temp",
        "domain": "sensor",
        "name": "Room",
        "source": "mosquitto",
    })
    entity_registry.reload()

    updated = entity_registry.update_entry("mqtt:test", entity_id="sensor.office_temp")
    assert updated["entity_id"] == "sensor.office_temp"
    assert updated["entity_id_user_set"] is True
