"""Entity factory — builds Hyve entities from Mammotion snapshots."""

from __future__ import annotations

from components.mammotion.entity_factory import build_entities_from_payload, extract_mammotion_entities
from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.row import MowerRow


def test_factory_delegates_to_mower_builder():
    payload = {
        "devices": [
            {
                "device_name": "Luba-TEST01",
                "name": "Curte",
                "online": True,
                "status": {"sys_status": 13, "charge_state": 0, "battery": 72},
                "sensors": {"battery_percent": 72},
            }
        ]
    }
    direct = build_mower_entities(MowerRow.from_snapshot(payload["devices"][0]))
    via_factory = build_entities_from_payload(payload)
    assert len(direct) == len(via_factory)
    assert {e["entity_id"] for e in direct} == {e["entity_id"] for e in via_factory}


def test_extract_alias():
    items = extract_mammotion_entities(
        {
            "devices": [
                {
                    "device_name": "Luba-X",
                    "online": True,
                    "status": {"sys_status": 11, "charge_state": 1, "battery": 80},
                }
            ]
        }
    )
    mower = next(e for e in items if e["domain"] == "lawn_mower")
    assert mower["state"] == "docked"
