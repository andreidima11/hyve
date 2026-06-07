"""AristonNET integration router."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

import ariston_net_client
import settings as settings_mod
from auth import get_current_user

log = logging.getLogger("ariston_net")

router = APIRouter(prefix="/api/ariston-net", tags=["ariston-net"])


def _is_configured(cfg: dict) -> bool:
    return bool((cfg.get("username") or "").strip() and (cfg.get("password") or "").strip())


def _friendly_error(exc: Exception) -> str:
    message = str(exc or "").strip()
    if isinstance(exc, ariston_net_client.AristonNetDependencyError):
        return message
    if "401" in message or "auth" in message.lower() or "autentific" in message.lower():
        return "Datele de autentificare AristonNET nu au fost acceptate."
    return message or "Conexiune AristonNET eșuată"


@router.get("/status")
async def ariston_net_status(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("ariston_net") or {}
    if not _is_configured(cfg):
        return {"ok": False, "message": "Username și parolă AristonNET sunt obligatorii"}
    client = await ariston_net_client.ensure_client(allow_disabled=True)
    if not client:
        return {"ok": False, "message": "AristonNET nu este configurat"}
    try:
        result = await client.test_connection()
        if result.get("ok") and not cfg.get("enabled"):
            result["message"] = f"{result.get('message') or 'Conectat'} — integrarea este salvată, dar încă inactivă."
        return result
    except Exception as exc:
        log.error("AristonNET connection test failed: %s", exc)
        return {"ok": False, "message": _friendly_error(exc)}


@router.get("/devices")
async def ariston_net_devices(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("ariston_net") or {}
    if not _is_configured(cfg):
        return {"ok": False, "message": "Username și parolă AristonNET sunt obligatorii", "devices": []}
    client = await ariston_net_client.ensure_client(allow_disabled=True)
    if not client:
        return {"ok": False, "message": "AristonNET nu este configurat", "devices": []}
    try:
        devices = await client.discover_devices()
        return {"ok": True, "devices": devices}
    except Exception as exc:
        log.error("AristonNET device discovery failed: %s", exc)
        return {"ok": False, "message": _friendly_error(exc), "devices": []}


@router.get("/data")
async def ariston_net_data(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("ariston_net") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "AristonNET integration is disabled"}
    client = await ariston_net_client.ensure_client()
    if not client:
        return {"ok": False, "message": "AristonNET not configured"}
    try:
        data = await client.fetch_all()
        return {"ok": True, "data": data}
    except Exception as exc:
        log.error("AristonNET data fetch failed: %s", exc)
        return {"ok": False, "message": _friendly_error(exc)}


@router.post("/refresh")
async def ariston_net_refresh(user=Depends(get_current_user)):
    cfg = settings_mod.CFG.get("ariston_net") or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": "AristonNET integration is disabled"}
    client = await ariston_net_client.ensure_client()
    if not client:
        return {"ok": False, "message": "AristonNET not configured"}
    try:
        client.clear_cache()
        data = await client.fetch_all(force=True)
        return {"ok": True, "data": data}
    except Exception as exc:
        log.error("AristonNET refresh failed: %s", exc)
        return {"ok": False, "message": _friendly_error(exc)}
