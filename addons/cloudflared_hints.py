"""Cloudflared add-on: computed config suggestions for the UI."""

from __future__ import annotations

from core.network_utils import suggest_origin_url


def enrich_addon_entry(entry: dict) -> dict:
    entry["config_suggestions"] = suggest_origin_url(prefer_lan=True)
    return entry
