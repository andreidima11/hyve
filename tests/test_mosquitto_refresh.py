"""Mosquitto SourceRefreshRunner mode selection."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from components.mosquitto.entity import MosquittoEntity, _payload_has_sources
from integrations.source_refresh import MODE_PROBE, MODE_PULL, attach_refresh_runner, detach_refresh_runner


def test_payload_has_sources_detects_z2m_and_discovery():
    assert not _payload_has_sources({})
    assert not _payload_has_sources({"broker": {"host": "localhost"}})
    assert _payload_has_sources({"z2m_devices": [{"friendly_name": "lamp"}]})
    assert _payload_has_sources({"discovery": {"homeassistant/light/x/config": {}}})


def test_mosquitto_choose_refresh_mode_force_uses_probe():
    entity = MosquittoEntity(entry_id="entry12345678", entry_data={}, entry_title="MQTT")
    cached = {"broker": {"host": "localhost", "port": 1883}, "z2m_devices": []}
    assert entity.choose_refresh_mode(force=True, cached=cached, cycle_count=3) == MODE_PROBE
    assert entity.choose_refresh_mode(force=False, cached={}, cycle_count=0) == MODE_PROBE
    assert entity.choose_refresh_mode(force=False, cached=cached, cycle_count=1) == MODE_PROBE


def test_mosquitto_choose_refresh_mode_pull_when_cache_has_devices():
    entity = MosquittoEntity(entry_id="entry12345678", entry_data={}, entry_title="MQTT")
    cached = {"z2m_devices": [{"friendly_name": "lamp", "ieee_address": "0x1"}]}
    assert entity.choose_refresh_mode(force=False, cached=cached, cycle_count=1) == MODE_PULL


def _fake_store(monkeypatch, cached: dict | None):
    class Store:
        def get_entities(self, key):
            if not cached:
                return None
            return {"entities": cached}

        def source_is_reachable(self, key):
            return True

    monkeypatch.setattr("core.entity_store.get_entity_store", lambda: Store())


def test_mosquitto_runner_probes_on_force_with_partial_cache(monkeypatch):
    cached = {"broker": {"host": "localhost", "port": 1883}, "z2m_devices": []}
    _fake_store(monkeypatch, cached)
    entity = MosquittoEntity(entry_id="entry12345678", entry_data={"host": "localhost"}, entry_title="MQTT")
    entity.probe_source = AsyncMock(return_value={"z2m_devices": [{"friendly_name": "lamp"}]})
    entity.pull_live_states = AsyncMock(return_value={"mode": "pull"})
    runner = attach_refresh_runner(entity)

    payload = asyncio.run(runner.run(force=True))

    assert payload["z2m_devices"] == [{"friendly_name": "lamp"}]
    entity.probe_source.assert_awaited_once()
    entity.pull_live_states.assert_not_awaited()
    assert runner.status.last_mode == MODE_PROBE
    detach_refresh_runner(entity.store_key)


def test_mosquitto_pull_live_states_probes_when_bridge_cache_empty():
    entity = MosquittoEntity(entry_id="entry12345678", entry_data={"host": "localhost"}, entry_title="MQTT")
    bridge = type("Bridge", (), {"is_running": lambda self: True, "snapshot": lambda self: {"z2m_devices": []}})()

    async def _run():
        with patch("components.mosquitto.entity._bridge_mod.get_bridge", return_value=bridge):
            with patch.object(entity, "probe_source", AsyncMock(return_value={"z2m_devices": [{"friendly_name": "sensor"}]})) as probe:
                payload = await entity.pull_live_states({"broker": {"host": "localhost"}})
        assert payload == {"z2m_devices": [{"friendly_name": "sensor"}]}
        probe.assert_awaited_once()

    asyncio.run(_run())
