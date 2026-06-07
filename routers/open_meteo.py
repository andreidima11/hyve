"""Open Meteo integration router."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

import settings as settings_mod
from auth import get_current_user
from open_meteo_client import ensure_client, fetch_all_locations

log = logging.getLogger("open_meteo")

router = APIRouter(prefix="/api/open-meteo", tags=["open-meteo"])


def _is_configured(cfg: dict) -> bool:
    locations = cfg.get("locations")
    if isinstance(locations, list) and any(isinstance(item, dict) and (str(item.get("location") or "").strip() or (item.get("latitude") not in (None, "") and item.get("longitude") not in (None, ""))) for item in locations):
        return True
    location = str(cfg.get("location") or "").strip()
    latitude = cfg.get("latitude")
    longitude = cfg.get("longitude")
    return bool(location or (latitude not in (None, "") and longitude not in (None, "")))


@router.get("/status")
async def open_meteo_status(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("open_meteo") or {}
    if not _is_configured(cfg):
        return {"ok": False, "message": "Location, or latitude and longitude, must be configured"}
    client = await ensure_client()
    if not client:
        return {"ok": False, "message": "Open Meteo is not configured"}
    result = await client.test_connection()
    if result.get("ok") and not cfg.get("enabled"):
        result["message"] = f"{result.get('message') or 'Connected'} — integration is saved, but still inactive."
    return result


@router.get("/data")
async def open_meteo_data(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("open_meteo") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Open Meteo integration is disabled"}
    client = await ensure_client()
    if not client:
        return {"ok": False, "message": "Open Meteo is not configured"}
    try:
        data = await fetch_all_locations()
        return {"ok": True, "data": data}
    except Exception as exc:
        log.error("Open Meteo data fetch failed: %s", exc)
        return {"ok": False, "message": str(exc)}


@router.post("/refresh")
async def open_meteo_refresh(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("open_meteo") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Open Meteo integration is disabled"}
    client = await ensure_client()
    if not client:
        return {"ok": False, "message": "Open Meteo is not configured"}
    try:
        client.clear_cache()
        data = await fetch_all_locations(force=True)
        return {"ok": True, "data": data}
    except Exception as exc:
        log.error("Open Meteo refresh failed: %s", exc)
        return {"ok": False, "message": str(exc)}


@router.get("/entities")
async def open_meteo_entities(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("open_meteo") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Open Meteo integration is disabled"}
    client = await ensure_client()
    if not client:
        return {"ok": False, "message": "Open Meteo is not configured"}
    data = await fetch_all_locations()
    return {"entities": data}