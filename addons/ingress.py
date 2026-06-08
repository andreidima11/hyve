"""Reverse-proxy addon Web UIs through Hyve (Home Assistant–style ingress).

Browsers never open ``http://localhost:<port>`` directly — they hit
``/api/addons/{slug}/ui/…`` on the Hyve host so remote clients work.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import logging
import re
import time
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
import websockets
from fastapi import HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import RedirectResponse, StreamingResponse
from starlette.background import BackgroundTask

import auth
import models
from addons import registry

log = logging.getLogger("addons.ingress")

_INGRESS_COOKIE_TTL = 3600
_HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
})
_STRIP_RESPONSE_HEADERS = frozenset({
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def ingress_cookie_name(slug: str) -> str:
    return f"hyve_addon_ui_{slug}"


def ingress_public_path(slug: str) -> str:
    return f"/api/addons/{quote(str(slug or '').strip(), safe='')}/ui"


def _sign_ingress_payload(payload: str) -> str:
    digest = hmac.new(
        auth.SECRET_KEY.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]
    return f"{payload}:{digest}"


def make_ingress_cookie(user_id: int, slug: str, *, ttl: int = _INGRESS_COOKIE_TTL) -> str:
    exp = int(time.time()) + max(60, int(ttl))
    return _sign_ingress_payload(f"{int(user_id)}:{slug}:{exp}")


def verify_ingress_cookie(raw: str | None, slug: str) -> int | None:
    value = str(raw or "").strip()
    if not value or value.count(":") != 3:
        return None
    user_part, slug_part, exp_part, sig = value.split(":", 3)
    if slug_part != slug:
        return None
    expected = _sign_ingress_payload(f"{user_part}:{slug_part}:{exp_part}")
    if not hmac.compare_digest(expected, f"{user_part}:{slug_part}:{exp_part}:{sig}"):
        return None
    try:
        exp = int(exp_part)
        user_id = int(user_part)
    except ValueError:
        return None
    if exp < int(time.time()):
        return None
    return user_id


def resolve_addon_upstream(slug: str) -> str | None:
    """Return the loopback upstream base URL for an addon Web UI, if proxiable."""
    manifest = registry.get_manifest(slug)
    if not manifest:
        return None
    web_ui = manifest.get("web_ui") or {}
    if not isinstance(web_ui, dict) or not web_ui:
        return None
    if web_ui.get("ingress") is False:
        return None

    state = registry.get_state(slug) or {}
    cfg = state.get("config") if isinstance(state.get("config"), dict) else {}

    direct = str(cfg.get(web_ui.get("url_key") or "") or "").strip()
    if direct:
        parsed = urlparse(direct)
        if parsed.hostname in _LOCAL_HOSTS:
            return direct.rstrip("/")
        return None

    host = str(
        web_ui.get("host")
        or cfg.get(web_ui.get("host_key") or "host")
        or cfg.get("host")
        or "127.0.0.1"
    ).strip().lower()
    if host not in _LOCAL_HOSTS:
        return None

    port_key = str(web_ui.get("port_key") or "port")
    port_raw = cfg.get(port_key, web_ui.get("port"))
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        return None
    if port <= 0 or port > 65535:
        return None

    protocol = str(web_ui.get("protocol") or "http").replace(":", "").lower() or "http"
    base_path = str(web_ui.get("path") or "/").strip()
    if not base_path.startswith("/"):
        base_path = f"/{base_path}"
    base_path = base_path.rstrip("/")
    return f"{protocol}://127.0.0.1:{port}{base_path}"


def build_upstream_target(slug: str, subpath: str) -> str | None:
    base = resolve_addon_upstream(slug)
    if not base:
        return None
    cleaned = str(subpath or "").lstrip("/")
    if not cleaned:
        return f"{base}/"
    return f"{base}/{cleaned}"


def _rewrite_location(value: str, slug: str, upstream_base: str) -> str:
    public_base = ingress_public_path(slug)
    parsed = urlparse(value)
    if parsed.scheme and parsed.netloc:
        up = urlparse(upstream_base)
        if parsed.netloc == up.netloc or parsed.hostname in _LOCAL_HOSTS:
            suffix = parsed.path or "/"
            if up.path and up.path != "/" and suffix.startswith(up.path):
                suffix = suffix[len(up.path):] or "/"
            query = f"?{parsed.query}" if parsed.query else ""
            fragment = f"#{parsed.fragment}" if parsed.fragment else ""
            if not suffix.startswith("/"):
                suffix = f"/{suffix}"
            return f"{public_base}{suffix}{query}{fragment}"
        return value
    if value.startswith("/"):
        return f"{public_base}{value}"
    return urljoin(f"{public_base}/", value)


def _filtered_response_headers(headers: httpx.Headers, *, slug: str, upstream_base: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.items():
        lower = key.lower()
        if lower in _HOP_BY_HOP or lower in _STRIP_RESPONSE_HEADERS:
            continue
        if lower == "location":
            out[key] = _rewrite_location(value, slug, upstream_base)
            continue
        out[key] = value
    return out


async def authenticate_ingress_request(
    request: Request,
    slug: str,
    *,
    db,
    token: str | None = None,
) -> models.User:
    user_id = verify_ingress_cookie(request.cookies.get(ingress_cookie_name(slug)), slug)
    if user_id:
        user = db.query(models.User).filter(models.User.id == user_id).first()
        if user and user.is_active:
            return user

    raw_token = (token or request.query_params.get("token") or "").strip()
    if not raw_token:
        auth_header = request.headers.get("authorization") or ""
        if auth_header.lower().startswith("bearer "):
            raw_token = auth_header[7:].strip()

    if raw_token:
        payload = auth.decode_access_token(raw_token, db)
        if payload and payload.get("sub"):
            user = db.query(models.User).filter(models.User.username == payload.get("sub")).first()
            if user and user.is_active:
                return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.auth_required"},
    )


def open_ingress_session(slug: str, user: models.User) -> RedirectResponse:
    upstream = resolve_addon_upstream(slug)
    if not upstream:
        raise HTTPException(status_code=404, detail={"key": "apps.configure_web_ui_first"})
    response = RedirectResponse(url=f"{ingress_public_path(slug)}/", status_code=307)
    attach_ingress_cookie(response, user, slug)
    return response


def attach_ingress_cookie(response: Response, user: models.User, slug: str) -> None:
    response.set_cookie(
        key=ingress_cookie_name(slug),
        value=make_ingress_cookie(user.id, slug),
        httponly=True,
        samesite="lax",
        max_age=_INGRESS_COOKIE_TTL,
        path=ingress_public_path(slug),
    )


def _maybe_attach_ingress_cookie(response: Response, request: Request, user: models.User, slug: str) -> Response:
    if verify_ingress_cookie(request.cookies.get(ingress_cookie_name(slug)), slug):
        return response
    attach_ingress_cookie(response, user, slug)
    return response


def _rewrite_html_paths(body: bytes, slug: str) -> bytes:
    public = ingress_public_path(slug)
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return body

    def _repl(match: re.Match[str]) -> str:
        attr, quote, path = match.group(1), match.group(2), match.group(3)
        if not path or path.startswith(("http://", "https://", "//", "#", "data:", "blob:")):
            return match.group(0)
        if path.startswith(public):
            return match.group(0)
        if not path.startswith("/"):
            return match.group(0)
        return f"{attr}={quote}{public}{path}{quote}"

    text = re.sub(
        r"""(href|src|action)=(["'])(/[^"']*)\2""",
        _repl,
        text,
        flags=re.IGNORECASE,
    )
    return text.encode("utf-8")


def _inject_base_href(body: bytes, slug: str) -> bytes:
    public_base = f"{ingress_public_path(slug)}/"
    tag = f'<base href="{public_base}">'
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return body
    lower = text.lower()
    if "<base " in lower:
        return body
    if "<head>" in lower:
        idx = lower.index("<head>") + len("<head>")
        return (text[:idx] + tag + text[idx:]).encode("utf-8")
    if "<html" in lower:
        idx = lower.index("<html")
        end = lower.index(">", idx) + 1
        return (text[:end] + tag + text[end:]).encode("utf-8")
    return body


async def proxy_http(request: Request, slug: str, subpath: str, user: models.User) -> Response:
    upstream_base = resolve_addon_upstream(slug)
    target = build_upstream_target(slug, subpath)
    if not upstream_base or not target:
        raise HTTPException(status_code=404, detail={"key": "apps.configure_web_ui_first"})

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP and key.lower() != "cookie"
    }
    body = await request.body()

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=httpx.Timeout(30.0)) as client:
            upstream = await client.request(
                request.method,
                target,
                params=request.query_params.multi_items(),
                content=body if body else None,
                headers=headers,
            )
    except httpx.RequestError as exc:
        log.warning("addon ingress http failed slug=%s target=%s: %s", slug, target, exc)
        raise HTTPException(status_code=502, detail={"key": "apps.addon_ui_unreachable"}) from exc

    response_headers = _filtered_response_headers(upstream.headers, slug=slug, upstream_base=upstream_base)
    content_type = upstream.headers.get("content-type", "")

    if upstream.status_code == 200 and "text/html" in content_type.lower():
        body = await upstream.aread()
        await upstream.aclose()
        body = _inject_base_href(body, slug)
        body = _rewrite_html_paths(body, slug)
        return _maybe_attach_ingress_cookie(
            Response(
                content=body,
                status_code=upstream.status_code,
                headers=response_headers,
            ),
            request,
            user,
            slug,
        )

    async def _close(resp: httpx.Response) -> None:
        await resp.aclose()

    return _maybe_attach_ingress_cookie(
        StreamingResponse(
            upstream.aiter_bytes(),
            status_code=upstream.status_code,
            headers=response_headers,
            background=BackgroundTask(_close, upstream),
        ),
        request,
        user,
        slug,
    )


async def proxy_websocket(websocket: WebSocket, slug: str, subpath: str, user: models.User) -> None:
    upstream_base = resolve_addon_upstream(slug)
    target = build_upstream_target(slug, subpath)
    if not upstream_base or not target:
        await websocket.close(code=1008, reason="addon ui unavailable")
        return

    parsed = urlparse(target)
    if parsed.scheme == "https":
        upstream_ws = f"wss://{parsed.netloc}{parsed.path or '/'}"
    else:
        upstream_ws = f"ws://{parsed.netloc}{parsed.path or '/'}"
    if parsed.query:
        upstream_ws = f"{upstream_ws}?{parsed.query}"

    await websocket.accept()
    try:
        async with websockets.connect(
            upstream_ws,
            open_timeout=8,
            max_size=None,
        ) as upstream:
            async def _client_to_upstream() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if message.get("text") is not None:
                        await upstream.send(message["text"])
                    elif message.get("bytes") is not None:
                        await upstream.send(message["bytes"])

            async def _upstream_to_client() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            tasks = [
                asyncio.create_task(_client_to_upstream()),
                asyncio.create_task(_upstream_to_client()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                with contextlib.suppress(Exception):
                    task.result()
    except Exception as exc:
        log.debug("addon ingress ws failed slug=%s: %s", slug, exc)
    finally:
        with contextlib.suppress(Exception):
            await websocket.close()
