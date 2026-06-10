"""Tests for EntityMirror shared snapshot loop."""

from __future__ import annotations

import asyncio

from core import event_bus
from core.entity_mirror import EntityMirror, TOPIC_MIRROR_TICK


def test_mirror_rebuilds_once_and_notifies(monkeypatch):
    calls = {"n": 0}

    def fake_build(*, include_derived: bool, sort_mode: str):
        calls["n"] += 1
        return [{"entity_id": "light.a", "state": str(calls["n"]), "unit": ""}]

    monkeypatch.setattr("core.entity_catalog.build_entities_uncached", fake_build)

    received: list[dict] = []
    event_bus.subscribe(TOPIC_MIRROR_TICK, "test_mirror_tick", received.append)

    async def run():
        mirror = EntityMirror(tick_sec=0.05)
        pushed: list[list] = []

        async def capture(items):
            pushed.append(list(items))

        mirror.register_push_target("test", capture, include_derived=True, sort_mode="name")
        mirror.start()
        await asyncio.sleep(0.12)
        await mirror.stop()
        return pushed, received

    pushed, received = asyncio.run(run())
    event_bus.unsubscribe(TOPIC_MIRROR_TICK, "test_mirror_tick")

    assert calls["n"] >= 1
    assert pushed and pushed[0][0]["entity_id"] == "light.a"
    assert received and received[0]["trigger"] in {"boot", "tick", "source", "manual", "read"}


def test_signal_source_refresh_triggers_immediate_rebuild(monkeypatch):
    calls = {"n": 0}

    def fake_build(*, include_derived: bool, sort_mode: str):
        calls["n"] += 1
        return [{"entity_id": "sensor.t", "state": str(calls["n"]), "unit": "°C"}]

    monkeypatch.setattr("core.entity_catalog.build_entities_uncached", fake_build)

    async def run():
        mirror = EntityMirror(tick_sec=60.0)
        mirror.start()
        await asyncio.sleep(0.02)
        boot_count = calls["n"]
        mirror.signal_source_refresh("reolink:abc12345")
        await asyncio.sleep(0.08)
        await mirror.stop()
        return boot_count

    boot_count = asyncio.run(run())
    # Each rebuild builds two snapshot variants (name + dashboard).
    assert calls["n"] >= boot_count + 2


def test_kick_during_rebuild_is_not_lost(monkeypatch):
  calls = {"n": 0}

  def fake_build(*, include_derived: bool, sort_mode: str):
      calls["n"] += 1
      return [{"entity_id": "sensor.t", "state": str(calls["n"]), "unit": ""}]

  monkeypatch.setattr("core.entity_catalog.build_entities_uncached", fake_build)

  async def run():
      mirror = EntityMirror(tick_sec=60.0)
      mirror.start()
      await asyncio.sleep(0.02)
      boot = calls["n"]

      async def kick_while_locked():
          await asyncio.sleep(0.01)
          mirror.signal_source_refresh("mosquitto:e1")
          await asyncio.sleep(0.01)
          mirror.signal_source_refresh("mosquitto:e2")

      asyncio.create_task(kick_while_locked())
      mirror.signal_source_refresh("mosquitto:e0")
      await asyncio.sleep(0.2)
      await mirror.stop()
      return boot

  boot = asyncio.run(run())
  assert calls["n"] >= boot + 2


def test_source_unreachable_flags_entities(monkeypatch):
    class FakeStore:
        def source_is_reachable(self, store_key: str) -> bool:
            return store_key != "reolink:deadbeef"

        def get_entities(self, key):
            return {"entities": {}}

        def get_entities_many(self, keys):
            return {key: self.get_entities(key) for key in keys}

        def apply_overrides(self, items):
            return None

    class FakeIntegration:
        slug = "reolink"
        store_key = "reolink:deadbeef"
        entry_id = "deadbeef"
        entry_title = "Camere"
        label = "Reolink"
        supports_sync = True

        def extract_entities(self, payload):
            return [{"entity_id": "camera.gate", "state": "idle", "domain": "camera"}]

        def live_payload(self, stored):
            return stored

    monkeypatch.setattr(
        "core.entity_catalog.get_entity_store",
        lambda: FakeStore(),
    )
    monkeypatch.setattr(
        "core.entity_catalog.get_integration_manager",
        lambda: type("M", (), {"all_instances": lambda self: [FakeIntegration()], "is_bootstrap_eligible": lambda self, i: True})(),
    )
    monkeypatch.setattr("core.entity_catalog.derived_entities.evaluate_all", lambda state: [])
    monkeypatch.setattr("core.entity_catalog.area_resolver.entity_area_map", lambda: {})

    from core.entity_catalog import build_entities_uncached

    items = build_entities_uncached(include_derived=False, sort_mode="name")
    assert items[0]["available"] is False
    assert items[0]["attributes"]["source_reachable"] is False
