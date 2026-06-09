"""Legacy import path — implementation lives in components/comfyui/client.py."""

from __future__ import annotations

from integrations.component_import import import_sibling
from integrations.component_paths import BUNDLED_COMPONENTS_DIR

_mod = import_sibling(BUNDLED_COMPONENTS_DIR / "comfyui", "client")


def __getattr__(name: str):
    return getattr(_mod, name)


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(dir(_mod)))
