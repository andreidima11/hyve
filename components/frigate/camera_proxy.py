"""Frigate camera proxy helpers (HTTP auth, go2rtc, stream attrs)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx

from core.cameras.shared import SNAPSHOT_DEADLINE, STREAM_CONNECT_DEADLINE, TIMEOUT, ws_base_url


def matches_entity(ent: dict[str, Any]) -> bool:
    return str(ent.get("source") or "").strip().lower() == "frigate"


def instance_for(ent: dict[str, Any]) -> Any | None:
    try:
        from integrations import get_integration_manager

        manager = get_integration_manager()
        entry_id = str(ent.get("entry_id") or "").strip()
        return manager.get_by_entry(entry_id) if entry_id else manager.get("frigate")
    except Exception:
        return None


def hydrate_stream_attrs(ent: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    """Rebuild Frigate stream URLs when attributes were stripped or stale."""
    from core.cameras.shared import http_stream_url, resolve_rtsp_url

    if http_stream_url(attrs) or resolve_rtsp_url(attrs):
        return attrs
    if not matches_entity(ent):
        return attrs
    cam = str(attrs.get("frigate_camera") or "").strip()
    if not cam:
        return attrs
    inst = instance_for(ent)
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


async def get_http_response(ent: dict[str, Any], url: str) -> httpx.Response:
    inst = instance_for(ent)
    if not inst:
        raise RuntimeError("Integrarea Frigate nu este disponibilă pentru această cameră.")
    section = dict(getattr(inst, "entry_data", {}) or {})
    base = inst._base_url()
    user = str(section.get("username") or "").strip()
    password = str(section.get("password") or "")
    kwargs = dict(inst._build_client_kwargs(section))
    kwargs["timeout"] = TIMEOUT
    async with httpx.AsyncClient(**kwargs) as client:
        if user and password:
            await asyncio.wait_for(inst._login(client, base, user, password), timeout=SNAPSHOT_DEADLINE)
        resp = await asyncio.wait_for(client.get(url), timeout=SNAPSHOT_DEADLINE)
        resp.raise_for_status()
        return resp


async def iter_http_stream(ent: dict[str, Any], url: str):
    """Yield raw chunks from an authenticated Frigate HTTP stream."""
    inst = instance_for(ent)
    if not inst:
        raise RuntimeError("Frigate integration not available for this camera")
    section = dict(getattr(inst, "entry_data", {}) or {})
    base = inst._base_url()
    user_name = str(section.get("username") or "").strip()
    password = str(section.get("password") or "")
    client_kwargs = inst._build_client_kwargs(section)
    async with httpx.AsyncClient(**client_kwargs) as client:
        if user_name and password:
            await asyncio.wait_for(
                inst._login(client, base, user_name, password),
                timeout=STREAM_CONNECT_DEADLINE,
            )
        stream_cm = client.stream("GET", url)
        resp = await asyncio.wait_for(stream_cm.__aenter__(), timeout=STREAM_CONNECT_DEADLINE)
        try:
            resp.raise_for_status()
            async for chunk in resp.aiter_raw(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            await stream_cm.__aexit__(None, None, None)


async def ws_headers(inst: Any, section: dict[str, Any], base: str) -> list[tuple[str, str]]:
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


async def go2rtc_play_file(inst: Any, stream_name: str, file_path: Path) -> None:
    base = inst._base_url().rstrip("/")
    url = f"{base}/api/go2rtc/api/ffmpeg"
    src = f"ffmpeg:{file_path}#audio=opus"
    section = dict(getattr(inst, "entry_data", {}) or {})
    kwargs = dict(inst._build_client_kwargs(section))
    kwargs["timeout"] = TIMEOUT
    async with httpx.AsyncClient(**kwargs) as client:
        user = str(section.get("username") or "").strip()
        password = str(section.get("password") or "")
        if user and password:
            await inst._login(client, base, user, password)
        resp = await client.post(url, params={"dst": stream_name, "src": src})
        resp.raise_for_status()


def enrich_capabilities(base: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    base["go2rtc_available"] = bool(attrs.get("go2rtc_available") and attrs.get("go2rtc_stream"))
    base["go2rtc_stream"] = str(attrs.get("go2rtc_stream") or "").strip()
    base["supports_talk"] = bool(attrs.get("go2rtc_available") and attrs.get("go2rtc_stream"))
    base["talk_methods"] = ["go2rtc"] if base["supports_talk"] else []
    return base
