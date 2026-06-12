"""Mammotion nudge button availability reflects BLE / cloud config."""

from __future__ import annotations

from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.row import MowerRow


def _row(**flags: bool) -> MowerRow:
    return MowerRow.from_snapshot(
        {
            "device_name": "Luba-TEST01",
            "name": "Luba",
            "online": True,
            "telemetry_ready": True,
            "flags": {
                "supports_video": False,
                **flags,
            },
            "status": {"sys_status": 1, "battery": 80},
            "sensors": {"battery_percent": 80},
            "switches": {},
            "numbers": {},
            "selects": {},
            "binary_sensors": {},
        }
    )


def _nudge_entities(row: MowerRow) -> list[dict]:
    return [
        ent
        for ent in build_mower_entities(row)
        if str(ent.get("entity_id", "")).startswith("button.")
        and "emergency_nudge" in str(ent.get("entity_id", ""))
    ]


def test_nudge_buttons_disabled_without_ble_or_wifi_mode():
    row = _row()
    buttons = _nudge_entities(row)
    assert len(buttons) == 4
    assert all(ent.get("available") is False for ent in buttons)
    assert all(
        ent["attributes"].get("nudge_hint_key") == "integrations.mammotion_nudge_ble_required"
        for ent in buttons
    )


def test_nudge_buttons_enabled_with_server_ble():
    row = _row(nudge_server_ble=True)
    buttons = _nudge_entities(row)
    assert all(ent.get("available") is True for ent in buttons)
    assert all("nudge_hint_key" not in ent["attributes"] for ent in buttons)


def test_nudge_buttons_enabled_with_cloud_mode_and_hint():
    row = _row(movement_use_wifi=True)
    buttons = _nudge_entities(row)
    assert all(ent.get("available") is True for ent in buttons)
    assert all(
        ent["attributes"].get("nudge_hint_key") == "integrations.mammotion_nudge_app_ble_hint"
        for ent in buttons
    )
