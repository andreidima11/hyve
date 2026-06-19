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
from core.settings import is_strict_startup_mode


@dataclass(frozen=True)
class HyveApp:
    app: FastAPI
    templates: Jinja2Templates
    limiter: Limiter
    app_start_ts: str


_hyve_singleton: HyveApp | None = None


def _openapi_enabled() -> bool:
    if os.environ.get("HYVE_OPENAPI_DOCS", "").strip() == "1":
        return True
    return not is_strict_startup_mode()


def create_app() -> HyveApp:
    """Build the FastAPI app with middleware, static files, and routers."""
    docs_on = _openapi_enabled()
    app = FastAPI(
        lifespan=lifespan,
        docs_url="/docs" if docs_on else None,
        redoc_url="/redoc" if docs_on else None,
        openapi_url="/openapi.json" if docs_on else None,
    )
    register_http_middleware(app)
    run_startup_migrations()
    try:
        from core.setup_service import migrate_legacy_setup

        migrate_legacy_setup()
    except Exception:
        pass

    if not os.path.exists("static"):
        os.makedirs("static/css", exist_ok=True)
        os.makedirs("static/js", exist_ok=True)

    app.mount("/static", StaticFiles(directory="static"), name="static")

    custom_cards = os.path.join("custom_components", "cards")
    if os.path.isdir(custom_cards):
        app.mount(
            "/custom_components/cards",
            StaticFiles(directory=custom_cards),
            name="custom_cards",
        )

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
