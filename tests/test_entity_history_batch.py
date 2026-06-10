"""Batch entity history queries for dashboard sparklines."""

from __future__ import annotations

import time

from sqlalchemy import text

import database
from core import entity_history
from core.http.startup_migrations import run_startup_migrations


def test_get_history_many_returns_grouped_points():
    run_startup_migrations()
    now = int(time.time())
    with database.engine.begin() as conn:
        conn.execute(text("DELETE FROM entity_state_history"))
        conn.execute(
            text("INSERT INTO entity_state_history (entity_id, ts, value) VALUES (:eid, :ts, :val)"),
            [
                {"eid": "sensor.a", "ts": now - 200, "val": 1.0},
                {"eid": "sensor.a", "ts": now - 100, "val": 2.0},
                {"eid": "sensor.b", "ts": now - 150, "val": 5.0},
            ],
        )

    out = entity_history.get_history_many(["sensor.a", "sensor.b"], hours=24.0)
    assert len(out["sensor.a"]) == 2
    assert out["sensor.a"][0]["value"] == 1.0
    assert out["sensor.b"][0]["value"] == 5.0
