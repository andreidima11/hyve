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
