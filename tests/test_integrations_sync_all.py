"""POST /api/integrations/sync-all"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

import core.auth as auth
from core.http.app import create_app


@pytest.fixture()
def admin_client(monkeypatch):
    bundle = create_app()
    admin = MagicMock()
    admin.username = "admin"
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_admin] = lambda: admin
    return TestClient(bundle.app)


def test_sync_all_runs_enabled_integrations(admin_client, monkeypatch):
    from routers.integrations import sync as sync_router

    manager = MagicMock()
    manager.classes.return_value = {"sun": object(), "tapo": object()}
    manager.entries_for.side_effect = lambda slug: [MagicMock()] if slug == "sun" else []

    async def _fake_sync(slug, store, manager, *, raise_on_total_failure=True):
        assert slug == "sun"
        return {"status": "ok", "slug": slug, "entity_count": 3, "errors": [], "refresh": {}}

    monkeypatch.setattr(sync_router, "_sync_integration_slug", _fake_sync)
    monkeypatch.setattr("integrations.get_integration_manager", lambda: manager)
    monkeypatch.setattr("routers.integrations.sync.get_entity_store", lambda: MagicMock())
    monkeypatch.setattr(
        "routers.integrations.sync.helpers.invalidate_all_entities_cache",
        lambda: None,
    )

    res = admin_client.post("/api/integrations/sync-all")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "ok"
    assert body["synced_count"] == 1
    assert body["synced_slugs"] == ["sun"]
    assert body["entity_count"] == 3


def test_sync_all_returns_500_when_everything_fails(admin_client, monkeypatch):
    from routers.integrations import sync as sync_router

    manager = MagicMock()
    manager.classes.return_value = {"sun": object()}
    manager.entries_for.return_value = [MagicMock()]

    async def _fail(slug, store, manager, *, raise_on_total_failure=True):
        return {"status": "error", "slug": slug, "entity_count": 0, "errors": ["boom"], "refresh": {}}

    monkeypatch.setattr(sync_router, "_sync_integration_slug", _fail)
    monkeypatch.setattr("integrations.get_integration_manager", lambda: manager)
    monkeypatch.setattr("routers.integrations.sync.get_entity_store", lambda: MagicMock())

    res = admin_client.post("/api/integrations/sync-all")
    assert res.status_code == 500
