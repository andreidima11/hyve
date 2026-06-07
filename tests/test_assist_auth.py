"""Assist/Ollama authentication regression tests."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import auth
import assist_keys
import settings


def _request(headers: dict[str, str] | None = None) -> Request:
    raw = [
        (k.lower().encode("latin-1"), v.encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    scope = {"type": "http", "headers": raw, "method": "POST", "path": "/api/chat"}
    return Request(scope)


def test_resolve_assist_user_id_accepts_assist_key():
    db = MagicMock()
    with patch.object(assist_keys, "get_user_id_by_token", return_value=42):
        uid = asyncio.run(auth.resolve_assist_user_id(
            _request({"Authorization": "Bearer hab_abc123"}),
            db,
        ))
    assert uid == 42


def test_resolve_assist_user_id_accepts_valid_jwt():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [None, MagicMock(id=7, is_active=True)]
    with patch.object(assist_keys, "get_user_id_by_token", return_value=None), patch.object(
        auth, "verify_token", return_value={"sub": "alice", "jti": "j1"}
    ):
        uid = asyncio.run(auth.resolve_assist_user_id(_request({"Authorization": "Bearer jwt-token"}), db))
    assert uid == 7


def test_resolve_assist_user_id_rejects_garbage_token():
    db = MagicMock()
    with patch.object(assist_keys, "get_user_id_by_token", return_value=None), patch.object(
        auth, "verify_token", return_value=None
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(auth.resolve_assist_user_id(_request({"Authorization": "Bearer garbage"}), db))
    assert exc.value.status_code == 401


def test_resolve_assist_user_id_rejects_revoked_jwt():
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = MagicMock()
    with patch.object(assist_keys, "get_user_id_by_token", return_value=None), patch.object(
        auth, "verify_token", return_value={"sub": "alice", "jti": "revoked-jti"}
    ):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(auth.resolve_assist_user_id(_request({"Authorization": "Bearer jwt-token"}), db))
    assert exc.value.status_code == 401


def test_resolve_assist_user_id_uses_default_when_no_credentials():
    db = MagicMock()
    with patch.object(settings, "CFG", {"assist": {"assist_default_user_id": 3}}):
        uid = asyncio.run(auth.resolve_assist_user_id(_request(), db))
    assert uid == 3


def test_memory_prefix_uses_memini_spelling():
    from routers.ollama_proxy import _MEMORY_SYSTEM_PREFIX

    assert "Memini memory" in _MEMORY_SYSTEM_PREFIX
    assert "\u0115" not in _MEMORY_SYSTEM_PREFIX
