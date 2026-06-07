"""MQTT bridge client id and reconnect helpers."""

from __future__ import annotations

import asyncio

from components.mosquitto.bridge import MosquittoBridge, _MQTT311_CLIENT_ID_MAX_BYTES, _mqtt_client_id


def test_mqtt_client_id_respects_mqtt311_limit():
    cid = _mqtt_client_id("entry-abc", "localhost", 1883)
    assert len(cid.encode("utf-8")) <= _MQTT311_CLIENT_ID_MAX_BYTES


def test_mqtt_client_id_stable_per_entry():
    a = _mqtt_client_id("entry-1", "192.168.1.10", 1883)
    b = _mqtt_client_id("entry-1", "192.168.1.10", 1883)
    c = _mqtt_client_id("entry-2", "192.168.1.10", 1883)
    assert a == b
    assert a != c


def test_mqtt_dispatch_keeps_subscriber_on_full_queue():
    async def run():
        bridge = MosquittoBridge({"host": "localhost", "port": 1883}, entry_key="e1")
        q = bridge.subscribe()
        assert q in bridge._listeners

        for i in range(600):
            await bridge._dispatch({"type": "state", "topic": f"t/{i}", "payload": i})

        assert q in bridge._listeners
        assert not q.empty()

    asyncio.run(run())
