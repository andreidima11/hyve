"""Integration lifecycle hooks — manifest-driven startup and wiring."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from integrations import lifecycle as integration_lifecycle
from integrations.component_loader import discover_component_classes


@pytest.fixture(autouse=True)
def _clear_lifecycle_cache():
    integration_lifecycle.invalidate_cache()
    yield
    integration_lifecycle.invalidate_cache()


def test_mosquitto_manifest_declares_mqtt_bridge_capability():
    discover_component_classes()
    assert "mqtt_bridge" in integration_lifecycle.capabilities_for_slug("mosquitto")
    assert "mosquitto" in integration_lifecycle.slugs_with_capability("mqtt_bridge")


def test_mammotion_entry_test_timeout_from_lifecycle():
    discover_component_classes()
    assert integration_lifecycle.entry_test_timeout_seconds("mammotion") == 120.0
    assert integration_lifecycle.entry_test_timeout_seconds("demo_sensor", default=50.0) == 50.0


def test_before_initial_sync_calls_hook(monkeypatch, tmp_path: Path):
    component_dir = tmp_path / "demo_sensor"
    trans_dir = component_dir / "translations"
    trans_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps(
            {
                "domain": "demo_sensor",
                "name": "Demo",
                "version": "0.1.0",
                "lifecycle_module": "lifecycle",
            }
        ),
        encoding="utf-8",
    )
    (component_dir / "lifecycle.py").write_text(
        """
import asyncio
_called = False

async def before_initial_sync(**_kwargs):
    global _called
    _called = True
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        integration_lifecycle,
        "_component_dir_for_domain",
        lambda _slug: component_dir,
    )
    integration_lifecycle.invalidate_cache()

    manager = MagicMock()
    asyncio.run(integration_lifecycle.before_initial_sync("demo_sensor", manager, "entry-1"))
    module = integration_lifecycle._load_lifecycle_module("demo_sensor")
    assert module is not None
    assert module._called is True


def test_run_startup_hooks_invokes_startup_all(monkeypatch, tmp_path: Path):
    component_dir = tmp_path / "demo_sensor"
    component_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "demo_sensor", "name": "Demo", "version": "0.1.0"}),
        encoding="utf-8",
    )
    hook = AsyncMock()
    (component_dir / "lifecycle.py").write_text(
        "async def startup_all(**kwargs):\n    pass\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(
        integration_lifecycle,
        "discovered_slugs",
        lambda: {"demo_sensor"},
    )
    monkeypatch.setattr(
        integration_lifecycle,
        "_component_dir_for_domain",
        lambda _slug: component_dir,
    )
    monkeypatch.setattr(
        "integrations.get_integration_manager",
        lambda: MagicMock(),
    )
    integration_lifecycle.invalidate_cache()

    module = integration_lifecycle._load_lifecycle_module("demo_sensor")
    module.startup_all = hook
    asyncio.run(integration_lifecycle.run_startup_hooks())
    hook.assert_awaited_once()


def test_purge_discovery_on_rename_delegates_to_module(monkeypatch, tmp_path: Path):
    component_dir = tmp_path / "mosquitto"
    component_dir.mkdir(parents=True)
    (component_dir / "manifest.json").write_text(
        json.dumps({"domain": "mosquitto", "name": "MQTT", "version": "1.0.0"}),
        encoding="utf-8",
    )
    (component_dir / "lifecycle.py").write_text(
        "def purge_discovery_on_rename(**kwargs):\n    return 2\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        integration_lifecycle,
        "_component_dir_for_domain",
        lambda slug: component_dir if slug == "mosquitto" else None,
    )
    integration_lifecycle.invalidate_cache()

    removed = integration_lifecycle.purge_discovery_on_rename(
        "mosquitto",
        canonical_id="0xabc",
        old_names=["old"],
        manager=MagicMock(),
    )
    assert removed == 2
    assert integration_lifecycle.purge_discovery_on_rename(
        "tapo",
        canonical_id="x",
        old_names=[],
        manager=MagicMock(),
    ) == 0
