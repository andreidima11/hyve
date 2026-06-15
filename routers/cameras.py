"""Camera proxy router — snapshot/MJPEG/WebM for ``camera.*`` entities."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Request, UploadFile

import core.auth as auth
import core.models as models
from core.cameras.attrs import hydrate_stream_attrs
from core.cameras.audio import apply_camera_audio_settings, apply_camera_talk_push
from core.cameras.capabilities import camera_capabilities_payload
from core.cameras.entity_lookup import camera_entity, image_entity
from core.cameras.schemas import CameraAudioBody
from core.cameras.snapshot import camera_snapshot_response, image_snapshot_response
from core.cameras.stream_auth import get_camera_user
from core.cameras.streaming import camera_mjpeg_stream_response, camera_webm_stream_response
from core.http.limiter import limiter

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


@router.post("/stream-token")
@limiter.limit("60/minute")
async def issue_camera_stream_token(
    request: Request,
    user: models.User = Depends(auth.get_current_user),
):
    token = auth.create_camera_stream_token(user.username)
    return {
        "token": token,
        "expires_in": auth.CAMERA_STREAM_TOKEN_EXPIRE_SECONDS,
    }


@router.get("/{entity_id}/snapshot")
async def camera_snapshot(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    return await camera_snapshot_response(ent)


@router.get("/{entity_id}/image")
async def image_snapshot(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await image_entity(entity_id)
    return await image_snapshot_response(ent)


@router.get("/{entity_id}/stream")
async def camera_stream(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    return await camera_mjpeg_stream_response(ent)


@router.get("/{entity_id}/play")
async def camera_play(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    return await camera_webm_stream_response(ent)


@router.get("/{entity_id}/capabilities")
async def camera_capabilities(
    entity_id: str,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    attrs = hydrate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    return camera_capabilities_payload(ent, attrs)


@router.post("/{entity_id}/audio")
async def camera_audio_settings(
    entity_id: str,
    body: CameraAudioBody,
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    return await apply_camera_audio_settings(ent, body)


@router.post("/{entity_id}/talk")
async def camera_talk_push(
    entity_id: str,
    audio: Annotated[UploadFile, File()],
    user: models.User = Depends(get_camera_user),
):
    ent = await camera_entity(entity_id)
    return await apply_camera_talk_push(ent, audio)
