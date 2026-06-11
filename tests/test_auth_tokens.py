"""Auth token type enforcement and SSE single-use consumption."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import core.auth as auth
import core.database as database
import core.models as models
from core.auth import (
    create_access_token,
    create_refresh_token,
    create_sse_exchange_token,
    decode_access_token,
    consume_sse_exchange_token,
)


@pytest.fixture()
def db_session(monkeypatch, tmp_path):
    db_path = tmp_path / "auth.db"
    engine = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(bind=engine)
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", SessionLocal)
    monkeypatch.setattr(database, "engine", engine)
    sess = SessionLocal()
    try:
        user = models.User(
            username="admin",
            hashed_password="x",
            is_active=True,
            is_admin=True,
        )
        sess.add(user)
        sess.commit()
        yield sess
    finally:
        sess.close()


def test_refresh_token_rejected_as_access(db_session):
    refresh = create_refresh_token({"sub": "admin"})
    assert decode_access_token(refresh, db_session) is None


def test_access_token_accepted(db_session):
    token = create_access_token({"sub": "admin"})
    payload = decode_access_token(token, db_session)
    assert payload is not None
    assert payload["sub"] == "admin"


def test_sse_exchange_token_single_use(db_session):
    token = create_sse_exchange_token("admin")
    first = consume_sse_exchange_token(token, db_session)
    assert first is not None
    assert first["sub"] == "admin"
    second = consume_sse_exchange_token(token, db_session)
    assert second is None


def test_authenticate_ws_token_consumes_exchange(db_session):
    token = create_sse_exchange_token("admin")
    user = auth.authenticate_ws_token(token)
    assert user is not None
    assert user.username == "admin"
    assert auth.authenticate_ws_token(token) is None
