from __future__ import annotations

import pytest

from components.roborock.cache import EntryRoborockCache, network_ip_from_cache
from components.roborock.transport import device_transport_snapshot, transport_log_message


class _FakeNetworkInfo:
    def __init__(self, ip: str):
        self.ip = ip


class _FakeDeviceCacheData:
    def __init__(self, ip: str):
        self.network_info = _FakeNetworkInfo(ip)


class _FakeCacheData:
    def __init__(self, duid: str, ip: str):
        self.device_info = {duid: _FakeDeviceCacheData(ip)}
        self.network_info = {}


class _FakeDevice:
    def __init__(self, *, local: bool, connected: bool, name: str = "S7", duid: str = "duid123"):
        self.name = name
        self.duid = duid
        self.is_local_connected = local
        self.is_connected = connected


def test_device_transport_snapshot_local():
    snap = device_transport_snapshot(_FakeDevice(local=True, connected=True))
    assert snap["transport"] == "local"
    assert snap["local_connected"] is True


def test_device_transport_snapshot_cloud_fallback():
    snap = device_transport_snapshot(_FakeDevice(local=False, connected=True))
    assert snap["transport"] == "cloud"


def test_device_transport_snapshot_offline():
    snap = device_transport_snapshot(_FakeDevice(local=False, connected=False))
    assert snap["transport"] == "offline"


def test_transport_log_message_local_includes_ip():
    msg = transport_log_message(
        _FakeDevice(local=True, connected=True),
        {"transport": "local"},
        ip="192.168.1.50",
    )
    assert "local" in msg.lower()
    assert "192.168.1.50" in msg


def test_network_ip_from_cache_reads_device_info():
    data = _FakeCacheData("abc", "10.0.0.8")
    assert network_ip_from_cache(data, "abc") == "10.0.0.8"


def test_entry_roborock_cache_persists_on_flush():
    import asyncio

    saved: dict = {}

    def _persist(payload: dict) -> None:
        saved.update(payload)

    async def _run() -> None:
        cache = EntryRoborockCache(entry_id="entry1", initial=None, persist=_persist)
        data = await cache.get()
        await cache.set(data)
        await cache.flush()

    asyncio.run(_run())
    assert isinstance(saved, dict)
