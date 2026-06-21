"""MQTT bridge optimistic state + restart hydration."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mosquitto.bridge import MosquittoBridge
from components.mosquitto.extract import _optimistic_z2m_state_patch


def test_optimistic_patch_turn_on_updates_state_topic():
    record = {
        "entity_id": "switch.releu_dormitor_state_l1",
        "domain": "switch",
        "state": "off",
        "attributes": {
            "state_topic": "zigbee2mqtt/releu_dormitor",
            "z2m_property": "state_l1",
            "capabilities": {
                "state_topic": "zigbee2mqtt/releu_dormitor",
                "z2m_property": "state_l1",
                "payload_on": "ON",
                "payload_off": "OFF",
            },
        },
    }
    topic, patch = _optimistic_z2m_state_patch(record, "turn_on") or ("", {})
    assert topic == "zigbee2mqtt/releu_dormitor"
    assert patch == {"state_l1": "ON"}


def test_bridge_hydrate_and_persist_round_trip():
    bridge = MosquittoBridge({"host": "localhost"}, entry_key="entry12345")
    store = MagicMock()
    store.get_entities.return_value = {
        "entities": {
            "states": {
                "zigbee2mqtt/lampa": {"state": "ON"},
            },
        },
    }
    with patch("core.entity_store.get_entity_store", return_value=store):
        bridge.hydrate_states_from_store()
    assert bridge.snapshot()["states"]["zigbee2mqtt/lampa"] == {"state": "ON"}


def test_apply_control_optimistic_persists_and_nudges_mirror():
    async def _run():
        bridge = MosquittoBridge({"host": "localhost"}, entry_key="entry12345")
        record = {
            "entity_id": "light.lampa",
            "domain": "light",
            "state": "off",
            "attributes": {
                "capabilities": {
                    "state_topic": "zigbee2mqtt/lampa",
                    "z2m_property": "state",
                    "payload_on": "ON",
                    "payload_off": "OFF",
                },
            },
        }
        persist = AsyncMock()
        nudge = MagicMock()
        with patch.object(bridge, "_persist_states_to_store", persist), patch(
            "core.mirror_nudge.nudge_entity_mirror",
            nudge,
        ):
            await bridge.apply_control_optimistic(record, "turn_on")
        assert bridge.snapshot()["states"]["zigbee2mqtt/lampa"] == {"state": "ON"}
        persist.assert_awaited_once()
        nudge.assert_called_once()

    asyncio.run(_run())
