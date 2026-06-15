"""Optional per-integration lifecycle hooks (startup, wiring, rename, shutdown).

Components declare ``lifecycle_module`` in ``manifest.json`` (default: ``lifecycle``)
and implement async callables in ``components/<slug>/lifecycle.py``.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from integrations.component_loader import discover_component_classes, manifest_meta
from integrations.component_paths import component_search_paths
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.lifecycle")

_MODULE_CACHE: dict[str, Any | None] = {}
_DEFAULT_TEST_TIMEOUT = 50.0


def _component_dir_for_domain(domain: str) -> Path | None:
    key = str(domain or "").strip()
    if not key:
        return None
    found: Path | None = None
    for _origin, root in component_search_paths():
        candidate = root / key
        if candidate.is_dir() and load_manifest(candidate) is not None:
            found = candidate
    return found


def _load_lifecycle_module(slug: str) -> Any | None:
    key = str(slug or "").strip()
    if not key:
        return None
    if key in _MODULE_CACHE:
        return _MODULE_CACHE[key]

    component_dir = _component_dir_for_domain(key)
    if component_dir is None:
        _MODULE_CACHE[key] = None
        return None

    manifest = load_manifest(component_dir) or {}
    module_stem = str(manifest.get("lifecycle_module") or "lifecycle").strip() or "lifecycle"
    module_path = component_dir / f"{module_stem}.py"
    if not module_path.is_file():
        _MODULE_CACHE[key] = None
        return None

    module_name = f"hyve_lifecycle_{key}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if not spec or not spec.loader:
        _MODULE_CACHE[key] = None
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        log.warning("Lifecycle module %s failed to load: %s", module_path, exc)
        _MODULE_CACHE[key] = None
        return None

    _MODULE_CACHE[key] = module
    return module


def invalidate_cache() -> None:
    _MODULE_CACHE.clear()


def discovered_slugs() -> set[str]:
    try:
        return set(discover_component_classes().keys())
    except Exception as exc:
        log.debug("discover_component_classes failed: %s", exc)
        return set()


def capabilities_for_slug(slug: str) -> list[str]:
    meta = manifest_meta(slug) or {}
    raw = meta.get("capabilities") or []
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def slugs_with_capability(capability: str) -> list[str]:
    cap = str(capability or "").strip()
    if not cap:
        return []
    return sorted(slug for slug in discovered_slugs() if cap in capabilities_for_slug(slug))


def entry_test_timeout_seconds(slug: str, *, default: float = _DEFAULT_TEST_TIMEOUT) -> float:
    module = _load_lifecycle_module(slug)
    if module is None:
        return default
    value = getattr(module, "ENTRY_TEST_TIMEOUT_SECONDS", None)
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


async def before_initial_sync(slug: str, manager: Any, entry_id: str) -> None:
    module = _load_lifecycle_module(slug)
    if module is None:
        return
    hook = getattr(module, "before_initial_sync", None)
    if not callable(hook):
        return
    try:
        result = hook(manager=manager, entry_id=entry_id, slug=slug)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:
        log.warning("before_initial_sync failed for %s: %s", slug, exc)


async def after_entry_wired(slug: str, manager: Any, entry_id: str) -> None:
    module = _load_lifecycle_module(slug)
    if module is None:
        return
    hook = getattr(module, "after_entry_wired", None)
    if not callable(hook):
        return
    try:
        result = hook(manager=manager, entry_id=entry_id, slug=slug)
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:
        log.warning("after_entry_wired failed for %s: %s", slug, exc)


async def run_startup_hooks() -> None:
    from integrations import get_integration_manager

    manager = get_integration_manager()
    for slug in sorted(discovered_slugs()):
        module = _load_lifecycle_module(slug)
        if module is None:
            continue
        hook = getattr(module, "startup_all", None)
        if not callable(hook):
            continue
        try:
            result = hook(manager=manager, slug=slug)
            if hasattr(result, "__await__"):
                await result
        except Exception as exc:
            log.warning("startup_all failed for %s: %s", slug, exc)


async def run_shutdown_hooks() -> None:
    for slug in sorted(discovered_slugs()):
        module = _load_lifecycle_module(slug)
        if module is None:
            continue
        hook = getattr(module, "shutdown", None)
        if not callable(hook):
            continue
        try:
            result = hook(slug=slug)
            if hasattr(result, "__await__"):
                await result
        except Exception as exc:
            log.warning("shutdown failed for %s: %s", slug, exc)


def purge_discovery_on_rename(
    slug: str,
    *,
    canonical_id: str,
    old_names: list[str],
    manager: Any,
) -> int:
    module = _load_lifecycle_module(slug)
    if module is None:
        return 0
    hook = getattr(module, "purge_discovery_on_rename", None)
    if not callable(hook):
        return 0
    try:
        return int(
            hook(
                manager=manager,
                slug=slug,
                canonical_id=canonical_id,
                old_names=old_names,
            )
            or 0
        )
    except Exception as exc:
        log.debug("purge_discovery_on_rename failed for %s: %s", slug, exc)
        return 0
