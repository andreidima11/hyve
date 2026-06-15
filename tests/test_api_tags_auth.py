"""GET /api/tags must require authentication (Ollama bridge uses /ollama/api/tags)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.auth as auth
import core.database as database
import core.models as models
from core.http.app import create_app


@pytest.fixture()
def client(monkeypatch, tmp_path):
    db_path = tmp_path / "tags.db"
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


def test_api_tags_requires_auth(client):
    res = client.get("/api/tags")
    assert res.status_code == 401


def test_api_tags_ok_with_bearer(client):
    token = auth.create_access_token({"sub": "alice"})
    res = client.get("/api/tags", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert "models" in body
