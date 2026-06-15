"""Media proxy router — fetch external favicons and web-search images server-side.

Browser <img> tags can't send auth headers, and many remote sites block hotlinking
(403/CORS), which is why proxied images would otherwise render as "broken". These
endpoints fetch the resource from our backend and stream the bytes back with a
permissive same-origin content type, while enforcing SSRF protection so callers
can't probe the internal network.

Auth: short-lived ``camera_stream`` JWT via ``?token=`` query param
(same pattern as ``/api/cameras/*``; access tokens are not accepted in URLs).
"""

from __future__ import annotations

from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response

import core.auth as auth
import core.database as database
import core.models as models
from brain.web_search import _is_internal_url
from core.http.limiter import limiter
from core.logger import log_line

router = APIRouter(tags=["media-proxy"])

_TIMEOUT = 8.0
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB cap per image
_MAX_REDIRECTS = 5
_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}

# 1x1 transparent PNG used as a graceful fallback so the browser never shows a
# broken-image glyph.
_TRANSPARENT_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c63fcffff3f0300050001ff5cce4d5d0000000049454e44ae426082"
)


def _png_fallback() -> Response:
    return Response(
        content=_TRANSPARENT_PNG,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


def _redirect_chain_is_safe(resp: httpx.Response) -> bool:
    chain = list(getattr(resp, "history", []) or []) + [resp]
    return not any(_is_internal_url(str(r.url)) for r in chain)


def _user_from_media_token(raw_token: str | None) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"key": "common.unauthorized"},
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = auth.decode_media_url_token((raw_token or "").strip())
    if not payload:
        raise credentials_exception
    db = next(database.get_db())
    try:
        jti = payload.get("jti")
        if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
            raise credentials_exception
        user = db.query(models.User).filter(models.User.username == payload.get("sub")).first()
        if user is None or not user.is_active:
            raise credentials_exception
        return user
    finally:
        db.close()


async def _fetch_image(url: str) -> Response:
    if not url.startswith("http://") and not url.startswith("https://"):
        return _png_fallback()
    if _is_internal_url(url):
        log_line("agent", "🛡️", "SSRF_BLOCK", f"media-proxy blocked internal URL: {url[:80]}")
        return _png_fallback()
    try:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=True,
            max_redirects=_MAX_REDIRECTS,
        ) as client:
            async with client.stream("GET", url, headers=_FETCH_HEADERS) as resp:
                if not _redirect_chain_is_safe(resp):
                    log_line("agent", "🛡️", "SSRF_BLOCK", f"media-proxy blocked redirect chain: {url[:80]}")
                    return _png_fallback()
                if resp.status_code != 200:
                    return _png_fallback()
                content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                if not content_type.startswith("image/"):
                    return _png_fallback()
                chunks = bytearray()
                async for chunk in resp.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > _MAX_BYTES:
                        return _png_fallback()
        return Response(
            content=bytes(chunks),
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception:
        return _png_fallback()


@router.get("/api/favicon")
@limiter.limit("120/minute")
async def favicon_proxy(
    request: Request,
    domain: str = Query(..., description="Domain to fetch a favicon for"),
    token: str | None = Query(None, description="Short-lived media auth token"),
):
    """Return a favicon for a domain, falling back to Google's favicon service."""
    _user_from_media_token(token)
    domain = (domain or "").strip()
    if not domain:
        return _png_fallback()
    # Normalize to a bare hostname.
    if "://" in domain:
        domain = urlparse(domain).hostname or domain
    domain = domain.split("/")[0].strip()
    if not domain:
        return _png_fallback()
    google_url = f"https://www.google.com/s2/favicons?domain={domain}&sz=64"
    return await _fetch_image(google_url)


@router.get("/api/img-proxy")
@limiter.limit("120/minute")
async def image_proxy(
    request: Request,
    url: str = Query(..., description="Absolute http(s) image URL to proxy"),
    token: str | None = Query(None, description="Short-lived media auth token"),
):
    """Proxy an external image so hotlink-protected / CORS-blocked images still render."""
    _user_from_media_token(token)
    return await _fetch_image((url or "").strip())
