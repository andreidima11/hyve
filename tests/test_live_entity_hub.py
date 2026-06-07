"""Tests for shared live entity WebSocket hub."""

from __future__ import annotations

import asyncio

from core.live_entity_hub import LiveEntityWsHub, diff_snapshot, entity_signature


def test_entity_signature_and_diff():
    prev = {
        "light.k": entity_signature({"entity_id": "light.k", "state": "on", "unit": ""}),
    }
    changed, removed = diff_snapshot(
        prev,
        [
            {"entity_id": "light.k", "state": "off", "unit": ""},
            {"entity_id": "sensor.t", "state": "12", "unit": "°C"},
        ],
    )
    assert len(changed) == 2
    assert removed == []


def test_hub_single_poller_serves_multiple_clients():
    calls = {"n": 0}

    async def fetch_items():
        calls["n"] += 1
        return [{"entity_id": "light.a", "state": str(calls["n"]), "unit": ""}]

    class FakeSocket:
        def __init__(self):
            self.messages: list[dict] = []

        async def send_json(self, payload):
            self.messages.append(payload)

    async def run():
        hub = LiveEntityWsHub(name="test", poll_interval_sec=0.05, fetch_items=fetch_items)
        a = FakeSocket()
        b = FakeSocket()
        hub.attach(a, type("U", (), {"username": "a"})())
        hub.attach(b, type("U", (), {"username": "b"})())

        await asyncio.sleep(0.15)
        await hub.detach(a)
        await hub.detach(b)

        assert calls["n"] >= 1
        assert a.messages and b.messages
        assert a.messages[0]["type"] == "snapshot"
        assert b.messages[0]["type"] == "snapshot"

    asyncio.run(run())
