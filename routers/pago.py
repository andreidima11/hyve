"""Pago Plătește integration router.

Provides:
 - GET  /api/pago/status   – test connection to pago.cloud
 - GET  /api/pago/data     – return cached data (all categories)
 - POST /api/pago/refresh  – force cache refresh and return fresh data
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import settings as settings_mod
from auth import get_current_user
import pago_client

log = logging.getLogger("pago")

router = APIRouter(prefix="/api/pago", tags=["pago"])


class PagoStatusResponse(BaseModel):
    ok: bool
    message: str = ""


@router.get("/status")
async def pago_status(user=Depends(get_current_user)):
    """Test connection to Pago (authenticate and return status)."""
    cfg = settings_mod.CFG.get("pago") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Pago integration is disabled"}
    email = cfg.get("email", "").strip()
    password = cfg.get("password", "").strip()
    if not email or not password:
        return {"ok": False, "message": "Email or password not configured"}
    client = await pago_client.ensure_client()
    if not client:
        return {"ok": False, "message": "Could not initialize Pago client"}
    return await client.test_connection()


@router.get("/data")
async def pago_data(user=Depends(get_current_user)):
    """Return all cached Pago data (bills, vehicles, cards, payments, profile)."""
    cfg = settings_mod.CFG.get("pago") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Pago integration is disabled"}
    client = await pago_client.ensure_client()
    if not client:
        return {"ok": False, "message": "Pago not configured (email/password missing)"}
    try:
        data = await client.fetch_all()
        return {"ok": True, "data": data}
    except Exception as e:
        log.error("Pago data fetch failed: %s", e)
        return {"ok": False, "message": str(e)}


@router.post("/refresh")
async def pago_refresh(user=Depends(get_current_user)):
    """Force-refresh all Pago data (clear cache first)."""
    cfg = settings_mod.CFG.get("pago") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "Pago integration is disabled"}
    client = await pago_client.ensure_client()
    if not client:
        return {"ok": False, "message": "Pago not configured (email/password missing)"}
    try:
        client.clear_cache()
        data = await client.fetch_all()
        return {"ok": True, "data": data}
    except Exception as e:
        log.error("Pago refresh failed: %s", e)
        return {"ok": False, "message": str(e)}
