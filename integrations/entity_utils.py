"""Shared helpers for integration entity extraction."""

from __future__ import annotations

import re
from typing import Any

from smart_home_registry import entity_domain, is_controllable_domain, normalize_entity_record

_Z2M_ENDPOINT_VARIANT = re.compile(r"^(.+)_(l\d+)$", re.I)
_Z2M_STATE_ENDPOINT_VARIANT = re.compile(r"^(.+)_state_(l\d+)$", re.I)


def entity_id_lookup_variants(entity_id: str) -> list[str]:
    """Return equivalent entity_id spellings (Z2M expose vs HA MQTT discovery)."""
    raw = str(entity_id or "").strip()
    if not raw:
        return []
    if "." not in raw:
        return [raw]
    domain, object_id = raw.split(".", 1)
    variants = [raw]
    m = _Z2M_STATE_ENDPOINT_VARIANT.match(object_id)
    if m:
        variants.append(f"{domain}.{m.group(1)}_{m.group(2)}")
    else:
        m2 = _Z2M_ENDPOINT_VARIANT.match(object_id)
        if m2:
            variants.append(f"{domain}.{m2.group(1)}_state_{m2.group(2)}")
    return list(dict.fromkeys(v for v in variants if v))


def resolve_entity_by_id(
    entity_id: str,
    items: list[dict[str, Any]] | dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Find an entity record by entity_id, unique_id, or alias variants."""
    variants = entity_id_lookup_variants(entity_id)
    if isinstance(items, dict):
        for variant in variants:
            hit = items.get(variant)
            if hit:
                return hit
        for ent in items.values():
            uid = str(ent.get("unique_id") or "").strip()
            if uid and uid in variants:
                return ent
        return None
    by_key: dict[str, dict[str, Any]] = {}
    for ent in items:
        if not isinstance(ent, dict):
            continue
        eid = str(ent.get("entity_id") or "").strip()
        uid = str(ent.get("unique_id") or "").strip()
        if eid:
            by_key[eid] = ent
        if uid:
            by_key[uid] = ent
    for variant in variants:
        hit = by_key.get(variant)
        if hit:
            return hit
    return None


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
