"""Every sync-capable integration must opt into SourceRefreshRunner layers."""

from __future__ import annotations

import inspect

import pytest

from integrations.base import BaseEntity
from integrations.component_loader import discover_component_classes
from integrations.component_paths import BUNDLED_COMPONENTS_DIR
from integrations.manifest import load_manifest


def _bundled_integration_classes() -> dict[str, type[BaseEntity]]:
    all_classes = discover_component_classes()
    bundled_slugs: set[str] = set()
    if BUNDLED_COMPONENTS_DIR.is_dir():
        for component_dir in BUNDLED_COMPONENTS_DIR.iterdir():
            if not component_dir.is_dir() or component_dir.name.startswith("_"):
                continue
            manifest = load_manifest(component_dir)
            if manifest:
                bundled_slugs.add(str(manifest["domain"]))
    return {slug: cls for slug, cls in all_classes.items() if slug in bundled_slugs}


_BUNDLED = _bundled_integration_classes()


@pytest.mark.parametrize("slug,cls", list(_BUNDLED.items()))
def test_sync_integrations_use_refresh_layers(slug: str, cls: type[BaseEntity]) -> None:
    if not cls.supports_sync:
        return
    assert getattr(cls, "uses_refresh_layers", False), (
        f"{slug} supports_sync but uses_refresh_layers is not enabled"
    )
    assert int(getattr(cls, "probe_interval_cycles", 0)) >= 1


@pytest.mark.parametrize("slug,cls", list(_BUNDLED.items()))
def test_sync_integrations_define_probe_and_pull(slug: str, cls: type[BaseEntity]) -> None:
    if not cls.supports_sync:
        return
    for method_name in ("probe_source", "pull_live_states", "fetch_entities"):
        method = getattr(cls, method_name, None)
        assert method is not None, f"{slug} missing {method_name}"
        assert inspect.iscoroutinefunction(method), f"{slug}.{method_name} must be async"


def test_hyve_scenes_skips_background_sync() -> None:
    cls = _BUNDLED["hyve_scenes"]
    assert cls.supports_sync is False
    assert getattr(cls, "uses_refresh_layers", False) is False
