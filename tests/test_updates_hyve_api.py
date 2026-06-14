"""Hyve self-update API."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import core.auth as auth
from core.hyve_update import HyveUpdateError
from core.http.app import create_app


@pytest.fixture()
def updates_client(monkeypatch):
    bundle = create_app()
    admin = MagicMock()
    admin.is_admin = True
    admin.is_active = True
    bundle.app.dependency_overrides[auth.get_current_user] = lambda: admin
    return TestClient(bundle.app)


def test_apply_hyve_update_api(updates_client, monkeypatch):
    def _apply():
        return {"status": "restarting", "version": "0.9.7.2", "message_key": "updates.hyve_updated_restarting"}

    monkeypatch.setattr("routers.updates.apply_hyve_update", _apply)
    res = updates_client.post("/api/updates/hyve/apply")
    assert res.status_code == 200
    assert res.json()["version"] == "0.9.7.2"


def test_apply_hyve_update_maps_errors(updates_client, monkeypatch):
    def _apply():
        raise HyveUpdateError("updates.hyve_dirty_tree")

    monkeypatch.setattr("routers.updates.apply_hyve_update", _apply)
    res = updates_client.post("/api/updates/hyve/apply")
    assert res.status_code == 400
    assert res.json()["detail"]["key"] == "updates.hyve_dirty_tree"


def test_apply_hyve_update_requires_admin(updates_client):
    user = MagicMock()
    user.is_admin = False
    user.is_active = True
    updates_client.app.dependency_overrides[auth.get_current_user] = lambda: user
    res = updates_client.post("/api/updates/hyve/apply")
    assert res.status_code == 403
