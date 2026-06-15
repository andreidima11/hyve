"""Mammotion Agora WebRTC camera stream API (capability router)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

import core.models as models
from components.mammotion.camera_stream import (
    is_mammotion_webrtc_camera,
    keepalive_mammotion_camera,
    mammotion_hub_for_camera_entity,
    refresh_mammotion_stream_tokens,
    start_mammotion_camera,
    stop_mammotion_camera,
)
from core.cameras.entity_lookup import camera_entity
from core.cameras.stream_auth import get_camera_user
from core.http.errors import error_detail

router = APIRouter(prefix="/api/cameras", tags=["cameras", "mammotion"])
log = logging.getLogger("mammotion.camera.router")


@router.post("/{entity_id}/mammotion/start")
async def mammotion_camera_start(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    if not is_mammotion_webrtc_camera(ent):
        raise HTTPException(400, error_detail("cameras.mammotion_not_webrtc"))
    try:
        hub, device_name = await mammotion_hub_for_camera_entity(ent)
        tokens = await start_mammotion_camera(hub, device_name)
        return {"ok": True, "entity_id": entity_id, "tokens": tokens}
    except ValueError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except RuntimeError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except Exception as exc:
        log.warning("mammotion camera start %s failed: %s", entity_id, exc, exc_info=True)
        raise HTTPException(502, error_detail("cameras.mammotion_start_failed", {"error": str(exc)})) from exc


@router.get("/{entity_id}/mammotion/tokens")
async def mammotion_camera_tokens(
    entity_id: str,
    force: bool = True,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    if not is_mammotion_webrtc_camera(ent):
        raise HTTPException(400, error_detail("cameras.mammotion_not_webrtc"))
    try:
        hub, device_name = await mammotion_hub_for_camera_entity(ent)
        tokens = await refresh_mammotion_stream_tokens(hub, device_name, force=force)
        return {"ok": True, "entity_id": entity_id, "tokens": tokens}
    except ValueError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except RuntimeError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except Exception as exc:
        log.warning("mammotion camera tokens %s failed: %s", entity_id, exc, exc_info=True)
        raise HTTPException(502, error_detail("cameras.mammotion_token_failed", {"error": str(exc)})) from exc


@router.post("/{entity_id}/mammotion/keepalive")
async def mammotion_camera_keepalive(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    if not is_mammotion_webrtc_camera(ent):
        raise HTTPException(400, error_detail("cameras.mammotion_not_webrtc"))
    try:
        hub, device_name = await mammotion_hub_for_camera_entity(ent)
        tokens = await keepalive_mammotion_camera(hub, device_name)
        return {"ok": True, "entity_id": entity_id, "tokens": tokens}
    except ValueError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except RuntimeError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except Exception as exc:
        log.warning("mammotion camera keepalive %s failed: %s", entity_id, exc, exc_info=True)
        raise HTTPException(502, error_detail("cameras.mammotion_keepalive_failed", {"error": str(exc)})) from exc


@router.post("/{entity_id}/mammotion/stop")
async def mammotion_camera_stop(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    if not is_mammotion_webrtc_camera(ent):
        raise HTTPException(400, error_detail("cameras.mammotion_not_webrtc"))
    try:
        hub, device_name = await mammotion_hub_for_camera_entity(ent)
        await stop_mammotion_camera(hub, device_name)
        return {"ok": True, "entity_id": entity_id}
    except ValueError as exc:
        raise HTTPException(400, error_detail("common.error_with_message", {"message": str(exc)})) from exc
    except Exception as exc:
        log.warning("mammotion camera stop %s failed: %s", entity_id, exc)
        raise HTTPException(502, error_detail("cameras.mammotion_stop_failed", {"error": str(exc)})) from exc
