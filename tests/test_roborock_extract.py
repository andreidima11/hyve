"""Roborock entity extraction — vacuum state mapping."""

from __future__ import annotations

from components.roborock.extract import extract_roborock_candidates


def _vacuum(payload: dict) -> dict:
    items = extract_roborock_candidates(payload)
    vacuums = [e for e in items if e["domain"] == "vacuum"]
    assert len(vacuums) == 1
    return vacuums[0]


def test_s5_idle_with_charge_status_shows_charging():
    entity = _vacuum(
        {
            "devices": [
                {
                    "duid": "s5-duid",
                    "name": "Etaj",
                    "online": True,
                    "status": {
                        "state": 3,
                        "state_name": "idle",
                        "battery": 100,
                        "charge_status": 1,
                    },
                }
            ]
        }
    )
    assert entity["state"] == "docked"
    assert entity["attributes"]["status"] == "Charging"
    assert entity["attributes"]["status_key"] == "charging"
    assert entity["attributes"]["charge_status"] == 1


def test_q_revo_charging_state_name():
    entity = _vacuum(
        {
            "devices": [
                {
                    "duid": "q-duid",
                    "name": "Parter",
                    "online": True,
                    "status": {
                        "state": 8,
                        "state_name": "charging",
                        "battery": 100,
                        "charge_status": 1,
                        "dock_state": "charging",
                    },
                }
            ]
        }
    )
    assert entity["state"] == "docked"
    assert entity["attributes"]["status"] == "Charging"
    assert entity["attributes"]["status_key"] == "charging"


def test_cleaning_ignores_charge_status():
    entity = _vacuum(
        {
            "devices": [
                {
                    "duid": "x-duid",
                    "name": "Robot",
                    "online": True,
                    "status": {
                        "state": 5,
                        "state_name": "cleaning",
                        "battery": 42,
                        "charge_status": 0,
                    },
                }
            ]
        }
    )
    assert entity["state"] == "cleaning"
    assert entity["attributes"]["status"] == "Cleaning"
    assert entity["attributes"]["status_key"] == "cleaning"
