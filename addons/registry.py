"""
Add-on registry facade — discovers, installs, configures and monitors add-ons.

Implementation is split across ``addons/discovery.py``, ``versions.py``,
``reconcile.py``, ``preflight.py``, ``install_ops.py``, and ``health.py``.
This module re-exports the public API (and test-facing ``_*`` helpers).
"""

from __future__ import annotations

import logging
import shutil
import sys
from typing import Any

from addons import integration_sync
from addons import lifecycle as addon_lifecycle
from addons.discovery import get_addon_dir, get_manifest, list_available
from addons.github_releases import (
    addon_release_notes,
    github_latest_version as _github_latest_version,
    github_release_info as _github_release_info,
    github_repo as _github_repo,
    github_tag_candidates as _github_tag_candidates,
)
from addons.health import check_health
from addons.install_ops import (
    _bootstrap_docker_linux,
    _bootstrap_docker_macos,
    _build_install_cmd,
    apply_patch as _apply_patch,
    bootstrap_cmds_for_method as _bootstrap_cmds_for_method,
    build_install_cmds as _build_install_cmds,
    finalize_install as _finalize_install,
    install_addon,
    install_addon_stream,
    run_install_commands as _run_install_commands,
    uninstall_addon,
    update_addon,
)
from addons.meta import (
    HYVE_META_KEY as _HYVE_META_KEY,
    clear_user_uninstalled,
    is_process_user_stopped,
    is_user_uninstalled,
    mark_user_uninstalled,
    patch_addon_meta as _patch_addon_meta,
    save_addon_state as _save_addon_state,
    set_process_user_stopped,
)
from addons.paths import ADDONS_DIR as _ADDONS_DIR, AVAILABLE_DIR as _AVAILABLE_DIR, CUSTOM_DIR as _CUSTOM_DIR, PROJECT_ROOT as _PROJECT_ROOT
from addons.preflight import preflight_check
from addons.reconcile import (
    _config_section_key,
    _entry_config_for_manifest,
    _install_requires_artifacts,
    _legacy_section_config,
    _reconcile_hints,
    detect_on_disk_install as _detect_on_disk_install,
    reconcile_addon_state,
    repair_false_installed_flags as _repair_false_installed_flags,
)
from addons.state_store import get_state
from addons.version_utils import (
    is_channel_tag as _is_channel_tag,
    normalize_version_string as _normalize_version_string,
    plausible_version_string as _plausible_version_string,
)
from addons.versions import (
    _brew_binary_path,
    _brew_binary_present,
    _brew_binary_version,
    _brew_installed_version,
    _docker_daemon_reachable,
    _docker_image,
    _docker_image_exists,
    _docker_installed_version,
    _http_runtime_version,
    _npm_installed_version,
    _npm_latest_version,
    _npm_prefix_dir,
    _pip_installed_version,
    _pypi_latest_version,
    _resolve_channel_version,
    _resolve_display_version,
    _resolve_installed_version,
    _resolve_latest_version,
    _run_capture,
    _run_capture_text,
    _strip_pkg_version,
    addon_entry,
    is_update_available,
    list_all,
    refresh_addon_versions,
    version_is_newer,
)

log = logging.getLogger("addons")

__all__ = [
    "addon_entry",
    "check_health",
    "clear_user_uninstalled",
    "get_addon_dir",
    "get_manifest",
    "get_state",
    "get_watchdog_addons",
    "install_addon",
    "install_addon_stream",
    "is_process_user_stopped",
    "is_update_available",
    "is_user_uninstalled",
    "list_all",
    "list_available",
    "mark_user_uninstalled",
    "patch_addon_enabled",
    "preflight_check",
    "reconcile_addon_state",
    "refresh_addon_versions",
    "set_addon_enabled",
    "set_addon_watchdog",
    "set_process_user_stopped",
    "uninstall_addon",
    "update_addon",
    "update_addon_config",
    "version_is_newer",
]


def update_addon_config(slug: str, config: dict) -> dict:
    """Update addon config fields and bootstrap external/local usage if needed."""
    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    state = get_state(slug)
    if not state.get("installed"):
        if _install_requires_artifacts(manifest):
            raise ValueError(f"Addon {slug} is not installed")
        schema = manifest.get("config_schema", [])
        default_config = {field["key"]: field.get("default", "") for field in schema}
        state = {
            "installed": True,
            "enabled": False,
            "version": manifest.get("version", "1.0.0"),
            "config": default_config,
            "watchdog": False,
        }

    state.setdefault("config", {})
    state["config"].update(config)
    _save_addon_state(slug, state)
    integration_sync.sync_config_fields(slug, config)
    addon_lifecycle.after_config_update(slug, state["config"], manifest=manifest)
    return state


def set_addon_enabled(slug: str, enabled: bool) -> dict:
    """Enable/disable an addon. Returns updated state."""
    state = patch_addon_enabled(slug, enabled)
    if state is None:
        raise ValueError(f"Addon {slug} is not installed")
    integration_sync.sync_enabled(slug, enabled)
    return state


def patch_addon_enabled(slug: str, enabled: bool) -> dict | None:
    """Update ``enabled`` in SQLite only (no integration write-back)."""
    state = get_state(slug)
    if not state.get("installed"):
        return None
    if bool(state.get("enabled")) == bool(enabled):
        return state
    state = dict(state)
    state["enabled"] = bool(enabled)
    _save_addon_state(slug, state)
    return state


def set_addon_watchdog(slug: str, enabled: bool) -> dict:
    """Enable/disable watchdog for an addon. Returns updated state."""
    manifest = get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")
    state = get_state(slug)
    if not state.get("installed"):
        raise ValueError(f"Addon {slug} is not installed")
    state = dict(state)
    state["watchdog"] = bool(enabled)
    _save_addon_state(slug, state)
    return state


def get_watchdog_addons() -> list[str]:
    """Return slugs of addons with watchdog enabled (auto-start on boot)."""
    result: list[str] = []
    for manifest in list_available():
        slug = manifest["slug"]
        state = get_state(slug)
        if not state.get("installed") or not state.get("enabled") or not state.get("watchdog"):
            continue
        if not manifest.get("start_command"):
            continue
        result.append(slug)
    return result
