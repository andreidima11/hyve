"""Camera proxy router — fetches snapshot/MJPEG bytes for ``camera.*`` entities
through Hyve so the browser doesn't need direct access to Frigate (or any
other camera backend) and we can centralise auth.

Endpoints:
  GET /api/cameras/{entity_id}/snapshot  → JPEG (single frame)
  GET /api/cameras/{entity_id}/stream    → MJPEG (multipart) live stream
  GET /api/cameras/{entity_id}/play      → WebM live stream (video + audio when available)
"""

from __future__ import annotations

import asyncio
import ssl
import logging
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import websockets
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile, WebSocket, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import core.auth as auth
import core.database as database
import core.models as models

router = APIRouter(prefix="/api/cameras", tags=["cameras"])
log = logging.getLogger("cameras")

# Hard-bounded timeouts so a dead camera can never hold a worker (or DB session)
# longer than ~6 s. Previously read=None allowed Frigate to wedge the proxy for
# 75-114 s, exhausting the SQLAlchemy pool and freezing /api/integrations/*.
_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=3.0, pool=3.0)
_SNAPSHOT_DEADLINE = 6.0
_RTSP_SNAPSHOT_DEADLINE = 14.0
_STREAM_CONNECT_DEADLINE = 6.0


def _decode_camera_auth_token(raw_token: str) -> dict | None:
    """Accept short-lived camera_stream tokens or normal access JWTs."""
    if not raw_token:
        return None
    payload = auth.verify_camera_stream_token(raw_token)
    if payload:
        return payload
    payload = auth.verify_token(raw_token)
    if not payload or not payload.get("sub"):
        return None
    tok_type = payload.get("type")
    if tok_type in ("refresh", "sse_exchange"):
        return None
    return payload


def _user_from_payload(payload: dict) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    db = next(database.get_db())
    try:
        jti = payload.get("jti")
        if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
            raise credentials_exception
        user = db.query(models.User).filter(models.User.username == payload.get("sub")).first()
        if user is None:
            raise credentials_exception
        return user
    finally:
        db.close()


async def _get_camera_user(
    token: str | None = Query(None),
    authorization: str | None = Header(None),
) -> models.User:
    """Authenticate the request *without* holding a DB session for the whole
    response lifetime — camera proxy responses can stream for minutes and we
    can't afford to keep one of the 15 pool slots locked that long.
    """
    raw_token = (token or "").strip()
    if not raw_token and authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer":
            raw_token = value.strip()
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not raw_token:
        raise credentials_exception
    payload = _decode_camera_auth_token(raw_token)
    if not payload:
        raise credentials_exception
    return _user_from_payload(payload)


@router.post("/stream-token")
async def issue_camera_stream_token(user: models.User = Depends(auth.get_current_user)):
    """Return a short-lived token for ``<img>/<video>`` camera URLs."""
    token = auth.create_camera_stream_token(user.username)
    return {
        "token": token,
        "expires_in": auth.CAMERA_STREAM_TOKEN_EXPIRE_SECONDS,
    }


async def _authenticate_ws(token: str | None) -> models.User | None:
    raw_token = (token or "").strip()
    if not raw_token:
        return None
    try:
        payload = _decode_camera_auth_token(raw_token)
        if not payload:
            return None
        return _user_from_payload(payload)
    except HTTPException:
        return None
    except Exception:
        return None


def _camera_object_id(entity_id: str) -> str:
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
            out.add(_camera_object_id(text))
    attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
    for raw in attrs.get("aliases") or []:
        text = str(raw or "").strip().lower()
        if text:
            out.add(text)
            out.add(_camera_object_id(text))
    frigate_cam = str(attrs.get("frigate_camera") or "").strip().lower()
    if frigate_cam:
        out.add(frigate_cam)
        try:
            from integrations.entity_utils import slugify
            out.add(slugify(frigate_cam))
        except Exception:
            pass
    return out


def _camera_entity_matches(ent: dict[str, Any], needle: str, needle_lower: str) -> bool:
    eid = str(ent.get("entity_id") or "").strip()
    if not eid:
        return False
    uid = str(ent.get("unique_id") or "").strip()
    eid_lower = eid.lower()
    if eid == needle or eid_lower == needle_lower:
        return True
    if uid and uid.lower() == needle_lower:
        return True
    needle_obj = _camera_object_id(needle)
    if _camera_object_id(eid) == needle_obj:
        return True
    if needle_obj and needle_obj in _camera_alias_set(ent):
        return True
    if needle_lower in _camera_alias_set(ent):
        return True
    return False


def _hydrate_frigate_stream_attrs(ent: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    """Rebuild Frigate stream URLs when attributes were stripped or stale."""
    if _http_stream_url(attrs) or _resolve_rtsp_url(attrs):
        return attrs
    if not _is_frigate_entity(ent):
        return attrs
    cam = str(attrs.get("frigate_camera") or "").strip()
    if not cam:
        return attrs
    inst = _frigate_instance_for(ent)
    if not inst:
        return attrs
    try:
        base = inst._base_url().rstrip("/")
        host = str(getattr(inst, "entry_data", {}).get("host") or "127.0.0.1").strip()
        rtsp_port = int(getattr(inst, "entry_data", {}).get("rtsp_port") or 8554)
    except Exception:
        return attrs
    live_stream = str(attrs.get("frigate_live_stream") or cam).strip() or cam
    merged = dict(attrs)
    merged.setdefault("snapshot_url", f"{base}/api/{cam}/latest.jpg?h=480")
    merged.setdefault("mjpeg_url", f"{base}/api/{cam}?fps=5&h=480")
    merged.setdefault("stream_url", f"{base}/api/{cam}/preview.mp4")
    merged.setdefault("rtsp_url", f"rtsp://{host}:{rtsp_port}/{live_stream}")
    merged.setdefault("live_providers", ["mjpeg", "snapshot"])
    return merged


async def _camera_entity(entity_id: str) -> dict[str, Any]:
    """Find a camera entity in the unified registry."""
    from core.entity_catalog import get_entities

    needle = (entity_id or "").strip()
    if not needle:
        raise HTTPException(404, f"Camera {entity_id!r} not found.")
    needle_lower = needle.lower()

    for ent in await get_entities():
        eid = str(ent.get("entity_id") or "").strip()
        if not eid:
            continue
        domain = str(ent.get("domain") or "").strip().lower()
        is_camera = domain == "camera" or eid.lower().startswith("camera.")
        if not is_camera:
            continue
        if _camera_entity_matches(ent, needle, needle_lower):
            return dict(ent)
    log.warning("camera entity lookup missed %r (not in unified registry)", entity_id)
    raise HTTPException(404, f"Camera {entity_id!r} not found.")


async def _image_entity(entity_id: str) -> dict[str, Any]:
    """Find an image entity in the unified registry."""
    from routers.integrations import _all_entities
    for ent in await _all_entities():
        if ent.get("entity_id") == entity_id and (ent.get("domain") == "image"
                                                  or str(entity_id).startswith("image.")):
            return dict(ent)
    raise HTTPException(404, f"Image entity {entity_id!r} nu există.")


async def _camera_attrs(entity_id: str) -> dict[str, Any]:
    """Find a camera entity in the unified registry and return its attributes."""
    ent = await _camera_entity(entity_id)
    return dict(ent.get("attributes") or {})


def _is_frigate_entity(ent: dict[str, Any]) -> bool:
    return str(ent.get("source") or "").strip().lower() == "frigate"


def _is_reolink_entity(ent: dict[str, Any]) -> bool:
    return str(ent.get("source") or "").strip().lower() == "reolink"


def _resolve_rtsp_url(attrs: dict[str, Any]) -> str:
    """Return an RTSP URL from camera attributes (Tapo, Reolink, CCTV-style entities)."""
    for key in ("rtsp_url", "stream_url"):
        url = str(attrs.get(key) or "").strip()
        if url.lower().startswith("rtsp://"):
            return url
    return ""


def _http_stream_url(attrs: dict[str, Any]) -> str:
    """HTTP(S) MJPEG or live URL (Frigate, Reolink HTTP) — preferred over RTSP proxy."""
    for key in ("mjpeg_url", "stream_url"):
        url = str(attrs.get(key) or "").strip()
        if url.lower().startswith(("http://", "https://")):
            return url
    return ""


def _supports_webm_live(attrs: dict[str, Any]) -> bool:
    providers = attrs.get("live_providers")
    if isinstance(providers, list):
        return "webm" in providers
    return bool(_resolve_rtsp_url(attrs))


def _prefer_http_snapshot(ent: dict[str, Any], attrs: dict[str, Any]) -> bool:
    """Frigate (and similar) expose HTTP snapshots; RTSP restream is optional."""
    if _is_frigate_entity(ent):
        return bool(str(attrs.get("snapshot_url") or "").strip())
    providers = attrs.get("live_providers")
    if isinstance(providers, list) and "mjpeg" in providers and "webm" not in providers:
        return bool(str(attrs.get("snapshot_url") or "").strip())
    snapshot_url = str(attrs.get("snapshot_url") or "").strip().lower()
    return snapshot_url.startswith(("http://", "https://"))


def _jpeg_media_type(data: bytes) -> str:
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"


def _frigate_instance_for(ent: dict[str, Any]) -> Any | None:
    try:
        from integrations import get_integration_manager
        manager = get_integration_manager()
        entry_id = str(ent.get("entry_id") or "").strip()
        return manager.get_by_entry(entry_id) if entry_id else manager.get("frigate")
    except Exception:
        return None


def _reolink_instance_for(ent: dict[str, Any]) -> Any | None:
    try:
        from integrations import get_integration_manager
        manager = get_integration_manager()
        entry_id = str(ent.get("entry_id") or "").strip()
        return manager.get_by_entry(entry_id) if entry_id else manager.get("reolink")
    except Exception:
        return None


async def _reolink_snapshot_bytes(ent: dict[str, Any], attrs: dict[str, Any]) -> bytes:
    inst = _reolink_instance_for(ent)
    if not inst:
        raise RuntimeError("Integrarea Reolink nu este disponibilă pentru această cameră.")
    api = await inst._connect()
    ch = int(attrs["reolink_channel"])
    stream = str(attrs.get("reolink_stream") or "sub")
    data = await api.get_snapshot(ch, stream)
    if not data:
        raise RuntimeError("Snapshot Reolink gol")
    return data


async def _frigate_get_response(ent: dict[str, Any], url: str) -> httpx.Response:
    inst = _frigate_instance_for(ent)
    if not inst:
        raise RuntimeError("Integrarea Frigate nu este disponibilă pentru această cameră.")
    section = dict(getattr(inst, "entry_data", {}) or {})
    base = inst._base_url()
    user = str(section.get("username") or "").strip()
    password = str(section.get("password") or "")
    # Force a bounded read timeout regardless of what the integration configured
    # — a hung Frigate must NOT wedge our worker pool.
    kwargs = dict(inst._build_client_kwargs(section))
    kwargs["timeout"] = _TIMEOUT
    async with httpx.AsyncClient(**kwargs) as client:
        if user and password:
            await asyncio.wait_for(
                inst._login(client, base, user, password), timeout=_SNAPSHOT_DEADLINE
            )
        resp = await asyncio.wait_for(client.get(url), timeout=_SNAPSHOT_DEADLINE)
        resp.raise_for_status()
        return resp


async def _frigate_ws_headers(inst: Any, section: dict[str, Any], base: str) -> list[tuple[str, str]]:
    headers: list[tuple[str, str]] = []
    user = str(section.get("username") or "").strip()
    password = str(section.get("password") or "")
    async with httpx.AsyncClient(**inst._build_client_kwargs(section)) as client:
        if user and password:
            await inst._login(client, base, user, password)
        cookie_header = "; ".join(f"{cookie.name}={cookie.value}" for cookie in client.cookies.jar)
    if cookie_header:
        headers.append(("Cookie", cookie_header))
    api_key = str(section.get("api_key") or "").strip()
    if api_key:
        headers.append(("X-API-KEY", api_key))
    return headers


def _ws_base_url(base: str) -> str:
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    return base


@router.get("/{entity_id}/snapshot")
async def camera_snapshot(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
):
    ent = await _camera_entity(entity_id)
    attrs = _hydrate_frigate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    if _is_reolink_entity(ent) and attrs.get("reolink_channel") is not None:
        try:
            frame = await asyncio.wait_for(
                _reolink_snapshot_bytes(ent, attrs),
                timeout=_SNAPSHOT_DEADLINE,
            )
            if not frame or (len(frame) >= 2 and frame[:2] != b"\xff\xd8"):
                raise RuntimeError("Snapshot Reolink nu e JPEG valid")
            return Response(
                content=frame,
                media_type=_jpeg_media_type(frame),
                headers={"Cache-Control": "no-store"},
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, "Snapshot timeout")
        except Exception as exc:
            log.warning("reolink snapshot %s failed, trying RTSP: %s", entity_id, exc)

    rtsp_url = _resolve_rtsp_url(attrs)
    url = str(attrs.get("snapshot_url") or "").strip()
    if not url and not rtsp_url:
        raise HTTPException(404, "Camera nu expune snapshot.")
    try:
        if _prefer_http_snapshot(ent, attrs) and url:

            async def _fetch_http() -> httpx.Response:
                if _is_frigate_entity(ent):
                    return await _frigate_get_response(ent, url)
                async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    return r

            resp = await asyncio.wait_for(_fetch_http(), timeout=_SNAPSHOT_DEADLINE)
        elif rtsp_url:
            import core.cctv_capture as cctv_capture

            frame = await asyncio.wait_for(
                asyncio.to_thread(cctv_capture.get_rtsp_frame, rtsp_url, 12.0),
                timeout=_RTSP_SNAPSHOT_DEADLINE,
            )
            if not frame:
                raise RuntimeError("ffmpeg nu a returnat cadru")
            return Response(
                content=frame,
                media_type=_jpeg_media_type(frame),
                headers={"Cache-Control": "no-store"},
            )
        else:

            async def _fetch() -> httpx.Response:
                if _is_frigate_entity(ent):
                    return await _frigate_get_response(ent, url)
                async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    return r

            resp = await asyncio.wait_for(_fetch(), timeout=_SNAPSHOT_DEADLINE)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Snapshot timeout")
    except Exception as exc:
        raise HTTPException(502, f"Snapshot indisponibil: {exc}")
    body = resp.content
    return Response(
        content=body,
        media_type=resp.headers.get("content-type") or _jpeg_media_type(body),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{entity_id}/image")
async def image_snapshot(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
):
    """Proxy snapshot for ``image.*`` entities (e.g. Frigate object snapshots)."""
    ent = await _image_entity(entity_id)
    attrs = dict(ent.get("attributes") or {})
    url = str(
        attrs.get("image_url")
        or attrs.get("snapshot_url")
        or attrs.get("entity_picture")
        or attrs.get("url")
        or ""
    ).strip()
    if not url:
        state = str(ent.get("state") or "")
        if state.startswith("http"):
            url = state
    if not url:
        raise HTTPException(404, "Entitatea image nu expune o imagine.")
    try:
        async def _fetch() -> httpx.Response:
            if _is_frigate_entity(ent):
                return await _frigate_get_response(ent, url)
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.get(url)
                r.raise_for_status()
                return r
        resp = await asyncio.wait_for(_fetch(), timeout=_SNAPSHOT_DEADLINE)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Image snapshot timeout")
    except Exception as exc:
        raise HTTPException(502, f"Image indisponibilă: {exc}")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{entity_id}/stream")
async def camera_stream(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
):
    ent = await _camera_entity(entity_id)
    attrs = _hydrate_frigate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    url = _http_stream_url(attrs)
    rtsp_url = "" if url else _resolve_rtsp_url(attrs)
    if not url and not rtsp_url:
        raise HTTPException(404, "Camera does not expose an MJPEG or RTSP stream.")

    if rtsp_url:
        import core.cctv_capture as cctv_capture

        async def _rtsp_proxy():
            try:
                async for chunk in cctv_capture.aiter_rtsp_mjpeg(rtsp_url):
                    yield chunk
            except (asyncio.CancelledError, GeneratorExit):
                return
            except Exception as exc:
                log.warning("camera RTSP stream %s failed: %s", entity_id, exc)

        return StreamingResponse(
            _rtsp_proxy(),
            media_type="multipart/x-mixed-replace; boundary=ffmpeg",
        )

    async def _proxy():
        try:
            if _is_frigate_entity(ent):
                inst = _frigate_instance_for(ent)
                if not inst:
                    raise RuntimeError("Integrarea Frigate nu este disponibilă pentru această cameră.")
                section = dict(getattr(inst, "entry_data", {}) or {})
                base = inst._base_url()
                user_name = str(section.get("username") or "").strip()
                password = str(section.get("password") or "")
                client_kwargs = inst._build_client_kwargs(section)
            else:
                inst = None
                base = ""
                user_name = ""
                password = ""
                client_kwargs = {"timeout": _TIMEOUT}
            async with httpx.AsyncClient(**client_kwargs) as client:
                if inst and user_name and password:
                    await asyncio.wait_for(
                        inst._login(client, base, user_name, password),
                        timeout=_STREAM_CONNECT_DEADLINE,
                    )
                stream_cm = client.stream("GET", url)
                resp = await asyncio.wait_for(
                    stream_cm.__aenter__(), timeout=_STREAM_CONNECT_DEADLINE
                )
                try:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_raw(chunk_size=8192):
                        if not chunk:
                            continue
                        yield chunk
                finally:
                    await stream_cm.__aexit__(None, None, None)
        except (asyncio.CancelledError, GeneratorExit):
            return
        except asyncio.TimeoutError:
            log.warning("camera stream proxy %s timed out connecting", entity_id)
        except Exception as exc:
            log.warning("camera stream proxy %s failed: %s", entity_id, exc)

    media_type = "multipart/x-mixed-replace; boundary=frame"
    return StreamingResponse(_proxy(), media_type=media_type)


@router.get("/{entity_id}/play")
async def camera_play(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
):
    """WebM live stream (VP8 + Opus) proxied from RTSP — supports browser audio."""
    ent = await _camera_entity(entity_id)
    attrs = dict(ent.get("attributes") or {})
    if not _supports_webm_live(attrs):
        raise HTTPException(404, "Camera nu suportă redare WebM live.")
    rtsp_url = _resolve_rtsp_url(attrs)
    if not rtsp_url:
        raise HTTPException(404, "Camera nu expune stream RTSP pentru redare WebM.")

    import core.cctv_capture as cctv_capture

    include_audio = attrs.get("has_audio")
    if include_audio is None:
        include_audio = True
    else:
        include_audio = bool(include_audio)

    async def _rtsp_webm():
        try:
            async for chunk in cctv_capture.aiter_rtsp_webm(rtsp_url, include_audio=include_audio):
                yield chunk
        except (asyncio.CancelledError, GeneratorExit):
            return
        except Exception as exc:
            log.warning("camera RTSP WebM %s failed: %s", entity_id, exc)

    return StreamingResponse(
        _rtsp_webm(),
        media_type="video/webm",
        headers={"Cache-Control": "no-store"},
    )


@router.websocket("/{entity_id}/go2rtc/ws")
async def camera_go2rtc_ws(websocket: WebSocket, entity_id: str, token: str = Query(default=None)):
    user = await _authenticate_ws(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    try:
        ent = await _camera_entity(entity_id)
        attrs = dict(ent.get("attributes") or {})
        stream_name = str(attrs.get("go2rtc_stream") or "").strip()
        if not _is_frigate_entity(ent) or not stream_name:
            await websocket.close(code=1003, reason="go2rtc unavailable")
            return
        inst = _frigate_instance_for(ent)
        if not inst:
            await websocket.close(code=1011, reason="frigate unavailable")
            return
        section = dict(getattr(inst, "entry_data", {}) or {})
        base = inst._base_url()
        verify_tls = bool(inst._build_client_kwargs(section).get("verify"))
        upstream_url = f"{_ws_base_url(base)}/api/go2rtc/api/ws?src={quote(stream_name, safe='')}"
        upstream_headers = await _frigate_ws_headers(inst, section, base)
        ssl_context = None
        if upstream_url.startswith("wss://") and not verify_tls:
            ssl_context = ssl._create_unverified_context()
    except Exception as exc:
        log.warning("camera go2rtc setup %s failed: %s", entity_id, exc)
        await websocket.close(code=1011, reason="go2rtc setup failed")
        return

    await websocket.accept()
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers=upstream_headers,
            ssl=ssl_context,
            open_timeout=8,
            max_size=None,
        ) as upstream:
            async def _browser_to_frigate() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if message.get("text") is not None:
                        await upstream.send(message["text"])
                    elif message.get("bytes") is not None:
                        await upstream.send(message["bytes"])

            async def _frigate_to_browser() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            tasks = [asyncio.create_task(_browser_to_frigate()), asyncio.create_task(_frigate_to_browser())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
    except Exception as exc:
        log.warning("camera go2rtc proxy %s failed: %s", entity_id, exc)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


class CameraAudioBody(BaseModel):
    action: str = Field(..., description="set_speaker_muted | set_microphone_muted | set_speaker_volume")
    enabled: bool | None = None
    volume: int | None = Field(None, ge=0, le=100)


def _camera_capabilities_payload(ent: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    source = str(ent.get("source") or "").strip().lower()
    return {
        "entity_id": ent.get("entity_id") or "",
        "source": source,
        "has_audio": bool(attrs.get("has_audio")),
        "two_way_audio": bool(attrs.get("two_way_audio")),
        "go2rtc_available": bool(attrs.get("go2rtc_available") and attrs.get("go2rtc_stream")),
        "go2rtc_stream": str(attrs.get("go2rtc_stream") or "").strip(),
        "microphone_mutable": bool(attrs.get("microphone_mutable")),
        "speaker_volume_mutable": bool(
            attrs.get("speaker_volume_mutable") or attrs.get("volume_speak") is not None or source == "reolink"
        ),
        "speaker_volume": attrs.get("speaker_volume"),
        "two_way_audio_capable": bool(attrs.get("two_way_audio")),
        "supports_talk": bool(attrs.get("go2rtc_available") and attrs.get("go2rtc_stream")),
        "talk_methods": [
            m for m in (
                "go2rtc" if attrs.get("go2rtc_available") and attrs.get("go2rtc_stream") else None,
            ) if m
        ],
    }


@router.get("/{entity_id}/capabilities")
async def camera_capabilities(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
):
    ent = await _camera_entity(entity_id)
    attrs = _hydrate_frigate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    return _camera_capabilities_payload(ent, attrs)


async def _tapo_device_for_entity(ent: dict[str, Any]) -> Any:
    from integrations import get_integration_manager

    entry_id = str(ent.get("entry_id") or "").strip()
    manager = get_integration_manager()
    integration = manager.get_by_entry(entry_id) if entry_id else manager.get("tapo")
    if not integration or getattr(integration, "slug", "") != "tapo":
        raise HTTPException(404, "Integrarea Tapo nu este disponibilă.")
    attrs = ent.get("attributes") or {}
    dev = await integration._connect()
    target = integration._find_device(dev, attrs.get("tapo_device_key"))
    if target is None:
        raise HTTPException(404, "Dispozitivul Tapo nu a fost găsit.")
    return integration, target


async def _apply_tapo_audio(target: Any, body: CameraAudioBody) -> None:
    action = (body.action or "").strip().lower()
    if action == "set_speaker_muted":
        if body.enabled is None:
            raise HTTPException(400, "Câmpul enabled este obligatoriu.")
        # Tapo has no global speaker mute — volume 0 is the closest match.
        volume = 0 if body.enabled else 50
        await target._raw_query({
            "method": "set",
            "audio_config": {"speaker": {"volume": volume}},
        })
        return
    if action == "set_microphone_muted":
        if body.enabled is None:
            raise HTTPException(400, "Câmpul enabled este obligatoriu.")
        await target._raw_query({
            "method": "set",
            "audio_config": {"microphone": {"mute": "on" if body.enabled else "off"}},
        })
        return
    if action == "set_speaker_volume":
        if body.volume is None:
            raise HTTPException(400, "Câmpul volume este obligatoriu.")
        await target._raw_query({
            "method": "set",
            "audio_config": {"speaker": {"volume": int(body.volume)}},
        })
        return
    raise HTTPException(400, f"Acțiune audio Tapo necunoscută: {action}")


async def _apply_reolink_audio(ent: dict[str, Any], attrs: dict[str, Any], body: CameraAudioBody) -> None:
    inst = _reolink_instance_for(ent)
    if not inst:
        raise HTTPException(404, "Integrarea Reolink nu este disponibilă.")
    api = await inst._connect()
    ch = attrs.get("reolink_channel")
    if ch is None:
        raise HTTPException(400, "Canalul Reolink lipsește din atribute.")
    channel = int(ch)
    action = (body.action or "").strip().lower()
    if action == "set_speaker_volume":
        if body.volume is None:
            raise HTTPException(400, "Câmpul volume este obligatoriu.")
        await api.set_volume(channel, volume_speak=int(body.volume))
        return
    if action == "set_microphone_muted":
        if body.enabled is None:
            raise HTTPException(400, "Câmpul enabled este obligatoriu.")
        await api.set_audio(channel, enable=not body.enabled)
        return
    if action == "set_speaker_muted":
        if body.enabled is None:
            raise HTTPException(400, "Câmpul enabled este obligatoriu.")
        if body.enabled:
            await api.set_volume(channel, volume_speak=0)
        return
    raise HTTPException(400, f"Acțiune audio Reolink necunoscută: {action}")


@router.post("/{entity_id}/audio")
async def camera_audio_settings(
    entity_id: str,
    body: CameraAudioBody,
    user: models.User = Depends(_get_camera_user),
):
    ent = await _camera_entity(entity_id)
    attrs = dict(ent.get("attributes") or {})
    source = str(ent.get("source") or "").strip().lower()
    try:
        if source == "tapo":
            _integration, target = await _tapo_device_for_entity(ent)
            await _apply_tapo_audio(target, body)
        elif source == "reolink":
            await _apply_reolink_audio(ent, attrs, body)
        else:
            raise HTTPException(400, "Setările audio nu sunt suportate pentru această cameră.")
        return {"ok": True, "entity_id": entity_id, "action": body.action}
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("camera audio %s failed: %s", entity_id, exc)
        raise HTTPException(502, f"Setare audio eșuată: {exc}") from exc


async def _go2rtc_play_file(inst: Any, stream_name: str, file_path: Path) -> None:
    base = inst._base_url().rstrip("/")
    url = f"{base}/api/go2rtc/api/ffmpeg"
    src = f"ffmpeg:{file_path}#audio=opus"
    section = dict(getattr(inst, "entry_data", {}) or {})
    kwargs = dict(inst._build_client_kwargs(section))
    kwargs["timeout"] = _TIMEOUT
    async with httpx.AsyncClient(**kwargs) as client:
        user = str(section.get("username") or "").strip()
        password = str(section.get("password") or "")
        if user and password:
            await inst._login(client, base, user, password)
        resp = await client.post(url, params={"dst": stream_name, "src": src})
        resp.raise_for_status()


@router.post("/{entity_id}/talk")
async def camera_talk_push(
    entity_id: str,
    user: models.User = Depends(_get_camera_user),
    audio: UploadFile = File(...),
):
    """Play a short audio clip to the camera speaker (go2rtc / ONVIF backchannel when configured)."""
    ent = await _camera_entity(entity_id)
    attrs = dict(ent.get("attributes") or {})
    source = str(ent.get("source") or "").strip().lower()
    stream_name = str(attrs.get("go2rtc_stream") or "").strip()
    suffix = Path(audio.filename or "clip.webm").suffix or ".webm"
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Fișierul audio este gol.")
    tmp_path: Path | None = None
    try:
        if _is_frigate_entity(ent) and stream_name:
            inst = _frigate_instance_for(ent)
            if not inst:
                raise HTTPException(404, "Integrarea Frigate nu este disponibilă.")
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(data)
                tmp_path = Path(tmp.name)
            await _go2rtc_play_file(inst, stream_name, tmp_path)
            return {"ok": True, "method": "go2rtc", "entity_id": entity_id}
        if source == "tapo" and attrs.get("two_way_audio"):
            raise HTTPException(
                501,
                "Talk-back direct Tapo nu este încă disponibil. Folosește Frigate+go2rtc cu sursă ONVIF sau aplicația Tapo.",
            )
        if source == "reolink" and attrs.get("two_way_audio"):
            raise HTTPException(
                501,
                "Talk-back Reolink necesită go2rtc cu sursă ONVIF în stream sau integrarea reolink_talk.",
            )
        raise HTTPException(400, "Camera nu suportă redare audio către difuzor.")
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("camera talk %s failed: %s", entity_id, exc)
        raise HTTPException(502, f"Redare audio eșuată: {exc}") from exc
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass
