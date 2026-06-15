"""Add-on lifecycle hooks — install detection and config side-effects."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from addons import lifecycle as addon_lifecycle
from addons import registry


@pytest.fixture(autouse=True)
def _clear_addon_lifecycle_cache():
    addon_lifecycle.invalidate_cache()
    yield
    addon_lifecycle.invalidate_cache()


def test_piper_detect_on_disk_models(tmp_path, monkeypatch):
    models_dir = tmp_path / "piper_models"
    models_dir.mkdir()
    (models_dir / "ro_RO-mihai-medium.onnx").write_bytes(b"x")

    manifest = registry.get_manifest("piper")
    version = addon_lifecycle.detect_on_disk_version(
        manifest,
        project_root=tmp_path,
        resolve_channel_version=None,
    )
    assert version == manifest.get("version")


def test_cloudflared_detect_on_disk_data_dir(tmp_path):
    data_dir = tmp_path / "output" / "addons" / "cloudflared" / "data"
    data_dir.mkdir(parents=True)
    (data_dir / "cert.pem").write_text("test", encoding="utf-8")

    manifest = registry.get_manifest("cloudflared")
    resolve = MagicMock(return_value="2026.1.0")
    version = addon_lifecycle.detect_on_disk_version(
        manifest,
        project_root=tmp_path,
        resolve_channel_version=resolve,
    )
    assert version == "2026.1.0"
    resolve.assert_called_once()


def test_cloudflared_enrich_catalog_entry():
    manifest = registry.get_manifest("cloudflared")
    entry = addon_lifecycle.enrich_catalog_entry({"slug": "cloudflared"}, manifest)
    assert "config_suggestions" in entry
    assert "origin_url" in entry["config_suggestions"]


def test_after_config_update_cloudflared_sync(monkeypatch):
    manifest = registry.get_manifest("cloudflared")
    sync = MagicMock()
    monkeypatch.setattr("addons.cloudflared_config.maybe_sync_from_addon_config", sync)
    addon_lifecycle.after_config_update(
        "cloudflared",
        {"origin_url": "http://192.168.1.1:8082"},
        manifest=manifest,
    )
    sync.assert_called_once()


def test_registry_detect_on_disk_uses_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(registry, "_resolve_installed_version", lambda _m: None)
    data_dir = tmp_path / "output" / "addons" / "cloudflared" / "data"
    data_dir.mkdir(parents=True)
    (data_dir / "x").write_text("1", encoding="utf-8")

    manifest = registry.get_manifest("cloudflared")
    assert registry._detect_on_disk_install(manifest)
