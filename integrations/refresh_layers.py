"""Shared helpers for SourceRefreshRunner probe / pull layers."""

from __future__ import annotations

from typing import Any


def merge_payload(cached: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    """Shallow merge: ``fresh`` wins; nested dicts merge one level deep."""
    if not isinstance(cached, dict):
        return dict(fresh or {})
    if not isinstance(fresh, dict):
        return dict(cached)
    out = dict(cached)
    for key, value in fresh.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = value
    return out


def merge_entity_items(
    cached_items: list[dict[str, Any]],
    fresh_items: list[dict[str, Any]],
    *,
    attr_keys: tuple[str, ...] | None = None,
) -> list[dict[str, Any]]:
    """Merge flat entity dicts by ``entity_id``, preserving heavy attrs when omitted."""
    cached_by_id = {
        str(item.get("entity_id") or ""): item
        for item in cached_items
        if item.get("entity_id")
    }
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for fresh in fresh_items:
        eid = str(fresh.get("entity_id") or "")
        if not eid:
            merged.append(dict(fresh))
            continue
        seen.add(eid)
        old = cached_by_id.get(eid)
        if not old:
            merged.append(dict(fresh))
            continue
        item = dict(old)
        item["state"] = fresh.get("state", item.get("state"))
        if "available" in fresh:
            item["available"] = fresh.get("available")
        if "unit" in fresh:
            item["unit"] = fresh.get("unit")
        new_attrs = fresh.get("attributes") or {}
        if new_attrs:
            attrs = dict(item.get("attributes") or {})
            if attr_keys:
                for key in attr_keys:
                    if key in new_attrs:
                        attrs[key] = new_attrs[key]
            else:
                attrs.update(new_attrs)
            item["attributes"] = attrs
        merged.append(item)
    for eid, old in cached_by_id.items():
        if eid not in seen:
            merged.append(dict(old))
    return merged


def cached_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = (payload or {}).get("items")
    return list(items) if isinstance(items, list) else []


def with_items(payload: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
    out = dict(payload or {})
    out["items"] = items
    return out
