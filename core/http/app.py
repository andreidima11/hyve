"""FastAPI application factory."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from slowapi import Limiter

from core.http.lifespan import lifespan
from core.http.limiter import limiter
from core.http.middleware import register_http_middleware
from core.http.routers import register_routers
from core.http.startup_migrations import run_startup_migrations


@dataclass(frozen=True)
class HyveApp:
    app: FastAPI
    templates: Jinja2Templates
    limiter: Limiter
    app_start_ts: str


_hyve_singleton: HyveApp | None = None


def create_app() -> HyveApp:
    """Build the FastAPI app with middleware, static files, and routers."""
    app = FastAPI(lifespan=lifespan)
    register_http_middleware(app)
    run_startup_migrations()

    if not os.path.exists("static"):
        os.makedirs("static/css", exist_ok=True)
        os.makedirs("static/js", exist_ok=True)

    app.mount("/static", StaticFiles(directory="static"), name="static")

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker():
        return FileResponse("static/sw.js", media_type="application/javascript")

    templates = Jinja2Templates(directory="templates")
    if os.environ.get("HYVE_DEV") != "1":
        try:
            templates.env.auto_reload = False
            templates.env.cache_size = 400
        except Exception:
            pass

    app_start_ts = str(int(time.time()))
    app.state.templates = templates
    app.state.app_start_ts = app_start_ts
    register_routers(app)
    return HyveApp(app=app, templates=templates, limiter=limiter, app_start_ts=app_start_ts)


def get_hyve_app() -> HyveApp:
    """Process-wide app bundle (used by main entrypoint and route introspection)."""
    global _hyve_singleton
    if _hyve_singleton is None:
        _hyve_singleton = create_app()
    return _hyve_singleton
