"""Display names when Z2M bridge/devices reports bare IEEE addresses."""

from __future__ import annotations

from components.mosquitto.extract import _resolve_z2m_display_name, extract_mosquitto_candidates


def test_resolve_display_name_prefers_registry_over_ieee():
    device = {
        "ieee_address": "0x94b216fffecb615b",
        "friendly_name": "0x94b216fffecb615b",
        "definition": {"model": "E2001", "vendor": "IKEA", "exposes": []},
    }

    from unittest.mock import patch

    with patch(
        "core.device_registry.get_device",
        return_value={
            "device_id": "0x94b216fffecb615b",
            "name": "telec2",
            "z2m_friendly_name": "telec2",
        },
    ):
        assert _resolve_z2m_display_name(device) == "telec2"


def test_extract_uses_display_name_when_z2m_friendly_is_ieee():
    ieee = "0x94b216fffecb615b"
    device = {
        "ieee_address": ieee,
        "friendly_name": ieee,
        "definition": {
            "model": "E2001/E2002/E2313",
            "vendor": "IKEA",
            "exposes": [
                {"type": "numeric", "property": "battery", "unit": "%", "access": 1},
                {"type": "enum", "property": "action", "access": 1},
            ],
        },
    }
    payload = {
        "discovery": {},
        "states": {f"zigbee2mqtt/{ieee}": {"battery": 65, "linkquality": 228, "action": "on"}},
        "z2m_devices": [device],
    }

    from unittest.mock import patch

    with patch(
        "core.device_registry.get_device",
        return_value={"device_id": ieee, "name": "telec2", "z2m_friendly_name": "telec2"},
    ):
        items = extract_mosquitto_candidates(payload)

    battery = next(e for e in items if (e.get("attributes") or {}).get("z2m_property") == "battery")
    assert battery["name"].startswith("telec2")
    assert battery["state"] == "65"
    assert "0x94b216" not in battery["entity_id"]
