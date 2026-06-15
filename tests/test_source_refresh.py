"""Tests for SourceRefreshRunner probe / pull layering."""

from __future__ import annotations

import asyncio

import pytest

from integrations.base import BaseEntity
from integrations.source_refresh import (
    MODE_FETCH,
    MODE_PROBE,
    MODE_PULL,
    SourceRefreshRunner,
    attach_refresh_runner,
    detach_refresh_runner,
    get_refresh_runner,
)


class _LayeredEntity(BaseEntity):
    slug = "layered_demo"
    label = "Layered"
    uses_refresh_layers = True
    probe_interval_cycles = 3

    def __init__(self, *args, **kwargs):
        super().__init__(entry_id="entry12345678", entry_data={}, entry_title="Layered")
        self.calls: list[str] = []

    async def fetch_entities(self):
        self.calls.append("fetch")
        return {"mode": "fetch", "value": 1}

    async def probe_source(self, cached=None):
        self.calls.append("probe")
        return {"mode": "probe", "value": 2}

    async def pull_live_states(self, cached):
        self.calls.append("pull")
        return {"mode": "pull", "value": 3, "from": cached.get("mode")}

    def extract_entities(self, payload):
        return []


class _PlainEntity(BaseEntity):
    slug = "plain_demo"
    label = "Plain"

    def __init__(self, *args, **kwargs):
        super().__init__(entry_id="plain12345678", entry_data={}, entry_title="Plain")
        self.calls: list[str] = []

    async def fetch_entities(self):
        self.calls.append("fetch")
        return {"mode": "fetch"}

    def extract_entities(self, payload):
        return []


def _fake_store(monkeypatch, cached: dict | None = None):
    class Store:
        def get_entities(self, key):
            if not cached:
                return None
            return {"entities": cached}

        def source_is_reachable(self, key):
            return True

    monkeypatch.setattr("core.entity_store.get_entity_store", lambda: Store())


def test_runner_uses_fetch_when_layers_disabled(monkeypatch):
    _fake_store(monkeypatch, cached={"mode": "probe"})
    inst = _PlainEntity()
    runner = attach_refresh_runner(inst)

    payload = asyncio.run(runner.run(force=False))

    assert payload["mode"] == "fetch"
    assert inst.calls == ["fetch"]
    assert runner.status.last_mode == MODE_FETCH
    detach_refresh_runner(inst.store_key)


def test_runner_probes_on_force_and_empty_cache(monkeypatch):
    _fake_store(monkeypatch, cached=None)
    inst = _LayeredEntity()
    runner = attach_refresh_runner(inst)

    payload = asyncio.run(runner.run(force=True))

    assert payload["mode"] == "probe"
    assert inst.calls == ["probe"]
    assert runner.status.last_mode == MODE_PROBE
    detach_refresh_runner(inst.store_key)


def test_runner_uses_pull_on_force_when_cache_exists(monkeypatch):
    _fake_store(monkeypatch, cached={"mode": "probe", "value": 2})
    inst = _LayeredEntity()
    runner = attach_refresh_runner(inst)

    payload = asyncio.run(runner.run(force=True))

    assert payload["mode"] == "pull"
    assert inst.calls == ["pull"]
    assert runner.status.last_mode == MODE_PULL
    detach_refresh_runner(inst.store_key)


def test_runner_alternates_pull_and_probe(monkeypatch):
    _fake_store(monkeypatch, cached={"mode": "probe", "value": 2})
    inst = _LayeredEntity()
    runner = attach_refresh_runner(inst)

    inst.calls.clear()
    payload = asyncio.run(runner.run(force=True))
    assert payload["mode"] == "pull"
    assert inst.calls == ["pull"]
    assert runner.status.last_mode == MODE_PULL

    inst.calls.clear()
    payload = asyncio.run(runner.run(force=False))
    assert payload["mode"] == "pull"
    assert inst.calls == ["pull"]

    inst.calls.clear()
    asyncio.run(runner.run(force=False))
    assert inst.calls == ["pull"]

    inst.calls.clear()
    asyncio.run(runner.run(force=False))
    assert inst.calls == ["probe"]
    detach_refresh_runner(inst.store_key)


def test_runner_pull_failure_keeps_cached(monkeypatch):
    class _FailingPull(_LayeredEntity):
        async def pull_live_states(self, cached):
            self.calls.append("pull")
            raise RuntimeError("pull failed")

    cached = {"mode": "probe", "value": 99}
    _fake_store(monkeypatch, cached=cached)
    inst = _FailingPull()
    runner = attach_refresh_runner(inst)

    payload = asyncio.run(runner.run(force=False))

    assert payload == cached
    assert inst.calls == ["pull"]
    assert runner.status.last_mode == MODE_PULL
    detach_refresh_runner(inst.store_key)


def test_runner_pull_failure_does_not_probe_when_cache_exists(monkeypatch):
    class _FailingPull(_LayeredEntity):
        async def pull_live_states(self, cached):
            self.calls.append("pull")
            raise RuntimeError("pull failed")

    cached = {"mode": "probe", "value": 42}
    _fake_store(monkeypatch, cached=cached)
    inst = _FailingPull()
    runner = attach_refresh_runner(inst)

    payload = asyncio.run(runner.run(force=False))

    assert payload == cached
    assert inst.calls == ["pull"]
    assert "probe" not in inst.calls
    detach_refresh_runner(inst.store_key)


def test_runner_resolves_live_instance_after_reload(monkeypatch):
    class _A(BaseEntity):
        slug = "reload_demo"
        label = "Reload"
        tag = "a"

        async def fetch_entities(self):
            self.calls.append(self.tag)
            return {"tag": self.tag}

        def extract_entities(self, payload):
            return []

    class _B(_A):
        tag = "b"

    _fake_store(monkeypatch)
    inst_a = _A(entry_id="reload12345678", entry_data={}, entry_title="Reload")
    inst_a.calls = []
    runner = attach_refresh_runner(inst_a)

    class FakeManager:
        def get_by_entry(self, entry_id):
            inst = _B(entry_id="reload12345678", entry_data={}, entry_title="Reload")
            inst.calls = inst_a.calls
            return inst

    monkeypatch.setattr("integrations.get_integration_manager", lambda: FakeManager())

    payload = asyncio.run(runner.run(force=True))
    assert payload["tag"] == "b"
    assert inst_a.calls == ["b"]
    detach_refresh_runner(inst_a.store_key)


def test_runner_records_failure(monkeypatch):
    class _Broken(BaseEntity):
        slug = "broken"
        label = "Broken"

        async def fetch_entities(self):
            raise RuntimeError("upstream down")

        def extract_entities(self, payload):
            return []

    _fake_store(monkeypatch)
    inst = _Broken()
    runner = attach_refresh_runner(inst)

    with pytest.raises(RuntimeError, match="upstream down"):
        asyncio.run(runner.run(force=True))

    assert runner.status.consecutive_failures == 1
    assert runner.status.reachable is False
    assert get_refresh_runner(inst.store_key) is runner
    detach_refresh_runner(inst.store_key)
