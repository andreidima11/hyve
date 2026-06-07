"""Search paths for bundled and user-supplied integration components."""

from __future__ import annotations

import os
from pathlib import Path

_INTEGRATIONS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = _INTEGRATIONS_DIR.parent
BUNDLED_COMPONENTS_DIR = PROJECT_ROOT / "components"
DEFAULT_CUSTOM_COMPONENTS_DIR = PROJECT_ROOT / "custom_components"


def custom_components_dir() -> Path:
    raw = (os.environ.get("HYVE_CUSTOM_COMPONENTS_DIR") or "").strip()
    if raw:
        path = Path(raw)
        return path if path.is_absolute() else (PROJECT_ROOT / path)
    return DEFAULT_CUSTOM_COMPONENTS_DIR


def component_search_paths() -> list[tuple[str, Path]]:
    """Return (origin, path) pairs in discovery order.

    Bundled ``components/`` is scanned first; ``custom_components/`` (or
    ``HYVE_CUSTOM_COMPONENTS_DIR``) may override a slug with the same domain.
    """
    paths: list[tuple[str, Path]] = []
    if BUNDLED_COMPONENTS_DIR.is_dir():
        paths.append(("bundled", BUNDLED_COMPONENTS_DIR))
    custom = custom_components_dir()
    if custom.is_dir():
        paths.append(("custom", custom))
    return paths
