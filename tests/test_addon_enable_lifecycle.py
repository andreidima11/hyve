"""Add-on enable/disable must control process lifecycle."""

import asyncio

import pytest

from addons import process_manager as pm
from addons import registry


def test_start_refuses_when_disabled(monkeypatch):
    slug = "mosquitto"
    monkeypatch.setattr(registry, "get_state", lambda _s: {"enabled": False, "config": {}})
    monkeypatch.setattr(
        registry,
        "get_manifest",
        lambda _s: {"start_command": {"command": "echo", "args": []}},
    )

    with pytest.raises(ValueError, match="is disabled"):
        asyncio.run(pm.start(slug))


def test_get_status_async_reports_stopped_when_disabled(monkeypatch):
    slug = "mosquitto"
    monkeypatch.setattr(registry, "get_state", lambda _s: {"enabled": False, "config": {"port": 1883}})
    monkeypatch.setattr(
        registry,
        "get_manifest",
        lambda _s: {"health_check": {"port_key": "port"}},
    )
    monkeypatch.setattr(pm, "_port_in_use", lambda *_a, **_k: True)

    status = asyncio.run(pm.get_status_async(slug))
    assert status["status"] == "stopped"
    assert status.get("disabled") is True


def test_get_watchdog_addons_skips_disabled(monkeypatch):
    slug = "mosquitto"
    manifest = registry.get_manifest(slug)
    assert manifest is not None

    monkeypatch.setattr(registry, "list_available", lambda: [manifest])
    monkeypatch.setattr(
        registry,
        "get_state",
        lambda _s: {"installed": True, "enabled": False, "watchdog": True},
    )

    assert registry.get_watchdog_addons() == []
