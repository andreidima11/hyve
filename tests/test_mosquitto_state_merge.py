"""MQTT state merge — stored snapshot fallback until live bridge warms up."""

from __future__ import annotations

from components.mosquitto.extract import _merge_payload


def test_live_payload_ignores_get_topic_pollution():
    from components.mosquitto.extract import _build_device_meta, _live_z2m_payload

    ieee = "0x94b216fffecb615b"
    device = {"ieee_address": ieee, "friendly_name": "telec", "definition": {"exposes": []}}
    meta = _build_device_meta([device])
    states = {
        "zigbee2mqtt/telec": {"battery": 65, "linkquality": 244, "action": "on"},
        "zigbee2mqtt/telec/get": {"battery": "", "linkquality": ""},
    }
    payload = _live_z2m_payload(states, ieee, meta, "zigbee2mqtt/telec", ["telec"])
    assert payload["battery"] == 65
    assert payload["linkquality"] == 244
    assert payload["action"] == "on"


def test_extract_reads_relay_state_after_get_pollution():
    from components.mosquitto.extract import extract_mosquitto_candidates

    ieee = "0xa4c138fe8b1226ab"
    device = {
        "ieee_address": ieee,
        "friendly_name": "releu_d2",
        "definition": {
            "exposes": [
                {
                    "endpoint": "l1",
                    "type": "switch",
                    "features": [{
                        "property": "state_l1",
                        "type": "binary",
                        "access": 7,
                        "value_on": "ON",
                        "value_off": "OFF",
                    }],
                },
                {"type": "numeric", "property": "countdown_l1", "access": 7},
                {"type": "numeric", "property": "linkquality", "access": 1},
            ],
        },
    }
    payload = {
        "discovery": {},
        "states": {
            "zigbee2mqtt/releu_d2": {
                "state_l1": "ON",
                "state_l2": "OFF",
                "countdown_l1": 0,
                "linkquality": 180,
                "indicator_mode": "off",
                "switch_type": "momentary",
            },
            "zigbee2mqtt/releu_d2/get": {
                "state_l1": "",
                "countdown_l1": "",
                "linkquality": "",
            },
        },
        "z2m_devices": [device],
    }
    items = extract_mosquitto_candidates(payload)
    by_prop = {(e.get("attributes") or {}).get("z2m_property"): e.get("state") for e in items}
    assert by_prop.get("state_l1") == "on"
    assert by_prop.get("countdown_l1") == "0"
    assert by_prop.get("linkquality") == "180"


def test_merge_payload_keeps_stored_states_until_live_topic_arrives():
    stored = {
        "discovery": {"homeassistant/sensor/a/config": {"name": "A"}},
        "states": {
            "zigbee2mqtt/telec2": {"battery": 61, "linkquality": 140},
        },
        "z2m_devices": [],
    }
    live = {
        "discovery": {},
        "states": {
            "zigbee2mqtt/releu_dormitor2": {"state": "ON"},
        },
        "z2m_devices": [{"friendly_name": "releu_dormitor2"}],
    }

    merged = _merge_payload(stored, live)

    assert merged["states"]["zigbee2mqtt/telec2"] == {"battery": 61, "linkquality": 140}
    assert merged["states"]["zigbee2mqtt/releu_dormitor2"] == {"state": "ON"}


def test_merge_payload_live_overrides_stored_for_same_topic():
    stored = {
        "states": {"zigbee2mqtt/telec2": {"battery": 10, "linkquality": 50}},
    }
    live = {
        "states": {"zigbee2mqtt/telec2": {"battery": 62, "linkquality": 145}},
    }

    merged = _merge_payload(stored, live)

    assert merged["states"]["zigbee2mqtt/telec2"] == {"battery": 62, "linkquality": 145}
