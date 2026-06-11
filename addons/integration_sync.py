"""Mirror add-on state into legacy ``config.json`` integration sections.

Bundled add-ons declare ``integration_key`` (e.g. Frigate → ``frigate``) so the
matching entity integration can read ``enabled`` and connection fields from
``config.json[slug]`` until fully migrated to config entries. All writes go
through this module — routers must not call ``save_config`` for add-on sync.
"""

from __future__ import annotations

import logging
from typing import Any

from addons import registry

log = logging.getLogger("addon_integration_sync")


def integration_key_for(slug: str) -> str | None:
    manifest = registry.get_manifest(slug)
    if not manifest:
        return None
    raw = manifest.get("integration_key")
    if raw is False:
        return None
    key = str(raw or slug).strip()
    return key or None


def _merge_integration_section(key: str, patch: dict[str, Any]) -> None:
    if not key or not patch:
        return
    from core.settings import _load_config_raw, save_config

    current = dict(_load_config_raw().get(key) or {})
    current.update(patch)
    save_config({key: current})


def sync_enabled(slug: str, enabled: bool) -> None:
    key = integration_key_for(slug)
    if not key:
        return
    _merge_integration_section(key, {"enabled": bool(enabled)})


def sync_config_fields(slug: str, fields: dict[str, Any]) -> None:
    key = integration_key_for(slug)
    if not key or not fields:
        return
    _merge_integration_section(key, dict(fields))


def sync_from_addon_state(slug: str, state: dict[str, Any] | None = None) -> None:
    """Push ``enabled`` plus stored config fields to the integration section."""
    state = dict(state if state is not None else registry.get_state(slug))
    key = integration_key_for(slug)
    if not key:
        return
    patch: dict[str, Any] = {"enabled": bool(state.get("enabled"))}
    cfg = state.get("config")
    if isinstance(cfg, dict) and cfg:
        patch.update(cfg)
    _merge_integration_section(key, patch)
