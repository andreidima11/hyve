"""Hyve-internal flags stored inside add-on config."""

from __future__ import annotations

from typing import Any

from addons.state_store import get_state, save_state

HYVE_META_KEY = "__hyve_meta"


def save_addon_state(slug: str, state: dict) -> dict:
    return save_state(slug, state)


def addon_meta(state: dict) -> dict[str, Any]:
    cfg = state.get("config") or {}
    meta = cfg.get(HYVE_META_KEY)
    return dict(meta) if isinstance(meta, dict) else {}


def patch_addon_meta(slug: str, **updates: Any) -> dict:
    state = dict(get_state(slug))
    config = dict(state.get("config") or {})
    meta = addon_meta(state)
    for key, value in updates.items():
        if value is None:
            meta.pop(key, None)
        else:
            meta[key] = value
    if meta:
        config[HYVE_META_KEY] = meta
    else:
        config.pop(HYVE_META_KEY, None)
    state["config"] = config
    return save_addon_state(slug, state)


def is_process_user_stopped(slug: str) -> bool:
    return bool(addon_meta(get_state(slug)).get("user_stopped_process"))


def set_process_user_stopped(slug: str, stopped: bool) -> dict:
    return patch_addon_meta(slug, user_stopped_process=True if stopped else None)


def is_user_uninstalled(slug: str) -> bool:
    return bool(addon_meta(get_state(slug)).get("user_uninstalled"))


def mark_user_uninstalled(slug: str) -> dict:
    return patch_addon_meta(slug, user_uninstalled=True)


def clear_user_uninstalled(slug: str) -> dict:
    return patch_addon_meta(slug, user_uninstalled=None)
