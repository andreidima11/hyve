"""Areas — logical groupings of entities (rooms, zones, floors).

Areas keep room metadata (Hyve-only registry) and extend it with
groupings that can include non-HA entities (Pago, Fusion Solar, derived).
Each area can carry voice aliases used by the intent router.

Endpoints:
- GET    /api/areas                — list all areas
- POST   /api/areas                — create a custom area (admin only)
- POST   /api/areas/sync           — pull HA area_registry and upsert (admin only)
- PATCH  /api/areas/{area_id}      — update name/icon/aliases/extra entities
- DELETE /api/areas/{area_id}      — remove a custom area (admin only)
- GET    /api/areas/{area_id}/entities — entities currently mapped to this area
"""
from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import database
import models
import area_resolver

router = APIRouter(prefix="/api/areas", tags=["areas"])

_MAX_NAME = 80
_MAX_ALIASES = 16
_MAX_EXTRA_ENTITIES = 256


class AreaCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=_MAX_NAME)
    icon: str | None = Field(None, max_length=64)
    color: str | None = Field(None, max_length=32)
    floor: str | None = Field(None, max_length=64)
    aliases: list[str] = Field(default_factory=list)
    extra_entities: list[str] = Field(default_factory=list)
    ordering: int = 0


class AreaUpdateBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=_MAX_NAME)
    icon: str | None = Field(None, max_length=64)
    color: str | None = Field(None, max_length=32)
    floor: str | None = Field(None, max_length=64)
    aliases: list[str] | None = None
    extra_entities: list[str] | None = None
    ordering: int | None = None


def _slugify(name: str) -> str:
    norm = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", norm).strip("_").lower()
    return slug or "area"


def _unique_slug(db: Session, base: str) -> str:
    slug = base
    n = 2
    while db.query(models.Area).filter(models.Area.id == slug).first() is not None:
        slug = f"{base}_{n}"
        n += 1
    return slug


def _clean_aliases(values: list[str] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in values[:_MAX_ALIASES]:
        s = str(raw or "").strip()
        if not s or len(s) > 80:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def _clean_extra_entities(values: list[str] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in values[:_MAX_EXTRA_ENTITIES]:
        eid = str(raw or "").strip()
        if not eid or "." not in eid or len(eid) > 255:
            continue
        if eid in seen:
            continue
        seen.add(eid)
        out.append(eid)
    return out


def _serialize(area: models.Area) -> dict[str, Any]:
    try:
        aliases = json.loads(area.aliases_json or "[]")
    except (TypeError, ValueError):
        aliases = []
    try:
        extra = json.loads(area.extra_entities_json or "[]")
    except (TypeError, ValueError):
        extra = []
    return {
        "id": area.id,
        "name": area.name,
        "ha_area_id": area.ha_area_id,
        "icon": area.icon,
        "color": area.color,
        "floor": area.floor,
        "aliases": aliases if isinstance(aliases, list) else [],
        "extra_entities": extra if isinstance(extra, list) else [],
        "ordering": int(area.ordering or 0),
        "synced": bool(area.ha_area_id),
        "updated_at": area.updated_at.isoformat() if area.updated_at else None,
    }


def _require_admin(user: models.User) -> None:
    if not user.is_admin:
        raise HTTPException(403, "Admin only")


@router.get("")
async def list_areas(
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    rows = db.query(models.Area).order_by(
        models.Area.ordering.asc(), models.Area.name.asc()
    ).all()
    return {"areas": [_serialize(a) for a in rows]}


@router.post("", status_code=201)
async def create_area(
    body: AreaCreateBody,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    _require_admin(user)
    base = _slugify(body.name)
    area = models.Area(
        id=_unique_slug(db, base),
        name=body.name.strip(),
        ha_area_id=None,
        icon=body.icon,
        color=body.color,
        floor=body.floor,
        aliases_json=json.dumps(_clean_aliases(body.aliases), ensure_ascii=False),
        extra_entities_json=json.dumps(_clean_extra_entities(body.extra_entities), ensure_ascii=False),
        ordering=int(body.ordering or 0),
    )
    db.add(area)
    db.commit()
    db.refresh(area)
    area_resolver.invalidate()
    return _serialize(area)


@router.patch("/{area_id}")
async def update_area(
    area_id: str,
    body: AreaUpdateBody,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    _require_admin(user)
    area = db.query(models.Area).filter(models.Area.id == area_id).first()
    if not area:
        raise HTTPException(404, "Area not found")
    if body.name is not None:
        area.name = body.name.strip()
    if body.icon is not None:
        area.icon = body.icon or None
    if body.color is not None:
        area.color = body.color or None
    if body.floor is not None:
        area.floor = body.floor or None
    if body.aliases is not None:
        area.aliases_json = json.dumps(_clean_aliases(body.aliases), ensure_ascii=False)
    if body.extra_entities is not None:
        area.extra_entities_json = json.dumps(_clean_extra_entities(body.extra_entities), ensure_ascii=False)
    if body.ordering is not None:
        area.ordering = int(body.ordering)
    db.commit()
    db.refresh(area)
    area_resolver.invalidate()
    return _serialize(area)


@router.delete("/{area_id}", status_code=204)
async def delete_area(
    area_id: str,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    _require_admin(user)
    area = db.query(models.Area).filter(models.Area.id == area_id).first()
    if not area:
        raise HTTPException(404, "Area not found")
    db.delete(area)
    db.commit()
    area_resolver.invalidate()
    return None


@router.post("/sync")
async def sync_from_ha(
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """Legacy endpoint: external area import has been removed.

    Areas are now entirely Hyve-managed; create them manually from the UI
    and assign Z2M/Pago/derived entities through the area editor.
    """
    _require_admin(user)
    raise HTTPException(status_code=410, detail="Importul extern a fost eliminat. Adăugaţi camerele manual.")


@router.get("/{area_id}/entities")
async def area_entities(
    area_id: str,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """Resolve entities currently associated with this area."""
    area = db.query(models.Area).filter(models.Area.id == area_id).first()
    if not area:
        raise HTTPException(404, "Area not found")

    try:
        extras = json.loads(area.extra_entities_json or "[]")
        if not isinstance(extras, list):
            extras = []
    except (TypeError, ValueError):
        extras = []

    out = _serialize(area)
    out["entities"] = sorted({eid for eid in extras if isinstance(eid, str) and eid})
    return out
