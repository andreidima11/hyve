"""HTTP contract smoke tests — structured API errors return ``detail.key``."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.database as database
import core.models as models
import core.settings as settings
from core.http.app import create_app


def _detail_key(response) -> str | None:
    body = response.json()
    detail = body.get("detail")
    if isinstance(detail, dict):
        return str(detail.get("key") or "") or None
    return None


@pytest.fixture(autouse=True)
def _disable_rate_limits(monkeypatch):
    from core.http.limiter import limiter

    monkeypatch.setattr(limiter, "enabled", False, raising=False)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "contracts.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(bind=engine)
    models.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)

    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(settings, "CONFIG_FILE", str(cfg_path))
    settings.CFG = settings.load_config()

    return TestClient(create_app().app)


@pytest.fixture()
def auth_headers(client: TestClient) -> dict[str, str]:
    res = client.post(
        "/api/setup/complete",
        json={
            "username": "admin",
            "password": "secret123",
            "password_confirm": "secret123",
            "full_name": "Admin",
            "language": "en",
            "timezone": "UTC",
        },
    )
    assert res.status_code == 200, res.text
    token = client.post(
        "/api/token",
        data={"username": "admin", "password": "secret123"},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize(
    ("method", "path", "json_body", "status", "key"),
    [
        ("GET", "/api/scenes/does-not-exist", None, 404, "scenes.not_found"),
        ("DELETE", "/api/areas/does-not-exist", None, 404, "areas.not_found"),
        ("GET", "/api/skills/__missing__", None, 404, "skills.not_found"),
        ("DELETE", "/api/derived/sensor.missing", None, 404, "derived.entity_not_found"),
        (
            "POST",
            "/api/skills/generate-preview",
            {"description": "ab", "allow_network": False},
            400,
            "skills.description_too_short",
        ),
        (
            "GET",
            "/api/integrations/no-such-provider/schema",
            None,
            404,
            "integrations.provider_not_found",
        ),
        ("GET", "/api/cameras/camera.missing/stream", None, 404, "cameras.not_found"),
    ],
)
def test_router_errors_expose_i18n_keys(
    client: TestClient,
    auth_headers: dict[str, str],
    method: str,
    path: str,
    json_body: dict[str, Any] | None,
    status: int,
    key: str,
):
    res = client.request(method, path, headers=auth_headers, json=json_body)
    assert res.status_code == status, res.text
    assert _detail_key(res) == key


def test_memory_update_not_found_returns_key(client: TestClient, auth_headers: dict[str, str], monkeypatch):
    import core.storage as storage

    class _EmptyCollection:
        def get(self, **_kwargs):
            return {"ids": []}

    monkeypatch.setattr(storage, "get_collection", lambda: _EmptyCollection())

    res = client.put(
        "/api/memory/missing-fact-id",
        headers=auth_headers,
        json={"text": "hello"},
    )
    assert res.status_code == 404
    assert _detail_key(res) == "memory.not_found"
