"""Mammotion utility helpers."""

from __future__ import annotations

import os

from components.mammotion.utils import (
    friendly_auth_error,
    mammotion_cache_usable,
    mammotion_ha_fingerprint,
)


def test_mammotion_ha_fingerprint_env_override(monkeypatch):
    monkeypatch.setenv("MAMMOTION_HA_FINGERPRINT", "0.6.4-beta2")
    assert mammotion_ha_fingerprint() == "0.6.4-beta2"
    monkeypatch.delenv("MAMMOTION_HA_FINGERPRINT", raising=False)


def test_mammotion_cache_usable():
    assert not mammotion_cache_usable(None)
    assert not mammotion_cache_usable({})
    assert mammotion_cache_usable({"aep_data": {"x": 1}})
    assert mammotion_cache_usable({"mammotion_mqtt": {}, "mammotion_device_records": []})


def test_friendly_auth_error_access_denied():
    from pymammotion.transport.base import LoginFailedError

    msg = friendly_auth_error(LoginFailedError("a@b.com", "Access denied"))
    assert "access denied" in msg.lower() or "refuzat" in msg.lower()
