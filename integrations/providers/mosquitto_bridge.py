"""Legacy import path — implementation lives in components/mosquitto/bridge.py."""

from __future__ import annotations

from integrations.component_import import import_sibling
from integrations.component_paths import BUNDLED_COMPONENTS_DIR

_mod = import_sibling(BUNDLED_COMPONENTS_DIR / "mosquitto", "bridge")

MosquittoBridge = _mod.MosquittoBridge
get_bridge = _mod.get_bridge
start_bridge = _mod.start_bridge
stop_bridge = _mod.stop_bridge
slugify = _mod.slugify

__all__ = ['MosquittoBridge', 'get_bridge', 'start_bridge', 'stop_bridge', 'slugify']
