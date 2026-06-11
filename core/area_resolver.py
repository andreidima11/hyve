"""Hyve-side area resolver — the single source of truth for entity ↔ area mapping.

Areas are a Hyve-native concept. They group entities from any source
(Zigbee2MQTT, scenes, derived sensors, virtual
sensors, Pago, Fusion Solar, …). The mapping lives in
`models.Area.extra_entities_json` and is managed via the Areas UI.

This module exposes a tiny, cached API that the entity catalog and the
Brain/voice routing use to enrich entities with their area or to look an
area up by free-text alias.
"""
from __future__ import annotations

import json
import threading
import time
import unicodedata
from typing import Optional

import core.database as database
import core.models as models


_CACHE: dict = {
    "built_at": 0.0,
    "version": 0,
    "entity_to_area": {},   # entity_id -> area name
    "area_by_key": {},      # normalized name/alias -> area dict
    "areas": [],            # list of dicts
}
_CACHE_TTL_SEC = 30.0
_LOCK = threading.Lock()


def _norm(text: str) -> str:
    """Lowercase + strip diacritics for tolerant matching."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return s.strip().lower()


def _build_cache() -> dict:
    entity_to_area: dict[str, str] = {}
    area_by_key: dict[str, dict] = {}
    areas_out: list[dict] = []

    gen = database.get_db()
    db = next(gen)
    try:
        rows = db.query(models.Area).order_by(models.Area.ordering.asc(), models.Area.name.asc()).all()
        for area in rows:
            try:
                extras = json.loads(area.extra_entities_json or "[]")
                if not isinstance(extras, list):
                    extras = []
            except (TypeError, ValueError):
                extras = []
            try:
                aliases = json.loads(area.aliases_json or "[]")
                if not isinstance(aliases, list):
                    aliases = []
            except (TypeError, ValueError):
                aliases = []
            entry = {
                "id": area.id,
                "name": area.name,
                "icon": area.icon,
                "color": area.color,
                "floor": area.floor,
                "aliases": aliases,
                "entities": list(extras),
            }
            areas_out.append(entry)
            for eid in extras:
                if isinstance(eid, str) and eid:
                    # First write wins, but later areas override only if eid not yet mapped.
                    entity_to_area.setdefault(eid, area.name)
            keys = [area.id, area.name, *aliases]
            for key in keys:
                nk = _norm(str(key))
                if nk:
                    area_by_key.setdefault(nk, entry)
    finally:
        try:
            gen.close()
        except Exception:
            pass

    return {
        "built_at": time.time(),
        "version": _CACHE.get("version", 0) + 1,
        "entity_to_area": entity_to_area,
        "area_by_key": area_by_key,
        "areas": areas_out,
    }


def _ensure_fresh() -> dict:
    now = time.time()
    if now - float(_CACHE.get("built_at") or 0.0) < _CACHE_TTL_SEC and _CACHE.get("areas"):
        return _CACHE
    with _LOCK:
        if now - float(_CACHE.get("built_at") or 0.0) < _CACHE_TTL_SEC and _CACHE.get("areas"):
            return _CACHE
        new_cache = _build_cache()
        _CACHE.update(new_cache)
        return _CACHE


def invalidate() -> None:
    """Force the next lookup to rebuild from DB. Call after any Area mutation."""
    with _LOCK:
        _CACHE["built_at"] = 0.0


def entity_area(entity_id: str) -> Optional[str]:
    """Return the Hyve area name for an entity, or None."""
    if not entity_id:
        return None
    return _ensure_fresh()["entity_to_area"].get(entity_id)


def entity_area_map() -> dict[str, str]:
    """Return a snapshot of entity_id → area name for bulk enrichment."""
    return dict(_ensure_fresh()["entity_to_area"])


def find_area(text: str) -> Optional[dict]:
    """Look up an area by id, name, or alias (diacritic/case-insensitive)."""
    if not text:
        return None
    return _ensure_fresh()["area_by_key"].get(_norm(text))


def list_areas() -> list[dict]:
    """Return a snapshot of all areas with members and aliases."""
    return list(_ensure_fresh()["areas"])
