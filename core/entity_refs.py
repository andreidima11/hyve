"""Stable entity reference resolution (entity_id or unique_id)."""

from __future__ import annotations

from typing import Any

from integrations.entity_utils import resolve_entity_by_id


def build_entity_map(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index entities by both entity_id and unique_id."""
    entity_map: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        eid = str(item.get("entity_id") or "").strip()
        uid = str(item.get("unique_id") or "").strip()
        if eid:
            entity_map[eid] = item
        if uid and uid not in entity_map:
            entity_map[uid] = item
    return entity_map


def resolve_entity_reference(
    ref: str,
    items: list[dict[str, Any]] | dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Resolve a stored reference (entity_id or unique_id) to a live entity record."""
    raw = str(ref or "").strip()
    if not raw:
        return None
    if items is not None:
        hit = resolve_entity_by_id(raw, items)
        if hit:
            return hit
    try:
        from core.device_control import find_entity_record

        return find_entity_record(raw)
    except Exception:
        return None


def live_entity_id(ref: str, items: list[dict[str, Any]] | None = None) -> str:
    """Return the current entity_id for a reference, or the ref itself."""
    record = resolve_entity_reference(ref, items)
    if record:
        return str(record.get("entity_id") or ref).strip() or ref
    return ref


def entity_ref_matches(
    stored_ref: str,
    payload_entity_id: str,
    *,
    items: list[dict[str, Any]] | dict[str, dict[str, Any]] | None = None,
) -> bool:
    """True when an event entity_id belongs to the stored reference."""
    ref = str(stored_ref or "").strip()
    live = str(payload_entity_id or "").strip()
    if not ref or not live:
        return False
    if ref == live:
        return True
    record = resolve_entity_reference(ref, items)
    if not record:
        return False
    candidates = {
        ref,
        str(record.get("entity_id") or "").strip(),
        str(record.get("unique_id") or "").strip(),
    }
    return live in candidates
