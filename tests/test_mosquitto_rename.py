"""Z2M device rename — payload, name resolution, bridge response handling."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

from components.mosquitto.bridge import MosquittoBridge


def test_resolve_z2m_rename_from_prefers_bridge_friendly_name():
    bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
    bridge._z2m_devices = [
        {
            "ieee_address": "0xA4C138FE8B1226AB",
            "friendly_name": "Lampa Birou",
        }
    ]
    assert bridge.resolve_z2m_rename_from("0xa4c138fe8b1226ab", "Wrong Alias") == "Lampa Birou"


def test_resolve_z2m_rename_from_falls_back_to_hint():
    bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
    assert bridge.resolve_z2m_rename_from("", "my_old_name") == "my_old_name"


def test_bridge_rename_response_nudges_mirror():
    async def run():
        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="mosq1")
        nudged: list[str | None] = []
        invalidated: list[bool] = []

        with patch("routers.integrations.helpers.invalidate_all_entities_cache", lambda: invalidated.append(True)):
            with patch("core.mirror_nudge.nudge_entity_mirror", lambda key=None: nudged.append(key)):
                await bridge._handle_bridge_response(
                    "zigbee2mqtt/bridge/response/device/rename",
                    {
                        "status": "ok",
                        "data": {
                            "from": "0xa4c138fe8b1226ab",
                            "to": "Lampa Birou",
                            "homeassistant_rename": True,
                        },
                    },
                )
                await asyncio.sleep(0.05)

        assert invalidated == [True]
        assert nudged == ["mosq1"]

    asyncio.run(run())


def test_bridge_rename_response_skips_without_ha_flag():
    async def run():
        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        nudged: list[str | None] = []

        with patch("core.mirror_nudge.nudge_entity_mirror", lambda key=None: nudged.append(key)):
            await bridge._handle_bridge_response(
                "zigbee2mqtt/bridge/response/device/rename",
                {
                    "status": "ok",
                    "data": {
                        "from": "bulb",
                        "to": "bulb_new",
                        "homeassistant_rename": False,
                    },
                },
            )
            await asyncio.sleep(0.05)

        assert nudged == []

    asyncio.run(run())


def test_rename_zigbee_device_sends_homeassistant_rename():
    async def run():
        from components.mosquitto.entity import MosquittoEntity

        entity = MosquittoEntity(entry_id="entry-abc")
        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="entry-abc")
        bridge._z2m_devices = [
            {"ieee_address": "0xA4C138FE8B1226AB", "friendly_name": "Old Lamp"},
        ]

        published: list[tuple[str, str]] = []

        async def fake_publish(cfg, topic, payload):
            published.append((topic, payload))

        with patch("components.mosquitto.entity._bridge_mod.get_bridge", return_value=bridge):
            with patch("components.mosquitto.entity._publish", side_effect=fake_publish):
                result = await entity.rename_zigbee_device(
                    "Old Lamp",
                    "New Lamp",
                    device_id="0xa4c138fe8b1226ab",
                    homeassistant_rename=True,
                )

        assert result["from"] == "Old Lamp"
        assert result["homeassistant_rename"] is True
        assert len(published) == 1
        topic, payload = published[0]
        assert topic == "zigbee2mqtt/bridge/request/device/rename"
        body = json.loads(payload)
        assert body == {
            "from": "Old Lamp",
            "to": "New Lamp",
            "homeassistant_rename": True,
        }

    asyncio.run(run())


def test_rename_zigbee_device_omits_ha_flag_when_disabled():
    async def run():
        from components.mosquitto.entity import MosquittoEntity

        entity = MosquittoEntity(entry_id="entry-abc")
        published: list[str] = []

        async def fake_publish(cfg, topic, payload):
            published.append(payload)

        with patch("components.mosquitto.entity._bridge_mod.get_bridge", return_value=None):
            with patch("components.mosquitto.entity._publish", side_effect=fake_publish):
                await entity.rename_zigbee_device(
                    "0xa4c138fe8b1226ab",
                    "New Lamp",
                    device_id="0xa4c138fe8b1226ab",
                    homeassistant_rename=False,
                )

        body = json.loads(published[0])
        assert body == {"from": "0xa4c138fe8b1226ab", "to": "New Lamp"}
        assert "homeassistant_rename" not in body

    asyncio.run(run())
