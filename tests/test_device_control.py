"""Tests for core.device_control — entity → integration resolution."""

from __future__ import annotations

import asyncio

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.device_control import (
    ControlTargetNotFound,
    control_entity,
    control_entity_sync,
    find_entity_record,
    integration_for_entity,
    resolve_control_target,
)


class _FakeIntegration:
    slug = "demo"

    def __init__(self, entry_id: str = "e1"):
        self.entry_id = entry_id

    async def control_entity(self, target_id, action, data=None):
        return {"target_id": target_id, "action": action, "data": data or {}}


def test_find_entity_record_by_unique_id():
    entities = [
        {"entity_id": "light.kitchen", "unique_id": "z2m:abc", "source": "mosquitto", "entry_id": "ent1"},
    ]
    hit = find_entity_record("z2m:abc", entities=entities)
    assert hit is not None
    assert hit["entity_id"] == "light.kitchen"


def test_integration_for_entity_uses_entry_id():
    inst = _FakeIntegration()
    manager = MagicMock()
    manager.get_by_entry.return_value = inst
    manager.get.return_value = None
    manager.entries_for.return_value = []

    entity = {"entry_id": "ent1", "source": "mosquitto", "unique_id": "z2m:x"}
    with patch("integrations.get_integration_manager", return_value=manager):
        assert integration_for_entity(entity) is inst
    manager.get_by_entry.assert_called_once_with("ent1")


def test_integration_for_entity_zigbee_alias_to_mosquitto():
    inst = _FakeIntegration()
    manager = MagicMock()
    manager.get_by_entry.return_value = None
    manager.get.return_value = inst
    manager.entries_for.return_value = [inst]

    entity = {"source": "zigbee2mqtt", "unique_id": "z2m:device1"}
    with patch("integrations.get_integration_manager", return_value=manager):
        assert integration_for_entity(entity) is inst


def test_resolve_control_target_maps_unique_id():
    inst = _FakeIntegration()
    entities = [
        {
            "entity_id": "light.bed",
            "unique_id": "prov:123",
            "source": "demo",
            "entry_id": "e1",
        }
    ]
    manager = MagicMock()
    manager.get_by_entry.return_value = inst
    manager.get.return_value = None

    with patch("integrations.get_integration_manager", return_value=manager):
        with patch("core.device_control.find_entity_record", return_value=entities[0]):
            target = resolve_control_target("light.bed")
    assert target.target_id == "prov:123"
    assert target.integration is inst


def test_control_entity_delegates_to_integration():
    inst = _FakeIntegration()

    async def _run():
        with patch(
            "core.device_control.resolve_control_target",
            return_value=MagicMock(
                target_id="tid",
                integration=inst,
                raw_entity_id="light.x",
                entity={},
            ),
        ):
            return await control_entity("light.x", "turn_on", {"brightness": 128})

    result = asyncio.run(_run())
    assert result["action"] == "turn_on"
    assert result["data"]["brightness"] == 128


def test_control_entity_sync_uses_main_loop():
    with patch("core.http.runtime.run_coroutine_on_main_loop", return_value={"ok": True}) as run:
        out = control_entity_sync("light.x", "turn_off")
    assert out == {"ok": True}
    run.assert_called_once()


def test_resolve_raises_when_unknown():
    manager = MagicMock()
    manager.get_by_entry.return_value = None
    manager.get.return_value = None
    manager.entries_for.return_value = []

    with patch("integrations.get_integration_manager", return_value=manager):
        with patch("core.device_control.find_entity_record", return_value=None):
            with pytest.raises(ControlTargetNotFound):
                resolve_control_target("unknown.entity")
