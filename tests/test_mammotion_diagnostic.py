"""Diagnostic and event entities for Mammotion."""

from __future__ import annotations

from components.mammotion.entity_factory import extract_mammotion_entities
from components.mammotion.specs.diagnostic import build_diagnostic_entities
from components.mammotion.specs.row import MowerRow


def test_diagnostic_entities_when_telemetry_ready():
    row = MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "online": True,
            "telemetry_ready": True,
            "mqtt_connected": True,
            "status": {"sys_status": 13, "charge_state": 0, "battery": 72, "work_mode_name": "MODE_WORKING"},
            "sensors": {"battery_percent": 72, "mqtt_status": "reported_online", "map_sync_status": "synced"},
        }
    )
    assert row is not None
    diag = build_diagnostic_entities(row, status_key="mowing")
    domains = {e["domain"] for e in diag}
    assert "sensor" in domains
    assert "binary_sensor" in domains
    assert "event" in domains
    activity = next(e for e in diag if e["entity_id"].endswith("_activity"))
    assert activity["state"] == "mowing"


def test_fault_event_when_errors_present():
    items = extract_mammotion_entities(
        {
            "devices": [
                {
                    "device_name": "Luba-TEST01",
                    "online": True,
                    "telemetry_ready": True,
                    "status": {"sys_status": 17, "charge_state": 0, "battery": 50, "work_mode_name": "MODE_LOCK"},
                    "sensors": {"battery_percent": 50, "mqtt_status": "reported_online"},
                    "errors": {"lock_mode": "Mower locked", "bumper_state": "Bumper fault"},
                }
            ]
        }
    )
    faults = [e for e in items if e.get("domain") == "event" and e["entity_id"].endswith("_fault")]
    assert len(faults) == 1
    assert faults[0]["state"] == "lock_mode"
    assert "lock_mode" in faults[0]["attributes"]["event_types"]
