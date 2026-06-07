"""Hyve user scenes → virtual scene.* entities."""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any

import database
import models

log = logging.getLogger("integrations.scenes")


def scene_slug(name: str, fallback: str) -> str:
    text = (name or "").strip()
    if not text:
        return fallback
    norm = unicodedata.normalize("NFKD", text)
    norm = norm.encode("ascii", "ignore").decode("ascii")
    norm = re.sub(r"[^a-zA-Z0-9]+", "_", norm).strip("_").lower()
    return norm or fallback


def load_hyve_scene_entities(source_slug: str = "hyve_scenes") -> list[dict[str, Any]]:
    """Read enabled scenes from SQLite and return entity dicts."""
    out: list[dict[str, Any]] = []
    gen = database.get_db()
    db = next(gen)
    try:
        scenes = (
            db.query(models.Scene)
            .filter(models.Scene.enabled.is_(True))
            .order_by(models.Scene.name.asc())
            .all()
        )
        for scene in scenes:
            try:
                entries = json.loads(scene.entries_json or "[]")
                if not isinstance(entries, list):
                    entries = []
            except (TypeError, ValueError):
                entries = []
            last_activated = (
                scene.last_activated_at.isoformat()
                if scene.last_activated_at else None
            )
            slug = scene_slug(scene.name, scene.id)
            base_slug = slug
            bump = 2
            while any(o["attributes"].get("_slug") == slug for o in out):
                slug = f"{base_slug}_{bump}"
                bump += 1
            out.append({
                "entity_id": f"scene.{slug}",
                "name": scene.name or scene.id,
                "friendly_name": scene.name or scene.id,
                "state": last_activated or "scening",
                "domain": "scene",
                "source": source_slug,
                "controllable": True,
                "icon": scene.icon or "fas fa-film",
                "color": scene.color or None,
                "attributes": {
                    "scene_id": scene.id,
                    "_slug": slug,
                    "description": scene.description or "",
                    "entry_count": len(entries),
                    "activation_count": int(scene.activation_count or 0),
                    "last_activated_at": last_activated,
                    "is_shared": bool(scene.is_shared),
                },
            })
    except Exception as exc:
        log.warning("load_hyve_scene_entities failed: %s", exc)
    finally:
        try:
            gen.close()
        except Exception:
            pass
    return out
