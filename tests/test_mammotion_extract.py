"""Mammotion entity extraction — lawn_mower state mapping."""

from __future__ import annotations

from components.mammotion.status import activity_from_status, telemetry_ready
from components.mammotion.extract import extract_mammotion_entities


def _mower(payload: dict) -> dict:
    items = extract_mammotion_entities(payload)
    mowers = [e for e in items if e["domain"] == "lawn_mower"]
    assert len(mowers) == 1
    return mowers[0]


def test_mowing_state():
    entity = _mower(
        {
            "devices": [
                {
                    "device_name": "Luba-TEST01",
                    "name": "Curte",
                    "online": True,
                    "status": {"sys_status": 13, "charge_state": 0, "battery": 72},
                }
            ]
        }
    )
    assert entity["state"] == "mowing"
    assert entity["attributes"]["status_key"] == "mowing"
    assert entity["domain"] == "lawn_mower"
    assert entity["unique_id"] == "mammotion:Luba-TEST01"


def test_docked_when_ready_and_charging():
    entity = _mower(
        {
            "devices": [
                {
                    "device_name": "Luba-TEST01",
                    "online": True,
                    "status": {"sys_status": 11, "charge_state": 1, "battery": 100},
                }
            ]
        }
    )
    assert entity["state"] == "docked"
    assert entity["attributes"]["status_key"] == "docked"


def test_paused_mode():
    state, key, _label = activity_from_status(sys_status=19, charge_state=0)
    assert state == "paused"
    assert key == "paused"


def test_battery_sensor_when_online():
    items = extract_mammotion_entities(
        {
            "devices": [
                {
                    "device_name": "Yuka-ABC",
                    "online": True,
                    "status": {"sys_status": 11, "charge_state": 1, "battery": 55},
                }
            ]
        }
    )
    sensors = [e for e in items if e["domain"] == "sensor" and "diagnostic" not in e["entity_id"]]
    assert len(sensors) == 1
    assert sensors[0]["state"] == 55
    assert sensors[0]["unit"] == "%"


def test_uninitialized_telemetry_not_exposed_as_zero_battery():
    items = extract_mammotion_entities(
        {
            "devices": [
                {
                    "device_name": "Luba-TEST01",
                    "online": True,
                    "telemetry_ready": False,
                    "status": {"sys_status": 0, "charge_state": 0, "battery": 0},
                    "sensors": {"battery_percent": 0, "wifi_rssi": 0},
                }
            ]
        }
    )
    mower = next(e for e in items if e["domain"] == "lawn_mower")
    assert mower["state"] == "idle"
    assert mower["attributes"]["status_key"] == "syncing"
    assert "battery_level" not in mower["attributes"]
    assert not [e for e in items if e["domain"] == "sensor"]


def test_telemetry_ready_helper():
    assert not telemetry_ready(sys_status=0, battery=0, charge_state=0)
    assert telemetry_ready(sys_status=11, battery=0)
    assert telemetry_ready(sys_status=0, battery=55)
    assert telemetry_ready(sys_status=0, battery=0, charge_state=1)


def test_all_entities_share_one_device_id():
    items = extract_mammotion_entities(
        {
            "devices": [
                {
                    "device_name": "Luba-TEST01",
                    "name": "Curte",
                    "online": True,
                    "status": {"sys_status": 13, "charge_state": 0, "battery": 72},
                    "sensors": {"battery_percent": 72, "wifi_rssi": -55},
                    "switches": {"rain_pause": False},
                }
            ]
        }
    )
    assert len(items) > 1
    device_ids = {e.get("device_id") for e in items}
    assert device_ids == {"mammotion_luba_test01"}
