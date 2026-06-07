"""Shared helpers for integration entity extraction."""

from __future__ import annotations

import re
from typing import Any

from smart_home_registry import entity_domain, is_controllable_domain, normalize_entity_record


def finalize_entities(items: list[dict[str, Any]], default_source: str = "") -> list[dict[str, Any]]:
    """Apply HA-style normalization to every record produced by an extractor."""
    for item in items:
        normalize_entity_record(item, default_source=default_source)
    return items


def slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower())
    return text.strip("_") or "device"


def is_state_controllable(state: Any, entity_id: str = "") -> bool:
    domain = entity_domain(entity_id)
    if is_controllable_domain(domain):
        return True
    value = str(state or "").strip().lower()
    return value in {"on", "off", "open", "closed", "locked", "unlocked", "playing", "paused", "heat", "cool"}


def set_status_attrs(
    attributes: dict[str, Any],
    *,
    key: str,
    label: str | None = None,
) -> None:
    """Attach platform status fields for localized UI display."""
    attributes["status_key"] = str(key or "").strip()
    if label is not None:
        attributes["status"] = label
