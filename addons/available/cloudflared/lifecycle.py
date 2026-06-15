"""Cloudflared add-on lifecycle — on-disk install detection, config sync, UI hints."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

from core.network_utils import suggest_origin_url

log = logging.getLogger("addons.cloudflared.lifecycle")


def detect_on_disk_version(
    manifest: dict[str, Any],
    *,
    project_root: Path,
    resolve_channel_version: Callable[[dict[str, Any], str], str] | None = None,
) -> str | None:
    data_dir = project_root / "output" / "addons" / "cloudflared" / "data"
    if not data_dir.is_dir() or not any(data_dir.iterdir()):
        return None
    ref = str(manifest.get("version") or "latest")
    if resolve_channel_version is not None:
        return resolve_channel_version(manifest, ref)
    return ref


def after_config_update(config: dict[str, Any], *, manifest: dict[str, Any], slug: str) -> None:
    del manifest, slug
    try:
        from addons.cloudflared_config import maybe_sync_from_addon_config

        maybe_sync_from_addon_config(config)
    except ValueError as exc:
        log.warning("Cloudflared Cloudflare sync skipped: %s", exc)
    except Exception as exc:
        log.warning("Cloudflared Cloudflare sync failed: %s", exc)


def enrich_catalog_entry(entry: dict[str, Any], *, manifest: dict[str, Any], slug: str) -> dict[str, Any]:
    del manifest, slug
    entry["config_suggestions"] = suggest_origin_url(prefer_lan=True)
    return entry
