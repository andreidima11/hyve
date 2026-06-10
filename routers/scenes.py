"""Scenes — named multi-entity state snapshots that can be activated on demand.

A Scene is a list of action entries; activating the scene dispatches each entry
as a service call. Designed as the first-class scene primitive
primitive for "movie mode", "bedtime", "wake up", etc.

Each entry has shape:
    {"entity_id": str, "service": "turn_on"|"turn_off"|"toggle", "service_data": {...}?}

The service is auto-derived from `entity_id` domain when omitted (turn_on by
default for controllable domains).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

import auth
import database
import models
from smart_home_registry import entity_domain, is_controllable_domain

router = APIRouter(prefix="/api/scenes", tags=["scenes"])


_ALLOWED_SERVICES = {"turn_on", "turn_off", "toggle"}
_MAX_ENTRIES = 64


def _invalidate_device_list_cache() -> None:
    try:
        from routers.dashboard.entities import invalidate_scene_synthetic_cache

        invalidate_scene_synthetic_cache()
    except Exception:
        pass
_MAX_NAME_LEN = 120
_MAX_DESC_LEN = 500


class SceneEntryBody(BaseModel):
    entity_id: str = Field(..., min_length=3, max_length=255)
    service: Literal["turn_on", "turn_off", "toggle"] | None = None
    service_data: dict[str, Any] | None = None


class SceneCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=_MAX_NAME_LEN)
    description: str | None = Field(None, max_length=_MAX_DESC_LEN)
    icon: str | None = Field(None, max_length=64)
    color: str | None = Field(None, max_length=32)
    is_shared: bool = False
    enabled: bool = True
    entries: list[SceneEntryBody] = Field(default_factory=list)


class SceneUpdateBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=_MAX_NAME_LEN)
    description: str | None = Field(None, max_length=_MAX_DESC_LEN)
    icon: str | None = Field(None, max_length=64)
    color: str | None = Field(None, max_length=32)
    is_shared: bool | None = None
    enabled: bool | None = None
    entries: list[SceneEntryBody] | None = None


def _normalize_entries(entries: list[SceneEntryBody]) -> list[dict[str, Any]]:
    if len(entries) > _MAX_ENTRIES:
        raise HTTPException(400, f"Too many entries (max {_MAX_ENTRIES})")
    out: list[dict[str, Any]] = []
    for raw in entries:
        eid = raw.entity_id.strip()
        if "." not in eid:
            raise HTTPException(400, f"Invalid entity_id '{eid}'")
        domain = entity_domain(eid)
        service = raw.service
        if service is None:
            service = "turn_on" if is_controllable_domain(domain) else "turn_on"
        if service not in _ALLOWED_SERVICES:
            raise HTTPException(400, f"Unsupported service '{service}'")
        item: dict[str, Any] = {"entity_id": eid, "service": service}
        if raw.service_data and isinstance(raw.service_data, dict):
            item["service_data"] = raw.service_data
        out.append(item)
    return out


def _serialize(scene: models.Scene) -> dict[str, Any]:
    try:
        entries = json.loads(scene.entries_json or "[]")
    except (TypeError, ValueError):
        entries = []
    return {
        "id": scene.id,
        "owner_id": scene.owner_id,
        "name": scene.name,
        "description": scene.description,
        "icon": scene.icon,
        "color": scene.color,
        "is_shared": bool(scene.is_shared),
        "enabled": bool(scene.enabled),
        "entries": entries,
        "entry_count": len(entries),
        "last_activated_at": scene.last_activated_at.isoformat() if scene.last_activated_at else None,
        "activation_count": int(scene.activation_count or 0),
        "created_at": scene.created_at.isoformat() if scene.created_at else None,
        "updated_at": scene.updated_at.isoformat() if scene.updated_at else None,
    }


def _query_visible(db: Session, user: models.User):
    return db.query(models.Scene).filter(
        or_(models.Scene.owner_id == user.id, models.Scene.is_shared.is_(True))
    )


def _load_owned(db: Session, scene_id: str, user: models.User) -> models.Scene:
    scene = db.query(models.Scene).filter(models.Scene.id == scene_id).first()
    if not scene:
        raise HTTPException(404, "Scene not found")
    if scene.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Not allowed")
    return scene


def _load_visible(db: Session, scene_id: str, user: models.User) -> models.Scene:
    scene = db.query(models.Scene).filter(models.Scene.id == scene_id).first()
    if not scene:
        raise HTTPException(404, "Scene not found")
    if scene.owner_id != user.id and not scene.is_shared and not user.is_admin:
        raise HTTPException(403, "Not allowed")
    return scene


@router.get("")
async def list_scenes(
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    rows = _query_visible(db, user).order_by(models.Scene.updated_at.desc()).all()
    return {"scenes": [_serialize(row) for row in rows]}


@router.post("", status_code=201)
async def create_scene(
    body: SceneCreateBody,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    entries = _normalize_entries(body.entries)
    scene = models.Scene(
        id=uuid.uuid4().hex,
        owner_id=user.id,
        name=body.name.strip(),
        description=(body.description or "").strip() or None,
        icon=body.icon,
        color=body.color,
        is_shared=bool(body.is_shared) if user.is_admin else False,
        enabled=bool(body.enabled),
        entries_json=json.dumps(entries, ensure_ascii=False),
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    _invalidate_device_list_cache()
    return _serialize(scene)


@router.get("/{scene_id}")
async def get_scene(
    scene_id: str,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    return _serialize(_load_visible(db, scene_id, user))


@router.put("/{scene_id}")
async def update_scene(
    scene_id: str,
    body: SceneUpdateBody,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    scene = _load_owned(db, scene_id, user)
    if body.name is not None:
        scene.name = body.name.strip()
    if body.description is not None:
        scene.description = body.description.strip() or None
    if body.icon is not None:
        scene.icon = body.icon or None
    if body.color is not None:
        scene.color = body.color or None
    if body.is_shared is not None and user.is_admin:
        scene.is_shared = bool(body.is_shared)
    if body.enabled is not None:
        scene.enabled = bool(body.enabled)
    if body.entries is not None:
        scene.entries_json = json.dumps(_normalize_entries(body.entries), ensure_ascii=False)
    db.commit()
    db.refresh(scene)
    _invalidate_device_list_cache()
    return _serialize(scene)


@router.delete("/{scene_id}", status_code=204)
async def delete_scene(
    scene_id: str,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    scene = _load_owned(db, scene_id, user)
    db.delete(scene)
    db.commit()
    _invalidate_device_list_cache()
    return None


@router.post("/{scene_id}/activate")
async def activate_scene(
    scene_id: str,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    scene = _load_visible(db, scene_id, user)
    return await activate_scene_internal(db, scene)


async def activate_scene_internal(db: Session, scene: models.Scene) -> dict[str, Any]:
    """Reusable scene activation core (callable from other routers, e.g. dashboard)."""
    if not scene.enabled:
        raise HTTPException(409, "Scene is disabled")

    try:
        entries = json.loads(scene.entries_json or "[]")
    except (TypeError, ValueError):
        entries = []
    if not isinstance(entries, list) or not entries:
        raise HTTPException(409, "Scene has no entries to activate")

    results: list[dict[str, Any]] = []
    success = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        eid = str(entry.get("entity_id") or "").strip()
        if "." not in eid:
            results.append({"entity_id": eid, "ok": False, "error": "invalid_entity_id"})
            continue
        domain = entity_domain(eid)
        service = str(entry.get("service") or "turn_on").strip().lower()
        if service not in _ALLOWED_SERVICES:
            results.append({"entity_id": eid, "ok": False, "error": "invalid_service"})
            continue
        service_data = entry.get("service_data")
        if service_data is not None and not isinstance(service_data, dict):
            service_data = None
        try:
            from core.device_control import ControlTargetNotFound, control_entity
            from integrations import get_integration_manager

            try:
                result = await control_entity(eid, service, service_data)
                res = {"ok": True, "result": result}
            except ControlTargetNotFound:
                integration = None
                manager = get_integration_manager()
                for inst in manager.all_instances():
                    if hasattr(inst, "control_entity"):
                        integration = inst
                        break
                if not integration:
                    res = {"ok": False, "error": "no_integration_found"}
                else:
                    result = await integration.control_entity(
                        eid, service, service_data or {}
                    )
                    res = {"ok": True, "result": result}
        except Exception as exc:  # noqa: BLE001 — surface error per entry
            results.append({"entity_id": eid, "ok": False, "error": str(exc)[:200]})
            continue
        ok = bool(res.get("ok"))
        if ok:
            success += 1
        results.append({"entity_id": eid, "ok": ok, "error": None if ok else res.get("error")})

    scene.last_activated_at = datetime.now()
    scene.activation_count = int(scene.activation_count or 0) + 1
    db.commit()
    db.refresh(scene)

    return {
        "scene": _serialize(scene),
        "total": len(results),
        "succeeded": success,
        "failed": len(results) - success,
        "results": results,
    }
