"""Mammotion integration wiring tests."""

from __future__ import annotations

import asyncio

from components.mammotion.entity import MammotionEntity


def test_mammotion_validate_entry_requires_credentials():
    result = asyncio.run(MammotionEntity.async_validate_entry({"account": "", "password": ""}))
    assert result["ok"] is False
    assert "account" in result["errors"]
    assert "password" in result["errors"]


def test_mammotion_test_connection_missing_password():
    result = asyncio.run(MammotionEntity.async_test_connection({"account": "a@b.com", "password": ""}))
    assert result["ok"] is False


def test_mammotion_test_connection_rejects_legacy_pymammotion(monkeypatch):
    from components.mammotion import entity as entity_mod

    monkeypatch.setattr(entity_mod, "_pymammotion_import_error", lambda: "pymammotion 0.0.5 prea vechi")
    result = asyncio.run(MammotionEntity.async_test_connection({"account": "a@b.com", "password": "x"}))
    assert result["ok"] is False
    assert "prea vechi" in result["message"]


def test_mammotion_choose_refresh_mode_force_uses_probe():
    entity = MammotionEntity(entry_id="e1", entry_data={"account": "a@b.com", "password": "x"})
    from integrations.source_refresh import MODE_PROBE, MODE_PULL

    assert entity.choose_refresh_mode(force=True, cached={"devices": [{"device_name": "Luba-X"}]}, cycle_count=1) == MODE_PROBE
    assert entity.choose_refresh_mode(force=False, cached={}, cycle_count=0) == MODE_PROBE
    assert entity.choose_refresh_mode(force=False, cached={"devices": []}, cycle_count=1) == MODE_PROBE
    assert entity.choose_refresh_mode(force=False, cached={"devices": [{"device_name": "Luba-X"}]}, cycle_count=1) == MODE_PULL


def test_mammotion_control_parses_unique_id(monkeypatch):
    entity = MammotionEntity(entry_id="entry1", entry_data={"account": "a@b.com", "password": "x"})

    class _FakeSession:
        async def control(self, target_id: str, action: str, data: dict | None = None) -> dict:
            assert target_id == "mammotion:Luba-XYZ"
            assert action == "start"
            return {"status": "ok", "action": "start"}

    async def _fake_get_session():
        return _FakeSession()

    monkeypatch.setattr(entity, "_get_session", _fake_get_session)
    result = asyncio.run(entity.control_entity("mammotion:Luba-XYZ", "start", {}))
    assert result["status"] == "ok"
    assert result["action"] == "start"
