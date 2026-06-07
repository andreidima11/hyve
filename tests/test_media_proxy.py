"""Media proxy authentication tests."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import auth
import database
import models
from core.http.app import create_app


@pytest.fixture()
def client(monkeypatch, tmp_path):
    db_path = tmp_path / "media.db"
    engine = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    sess = SessionLocal()
    user = models.User(username="alice", hashed_password="x", is_active=True)
    sess.add(user)
    sess.commit()
    sess.close()
    return TestClient(create_app().app)


def test_img_proxy_requires_token(client):
    res = client.get("/api/img-proxy", params={"url": "https://example.com/a.png"})
    assert res.status_code == 401


def test_favicon_requires_token(client):
    res = client.get("/api/favicon", params={"domain": "example.com"})
    assert res.status_code == 401


def test_img_proxy_accepts_camera_stream_token(client):
    token = auth.create_camera_stream_token("alice")
    res = client.get(
        "/api/img-proxy",
        params={"url": "https://example.com/a.png", "token": token},
    )
    assert res.status_code == 200
    assert res.headers.get("content-type", "").startswith("image/")


def test_favicon_accepts_access_token(client, monkeypatch, tmp_path):
    db_path = tmp_path / "media2.db"
    engine = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    sess = SessionLocal()
    sess.add(models.User(username="bob", hashed_password="x", is_active=True))
    sess.commit()
    sess.close()
    token = auth.create_access_token({"sub": "bob"})
    res = client.get("/api/favicon", params={"domain": "example.com", "token": token})
    assert res.status_code == 200
    assert res.headers.get("content-type", "").startswith("image/")
