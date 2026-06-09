"""Zigbee remote / action entity extraction for Mosquitto."""

from __future__ import annotations

from components.mosquitto.extract import (
    extract_mosquitto_candidates,
    z2m_get_payload_for_device,
)

_IEEE = "0x90fd9ffffedf1266"
_FRIENDLY = "telecomanda dormitor 2"


def _remote_z2m_device() -> dict:
    return {
        "ieee_address": _IEEE,
        "friendly_name": _FRIENDLY,
        "definition": {
            "model": "E2001/E2002/E2313",
            "vendor": "IKEA",
            "exposes": [
                {"type": "enum", "property": "action", "access": 1, "values": [
                    "on", "off", "brightness_move_up", "brightness_move_down",
                ]},
                {"type": "numeric", "property": "battery", "unit": "%", "access": 1},
                {"type": "numeric", "property": "linkquality", "access": 1},
                {"type": "enum", "property": "identify", "access": 2},
            ],
        },
    }


def _per_action_binary_discovery() -> dict:
    """Z2M HA discovery noise: one binary_sensor per action value."""
    base = {
        "state_topic": f"zigbee2mqtt/{_FRIENDLY}",
        "device": {"identifiers": [f"zigbee2mqtt_{_IEEE}"], "name": _FRIENDLY},
    }
    out = {}
    for action in ("on", "off", "brightness_move_up"):
        oid = f"action_{action}"
        out[f"homeassistant/binary_sensor/{oid}/{oid}/config"] = {
            **base,
            "unique_id": f"{_IEEE}_action_{action}_zigbee2mqtt",
            "name": f"{_FRIENDLY} {action}",
            "value_template": f"{{{{ value_json.action == '{action}' }}}}",
        }
    return out


def test_remote_skips_per_action_discovery_and_keeps_single_event():
    payload = {
        "discovery": {
            **_per_action_binary_discovery(),
            f"homeassistant/sensor/{_FRIENDLY}_action/{_FRIENDLY}_action/config": {
                "state_topic": f"zigbee2mqtt/{_FRIENDLY}",
                "value_template": "{{ value_json.action }}",
                "unique_id": f"{_IEEE}_action_zigbee2mqtt",
                "name": f"{_FRIENDLY} action",
                "device": {"identifiers": [f"zigbee2mqtt_{_IEEE}"], "name": _FRIENDLY},
            },
        },
        "states": {
            f"zigbee2mqtt/{_FRIENDLY}": {"battery": 87, "linkquality": 120, "action": "on"},
        },
        "z2m_devices": [_remote_z2m_device()],
    }

    items = extract_mosquitto_candidates(payload)
    device_items = [
        i for i in items
        if (i.get("attributes") or {}).get("device_id") == _IEEE
        or (i.get("attributes") or {}).get("zigbee_ieee") == _IEEE
    ]

    action_entities = [
        e for e in device_items
        if (e.get("attributes") or {}).get("z2m_property") == "action"
        or "action" in str(e.get("entity_id", "")).lower()
    ]
    assert len(action_entities) == 1
    action_ent = action_entities[0]
    assert action_ent["domain"] == "event"
    assert action_ent["state"] == "on"

    junk = [e for e in device_items if "action_" in str((e.get("attributes") or {}).get("object_id") or "")]
    assert not junk


def test_remote_action_updates_from_state_payload():
    payload = {
        "discovery": {},
        "states": {
            f"zigbee2mqtt/{_FRIENDLY}": {"battery": 90, "linkquality": 100},
        },
        "z2m_devices": [_remote_z2m_device()],
    }
    items = extract_mosquitto_candidates(payload)
    action_ent = next(
        e for e in items
        if (e.get("attributes") or {}).get("z2m_property") == "action"
    )
    assert action_ent["domain"] == "event"
    assert action_ent["state"] == "unknown"

    payload["states"][f"zigbee2mqtt/{_FRIENDLY}"]["action"] = "brightness_move_up"
    items2 = extract_mosquitto_candidates(payload)
    action_ent2 = next(
        e for e in items2
        if (e.get("attributes") or {}).get("z2m_property") == "action"
    )
    assert action_ent2["state"] == "brightness_move_up"


def test_z2m_get_requests_battery_not_only_state():
    payload = z2m_get_payload_for_device(_remote_z2m_device())
    assert "battery" in payload
    assert "linkquality" in payload
    assert "action" not in payload


def test_discovery_resolves_state_when_topic_uses_ieee():
    """HA discovery may retain IEEE in state_topic while live MQTT uses friendly_name."""
    payload = {
        "discovery": {
            f"homeassistant/sensor/{_IEEE}_battery/{_IEEE}_battery/config": {
                "state_topic": f"zigbee2mqtt/{_IEEE}",
                "value_template": "{{ value_json.battery }}",
                "unique_id": f"{_IEEE}_battery_zigbee2mqtt",
                "unit_of_measurement": "%",
                "name": f"{_FRIENDLY} battery",
                "device": {"identifiers": [f"zigbee2mqtt_{_IEEE}"], "name": _FRIENDLY},
            },
        },
        "states": {
            f"zigbee2mqtt/{_FRIENDLY}": {"battery": 72, "linkquality": 99},
        },
        "z2m_devices": [_remote_z2m_device()],
    }
    items = extract_mosquitto_candidates(payload)
    battery = next(
        e for e in items
        if (e.get("attributes") or {}).get("z2m_property") == "battery"
        or "battery" in str(e.get("entity_id", ""))
    )
    assert battery["state"] == "72"


def test_action_from_dedicated_action_topic():
    payload = {
        "discovery": {},
        "states": {
            f"zigbee2mqtt/{_FRIENDLY}/action": "brightness_move_up",
            f"zigbee2mqtt/{_FRIENDLY}": {"battery": 55, "linkquality": 80},
        },
        "z2m_devices": [_remote_z2m_device()],
    }
    items = extract_mosquitto_candidates(payload)
    action_ent = next(
        e for e in items
        if (e.get("attributes") or {}).get("z2m_property") == "action"
    )
    assert action_ent["state"] == "brightness_move_up"


def test_stale_discovery_dropped_when_expose_resolves_live_state():
    """Matches telec2 rename: old HA discovery names, live MQTT on new friendly_name."""
    ieee = "0x94b216fffecb615b"
    friendly = "telec2"
    old_name = "telecomanda dormitor 2"
    device = {
        "ieee_address": ieee,
        "friendly_name": friendly,
        "definition": {
            "model": "E2001/E2002/E2313",
            "vendor": "IKEA",
            "exposes": [
                {"type": "enum", "property": "action", "access": 1, "values": ["on", "off"]},
                {"type": "numeric", "property": "battery", "unit": "%", "access": 1},
                {"type": "numeric", "property": "linkquality", "access": 1},
                {"type": "enum", "property": "identify", "access": 2},
            ],
        },
    }
    payload = {
        "discovery": {
            f"homeassistant/sensor/{old_name.replace(' ', '_')}/{old_name.replace(' ', '_')}/config": {
                "state_topic": f"zigbee2mqtt/{old_name}",
                "value_template": "{{ value_json.battery }}",
                "unique_id": f"{ieee}_battery_zigbee2mqtt",
                "unit_of_measurement": "%",
                "name": f"{old_name} battery",
                "device": {"identifiers": [f"zigbee2mqtt_{ieee}"], "name": old_name},
            },
            f"homeassistant/sensor/{ieee}_linkquality/{ieee}_linkquality/config": {
                "state_topic": f"zigbee2mqtt/{ieee}",
                "value_template": "{{ value_json.linkquality }}",
                "unique_id": f"{ieee}_linkquality_zigbee2mqtt",
                "name": f"{ieee} linkquality",
                "device": {"identifiers": [f"zigbee2mqtt_{ieee}"], "name": friendly},
            },
            f"homeassistant/update/{friendly}/{friendly}/config": {
                "state_topic": f"zigbee2mqtt/{friendly}",
                "unique_id": f"{ieee}_update_zigbee2mqtt",
                "name": friendly,
                "device": {"identifiers": [f"zigbee2mqtt_{ieee}"], "name": friendly},
            },
            f"homeassistant/event/{friendly}/{friendly}/config": {
                "state_topic": f"zigbee2mqtt/{friendly}",
                "value_template": "{{ value_json.action }}",
                "unique_id": f"{ieee}_action_zigbee2mqtt",
                "name": friendly,
                "device": {"identifiers": [f"zigbee2mqtt_{ieee}"], "name": friendly},
            },
        },
        "states": {
            f"zigbee2mqtt/{friendly}": {"battery": 61, "linkquality": 142, "action": "on"},
        },
        "z2m_devices": [device],
    }
    items = extract_mosquitto_candidates(payload)
    eids = {e["entity_id"] for e in items}
    assert "update.telec2" not in eids
    assert "sensor.telecomanda_dormitor_2" not in eids
    assert f"sensor.{ieee}_linkquality" not in eids and f"sensor.{ieee.replace('0x', '')}_linkquality" not in eids
    battery = next(e for e in items if (e.get("attributes") or {}).get("z2m_property") == "battery")
    lqi = next(e for e in items if (e.get("attributes") or {}).get("z2m_property") == "linkquality")
    action = next(e for e in items if (e.get("attributes") or {}).get("z2m_property") == "action")
    assert battery["state"] == "61"
    assert lqi["state"] == "142"
    assert action["state"] == "on"
    assert "battery" in battery["entity_id"]


def test_device_automation_discovery_still_skipped():
    payload = {
        "discovery": {
            f"homeassistant/device_automation/{_IEEE}/action_on/config": {
                "automation_type": "trigger",
                "type": "action",
                "subtype": "on",
                "topic": f"zigbee2mqtt/{_FRIENDLY}/action",
                "payload": "on",
                "device": {"identifiers": [f"zigbee2mqtt_{_IEEE}"]},
            },
        },
        "states": {},
        "z2m_devices": [_remote_z2m_device()],
    }
    items = extract_mosquitto_candidates(payload)
    assert not any("device_automation" in str((e.get("attributes") or {}).get("discovery_topic") or "") for e in items)
