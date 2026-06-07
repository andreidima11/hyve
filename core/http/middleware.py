"""HTTP middleware stack (gzip, CORS, security headers, request logging)."""

from __future__ import annotations

import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from core.http.limiter import limiter

import logger
import settings
from core.log_stream import log_line


class SafeGZipMiddleware:
    """Gzip only fully-buffered, compressible responses."""

    _COMPRESSIBLE = (
        "application/json",
        "text/html",
        "text/css",
        "text/plain",
        "application/javascript",
        "text/javascript",
        "image/svg+xml",
    )

    def __init__(self, app, minimum_size: int = 600):
        self.app = app
        self.minimum_size = minimum_size

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        from starlette.datastructures import Headers, MutableHeaders
        import gzip as _gzip

        if "gzip" not in Headers(scope=scope).get("accept-encoding", "").lower():
            await self.app(scope, receive, send)
            return

        start_msg = {}
        state = {"decided": False, "passthrough": False}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                start_msg.clear()
                start_msg.update(message)
                return
            if message["type"] != "http.response.body":
                await send(message)
                return
            if state["passthrough"]:
                await send(message)
                return
            if not state["decided"]:
                state["decided"] = True
                more = message.get("more_body", False)
                body = message.get("body", b"")
                headers = MutableHeaders(raw=start_msg.get("headers", []))
                ctype = headers.get("content-type", "").split(";")[0].strip().lower()
                already = headers.get("content-encoding")
                if more or already or ctype not in self._COMPRESSIBLE or len(body) < self.minimum_size:
                    state["passthrough"] = True
                    await send(start_msg)
                    await send(message)
                    return
                compressed = _gzip.compress(body)
                headers["Content-Encoding"] = "gzip"
                headers["Content-Length"] = str(len(compressed))
                vary = headers.get("vary")
                headers["Vary"] = f"{vary}, Accept-Encoding" if vary else "Accept-Encoding"
                await send(start_msg)
                await send({"type": "http.response.body", "body": compressed, "more_body": False})
                return
            await send(message)

        await self.app(scope, receive, send_wrapper)


def register_http_middleware(app: FastAPI) -> None:
    app.state.limiter = limiter
    app.add_middleware(SafeGZipMiddleware)

    cors_raw = os.environ.get("CORS_ORIGINS", "").strip()
    cors_origins = [o.strip() for o in cors_raw.split(",") if o.strip()] if cors_raw else []
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Accept"],
    )

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        request.state.request_id = request_id
        token = logger.set_request_id(request_id)
        try:
            response = await call_next(request)
        finally:
            logger.reset_request_id(token)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.middleware("http")
    async def security_headers_and_api_version(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-API-Version"] = "1"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com https://cdn.jsdelivr.net; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "connect-src 'self'; "
            "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com https://cdn.jsdelivr.net; "
            "frame-ancestors 'none'"
        )
        return response

    @app.exception_handler(RateLimitExceeded)
    async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
        return JSONResponse(status_code=429, content={"detail": "Too many requests. Please slow down."})

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start_time = time.time()
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        if "/api/logs" not in request.url.path and "/static/" not in request.url.path and "/api/notifications/check" not in request.url.path:
            verbose = bool((settings.CFG or {}).get("verbose_logging"))
            if verbose or response.status_code >= 400:
                log_line("dim", "🌐", "HTTP", f"{request.method} {request.url.path} → {response.status_code} ({process_time:.0f}ms)")
        return response

    @app.middleware("http")
    async def no_cache_static_assets(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/static/") and (path.endswith(".js") or path.endswith(".css")):
            if request.url.query and "v=" in request.url.query:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                for _h in ("Pragma", "Expires"):
                    if _h in response.headers:
                        del response.headers[_h]
            else:
                response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
                response.headers["Pragma"] = "no-cache"
                response.headers["Expires"] = "0"
        return response
