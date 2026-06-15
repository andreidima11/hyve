"""Optional per-add-on lifecycle hooks (install detection, config side-effects, catalog enrich)."""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("addons.lifecycle")

_MODULE_CACHE: dict[str, Any | None] = {}


def invalidate_cache() -> None:
    _MODULE_CACHE.clear()


def _load_lifecycle_module(slug: str, manifest: dict[str, Any] | None = None) -> Any | None:
    from addons.registry import get_addon_dir, get_manifest

    key = str(slug or "").strip()
    if not key:
        return None
    if key in _MODULE_CACHE:
        return _MODULE_CACHE[key]

    manifest = manifest or get_manifest(key) or {}
    addon_dir = get_addon_dir(key)
    if addon_dir is None:
        _MODULE_CACHE[key] = None
        return None

    module_stem = str(manifest.get("lifecycle_module") or "lifecycle").strip() or "lifecycle"
    module_path = addon_dir / f"{module_stem}.py"
    if not module_path.is_file():
        _MODULE_CACHE[key] = None
        return None

    module_name = f"hyve_addon_lifecycle_{key}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if not spec or not spec.loader:
        _MODULE_CACHE[key] = None
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        log.warning("Add-on lifecycle module %s failed to load: %s", module_path, exc)
        _MODULE_CACHE[key] = None
        return None

    _MODULE_CACHE[key] = module
    return module


def detect_on_disk_version(
    manifest: dict[str, Any],
    *,
    project_root: Path,
    resolve_channel_version: Callable[[dict[str, Any], str], str] | None = None,
) -> str | None:
    slug = str(manifest.get("slug") or "").strip()
    module = _load_lifecycle_module(slug, manifest)
    if module is None:
        return None
    hook = getattr(module, "detect_on_disk_version", None)
    if not callable(hook):
        return None
    try:
        return hook(
            manifest,
            project_root=project_root,
            resolve_channel_version=resolve_channel_version,
        )
    except Exception as exc:
        log.debug("detect_on_disk_version failed for %s: %s", slug, exc)
        return None


def after_config_update(
    slug: str,
    config: dict[str, Any],
    *,
    manifest: dict[str, Any] | None = None,
) -> None:
    from addons.registry import get_manifest

    key = str(slug or "").strip()
    module = _load_lifecycle_module(key, manifest)
    if module is None:
        return
    hook = getattr(module, "after_config_update", None)
    if not callable(hook):
        return
    try:
        manifest = manifest or get_manifest(key) or {}
        hook(config, manifest=manifest, slug=key)
    except Exception as exc:
        log.warning("after_config_update failed for %s: %s", key, exc)


def enrich_catalog_entry(entry: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    slug = str(manifest.get("slug") or "").strip()
    module = _load_lifecycle_module(slug, manifest)
    if module is None:
        return entry
    hook = getattr(module, "enrich_catalog_entry", None)
    if not callable(hook):
        return entry
    try:
        return hook(entry, manifest=manifest, slug=slug)
    except Exception as exc:
        log.debug("enrich_catalog_entry failed for %s: %s", slug, exc)
        return entry
