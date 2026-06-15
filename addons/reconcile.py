"""Reconcile SQLite add-on state with config.json and on-disk artifacts."""

from __future__ import annotations

import logging
from typing import Any

from addons import integration_sync
from addons import lifecycle as addon_lifecycle
from addons.discovery import list_available
from addons.meta import HYVE_META_KEY, is_user_uninstalled, save_addon_state
from addons.state_store import get_state
from addons.versions import (
    _resolve_channel_version,
    _resolve_installed_version,
)

log = logging.getLogger("addons.reconcile")

_INSTALL_METHODS_REQUIRING_ARTIFACTS = frozenset({"docker", "brew", "npm", "pip", "binary"})


def detect_on_disk_install(manifest: dict) -> str | None:
    """Return an installed version when local artifacts exist, else None."""
    from addons import registry

    version = registry._resolve_installed_version(manifest)
    if version:
        return version

    return addon_lifecycle.detect_on_disk_version(
        manifest,
        project_root=registry._PROJECT_ROOT,
        resolve_channel_version=registry._resolve_channel_version,
    )


def _config_section_key(manifest: dict) -> str | None:
    raw = manifest.get("integration_key")
    if raw is False:
        return None
    key = str(raw or manifest.get("slug") or "").strip()
    return key or None


def _legacy_section_config(
    manifest: dict,
    section: dict,
    *,
    include_all: bool = False,
) -> dict[str, Any]:
    schema = manifest.get("config_schema") or []
    schema_keys = {f.get("key") for f in schema if f.get("key")}
    cfg: dict[str, Any] = {k: section[k] for k in schema_keys if k in section}
    if include_all:
        return cfg
    defaults = {f["key"]: f.get("default") for f in schema if f.get("key")}
    for key, val in cfg.items():
        default = defaults.get(key)
        if val != default and val not in (None, "", False):
            return cfg
    return {}


def _install_requires_artifacts(manifest: dict) -> bool:
    method = str((manifest.get("install") or {}).get("method") or "").strip().lower()
    return method in _INSTALL_METHODS_REQUIRING_ARTIFACTS


def repair_false_installed_flags() -> int:
    """Clear ``installed`` when DB says yes but local package/image is missing."""
    from addons import registry

    fixed = 0
    for manifest in registry.list_available():
        slug = manifest["slug"]
        state = get_state(slug)
        if not state.get("installed"):
            continue
        if not _install_requires_artifacts(manifest):
            continue
        if registry._detect_on_disk_install(manifest):
            continue
        install = manifest.get("install") or {}
        if install.get("method") == "docker" and not registry._docker_daemon_reachable():
            log.debug(
                "Skipping false-installed repair for %s (docker daemon unavailable)",
                slug,
            )
            continue
        new_state = dict(state)
        new_state["installed"] = False
        new_state["version"] = None
        new_state["latest_version"] = None
        if manifest.get("start_command"):
            new_state["enabled"] = False
        save_addon_state(slug, new_state)
        log.info("Cleared false installed flag for add-on %s (no local artifacts)", slug)
        fixed += 1
    return fixed


def _entry_config_for_manifest(manifest: dict, data: dict[str, Any]) -> dict[str, Any]:
    schema = manifest.get("config_schema") or []
    schema_keys = {f.get("key") for f in schema if f.get("key")}
    return {k: data[k] for k in schema_keys if k in data}


def _reconcile_hints(manifest: dict, raw_config: dict, on_disk_version: str | None) -> dict[str, Any] | None:
    hints: dict[str, Any] = {}
    if on_disk_version:
        hints["version"] = on_disk_version
        hints["latest_version"] = on_disk_version

    key = _config_section_key(manifest)
    section = raw_config.get(key) if key else None
    section_signal = False

    if key:
        try:
            from integrations import config_entries

            entries = config_entries.list_entries(key)
            if entries:
                entry = entries[0]
                hints["enabled"] = bool(entry.get("enabled"))
                cfg = _entry_config_for_manifest(manifest, entry.get("data") or {})
                if cfg:
                    hints["config"] = cfg
                    section_signal = True
                elif entry.get("enabled") is True:
                    section_signal = True
                section = None
        except Exception:
            pass

    if isinstance(section, dict):
        if "enabled" in section:
            hints["enabled"] = bool(section["enabled"])
        cfg = _legacy_section_config(
            manifest,
            section,
            include_all=bool(on_disk_version) or section.get("enabled") is True,
        )
        if cfg:
            hints["config"] = cfg
        if section.get("enabled") is True or cfg:
            section_signal = True

    if on_disk_version:
        return hints
    if section_signal and not _install_requires_artifacts(manifest):
        return hints
    return None


def reconcile_addon_state() -> int:
    """Backfill SQLite when install info lived only in integration sections or on disk."""
    import core.settings as settings_mod
    from addons import registry

    repaired = repair_false_installed_flags()

    raw = settings_mod._load_config_raw()
    for manifest in registry.list_available():
        slug = manifest["slug"]
        state = get_state(slug)
        if state.get("installed"):
            continue
        if is_user_uninstalled(slug):
            continue

        on_disk = registry._detect_on_disk_install(manifest)
        hints = _reconcile_hints(manifest, raw, on_disk)
        if not hints:
            continue

        new_state = dict(state)
        new_state["installed"] = True
        if hints.get("version"):
            new_state["version"] = hints["version"]
            new_state["latest_version"] = hints.get("latest_version") or hints["version"]
        if "enabled" in hints:
            new_state["enabled"] = hints["enabled"]
        if hints.get("config"):
            merged = dict(new_state.get("config") or {})
            user_keys = [k for k in merged if k != HYVE_META_KEY]
            if not user_keys:
                merged.update(hints["config"])
            new_state["config"] = merged

        save_addon_state(slug, new_state)
        integration_sync.sync_from_addon_state(slug, new_state)
        log.info("Reconciled add-on state for %s", slug)
        repaired += 1
    return repaired
