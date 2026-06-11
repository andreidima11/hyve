"""Zigbee2MQTT device image proxy helpers."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.auth as auth
import core.database as database
import core.models as models
from core.http.app import create_app
from integrations.z2m_images import attach_device_images, model_image_slug, proxy_image_url


def test_model_image_slug_replaces_slashes():
    assert model_image_slug("E2001/E2002/E2313") == "E2001-E2002-E2313"
    assert model_image_slug("TS0003_switch_module_2") == "TS0003_switch_module_2"


def test_proxy_image_url_is_same_origin():
    url = proxy_image_url("TS0003_switch_module_2")
    assert url.startswith("/api/integrations/device-image?model=")
    assert "TS0003_switch_module_2" in url


def test_attach_device_images_only_for_mosquitto():
    devices = [{"model": "TS0003_switch_module_2", "name": "Relay"}]
    attach_device_images(devices, slug="mosquitto")
    assert devices[0]["image_url"].startswith("/api/integrations/device-image")

    other = [{"model": "TS0003_switch_module_2", "name": "Relay"}]
    attach_device_images(other, slug="tapo")
    assert "image_url" not in other[0]


@pytest.fixture()
def client(monkeypatch, tmp_path):
    db_path = tmp_path / "z2m_images.db"
    engine = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    sess = SessionLocal()
    sess.add(models.User(username="alice", hashed_password="x", is_active=True))
    sess.commit()
    sess.close()
    return TestClient(create_app().app)


def test_device_image_requires_token(client):
    res = client.get(
        "/api/integrations/device-image",
        params={"model": "TS0003_switch_module_2"},
    )
    assert res.status_code == 401


async def _fake_fetch_device_image_bytes(model):
    return (b"\x89PNG\r\n", "image/png")


def test_device_image_accepts_query_token(client, monkeypatch):
    monkeypatch.setattr(
        "integrations.z2m_images.fetch_device_image_bytes",
        _fake_fetch_device_image_bytes,
    )
    token = auth.create_camera_stream_token("alice")
    res = client.get(
        "/api/integrations/device-image",
        params={"model": "TS0003_switch_module_2", "token": token},
    )
    assert res.status_code == 200
    assert res.headers.get("content-type", "").startswith("image/")
