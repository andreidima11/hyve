"""Core pages and system endpoints (health, logs, themes, dashboard shell)."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

import database
import models
import scheduler_service
import settings
import storage
import auth
from core.json_fast import jdumps as _jdumps
from core.log_stream import _MAX_LOG_STREAMS, log_buffer, log_line, log_queues
from routers.ollama_proxy import list_models as ollama_list_models
from server_restart import schedule_restart

router = APIRouter(tags=["system"])

_THEMES_CACHE: dict[str, Any] = {"sig": None, "data": None}


@router.get("/api/tags")
async def api_tags():
    return await ollama_list_models()

@router.get("/api/themes")
async def api_themes():
    """List available themes from the static/css/themes/ directory.

    Cached by directory listing + per-file mtime so unchanged theme files do
    not trigger a fresh disk read + JSON parse on every dashboard load.
    """
    themes_dir = os.path.join("static", "css", "themes")
    if not os.path.isdir(themes_dir):
        return []
    try:
        names = sorted(f for f in os.listdir(themes_dir) if f.endswith(".json"))
        sig = tuple((n, os.path.getmtime(os.path.join(themes_dir, n))) for n in names)
    except OSError:
        return _THEMES_CACHE.get("data") or []
    if _THEMES_CACHE["sig"] == sig and _THEMES_CACHE["data"] is not None:
        return _THEMES_CACHE["data"]
    themes = []
    for fname in names:
        fpath = os.path.join(themes_dir, fname)
        try:
            with open(fpath, "r") as f:
                themes.append(json.load(f))
        except Exception as e:
            log_line("error", "⚠️", "THEMES", f"Failed to load {fname}: {e}")
    _THEMES_CACHE["sig"] = sig
    _THEMES_CACHE["data"] = themes
    return themes

@router.get("/", response_class=HTMLResponse)
async def read_dashboard(request: Request): 
    response = request.app.state.templates.TemplateResponse("index.html", {"request": request, "cache_bust": request.app.state.app_start_ts, "app_version": settings.APP_VERSION})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response

@router.get("/api/startup/status")
async def get_startup_status():
    """Lightweight startup progress for the Hub nav loading indicator."""
    from core.startup_status import get_startup_status as _status
    return _status()

@router.get("/api/health")
async def get_health(request: Request, db: Session = Depends(database.get_db)):
    """Unified health: DB + Chroma required for 200; returns 503 if either fails (Docker/K8s). Also scheduler, WAHA, LLM status."""
    cfg = settings.CFG
    status_db = False
    status_chroma = False
    db_error = None
    chroma_error = None
    try:
        db.execute(text("SELECT 1"))
        status_db = True
    except Exception as e:
        db_error = str(e)
    try:
        live_collection = storage.get_collection()
        chroma_meta = storage.get_collection_health()
        await asyncio.wait_for(asyncio.to_thread(live_collection.peek, limit=1), timeout=2.0)
        status_chroma = True
    except asyncio.TimeoutError:
        chroma_error = "timeout"
        chroma_meta = storage.get_collection_health()
    except Exception as e:
        chroma_error = str(e)
        chroma_meta = storage.get_collection_health()
    memory_status = chroma_meta.get("status") or "unknown"
    overall_ok = status_db and status_chroma and memory_status == "ok"
    health = {
        "status": "ok" if overall_ok else "degraded",
        "db": status_db,
        "db_error": db_error,
        "chroma": "ok" if status_chroma else "error",
        "chroma_error": chroma_error,
        "memory": chroma_meta,
        "scheduler": "unknown",
        "waha": {"enabled": False, "reachable": None},
        "llm": {"configured": False, "target_url": "", "model_name": ""},
        "verbose_logging": bool(cfg.get("verbose_logging")),
    }
    if health["memory"].get("status") == "ok" and not status_chroma:
        health["memory"]["status"] = "error"
        health["memory"]["last_error"] = chroma_error
    try:
        health["scheduler"] = "running" if scheduler_service.scheduler.running else "stopped"
    except Exception:
        health["scheduler"] = "error"
    waha_cfg = cfg.get("waha") or {}
    health["waha"]["enabled"] = bool(waha_cfg.get("enabled"))
    if health["waha"]["enabled"] and waha_cfg.get("api_url"):
        try:
            r = await request.app.state.http_client.get(waha_cfg["api_url"].rstrip("/") + "/", timeout=2.5)
            health["waha"]["reachable"] = r.status_code < 500
        except Exception:
            health["waha"]["reachable"] = False
    llm = cfg.get("llm") or {}
    health["llm"]["configured"] = bool(llm.get("target_url") and llm.get("model_name"))
    # Don't expose internal URLs/model names to unauthenticated callers
    return JSONResponse(status_code=200 if overall_ok else 503, content=health)

@router.post("/api/restart")
def restart_server(_: models.User = Depends(auth.get_current_admin)):
    # This endpoint is a sync handler, so it can run in a threadpool where
    # `asyncio.get_event_loop()` may fail with "There is no current event loop".
    # Use the dedicated thread-based restarter, safe for sync/async callers.
    schedule_restart(delay=0.5, log_msg="Restart sequence initiated...")
    return {"ok": True, "message": "Restarting..."}

@router.get("/api/logs")
async def stream_logs(request: Request, token: Optional[str] = None, db: Session = Depends(database.get_db)):
    # SSE (EventSource) can't send headers, so only accept a short-lived exchange token in the URL.
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        sse_payload = auth.consume_sse_exchange_token(token, db)
        if not sse_payload:
            raise HTTPException(status_code=401, detail="Invalid token")
        username = sse_payload["sub"]
        user = db.query(models.User).filter(models.User.username == username).first()
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required for logs")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if len(log_queues) >= _MAX_LOG_STREAMS:
        raise HTTPException(status_code=429, detail="Too many log streams open")
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    log_queues.append(q)

    async def event_generator():
        try:
            # Replay buffer so web console mirrors server console from the beginning
            # Make a copy to avoid "deque mutated during iteration" if log_buffer grows
            for msg in list(log_buffer):
                yield f"data: {msg}\n\n"
            yield f"data: {_jdumps('🔌 Connected to log stream')}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(q.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {data}\n\n"
        finally:
            try: log_queues.remove(q)
            except ValueError: pass

    return StreamingResponse(event_generator(), media_type="text/event-stream")
