"""Bundled i18n merge — platform, components, and add-ons."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.i18n import bundles as bundle_i18n
from core.i18n.platform import get_platform_translations


@pytest.fixture(autouse=True)
def _clear_bundle_cache():
    bundle_i18n.invalidate_cache()
    yield
    bundle_i18n.invalidate_cache()


def test_platform_cameras_namespace():
    payload = get_platform_translations("en", force=True)
    assert "cameras" in payload
    assert isinstance(payload["cameras"].get("not_found"), str)


def test_bundled_merge_includes_apps(monkeypatch):
    monkeypatch.setattr(
        bundle_i18n.component_i18n,
        "discovered_domains",
        lambda: set(),
    )
    monkeypatch.setattr(
        bundle_i18n.addon_i18n,
        "discovered_addon_slugs",
        lambda: set(),
    )
    payload = bundle_i18n.get_bundled_translations("en", force=True)
    assert "apps" in payload
    assert isinstance(payload["apps"].get("log_title"), str)


def test_component_catalog_desc_in_bundle():
    payload = bundle_i18n.get_bundled_translations("en", force=True)
    mammotion = (payload.get("components") or {}).get("mammotion") or {}
    assert mammotion.get("catalog_desc")
