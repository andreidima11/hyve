"""Integration config-entry HTTP API."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import core.auth as auth
from core.http.app import create_app


@pytest.fixture()
def admin_client(monkeypatch, tmp_path):
    import integrations.config_entries as config_entries_mod

    entries_db = tmp_path / "integration_entries.sqlite"
    monkeypatch.setattr(config_entries_mod, "_DB_PATH", entries_db)

    bundle = create_app()
    admin = MagicMock()
    admin.username = "admin"
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_admin] = lambda: admin
    return TestClient(bundle.app)


def test_create_entry_returns_before_slow_wire(admin_client, monkeypatch):
    """POST /entries must respond before post-create sync runs (Mammotion-class)."""
    from integrations import config_entries
    from routers.integrations import entries as entries_router

    async def _slow_wire(*_args, **_kwargs):
        await asyncio.sleep(5)

    monkeypatch.setattr(entries_router, "wire_new_entry", _slow_wire)

    res = admin_client.post(
        "/api/integrations/sun/entries",
        json={"title": "Sun test", "data": {}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "ok"
    assert body["entry"]["entry_id"]

    stored = config_entries.list_entries("sun")
    assert any(e["entry_id"] == body["entry"]["entry_id"] for e in stored)


def test_entry_test_omits_phase_for_providers_without_kwarg(admin_client, monkeypatch):
    """Regression: generic integrations must not receive Tapo-only ``phase`` kwarg."""
    captured: dict[str, Any] = {}

    class FakeEntity:
        CONFIG_SCHEMA: list[dict[str, Any]] = []

        @classmethod
        def get_config_schema(cls) -> list[dict[str, Any]]:
            return []

        @classmethod
        async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
            captured["data"] = data
            return {"ok": True, "message": "ok"}

    mgr = MagicMock()
    mgr.get_class.return_value = FakeEntity
    monkeypatch.setattr("integrations.get_integration_manager", lambda: mgr)

    res = admin_client.post(
        "/api/integrations/fake/entries/test",
        json={"data": {"host": "1.2.3.4"}, "test_phase": "full"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["ok"] is True
    assert captured.get("data") == {"host": "1.2.3.4"}


def test_entry_test_passes_phase_for_tapo(admin_client, monkeypatch):
    captured: dict[str, Any] = {}

    class TapoLike:
        CONFIG_SCHEMA: list[dict[str, Any]] = []

        @classmethod
        def get_config_schema(cls) -> list[dict[str, Any]]:
            return []

        @classmethod
        async def async_test_connection(cls, data: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
            captured["phase"] = kwargs.get("phase")
            return {"ok": True}

    mgr = MagicMock()
    mgr.get_class.return_value = TapoLike
    monkeypatch.setattr("integrations.get_integration_manager", lambda: mgr)

    res = admin_client.post(
        "/api/integrations/tapo/entries/test",
        json={"data": {}, "test_phase": "api"},
    )
    assert res.status_code == 200, res.text
    assert captured.get("phase") == "api"
