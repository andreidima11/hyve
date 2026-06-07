"""Xiaomi Home vacuum state — charging-state on dock."""

from __future__ import annotations

from components.xiaomi_home.extract import extract_xiaomi_home_candidates


def _vacuum(payload: dict) -> dict:
    items = extract_xiaomi_home_candidates(payload)
    vacuums = [e for e in items if e["domain"] == "vacuum"]
    assert len(vacuums) == 1
    return vacuums[0]


def test_idle_status_with_charging_state_shows_fully_charged_at_100():
    entity = _vacuum(
        {
            "profiles": {
                "123": {
                    "name": "Etaj",
                    "model": "roborock.vacuum.s5",
                    "domain": "vacuum",
                    "online": True,
                    "controls": {
                        "status": {
                            "siid": 2,
                            "piid": 1,
                            "prop": "status",
                            "value_list": {2: "Idle", 8: "Charging"},
                        }
                    },
                    "props": [
                        {
                            "siid": 3,
                            "piid": 1,
                            "prop": "battery-level",
                            "platform": "sensor",
                        },
                        {
                            "siid": 3,
                            "piid": 2,
                            "prop": "charging-state",
                            "platform": "binary_sensor",
                            "format": "bool",
                        },
                    ],
                    "values": {
                        "2.1": 2,
                        "3.1": 100,
                        "3.2": 1,
                    },
                }
            }
        }
    )
    assert entity["state"] == "docked"
    assert entity["attributes"]["status"] == "Fully charged"
    assert entity["attributes"]["status_key"] == "fully_charged"
    assert entity["attributes"]["battery_level"] == 100


def test_charging_state_below_100_shows_charging():
    entity = _vacuum(
        {
            "profiles": {
                "123": {
                    "name": "Etaj",
                    "domain": "vacuum",
                    "online": True,
                    "controls": {
                        "status": {
                            "siid": 2,
                            "piid": 1,
                            "prop": "status",
                            "value_list": {2: "Idle"},
                        }
                    },
                    "reads": [
                        {"siid": 3, "piid": 1, "prop": "battery-level"},
                    ],
                    "props": [
                        {
                            "siid": 3,
                            "piid": 2,
                            "prop": "charging-state",
                            "platform": "binary_sensor",
                        }
                    ],
                    "values": {"2.1": 2, "3.1": 72, "3.2": 1},
                }
            }
        }
    )
    assert entity["state"] == "docked"
    assert entity["attributes"]["status"] == "Charging"
    assert entity["attributes"]["status_key"] == "charging"
    assert entity["attributes"]["battery_level"] == 72


def test_cleaning_ignores_charging_state():
    entity = _vacuum(
        {
            "profiles": {
                "123": {
                    "name": "Etaj",
                    "domain": "vacuum",
                    "online": True,
                    "controls": {
                        "status": {
                            "siid": 2,
                            "piid": 1,
                            "prop": "status",
                            "value_list": {5: "Sweeping"},
                        }
                    },
                    "props": [
                        {
                            "siid": 3,
                            "piid": 2,
                            "prop": "charging-state",
                            "platform": "binary_sensor",
                        }
                    ],
                    "values": {"2.1": 5, "3.2": 0},
                }
            }
        }
    )
    assert entity["state"] == "cleaning"
    assert entity["attributes"]["status"] == "Sweeping"
    assert entity["attributes"]["status_key"] == "cleaning"
