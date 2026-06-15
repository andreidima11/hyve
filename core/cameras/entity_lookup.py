"""Resolve ``camera.*`` entities from the unified registry."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

log = logging.getLogger("cameras.lookup")


def camera_object_id(entity_id: str) -> str:
    """Return the slug after ``camera.`` (or domain prefix)."""
    eid = str(entity_id or "").strip().lower()
    if eid.startswith("camera."):
        return eid[7:]
    if "." in eid:
        return eid.split(".", 1)[1]
    return eid


def _camera_alias_set(ent: dict[str, Any]) -> set[str]:
    out: set[str] = set()
    for raw in ent.get("aliases") or []:
        text = str(raw or "").strip().lower()
        if text:
            out.add(text)
            out.add(camera_object_id(text))
    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    for raw in attrs.get("aliases") or []:
        text = str(raw or "").strip().lower()
        if text:
            out.add(text)
            out.add(camera_object_id(text))
    frigate_cam = str(attrs.get("frigate_camera") or "").strip().lower()
    if frigate_cam:
        out.add(frigate_cam)
        try:
            from integrations.entity_utils import slugify

            out.add(slugify(frigate_cam))
        except Exception:
            pass
    return out


def camera_entity_matches(ent: dict[str, Any], needle: str, needle_lower: str) -> bool:
    eid = str(ent.get("entity_id") or "").strip()
    if not eid:
        return False
    uid = str(ent.get("unique_id") or "").strip()
    eid_lower = eid.lower()
    if eid == needle or eid_lower == needle_lower:
        return True
    if uid and uid.lower() == needle_lower:
        return True
    needle_obj = camera_object_id(needle)
    if camera_object_id(eid) == needle_obj:
        return True
    if needle_obj and needle_obj in _camera_alias_set(ent):
        return True
    if needle_lower in _camera_alias_set(ent):
        return True
    return False


async def camera_entity(entity_id: str) -> dict[str, Any]:
    """Find a camera entity in the unified registry."""
    from core.entity_catalog import get_entities
    from core.http.errors import error_detail

    needle = (entity_id or "").strip()
    if not needle:
        raise HTTPException(404, error_detail("cameras.not_found", {"entity_id": entity_id}))
    needle_lower = needle.lower()

    for ent in await get_entities():
        eid = str(ent.get("entity_id") or "").strip()
        if not eid:
            continue
        domain = str(ent.get("domain") or "").strip().lower()
        is_camera = domain == "camera" or eid.lower().startswith("camera.")
        if not is_camera:
            continue
        if camera_entity_matches(ent, needle, needle_lower):
            return dict(ent)
    log.warning("camera entity lookup missed %r (not in unified registry)", entity_id)
    raise HTTPException(404, error_detail("cameras.not_found", {"entity_id": entity_id}))


async def image_entity(entity_id: str) -> dict[str, Any]:
    """Find an ``image.*`` entity in the unified registry."""
    from routers.integrations import _all_entities

    from core.http.errors import error_detail

    for ent in await _all_entities():
        if ent.get("entity_id") == entity_id and (
            ent.get("domain") == "image" or str(entity_id).startswith("image.")
        ):
            return dict(ent)
    raise HTTPException(404, error_detail("cameras.image_not_found", {"entity_id": entity_id}))
