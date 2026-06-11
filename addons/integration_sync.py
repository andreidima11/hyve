"""Mirror add-on state into integration config entries (SQLite).

Bundled add-ons declare ``integration_key`` (e.g. Frigate → ``frigate``) so the
matching entity integration reads ``enabled`` and connection fields from config
entries — not legacy ``config.json`` sections.
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


def _integration_schema(slug: str) -> list[dict[str, Any]]:
    try:
        from integrations.loader import get_integration_manager

        cls = get_integration_manager().get_class(slug)
        return list(getattr(cls, "CONFIG_SCHEMA", None) or []) if cls else []
    except Exception:
        return []


def _reload_manager() -> None:
    try:
        from integrations.loader import get_integration_manager

        get_integration_manager().reload()
    except Exception:
        pass


def _primary_entry(slug: str) -> dict[str, Any] | None:
    from integrations import config_entries

    entries = config_entries.list_entries(slug)
    return entries[0] if entries else None


def _entry_title(integration_slug: str) -> str:
    for manifest in registry.list_available():
        key = integration_key_for(str(manifest.get("slug") or ""))
        if key == integration_slug:
            return str(manifest.get("name") or integration_slug)
    return integration_slug.replace("_", " ").title()


def _apply_entry_patch(key: str, patch: dict[str, Any]) -> None:
    if not key or not patch:
        return
    from integrations import config_entries

    enabled = patch.get("enabled")
    data_patch = {k: v for k, v in patch.items() if k != "enabled"}
    schema = _integration_schema(key)
    entry = _primary_entry(key)

    if entry is None:
        if enabled is False and not data_patch:
            return
        config_entries.create_entry(
            key,
            title=_entry_title(key),
            data=data_patch,
            schema=schema,
            enabled=bool(enabled) if enabled is not None else True,
        )
    else:
        kwargs: dict[str, Any] = {"schema": schema}
        if enabled is not None:
            kwargs["enabled"] = bool(enabled)
        if data_patch:
            kwargs["data"] = data_patch
        if len(kwargs) > 1:
            config_entries.update_entry(entry["entry_id"], **kwargs)

    _reload_manager()


def sync_enabled(slug: str, enabled: bool) -> None:
    key = integration_key_for(slug)
    if not key:
        return
    _apply_entry_patch(key, {"enabled": bool(enabled)})


def sync_config_fields(slug: str, fields: dict[str, Any]) -> None:
    key = integration_key_for(slug)
    if not key or not fields:
        return
    _apply_entry_patch(key, dict(fields))


def sync_from_addon_state(slug: str, state: dict[str, Any] | None = None) -> None:
    """Push ``enabled`` plus stored config fields to the integration config entry."""
    state = dict(state if state is not None else registry.get_state(slug))
    key = integration_key_for(slug)
    if not key:
        return
    patch: dict[str, Any] = {"enabled": bool(state.get("enabled"))}
    cfg = state.get("config")
    if isinstance(cfg, dict) and cfg:
        patch.update(cfg)
    _apply_entry_patch(key, patch)
