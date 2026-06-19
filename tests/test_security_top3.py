"""Security hardening for setup token, camera ACL, and assist auth."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import core.auth as auth
from core.cameras.access import user_may_access_camera
from core.network_bind import resolve_bind_host
from core.setup_token import ensure_setup_token, verify_setup_token


def test_resolve_bind_host_localhost_until_setup(monkeypatch, tmp_path):
    import core.settings as settings

    monkeypatch.setattr(settings, "CONFIG_FILE", str(tmp_path / "config.json"))
    settings.CFG = settings.load_config()
    monkeypatch.delenv("HYVE_BIND_HOST", raising=False)
    monkeypatch.setattr("core.setup_service.is_setup_complete", lambda: False)
    assert resolve_bind_host() == "127.0.0.1"


def test_resolve_bind_host_all_interfaces_after_setup(monkeypatch, tmp_path):
    import core.settings as settings

    cfg_path = tmp_path / "config.json"
    cfg_path.write_text('{"setup_complete": true}', encoding="utf-8")
    monkeypatch.setattr(settings, "CONFIG_FILE", str(cfg_path))
    settings.CFG = settings.load_config()
    monkeypatch.delenv("HYVE_BIND_HOST", raising=False)
    assert resolve_bind_host() == "0.0.0.0"


def test_setup_token_roundtrip(monkeypatch, tmp_path):
    import core.setup_token as setup_token_mod

    monkeypatch.setattr(setup_token_mod, "_SETUP_TOKEN_PATH", tmp_path / "setup_token")
    token = ensure_setup_token()
    assert verify_setup_token(token)
    assert not verify_setup_token("wrong-token")


def test_camera_acl_admin_vs_dashboard(monkeypatch):
    admin = MagicMock(is_admin=True, username="admin")
    guest = MagicMock(is_admin=False, username="guest")
    monkeypatch.setattr(
        "core.cameras.access.dashboard_entity_ids",
        lambda: {"camera.living", "light.kitchen"},
    )
    assert user_may_access_camera(admin, "camera.backyard")
    assert user_may_access_camera(guest, "camera.living")
    assert not user_may_access_camera(guest, "camera.backyard")


def test_unscoped_camera_stream_token_rejected():
    with pytest.raises(ValueError):
        auth.create_camera_stream_token("alice", "")
    token = auth.create_camera_stream_token("alice", "camera.front")
    assert auth.verify_camera_stream_token(token)["entity_id"] == "camera.front"
