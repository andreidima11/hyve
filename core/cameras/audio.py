"""Camera audio settings and two-way talk upload."""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile

from components.frigate import camera_proxy as frigate_cam
from components.reolink import camera_proxy as reolink_cam
from components.tapo import camera_proxy as tapo_cam
from core.cameras.schemas import CameraAudioBody
from core.cameras.shared import entity_source
from core.http.errors import error_detail

log = logging.getLogger("cameras.audio")


async def apply_camera_audio_settings(ent: dict[str, Any], body: CameraAudioBody) -> dict[str, Any]:
    entity_id = str(ent.get("entity_id") or "")
    attrs = dict(ent.get("attributes") or {})
    source = entity_source(ent)
    try:
        if source == "tapo":
            _integration, target = await tapo_cam.device_for_entity(ent)
            await tapo_cam.apply_audio(target, body)
        elif source == "reolink":
            await reolink_cam.apply_audio(ent, attrs, body)
        else:
            raise HTTPException(400, error_detail("cameras.audio_not_supported"))
        return {"ok": True, "entity_id": entity_id, "action": body.action}
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("camera audio %s failed: %s", entity_id, exc)
        raise HTTPException(502, error_detail("cameras.audio_settings_failed", {"error": str(exc)})) from exc


async def apply_camera_talk_push(ent: dict[str, Any], audio: UploadFile) -> dict[str, Any]:
    entity_id = str(ent.get("entity_id") or "")
    attrs = dict(ent.get("attributes") or {})
    source = entity_source(ent)
    stream_name = str(attrs.get("go2rtc_stream") or "").strip()
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"
    data = await audio.read()
    if not data:
        raise HTTPException(400, error_detail("cameras.audio_file_empty"))
    tmp_path: Path | None = None
    try:
        if frigate_cam.matches_entity(ent) and stream_name:
            inst = frigate_cam.instance_for(ent)
            if not inst:
                raise HTTPException(404, error_detail("cameras.frigate_unavailable"))
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(data)
                tmp_path = Path(tmp.name)
            await frigate_cam.go2rtc_play_file(inst, stream_name, tmp_path)
            return {"ok": True, "method": "go2rtc", "entity_id": entity_id}
        if source == "tapo" and attrs.get("two_way_audio"):
            raise HTTPException(501, error_detail("cameras.tapo_talk_not_available"))
        if source == "reolink" and attrs.get("two_way_audio"):
            raise HTTPException(501, error_detail("cameras.reolink_talk_not_available"))
        raise HTTPException(400, error_detail("cameras.audio_play_not_supported"))
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("camera talk %s failed: %s", entity_id, exc)
        raise HTTPException(502, error_detail("cameras.audio_play_failed", {"error": str(exc)})) from exc
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass
