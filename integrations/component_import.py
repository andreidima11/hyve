"""Load sibling .py files from a component folder (importlib, no package)."""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from integrations.component_paths import BUNDLED_COMPONENTS_DIR, component_search_paths
from integrations.manifest import load_manifest

log = logging.getLogger("integrations.component_import")

_CACHE: dict[tuple[str, str], Any] = {}


def resolve_component_dir(domain: str) -> Path:
    """Return the component folder for *domain* (custom overrides bundled)."""
    key = str(domain or "").strip()
    found: Path | None = None
    for _origin, root in component_search_paths():
        candidate = root / key
        if candidate.is_dir() and load_manifest(candidate) is not None:
            found = candidate
    if found is not None:
        return found
    fallback = BUNDLED_COMPONENTS_DIR / key
    if fallback.is_dir():
        return fallback
    raise ImportError(f"Component directory not found for {key!r}")


def load_component_module(domain: str, stem: str) -> Any:
    """Load ``components/<domain>/<stem>.py`` (or custom_components override)."""
    return import_sibling(resolve_component_dir(domain), stem)


def import_sibling(component_dir: Path, stem: str) -> Any:
    """Import ``component_dir/<stem>.py`` once and cache the module."""
    key = (str(component_dir.resolve()), stem)
    if key in _CACHE:
        return _CACHE[key]
    path = component_dir / f"{stem}.py"
    if not path.is_file():
        raise ImportError(f"Component module not found: {path}")
    module_name = f"hyve_component_{component_dir.name}_{stem}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if not spec or not spec.loader:
        raise ImportError(f"Cannot load component module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        log.warning("Component sibling %s failed to load: %s", path, exc)
        raise
    _CACHE[key] = module
    return module
