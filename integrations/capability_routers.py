"""Discover and register optional per-integration HTTP routers.

Components opt in by adding ``router.py`` (or ``router_module`` in
``manifest.json``) that exports ``router: APIRouter``. Loaded routers are
included from ``core.http.routers.register_routers`` — no per-slug imports
in platform code.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI

from integrations.component_paths import component_search_paths
from integrations.lifecycle import discovered_slugs
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.capability_routers")

_MODULE_CACHE: dict[str, APIRouter | None] = {}


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


def invalidate_cache() -> None:
    _MODULE_CACHE.clear()


def _load_router_module(slug: str) -> Any | None:
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
    module_stem = str(manifest.get("router_module") or "router").strip() or "router"
    module_path = component_dir / f"{module_stem}.py"
    if not module_path.is_file():
        _MODULE_CACHE[key] = None
        return None

    module_name = f"hyve_router_{key}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if not spec or not spec.loader:
        _MODULE_CACHE[key] = None
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        log.warning("Router module %s failed to load: %s", module_path, exc)
        _MODULE_CACHE[key] = None
        return None

    router = getattr(module, "router", None)
    if not isinstance(router, APIRouter):
        log.warning("Router module %s must export APIRouter as `router`", module_path)
        _MODULE_CACHE[key] = None
        return None

    _MODULE_CACHE[key] = router
    return router


def routers_for_slug(slug: str) -> APIRouter | None:
    return _load_router_module(slug)


def discover_component_routers() -> list[tuple[str, APIRouter]]:
    found: list[tuple[str, APIRouter]] = []
    for slug in discovered_slugs():
        router = _load_router_module(slug)
        if router is not None:
            found.append((slug, router))
    return found


def register_component_routers(app: FastAPI) -> list[str]:
    """Include all discovered component routers on ``app``. Returns slug list."""
    registered: list[str] = []
    for slug, router in discover_component_routers():
        app.include_router(router)
        registered.append(slug)
        log.debug("Registered component router for %s", slug)
    return registered
