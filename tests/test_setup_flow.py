"""First-run browser setup API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import database
import models
import settings
from core.http.app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "setup.db"
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

    hyve = create_app()
    return TestClient(hyve.app)


def test_setup_status_incomplete_on_fresh_install(client):
    res = client.get("/api/setup/status")
    assert res.status_code == 200
    data = res.json()
    assert data["complete"] is False
    assert "en" in data["languages"]
    assert "ro" in data["languages"]


def test_setup_complete_creates_admin_and_marks_done(client, tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(settings, "CONFIG_FILE", str(cfg_path))

    res = client.post(
        "/api/setup/complete",
        json={
            "username": "admin",
            "password": "secret123",
            "password_confirm": "secret123",
            "full_name": "Admin",
            "language": "ro",
            "timezone": "Europe/Bucharest",
            "server_name": "Casa mea",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["username"] == "admin"
    assert data["access_token"]
    assert data["is_admin"] is True

    status = client.get("/api/setup/status").json()
    assert status["complete"] is True

    cfg = settings._load_config_raw()
    assert cfg.get("setup_complete") is True
    assert cfg.get("timezone") == "Europe/Bucharest"
    assert cfg.get("server_name") == "Casa mea"
    assert cfg.get("ui", {}).get("language") == "ro"

    login = client.post(
        "/api/token",
        data={"username": "admin", "password": "secret123"},
    )
    assert login.status_code == 200


def test_setup_complete_rejected_after_first_run(client, tmp_path, monkeypatch):
    cfg_path = tmp_path / "config.json"
    monkeypatch.setattr(settings, "CONFIG_FILE", str(cfg_path))
    payload = {
        "username": "admin",
        "password": "secret123",
        "password_confirm": "secret123",
        "language": "en",
        "timezone": "UTC",
    }
    assert client.post("/api/setup/complete", json=payload).status_code == 200
    retry = client.post(
        "/api/setup/complete",
        json={
            **payload,
            "username": "other",
        },
    )
    assert retry.status_code == 403
    assert retry.json()["detail"]["key"] == "setup.already_complete"


def test_setup_password_mismatch(client):
    res = client.post(
        "/api/setup/complete",
        json={
            "username": "admin",
            "password": "secret123",
            "password_confirm": "different",
            "language": "en",
            "timezone": "UTC",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"]["key"] == "setup.password_mismatch"
