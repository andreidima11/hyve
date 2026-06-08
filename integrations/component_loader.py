"""Discover integration entity classes from folder-based components."""

from __future__ import annotations

import importlib.util
import inspect
import logging
import sys
from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_paths import component_search_paths
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.component_loader")

# slug -> metadata from manifest (last writer wins — custom overrides bundled)
_manifest_meta: dict[str, dict[str, Any]] = {}


def manifest_meta(slug: str) -> dict[str, Any] | None:
    return _manifest_meta.get(str(slug or "").strip())


def _entry_module_path(component_dir: Path) -> Path | None:
    for name in ("entity.py", "integration.py", "__init__.py"):
        path = component_dir / name
        if path.is_file():
            return path
    return None


def _load_module(component_dir: Path, *, origin: str) -> Any | None:
    manifest = load_manifest(component_dir)
    if manifest is None:
        return None
    domain = manifest["domain"]
    module_path = _entry_module_path(component_dir)
    if module_path is None:
        log.warning("Component %s has manifest but no __init__.py / integration.py / entity.py", component_dir)
        return None
    module_name = f"hyve_component_{origin}_{domain}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if not spec or not spec.loader:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        log.warning("Component module %s failed to load: %s", module_path, exc)
        return None
    _manifest_meta[domain] = {
        **manifest,
        "origin": origin,
        "path": str(component_dir),
    }
    return module


def _classes_from_module(module: Any, expected_slug: str) -> list[type[BaseEntity]]:
    found: list[type[BaseEntity]] = []
    for _, obj in inspect.getmembers(module, inspect.isclass):
        if not issubclass(obj, BaseEntity) or obj is BaseEntity:
            continue
        slug = getattr(obj, "slug", "")
        if not slug:
            continue
        if slug != expected_slug:
            log.warning(
                "Component %s defines %s.slug=%r; expected %r",
                expected_slug,
                obj.__name__,
                slug,
                expected_slug,
            )
            continue
        found.append(obj)
    return found


def discover_component_classes(*, force: bool = False) -> dict[str, type[BaseEntity]]:
    if force:
        _manifest_meta.clear()
    classes: dict[str, type[BaseEntity]] = {}
    for origin, root in component_search_paths():
        if not root.is_dir():
            continue
        for component_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
            manifest = load_manifest(component_dir)
            if manifest is None:
                continue
            domain = manifest["domain"]
            module = _load_module(component_dir, origin=origin)
            if module is None:
                continue
            for cls in _classes_from_module(module, domain):
                if domain in classes and origin == "bundled":
                    continue
                classes[domain] = cls
    return classes


def discover_legacy_provider_classes(providers_dir: Path) -> dict[str, type[BaseEntity]]:
    """Load flat ``integrations/providers/*.py`` modules (legacy layout)."""
    classes: dict[str, type[BaseEntity]] = {}
    if not providers_dir.is_dir():
        return classes
    for path in sorted(providers_dir.glob("*.py")):
        if path.name.startswith("_") or path.stem == "__init__":
            continue
        module_name = f"hyve_integrations_{path.stem}"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if not spec or not spec.loader:
            continue
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            log.warning("Provider module %s failed to load: %s", path.name, exc)
            continue
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if not issubclass(obj, BaseEntity) or obj is BaseEntity:
                continue
            slug = getattr(obj, "slug", "")
            if not slug or slug in classes:
                continue
            classes[slug] = obj
    return classes


def discover_integration_classes(
    *,
    providers_dir: Path | None = None,
    force: bool = False,
) -> dict[str, type[BaseEntity]]:
    """Unified discovery: ``components/`` + ``custom_components/`` + legacy providers."""
    root = providers_dir or Path(__file__).resolve().parent / "providers"
    classes = discover_component_classes(force=force)
    for slug, cls in discover_legacy_provider_classes(root).items():
        classes.setdefault(slug, cls)
    return classes


def get_component_entity_class(slug: str) -> type[BaseEntity] | None:
    """Load a single bundled/custom component class (for legacy import shims)."""
    key = str(slug or "").strip()
    if not key:
        return None
    discovered = discover_component_classes()
    return discovered.get(key)
