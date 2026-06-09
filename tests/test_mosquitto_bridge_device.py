"""Zigbee2MQTT bridge virtual device entities."""

from __future__ import annotations

from components.mosquitto.extract import (
    _build_command,
    _entities_from_z2m_bridge,
    _merge_payload,
    _resolve_control_caps,
    extract_mosquitto_candidates,
)
from components.mosquitto import bridge as bridge_mod
from components.mosquitto.bridge import _flatten_bridge_info, _normalize_bridge_state


def test_flatten_bridge_info_extracts_coordinator_type():
    info = {
        "version": "2.0.0",
        "permit_join": False,
        "coordinator": {
            "type": "zStack3x0",
            "meta": {"maintrel": 7},
        },
    }
    flat = _flatten_bridge_info(info)
    assert flat["version"] == "2.0.0"
    assert flat["permit_join"] is False
    assert "zStack3x0" in flat["coordinator_type"]


def test_normalize_bridge_state_maps_online_offline():
    assert _normalize_bridge_state({"state": "online"})["connection"] == "on"
    assert _normalize_bridge_state({"state": "offline"})["connection"] == "off"


def test_entities_from_z2m_bridge_builds_device_card():
    payload = {
        "z2m_devices": [
            {"friendly_name": "lamp", "ieee_address": "0xAABBCCDDEEFF0011", "type": "Router"},
            {"friendly_name": "Coordinator", "type": "Coordinator"},
        ],
        "z2m_bridge": {
            "info": {
                "version": "1.40.0",
                "permit_join": True,
                "coordinator": {"type": "ember", "meta": {"maintrel": 3}},
            },
            "state": {"state": "online"},
        },
        "states": {},
    }
    entities = _entities_from_z2m_bridge(payload)
    by_id = {e["entity_id"]: e for e in entities}
    assert len(entities) == 5
    assert by_id["sensor.z2m_bridge_device_count"]["state"] == "1"
    assert by_id["binary_sensor.z2m_bridge_online"]["state"] == "on"
    assert by_id["sensor.z2m_bridge_version"]["state"] == "1.40.0"
    assert "ember" in by_id["sensor.z2m_bridge_coordinator"]["state"]
    assert by_id["switch.z2m_bridge_permit_join"]["state"] == "on"
    assert by_id["switch.z2m_bridge_permit_join"]["controllable"] is True
    assert all(
        e["attributes"]["device_id"] == "z2m_bridge"
        for e in entities
    )


def test_extract_mosquitto_candidates_includes_bridge_entities():
    payload = {
        "discovery": {},
        "states": {},
        "z2m_devices": [{"friendly_name": "bulb", "ieee_address": "0x0011223344556677"}],
        "z2m_bridge": {
            "info": {"version": "2.1.0", "permit_join": False},
            "state": {"state": "online"},
        },
    }
    items = extract_mosquitto_candidates(payload)
    bridge_ids = {e["entity_id"] for e in items if (e.get("attributes") or {}).get("z2m_bridge")}
    assert "switch.z2m_bridge_permit_join" in bridge_ids
    assert "sensor.z2m_bridge_device_count" in bridge_ids
    assert len(bridge_ids) == 5


def test_permit_join_control_builds_bridge_request_payload():
    ent = _entities_from_z2m_bridge({
        "z2m_devices": [{"friendly_name": "x", "ieee_address": "0xAABBCCDDEEFF0011"}],
        "z2m_bridge": {"info": {"version": "1.0"}, "state": {"state": "online"}},
    })
    switch = next(e for e in ent if e["entity_id"] == "switch.z2m_bridge_permit_join")
    caps = _resolve_control_caps(switch)
    topic, payload = _build_command("switch", "turn_on", caps, None)
    assert topic == "zigbee2mqtt/bridge/request/permit_join"
    assert payload == '{"time": 254}'
    topic, payload = _build_command("switch", "turn_off", caps, None)
    assert payload == '{"time": 0}'


def test_merge_payload_carries_z2m_bridge_section():
    merged = _merge_payload(
        {"z2m_devices": [], "z2m_bridge": {"info": {"version": "1.0"}, "state": {}}},
        {"z2m_bridge": {"info": {"version": "2.0", "permit_join": True}, "state": {"state": "online"}}},
    )
    assert merged["z2m_bridge"]["info"]["version"] == "2.0"


def test_bridge_handler_stores_info_and_state():
    import asyncio

    async def run():
        b = bridge_mod.MosquittoBridge({"host": "localhost", "port": 1883})
        await b._handle(_Msg("zigbee2mqtt/bridge/info", {
            "version": "2.0.0",
            "permit_join": True,
            "coordinator": {"type": "zStack3x0"},
        }))
        await b._handle(_Msg("zigbee2mqtt/bridge/state", {"state": "online"}))
        snap = b.snapshot()
        assert snap["z2m_bridge"]["info"]["version"] == "2.0.0"
        assert snap["states"]["zigbee2mqtt/bridge/state"]["connection"] == "on"
        assert snap["states"]["zigbee2mqtt/bridge/info"]["permit_join"] is True

    asyncio.run(run())


class _Msg:
    def __init__(self, topic: str, payload: dict):
        self.topic = topic
        self.payload = json_bytes(payload)


def json_bytes(obj):
    import json
    return json.dumps(obj).encode("utf-8")
