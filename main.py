# Load .env BEFORE any module that reads environment variables.
from env_bootstrap import ensure_env_loaded
ensure_env_loaded()

import warnings
# Evită avertismentul "resource_tracker: leaked semaphore" la shutdown (dependențe multiprocessing)
warnings.filterwarnings("ignore", message=".*resource_tracker.*leaked semaphore.*", category=UserWarning, module="multiprocessing.resource_tracker")
# Suppress noisy FutureWarnings from transformers / huggingface_hub (deprecated torch pytree + resume_download)
warnings.filterwarnings("ignore", category=FutureWarning, module=r"transformers\.utils\.generic")
warnings.filterwarnings("ignore", category=FutureWarning, module=r"huggingface_hub\.file_download")
import logging
# Suppress uvicorn "Exception in ASGI application" tracebacks that fire during normal shutdown
logging.getLogger("uvicorn.error").addFilter(
    type("_ShutdownFilter", (), {"filter": staticmethod(lambda r: "CancelledError" not in r.getMessage())})()
)

import uvicorn
import os
import sys
import json
import time
import uuid
import httpx
import asyncio
import traceback
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Depends, status, File, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import text
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# --- IMPORTURI MODULE LOCALE ---
import settings
settings.enforce_runtime_requirements(settings.CFG)
import storage
from storage import collection 
import brain
import home_assistant
import scheduler_service
import skills
import automation_definitions

# --- IMPORTURI PENTRU DB & AUTH (NOU) ---
import models
import database
import auth
import logger
from addons.entity_store import get_entity_store

# --- ROUTERS ---
from routers import ha as ha_router
from routers import skills_api as skills_router
from routers import memory as memory_router
from routers import users_auth as users_auth_router
from routers import config_profiles as config_profiles_router
from routers import automations_reminders as automations_reminders_router
from routers import shell_proposals as shell_proposals_router
from routers import cctv as cctv_router
from routers import sessions as sessions_router
from routers import notifications as notifications_router
from routers import notifications_push as notifications_push_router
from routers import notifications_ws as notifications_ws_router
from routers import openai_proxy as openai_proxy_router
from routers import ollama_proxy as ollama_proxy_router
from routers import conference as conference_router
from routers import whisper as whisper_router
from routers import piper as piper_router
from routers import comfyui as comfyui_router
from routers import entries as entries_router
from routers import addons as addons_router
from routers import integrations as integrations_router
from routers import pago as pago_router

from routers.ollama_proxy import list_models as ollama_list_models, chat_handle as ollama_chat_handle
from core.auto_router_stats import record_auto_router_usage
from core.chat_helpers import (
    build_llm_override,
    build_session_history,
    extract_json_payload_safe,
    select_profile_for_auto,
)
from core.log_stream import (
    _MAX_LOG_STREAMS,
    console,
    get_time,
    log_buffer,
    log_conversation_reply,
    log_conversation_start,
    log_detail,
    log_line,
    log_queues,
    print_banner,
)
from core.media_utils import (
    extract_document_text as _extract_document_text,
    extract_markdown_image_urls as _extract_markdown_image_urls,
    strip_markdown_images as _strip_markdown_images,
    waha_download_media_as_base64 as _waha_download_media_as_base64,
    waha_send_image as _waha_send_image,
)
from core.post_response import PostResponseManager
from core.request_media import validate_incoming_image_base64


# ---------------------------------------------------------------------------
# Pago entity context formatter (for AI system prompt injection)
# ---------------------------------------------------------------------------

def _format_pago_context(entities: dict) -> str:
    """Format Pago entity data into a concise AI-readable block.

    Uses the normalized data keys from pago_client (matching cnecrea/pagoplateste).
    """
    parts: list[str] = []

    # Profil
    profil = entities.get("profil")
    if isinstance(profil, dict) and not profil.get("error"):
        name = f"{profil.get('nume') or ''} {profil.get('prenume') or ''}".strip()
        if name:
            parts.append(f"Titular: {name}")

    # Abonament
    abon = entities.get("abonament")
    if isinstance(abon, dict) and not abon.get("error"):
        status = "activ" if abon.get("activ") else "inactiv"
        ramase = abon.get("plati_ramase")
        if ramase is not None:
            parts.append(f"Abonament: {status}, {ramase} plăți rămase")

    # Vehicule (with parsed alerts)
    vehicule = entities.get("vehicule")
    if isinstance(vehicule, list) and vehicule:
        cars = []
        for v in vehicule[:6]:
            plate = v.get("nr_inmatriculare") or ""
            if not plate:
                continue
            alerte = v.get("alerte") or {}
            tags = []
            rca = alerte.get("rca_expira")
            if rca:
                tags.append(f"RCA {rca[:10]}")
            itp = alerte.get("itp_expira")
            if itp:
                tags.append(f"ITP {itp[:10]}")
            label = plate
            if tags:
                label += f" ({', '.join(tags)})"
            cars.append(label)
        if cars:
            parts.append("Vehicule: " + "; ".join(cars))

    # Facturi emise
    facturi = entities.get("facturi")
    if isinstance(facturi, list) and facturi:
        total = sum((f.get("suma_datorata") or 0) for f in facturi)
        items = []
        for f in facturi[:8]:
            amount = f.get("suma_datorata")
            scadenta = f.get("scadenta") or ""
            desc = f"{amount:.2f} RON" if amount else "?"
            if scadenta:
                desc += f" (scadentă {scadenta})"
            items.append(desc)
        parts.append(f"Facturi ({len(facturi)}, total {total:.2f} RON): " + "; ".join(items))

    # Conturi furnizori
    conturi = entities.get("conturi_facturi")
    if isinstance(conturi, list) and conturi:
        items = []
        for c in conturi[:10]:
            fname = c.get("furnizor_nume") or c.get("furnizor") or "?"
            loc = c.get("locatie") or ""
            suma = c.get("ultima_plata_suma")
            desc = fname
            if loc:
                desc += f" ({loc})"
            if suma is not None:
                desc += f" ultima plată {suma:.2f} RON"
            items.append(desc)
        parts.append("Conturi furnizori: " + "; ".join(items))

    # Carduri
    carduri = entities.get("carduri")
    if isinstance(carduri, list) and carduri:
        cards = []
        for c in carduri[:6]:
            last4 = c.get("last4") or ""
            ctype = c.get("tip_card") or ""
            alias = c.get("alias") or ""
            if last4:
                label = f"****{last4}"
                if ctype:
                    label += f" {ctype}"
                if alias:
                    label += f" ({alias})"
                if c.get("default"):
                    label += " [Default]"
                cards.append(label)
        if cards:
            parts.append("Carduri: " + "; ".join(cards))

    # Plăți recente
    plati = entities.get("plati")
    if isinstance(plati, list) and plati:
        recent = []
        for p in plati[:8]:
            fname = p.get("furnizor_nume") or ""
            amount = p.get("suma") or p.get("suma_platita") or ""
            date = p.get("data") or ""
            tip = p.get("tip") or ""
            desc = fname or tip or "?"
            if amount:
                desc += f" {amount} RON"
            if date:
                desc += f" ({date[:10]})"
            recent.append(desc)
        if recent:
            parts.append("Plăți recente: " + "; ".join(recent))

    if not parts:
        return ""
    return "[Pago Plătește]\n" + "\n".join(parts)


# --- LIFESPAN (replaces deprecated on_event) ---
@asynccontextmanager
async def lifespan(app):
    """Startup / shutdown lifecycle for the FastAPI app."""
    # --- STARTUP ---
    # Store the main event loop so scheduler threads can send WebSocket notifications
    import main as _self_module
    _self_module._main_loop = asyncio.get_event_loop()
    
    print_banner()
    timeout = float(settings.CFG.get("llm", {}).get("timeout") or 120)
    app.state.http_client = httpx.AsyncClient(timeout=timeout)
    try:
        scheduler_service.start_scheduler()
        scheduler_service.schedule_consolidation_job()
        log_line("success", "⏰", "SCHEDULER", "Service started.")
    except Exception as e:
        log_line("error", "❌", "SCHEDULER", f"Failed: {e}")

    # Initialize entity store for integrations
    try:
        entity_store = get_entity_store()
        await entity_store.initialize_schema()
        log_line("success", "🔄", "ENTITIES", "Entity store initialized.")
    except Exception as e:
        log_line("error", "❌", "ENTITIES", f"Failed to initialize entity store: {e}")

    # Wire Pago entity sync (if enabled)
    try:
        pago_cfg = settings.CFG.get("pago") or {}
        if pago_cfg.get("enabled") and pago_cfg.get("email") and pago_cfg.get("password"):
            from pago_client import ensure_client
            from addons.entity_store import get_entity_store as _es
            client = await ensure_client()
            if client:
                store = _es()
                interval = max(int(pago_cfg.get("scan_interval", 3600)), 60)
                store.register_fetcher("pago", client.fetch_all, _format_pago_context)
                store.init_schedule("pago", interval)
                # Initial fetch
                try:
                    await store.do_sync("pago")
                    log_line("success", "📦", "PAGO SYNC", "Initial entity sync OK")
                except Exception as sync_err:
                    log_line("error", "⚠️", "PAGO SYNC", f"Initial sync failed: {sync_err}")
                await store.start_sync_loop("pago", interval)
    except Exception as e:
        log_line("error", "⚠️", "PAGO SYNC", f"Setup failed: {e}")

    # Start HA WebSocket real-time event listener
    try:
        from ha_websocket import ha_ws
        await ha_ws.start()
    except Exception as e:
        log_line("error", "⚠️", "HA WS", f"Failed to start: {e}")

    # Warm up LLM KV cache so the first user request doesn't pay cold-start penalty
    try:
        from brain.cortex import warmup_llm_cache
        asyncio.create_task(warmup_llm_cache())
    except Exception as e:
        log_line("error", "⚠️", "WARMUP", f"Failed to schedule: {e}")

    # Auto-start watchdog-enabled addons and begin watchdog loop
    try:
        from addons.process_manager import auto_start_watchdog_addons, start_watchdog
        await auto_start_watchdog_addons()
        await start_watchdog()
    except Exception as e:
        log_line("error", "⚠️", "WATCHDOG", f"Failed to start: {e}")

    # Migration: add default_profile_id to users if missing (per-user default model)
    try:
        db = next(database.get_db())
        try:
            r = db.execute(text("PRAGMA table_info(users)"))
            cols = [row[1] for row in r.fetchall()]
            if "default_profile_id" not in cols:
                db.execute(text("ALTER TABLE users ADD COLUMN default_profile_id VARCHAR"))
                db.commit()
                log_line("sys", "🔧", "MIGRATION", "Added users.default_profile_id")
            # Cleanup expired token revocations on startup
            from auth import cleanup_expired_revocations
            removed = cleanup_expired_revocations(db)
            if removed:
                log_line("sys", "🧹", "AUTH", f"Cleaned {removed} expired revoked tokens")
        finally:
            db.close()
    except Exception as e:
        log_line("error", "⚠️", "MIGRATION", str(e))

    yield  # application is running

    # --- SHUTDOWN ---
    # Stop HA WebSocket listener
    try:
        from ha_websocket import ha_ws
        await ha_ws.stop()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"ha_ws.stop: {e}")
    scheduler_service.stop_scheduler()
    if getattr(app.state, "http_client", None) is not None:
        await app.state.http_client.aclose()
    try:
        from llm_client import close_llm_client
        await close_llm_client()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"close_llm_client: {e}")
    try:
        await home_assistant.close_ha_client()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"close_ha_client: {e}")
    try:
        get_entity_store().stop_all_sync_loops()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"entity_store.stop_all: {e}")
    try:
        from addons.process_manager import stop_all
        await stop_all()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"process_manager.stop_all: {e}")
    try:
        storage.shutdown_storage()
    except Exception as e:
        log_line("error", "⚠️", "SHUTDOWN", f"storage.shutdown_storage: {e}")


limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])
app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter

# CORS: set CORS_ORIGINS env (comma-separated). If unset, allow only same-origin (empty list = no CORS preflight from other origins; credentials-safe).
_cors_raw = os.environ.get("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()] if _cors_raw else []
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
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
    # CSP: allow self + CDN origins used in index.html + inline for event handlers
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; "
        "frame-ancestors 'none'"
    )
    return response

@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(status_code=429, content={"detail": "Too many requests. Please slow down."})

# --- DATABASE SETUP ---
models.Base.metadata.create_all(bind=database.engine)
# Migrare: coloană persona_override pentru useri (dacă lipsește)
try:
    with database.engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN persona_override TEXT"))
        conn.commit()
except Exception:  # Column already exists — expected on subsequent starts
    pass

# Migrare: coloană notification_preferences pentru useri (dacă lipsește)
try:
    with database.engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN notification_preferences TEXT"))
        conn.commit()
except Exception:  # Column already exists — expected on subsequent starts
    pass

# Migrare: coloane evenimente planner (dacă lipsesc)
for _sql in [
    "ALTER TABLE entries ADD COLUMN event_color VARCHAR",
    "ALTER TABLE entries ADD COLUMN event_notify BOOLEAN",
    "ALTER TABLE entries ADD COLUMN event_notify_minutes INTEGER",
    "ALTER TABLE entries ADD COLUMN event_notify_job_id VARCHAR",
]:
    try:
        with database.engine.connect() as conn:
            conn.execute(text(_sql))
            conn.commit()
    except Exception:
        pass

# Migrare: convertire mementos → events (tip eliminat din UI)
try:
    with database.engine.connect() as conn:
        conn.execute(text("UPDATE entries SET entry_type = 'event' WHERE entry_type = 'memento'"))
        conn.commit()
except Exception:
    pass

try:
    db = next(database.get_db())
    try:
        automation_definitions.backfill_yaml_files_from_db(db)
    finally:
        db.close()
except Exception as e:
    log_line("error", "⚠️", "AUTOMATION", f"YAML storage bootstrap failed: {e}")


def extract_json_payload(text):
    return extract_json_payload_safe(text, log_line)

# --- HTTP LOGGING ---
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = (time.time() - start_time) * 1000
    if "/api/logs" not in request.url.path and "/static/" not in request.url.path and "/api/notifications/check" not in request.url.path:
        verbose = bool((settings.CFG or {}).get("verbose_logging"))
        # Compact mode: hide noisy successful access logs; keep HTTP errors.
        if verbose or response.status_code >= 400:
            log_line("dim", "🌐", "HTTP", f"{request.method} {request.url.path} → {response.status_code} ({process_time:.0f}ms)")
    return response

if not os.path.exists("static"):
    os.makedirs("static/css", exist_ok=True)
    os.makedirs("static/js", exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript")
templates = Jinja2Templates(directory="templates")

# --- Force no-cache on JS/CSS so browser always picks up latest code ---
_APP_START_TS = str(int(time.time()))

@app.middleware("http")
async def no_cache_static_assets(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") and (path.endswith(".js") or path.endswith(".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# --- OLLAMA COMPAT (for HA integration: base URL = http://bridge:8082 → GET /api/tags)
@app.get("/api/tags")
async def api_tags():
    return await ollama_list_models()

# --- THEMES ---
@app.get("/api/themes")
async def api_themes():
    """List available themes from the static/css/themes/ directory."""
    themes = []
    themes_dir = os.path.join("static", "css", "themes")
    if os.path.isdir(themes_dir):
        for fname in sorted(os.listdir(themes_dir)):
            if fname.endswith(".json"):
                fpath = os.path.join(themes_dir, fname)
                try:
                    import json as _json
                    with open(fpath, "r") as f:
                        meta = _json.load(f)
                    themes.append(meta)
                except Exception as e:
                    log_line("error", "⚠️", "THEMES", f"Failed to load {fname}: {e}")
    return themes

# --- REGISTER ROUTERS ---
app.include_router(ha_router.router)
app.include_router(skills_router.router)
app.include_router(memory_router.router)
app.include_router(users_auth_router.router)
app.include_router(config_profiles_router.router)
app.include_router(automations_reminders_router.router)
app.include_router(shell_proposals_router.router)
app.include_router(cctv_router.router)
app.include_router(sessions_router.router)
app.include_router(notifications_router.router)
app.include_router(notifications_push_router.router)
app.include_router(notifications_ws_router.router)
app.include_router(openai_proxy_router.router)
app.include_router(ollama_proxy_router.router)
app.include_router(whisper_router.router)
app.include_router(piper_router.router)
app.include_router(comfyui_router.router)
app.include_router(conference_router.router)
app.include_router(entries_router.router)
app.include_router(addons_router.router)
app.include_router(integrations_router.router)
app.include_router(pago_router.router)


# Bounded WhatsApp context: max 5000 chats, evict oldest (LRU)
def _make_bounded_whatsapp_store(maxsize: int = 5000):
    from collections import OrderedDict
    class BoundedContextStore(OrderedDict):
        def __setitem__(self, key, value):
            if key in self:
                self.move_to_end(key)
            else:
                while len(self) >= maxsize and self:
                    self.popitem(last=False)
            super().__setitem__(key, value)
    return BoundedContextStore()
whatsapp_context_store = _make_bounded_whatsapp_store()
whatsapp_context_lock = asyncio.Lock()

# --- MODIFIED CHAT REQUEST (validare input: limite lungime) ---
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=0, max_length=50000)
    session_id: Optional[str] = Field(None, max_length=128)
    token: Optional[str] = Field(None, max_length=2048)
    image: Optional[str] = Field(None, max_length=4_000_000)  # base64 (fără data URL prefix) pentru modele vision
    document_text: Optional[str] = Field(None, max_length=200_000)  # text extras din document atașat (PDF, DOCX, TXT)


# --- AUTHENTICATION ROUTES (ENTERPRISE) ---

@app.post("/api/token")
@limiter.limit("10/minute")
async def login_for_access_token(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == form_data.username).first()
    if not user or not auth.verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = auth.create_access_token(data={"sub": user.username})
    refresh_token = auth.create_refresh_token(data={"sub": user.username})
    log_line("sys", "🔑", "LOGIN", f"User '{user.username}' logged in.")
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "is_admin": user.is_admin,
        "expires_in": auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


@app.post("/api/token/refresh")
@limiter.limit("30/minute")
async def refresh_access_token(request: Request, db: Session = Depends(database.get_db)):
    """Exchange a valid refresh token for a new access + refresh token pair."""
    body = await request.json()
    token = (body.get("refresh_token") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="refresh_token required")
    payload = auth.verify_refresh_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    username = payload["sub"]
    # Check revocation
    jti = payload.get("jti", "")
    if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
        raise HTTPException(status_code=401, detail="Token revoked")
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    # Revoke old refresh token (single-use rotation)
    auth.revoke_token(token, db)
    new_access = auth.create_access_token(data={"sub": username})
    new_refresh = auth.create_refresh_token(data={"sub": username})
    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
        "expires_in": auth.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }


@app.post("/api/token/sse")
async def get_sse_exchange_token(current_user: models.User = Depends(auth.get_current_user)):
    """Get a short-lived (30s) single-use token for SSE/WebSocket connections.

    This avoids passing the long-lived JWT in query params where it would
    appear in server logs, browser history, and proxy logs.
    """
    token = auth.create_sse_exchange_token(current_user.username)
    return {"sse_token": token, "expires_in": auth.SSE_EXCHANGE_TOKEN_EXPIRE_SECONDS}


# --- ROUTES ---
@app.get("/", response_class=HTMLResponse)
async def read_dashboard(request: Request): 
    response = templates.TemplateResponse("index.html", {"request": request, "cache_bust": _APP_START_TS, "app_version": settings.APP_VERSION})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    return response

@app.get("/api/health")
async def get_health(db: Session = Depends(database.get_db)):
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
            r = await app.state.http_client.get(waha_cfg["api_url"].rstrip("/") + "/", timeout=2.5)
            health["waha"]["reachable"] = r.status_code < 500
        except Exception:
            health["waha"]["reachable"] = False
    llm = cfg.get("llm") or {}
    health["llm"]["configured"] = bool(llm.get("target_url") and llm.get("model_name"))
    # Don't expose internal URLs/model names to unauthenticated callers
    return JSONResponse(status_code=200 if overall_ok else 503, content=health)


# ── SLASH COMMANDS (terminal-style commands from chat) ───────────────
class SlashRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=200)
    session_id: Optional[str] = Field(None, max_length=128)

SLASH_COMMANDS = {
    "/restart":  {"desc": "Restart the server",              "admin": True},
    "/stop":     {"desc": "Stop the server",                 "admin": True},
    "/clear":    {"desc": "Clear current session context",   "admin": False},
    "/new":      {"desc": "Start a new chat session",        "admin": False},
    "/version":  {"desc": "Show app version",                "admin": False},
    "/status":   {"desc": "Show system health summary",      "admin": False},
    "/compact":  {"desc": "Summarize session context (optional: /compact <topic>)",  "admin": False},
    "/persona":  {"desc": "Switch AI persona (usage: /persona <name> or /persona list)", "admin": False},
    "/help":     {"desc": "List available slash commands",    "admin": False},
}

@app.get("/api/slash/commands")
async def list_slash_commands(current_user: models.User = Depends(auth.get_current_user)):
    """Return the list of available slash commands for autocomplete."""
    is_admin = getattr(current_user, "is_admin", False)
    cmds = []
    for cmd, meta in SLASH_COMMANDS.items():
        if meta["admin"] and not is_admin:
            continue
        cmds.append({"command": cmd, "description": meta["desc"], "admin": meta["admin"]})
    return cmds

@app.post("/api/slash")
async def execute_slash_command(
    req: SlashRequest,
    request: Request,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    """Execute a slash command issued from the chat input."""
    raw = req.command.strip()
    parts = raw.split(None, 1)
    cmd = parts[0].lower() if parts else ""
    is_admin = getattr(current_user, "is_admin", False)

    if cmd not in SLASH_COMMANDS:
        return JSONResponse(content={"ok": False, "message": f"Unknown command: `{cmd}`\nType /help for a list of commands."})

    meta = SLASH_COMMANDS[cmd]
    if meta["admin"] and not is_admin:
        return JSONResponse(status_code=403, content={"ok": False, "message": "🔒 Admin access required."})

    # ── /help ────────────────────────────────────────────────────
    if cmd == "/help":
        lines = ["**Available commands:**\n"]
        for c, m in SLASH_COMMANDS.items():
            if m["admin"] and not is_admin:
                continue
            tag = " 🔒" if m["admin"] else ""
            lines.append(f"`{c}` — {m['desc']}{tag}")
        return {"ok": True, "message": "\n".join(lines)}

    # ── /version ─────────────────────────────────────────────────
    if cmd == "/version":
        return {"ok": True, "message": f"**Memini** v{settings.APP_VERSION}"}

    # ── /status ──────────────────────────────────────────────────
    if cmd == "/status":
        health = (await get_health(db)).body
        h = json.loads(health)
        parts_out = [
            f"**System status:** {'✅ OK' if h.get('status') == 'ok' else '⚠️ Degraded'}",
            f"Database: {'✅' if h.get('db') else '❌'}",
            f"Memory (Chroma): {h.get('chroma', '?')}",
            f"Scheduler: {h.get('scheduler', '?')}",
            f"LLM: {h.get('llm', {}).get('model_name') or 'not configured'}",
        ]
        return {"ok": True, "message": "\n".join(parts_out)}

    # ── /clear ───────────────────────────────────────────────────
    if cmd == "/clear":
        return {"ok": True, "message": "🧹 Context cleared.", "action": "clear_context"}

    # ── /new ─────────────────────────────────────────────────────
    if cmd == "/new":
        return {"ok": True, "message": "📂 New session started.", "action": "new_session"}

    # ── /restart ─────────────────────────────────────────────────
    if cmd == "/restart":
        async def _do_restart():
            await asyncio.sleep(0.5)
            console.print("")
            console.rule("[bold red]SYSTEM RESTART[/]")
            log_line("error", "🔄", "COMMAND", f"Restart via /restart by {current_user.username}")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        asyncio.get_event_loop().call_later(0.5, lambda: asyncio.ensure_future(_do_restart()))
        return {"ok": True, "message": "🔄 Restarting server…", "action": "restart"}

    # ── /stop ────────────────────────────────────────────────────
    if cmd == "/stop":
        import signal
        async def _do_stop():
            await asyncio.sleep(0.5)
            console.print("")
            console.rule("[bold red]SERVER STOP[/]")
            log_line("error", "🛑", "COMMAND", f"Stop via /stop by {current_user.username}")
            os.kill(os.getpid(), signal.SIGTERM)
        asyncio.get_event_loop().call_later(0.5, lambda: asyncio.ensure_future(_do_stop()))
        return {"ok": True, "message": "🛑 Server shutting down…", "action": "stop"}

    # ── /compact [topic] ─────────────────────────────────────────
    if cmd == "/compact":
        topic_hint = parts[1].strip() if len(parts) > 1 else ""
        sid = req.session_id
        if not sid:
            return {"ok": True, "message": "⚠️ No active session to compact."}
        session = storage.get_session(sid)
        if not session or not session.get("messages"):
            return {"ok": True, "message": "⚠️ Session is empty — nothing to compact."}
        msgs = session["messages"]
        summary = await brain.summarize_conversation(msgs)
        if topic_hint:
            summary = f"[Focus: {topic_hint}] {summary}"
        if summary:
            session["summary"] = summary
            storage.save_session(sid, session)
            return {"ok": True, "message": f"📋 **Session compacted.**\n\n{summary}"}
        return {"ok": True, "message": "⚠️ Could not generate summary. Try again later."}

    # ── /persona [name|list] ─────────────────────────────────────
    if cmd == "/persona":
        arg = parts[1].strip().lower() if len(parts) > 1 else ""
        personas = settings.CFG.get("personas") or {}
        if not personas:
            return {"ok": True, "message": "No personas configured. Add `personas` to config.json.\n\nExample:\n```json\n\"personas\": {\n  \"casual\": { \"label\": \"Casual\", \"system_note\": \"Be relaxed and friendly.\" },\n  \"formal\": { \"label\": \"Formal\", \"system_note\": \"Be professional and concise.\" }\n}\n```"}
        if not arg or arg == "list":
            active = settings.CFG.get("active_persona") or "default"
            lines = ["**Available personas:**\n"]
            lines.append(f"`default` — Default persona {'✅' if active == 'default' else ''}")
            for k, v in personas.items():
                label = v.get("label", k)
                marker = " ✅" if active == k else ""
                lines.append(f"`{k}` — {label}{marker}")
            lines.append(f"\nUsage: `/persona <name>` to switch.")
            return {"ok": True, "message": "\n".join(lines)}
        if arg == "default":
            settings.CFG["active_persona"] = "default"
            settings.save_config(settings.CFG)
            return {"ok": True, "message": "🎭 Switched to **default** persona."}
        if arg not in personas:
            return {"ok": True, "message": f"❌ Unknown persona `{arg}`. Use `/persona list` to see available options."}
        settings.CFG["active_persona"] = arg
        settings.save_config(settings.CFG)
        label = personas[arg].get("label", arg)
        return {"ok": True, "message": f"🎭 Switched to **{label}** persona."}

    return JSONResponse(content={"ok": False, "message": f"Command `{cmd}` not implemented yet."})


@app.post("/api/restart")
def restart_server(_: models.User = Depends(auth.get_current_admin)):
    console.print("")
    console.rule("[bold red]SYSTEM RESTART[/]")
    log_line("error", "🔄", "COMMAND", "Restart sequence initiated...")
    os.execv(sys.executable, [sys.executable] + sys.argv)

@app.get("/api/logs")
async def stream_logs(request: Request, token: Optional[str] = None, db: Session = Depends(database.get_db)):
    # SSE (EventSource) can't send headers — accept exchange token or regular JWT as query param
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        # Try short-lived SSE exchange token first
        sse_payload = auth.verify_sse_exchange_token(token)
        if sse_payload:
            username = sse_payload["sub"]
        else:
            # Fall back to regular JWT (backward compat)
            payload = auth.jwt.decode(token, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])
            username = payload.get("sub")
            if not username:
                raise HTTPException(status_code=401, detail="Invalid token")
            # Check token not revoked
            jti = payload.get("jti", "")
            if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
                raise HTTPException(status_code=401, detail="Token revoked")
        # Verify user still exists and is admin
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
            yield f"data: {json.dumps('🔌 Connected to log stream')}\n\n"
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

# --- MEMORY ROUTES → routers/memory.py ---

@app.post("/api/webhook/waha")
@limiter.limit("60/minute")
async def waha_hook(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(database.get_db)):
    # HMAC signature verification (if secret configured)
    waha_secret = os.environ.get("WAHA_WEBHOOK_SECRET", "").strip()
    if waha_secret:
        import hmac, hashlib
        sig_header = request.headers.get("x-webhook-hmac-sha256") or request.headers.get("x-hub-signature-256") or ""
        body_bytes = await request.body()
        expected = hmac.new(waha_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig_header.replace("sha256=", ""), expected):
            log_line("error", "🔒", "WAHA_HMAC", "Invalid webhook signature")
            raise HTTPException(status_code=403, detail="Invalid signature")
    cfg = settings.CFG
    if not cfg.get("waha", {}).get("enabled"): return {"status": "ignored"}
    try:
        data = await request.json()
        payload = data.get("payload", {})
        if payload.get("fromMe"):
            return {"status": "ignored"}
        chat_id = payload.get("from")
        user_msg = (payload.get("body") or "").strip()
        has_media = payload.get("hasMedia") and payload.get("media")
        media = payload.get("media") or {}
        media_url = media.get("url")
        media_mimetype = (media.get("mimetype") or "").lower()

        # Debug: de ce ignorăm (poze fără caption sau media neîn descărcat)
        if not user_msg and not (has_media and media_url):
            event = data.get("event", "?")
            reason = f"event={event} – no text and no media URL"
            if payload.get("hasMedia") and not media_url:
                reason += " (hasMedia=True but media.url missing – check WAHA media storage)"
            log_line("sys", "📩", "WAHA IGNORED", reason)
            return {"status": "ignored"}

        image_base64 = None
        if has_media and media_url and media_mimetype.startswith("image/"):
            image_base64 = await _waha_download_media_as_base64(media_url, media_mimetype, cfg, app.state.http_client, log_line)
            if image_base64:
                log_line("user_head", "🖼", "WAHA IMAGE", f"Downloaded image ({len(image_base64)} b64 chars)")
            elif media_url:
                log_line("error", "🖼", "WAHA IMAGE", "Download failed or not image")
        if not user_msg and not image_base64:
            log_line("sys", "📩", "WAHA IGNORED", "image download failed or not image/*")
            return {"status": "ignored"}

        # Whitelist: config + numere legate de useri (DB)
        allowed = set(cfg.get("security", {}).get("allowed_numbers", []))
        for p in db.query(models.PhoneNumber).all():
            allowed.add(p.waha_id)
            allowed.add(p.number.replace(" ", "").strip() if p.number else "")
        if cfg.get("security", {}).get("whitelist_enabled") and allowed:
            if chat_id not in allowed and chat_id.split("@")[0] not in allowed:
                return {"status": "blocked"}

        # --- IDENTITY CHECK ---
        unified_user_id = chat_id
        phone_entry = db.query(models.PhoneNumber).filter(models.PhoneNumber.waha_id == chat_id).first()
        if phone_entry:
            unified_user_id = f"user_{phone_entry.user_id}"
            log_line("success", "🔗", "AUTH", f"Message linked to Account ID: {unified_user_id} ({phone_entry.owner.username})")

        log_conversation_start("whatsapp", unified_user_id, user_msg or "[image]", has_image=bool(image_base64))

        # Comandă /clear: șterge contextul conversației (istoric + context HA) și răspunde scurt
        if (user_msg or "").strip().lower() == "/clear":
            async with whatsapp_context_lock:
                whatsapp_context_store[chat_id] = []
            async with brain.CONTEXT_LOCK:
                brain.USER_CONTEXT.pop(unified_user_id, None)
            log_line("mem", "🗑️", "CONTEXT", f"Cleared for WhatsApp {chat_id}")
            prompts_cfg = cfg.get("prompts") or {}
            clear_reply = prompts_cfg.get("clear_context_message") or "Context cleared. Conversation starts from scratch."
            url = f"{cfg['waha']['api_url']}/api/sendText"
            headers = {"Content-Type": "application/json", "X-Api-Key": cfg['waha'].get('api_key', '')}
            auth = (cfg['waha']['username'], cfg['waha']['password']) if cfg['waha'].get('username') else None
            try:
                await app.state.http_client.post(url, json={"chatId": chat_id, "text": clear_reply, "session": "default"}, headers=headers, auth=auth, timeout=10)
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
            return {"status": "ok"}

        async with whatsapp_context_lock:
            history = list(whatsapp_context_store.get(chat_id, []))
        persona = phone_entry.owner.persona_override if phone_entry else None
        ai_text, _ = await brain.generate_response(user_msg or "", history, unified_user_id, persona_override=persona, conversation_summary=None, image_base64=image_base64)
        ai_text = brain.strip_think(ai_text or "")

        # Extrage imagini markdown ![alt](url) și trimite-le ca poze pe WhatsApp; textul rămas ca mesaj text
        image_urls = _extract_markdown_image_urls(ai_text, log_line)
        text_to_send = _strip_markdown_images(ai_text)

        url = f"{cfg['waha']['api_url']}/api/sendText"
        headers = {"Content-Type": "application/json", "X-Api-Key": cfg['waha'].get('api_key', '')}
        auth = (cfg['waha']['username'], cfg['waha']['password']) if cfg['waha'].get('username') else None

        _http = app.state.http_client
        # 1. Trimite textul (fără blocuri de imagine)
        if text_to_send:
            try:
                await _http.post(url, json={"chatId": chat_id, "text": text_to_send, "session": "default"}, headers=headers, auth=auth, timeout=15.0)
                log_line("user_head", "🚀", "DELIVERED", "Text sent.")
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
        # 2. Trimite fiecare imagine cu sendImage (WAHA Plus); la 422 trimitem linkurile ca text
        plus_required = False
        for _alt, img_url in image_urls:
            result = await _waha_send_image(chat_id, img_url, None, cfg, app.state.http_client, log_line)
            if result == "plus_required":
                plus_required = True
                break
        if plus_required and image_urls:
            links_msg = "Imagini (deschide linkurile):\n" + "\n".join(url for _, url in image_urls)
            try:
                await _http.post(url, json={"chatId": chat_id, "text": links_msg, "session": "default"}, headers=headers, auth=auth, timeout=15.0)
            except Exception as e:
                log_line("error", "❌", "SEND FAIL", str(e))
            if image_urls and not text_to_send and not plus_required:
                log_line("user_head", "🚀", "DELIVERED", f"Image(s) sent ({len(image_urls)}).")
            elif image_urls:
                log_line("user_head", "🚀", "DELIVERED", f"Text + {len(image_urls)} image(s) sent." if not plus_required else "Text + image links sent (Plus required for inline images).")

        user_content_for_history = user_msg if user_msg else ("[Imagine]" if image_base64 else "")
        clean_ai_text = brain.strip_think(ai_text)
        history.append({"role": "user", "content": user_content_for_history})
        history.append({"role": "assistant", "content": clean_ai_text})
        async with whatsapp_context_lock:
            whatsapp_context_store[chat_id] = history[-10:]
        log_conversation_reply(ai_text, profile_name=settings.get_active_profile_name())
        try:
            from task_utils import create_tracked_task
            create_tracked_task(brain.process_memory_pipeline(user_msg or user_content_for_history, unified_user_id, clean_ai_text, history), name="memory_pipeline_wa")
        except Exception:
            # Fallback: schedule via background tasks if create_task fails
            try:
                background_tasks.add_task(brain.process_memory_pipeline, user_msg or user_content_for_history, unified_user_id, clean_ai_text, history)
            except Exception:
                log_line("error", "⚠️", "MEMORY", "Failed to schedule memory pipeline")
        return {"status": "ok"}
    except Exception as e:
        log_line("error", "⚠️", "EXCEPTION", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})

post_response_manager = PostResponseManager(log_line)


@app.post("/api/extract-document")
@limiter.limit("20/minute")
async def api_extract_document(request: Request, file: UploadFile = File(...), _: models.User = Depends(auth.get_current_user)):
    """Extract text from uploaded PDF, TXT, or DOCX. Returns { \"text\": \"...\" }."""
    try:
        data = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}")
    if len(data) > 10 * 1024 * 1024:  # 10 MB
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")
    try:
        text = _extract_document_text(data, file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return JSONResponse(content={"text": text})


# --- WEB CHAT (AUTH SUPPORT) ---
@app.post("/api/chat")
@limiter.limit("30/minute")
async def api_chat(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(database.get_db)):
    """Single /api/chat: Ollama-format (HA Assist) → proxy; else Bridge web chat."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    # HA Ollama/Assist sends { model, messages, stream, tools, ... }
    if isinstance(body.get("messages"), list) and body.get("model") is not None:
        return await ollama_chat_handle(request, body)
    # Bridge web UI sends { message, session_id?, token?, image? }
    try:
        req = ChatRequest(
            message=body.get("message") or "",
            session_id=body.get("session_id"),
            token=body.get("token"),
            image=body.get("image"),
            document_text=body.get("document_text"),
        )
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid chat request body")
    return await chat_web_impl(request, req, background_tasks, db)


async def chat_web_impl(request: Request, req: ChatRequest, background_tasks: BackgroundTasks, db: Session):
    try:
        token = req.token or (request.headers.get("Authorization") or "").replace("Bearer ", "").strip()
        user_obj = None
        if token:
            try:
                from jose import jwt
                payload = jwt.decode(token, auth.SECRET_KEY, algorithms=[auth.ALGORITHM])
                username = payload.get("sub")
                if username:
                    # Check token revocation
                    jti = payload.get("jti", "")
                    if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
                        raise HTTPException(status_code=401, detail="Token revoked")
                    user_obj = db.query(models.User).filter(models.User.username == username).first()
            except HTTPException:
                raise
            except Exception:  # Invalid/expired token — reject
                raise HTTPException(status_code=401, detail="Invalid or expired token")

        if not user_obj:
            raise HTTPException(status_code=401, detail="Authentication required")

        session_user_id = user_obj.id
        session = storage.get_session(req.session_id) if req.session_id else None
        if session and session.get("user_id") is not None and session.get("user_id") != session_user_id:
            session = None
        if not session:
            session = storage.create_session(user_id=session_user_id)
            log_line("sys", "📂", "SESSION", f"New session {session['id'][:8]}... for user_id={session_user_id or 'anon'}")

        user_id = f"user_{user_obj.id}" if user_obj else f"web_{session['id'][:8]}"
        # Prepend attached document text so the model has full context
        effective_message = (req.message or "").strip()
        if (req.document_text or "").strip():
            effective_message = ("User attached a document:\n\n" + (req.document_text or "").strip() + "\n\n" + effective_message).strip()
        msg_preview = effective_message[:80] or ("[image]" if req.image else "")
        working_window = settings.CFG.get("memory", {}).get("working_window", 12)
        # Include full message structure (tool_calls, tool role) so the model sees prior tool-use
        history = build_session_history(session["messages"], working_window)
        log_conversation_start("web", user_id, effective_message or "[image]", has_image=bool(req.image))
        log_detail("api", "CHAT_START", session_id=session["id"], user_id=user_id, msg_len=len(req.message or ""), has_image=bool(req.image), history_len=len(history))
        conversation_summary = session.get("summary") or ""
        persona = user_obj.persona_override if user_obj else None

        # Per-user default profile: use it for this request if set
        llm_override = None
        effective_profile_name = None
        is_auto_selection = False
        ordered_auto_ids = []
        profile = None
        if user_obj and getattr(user_obj, "default_profile_id", None):
            profiles = settings.CFG.get("model_profiles") or []
            profile_id_to_use = user_obj.default_profile_id
            if (profile_id_to_use or "").strip().lower() == "auto":
                ordered_auto_ids, auto_reason = select_profile_for_auto(
                    has_image=bool(req.image),
                    has_document=bool((req.document_text or "").strip()),
                    profiles=profiles,
                    message_length=len(req.message or ""),
                    history_message_count=len(history),
                )
                profile_id_to_use = ordered_auto_ids[0] if ordered_auto_ids else None
                if profile_id_to_use:
                    log_detail("api", "AUTO_PROFILE", profile_id=profile_id_to_use, reason=auto_reason)
                    is_auto_selection = True
            profile = next((p for p in profiles if p.get("id") == profile_id_to_use), None) if profile_id_to_use else None
            if profile:
                llm_override = build_llm_override(profile)
                effective_profile_name = (profile.get("name") or "").strip() or (profile.get("model_name") or "?")
                profile_persona = (profile.get("persona_override") or "").strip() or None
                if profile_persona:
                    persona = profile_persona
        if effective_profile_name is None:
            effective_profile_name = settings.get_active_profile_name()

        sec_cfg = settings.CFG.get("security") or {}
        max_image_bytes = int(sec_cfg.get("uploaded_image_max_bytes") or 3_000_000)
        req.image = validate_incoming_image_base64(req.image, max_bytes=max_image_bytes)

        # ── TIER 1: Regex fast-path (instant, single command) ────────
        direct_reply = None
        if not req.image and not (req.document_text or "").strip() and effective_message and len(effective_message) <= 250:
            try:
                from direct_commands import try_regex_command
                direct_reply = await try_regex_command(effective_message, user_id)
            except Exception as e:
                log_line("error", "⚠️", "REGEX_CMD", str(e))

        # ── Intent router: classify message ──────────────────────────
        routed_intent = None
        if direct_reply is None and effective_message:
            try:
                from intent_router import classify_intent, INTENT_DEVICE_CONTROL
                routed_intent, router_ms = await classify_intent(
                    effective_message,
                    has_image=bool(req.image),
                    has_document=bool((req.document_text or "").strip()),
                )
            except Exception as e:
                log_line("error", "⚠️", "INTENT_ROUTER", str(e))

        # ── TIER 2: Semantic extraction (only if device_control) ─────
        if direct_reply is None and routed_intent == "device_control":
            try:
                from direct_commands import try_semantic_commands
                direct_reply = await try_semantic_commands(effective_message, user_id)
            except Exception as e:
                log_line("error", "⚠️", "SEMANTIC_CMD", str(e))

        # ── COMPOUND: mixed device + other intent ────────────────────
        compound_ha_reply = None
        if direct_reply is None and routed_intent == "compound":
            # Try Tier 1 (regex) on the full message — it can extract device parts
            try:
                from direct_commands import try_regex_command
                compound_ha_reply = await try_regex_command(effective_message, user_id)
            except Exception:
                pass
            # If regex didn't find anything, try Tier 2 (semantic)
            if not compound_ha_reply:
                try:
                    from direct_commands import try_semantic_commands
                    compound_ha_reply = await try_semantic_commands(effective_message, user_id)
                except Exception:
                    pass
            # Don't set direct_reply — let the agent handle the rest
            # The HA result will be prepended to the agent's response
            routed_intent = "complex"  # fall through to agent for the non-HA part

        async def response_generator():
            full_response = ""
            full_thinking = ""
            history_messages = None
            last_search_sources = []
            last_forge_preview = ""
            last_forge_preview_language = "python"
            used_profile_color = (profile.get("color") or "").strip() or "#38bdf8" if profile else None
            used_model_name = effective_profile_name or ""
            used_model_id = (profile.get("model_name") or "").strip() if profile else ""

            # Human-like streaming pacing (configurable delay between chunks)
            _pacing_cfg = (settings.CFG.get("intelligence") or {})
            _stream_pace_ms = float(_pacing_cfg.get("stream_pace_ms", 0) or 0)
            _stream_pace_sec = max(0.0, _stream_pace_ms / 1000.0) if _stream_pace_ms > 0 else 0.0

            if direct_reply is not None:
                # Răspuns direct (comandă aprinde/stinge etc.) — fără agent
                full_response = direct_reply
                yield f"event: chunk\ndata: {json.dumps(direct_reply, ensure_ascii=False)}\n\n"
                yield f"event: final_message\ndata: {json.dumps({'thinking': '', 'content': direct_reply, 'model': used_model_name, 'model_id': used_model_id}, ensure_ascii=False)}\n\n"
            else:
                # If compound intent resolved HA commands, prepend that to the stream
                if compound_ha_reply:
                    ha_prefix = compound_ha_reply + "\n\n"
                    full_response += ha_prefix
                    yield f"event: chunk\ndata: {json.dumps(ha_prefix, ensure_ascii=False)}\n\n"
                used_auto_profile_id = None
                last_fallback_error = None
                if is_auto_selection and ordered_auto_ids:
                    for profile_id in ordered_auto_ids:
                        profile_try = next((p for p in profiles if p.get("id") == profile_id), None)
                        if not profile_try:
                            continue
                        try_override = build_llm_override(profile_try)
                        try_persona = (profile_try.get("persona_override") or "").strip() or persona
                        try:
                            async for chunk in brain.generate_response_stream(
                                effective_message, history, user_id,
                                persona_override=try_persona,
                                conversation_summary=conversation_summary,
                                image_base64=req.image,
                                llm_override=try_override,
                                is_anonymous=(user_obj is None),
                                routed_intent=routed_intent,
                            ):
                                if isinstance(chunk, dict):
                                    if chunk.get("t") == "history_messages":
                                        history_messages = chunk.get("messages", [])
                                        continue
                                    if chunk.get("t") == "thinking":
                                        c = chunk.get("content", "") or ""
                                        full_thinking += c
                                        yield f"event: thinking\ndata: {json.dumps({'content': c}, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "status":
                                        payload = {"type": chunk.get("type", ""), "label": chunk.get("label", "")}
                                        if chunk.get("labelKey") is not None:
                                            payload["labelKey"] = chunk["labelKey"]
                                        if chunk.get("params"):
                                            payload["params"] = chunk["params"]
                                        yield f"event: status\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_done":
                                        yield f"event: shell_done\ndata: {json.dumps({'command': chunk.get('command', ''), 'exit_code': chunk.get('exit_code'), 'output_preview': chunk.get('output_preview', '')}, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_request":
                                        yield f"event: shell_request\ndata: {json.dumps({'command': chunk.get('command', '')}, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "shell_suggest":
                                        yield f"event: shell_suggest\ndata: {json.dumps({'command': chunk.get('command', ''), 'reason': chunk.get('reason', '')}, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "proposal":
                                        yield f"event: proposal\ndata: {json.dumps(chunk.get('proposal', {}), ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "metrics":
                                        payload = {"completion_tokens": chunk.get("completion_tokens"), "prompt_tokens": chunk.get("prompt_tokens"), "total_tokens": chunk.get("total_tokens"), "ttft_ms": chunk.get("ttft_ms"), "llm_elapsed_ms": chunk.get("llm_elapsed_ms"), "total_elapsed_ms": chunk.get("total_elapsed_ms")}
                                        yield f"event: metrics\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "clear_content":
                                        full_response = ""
                                        yield f"event: clear_content\ndata: {{}}\n\n"
                                        continue
                                    if chunk.get("t") == "search_sources":
                                        sources = chunk.get('sources', [])
                                        if isinstance(sources, list):
                                            last_search_sources = sources
                                        yield f"event: search_sources\ndata: {json.dumps({'sources': chunk.get('sources', [])}, ensure_ascii=False)}\n\n"
                                        continue
                                    if chunk.get("t") == "forge_preview":
                                        last_forge_preview = chunk.get('content', '') or ""
                                        last_forge_preview_language = chunk.get('language', 'python') or 'python'
                                        yield f"event: forge_preview\ndata: {json.dumps({'content': chunk.get('content', ''), 'language': chunk.get('language', 'python'), 'done': bool(chunk.get('done'))}, ensure_ascii=False)}\n\n"
                                        continue
                                full_response += chunk
                                if _stream_pace_sec > 0:
                                    await asyncio.sleep(_stream_pace_sec)
                                yield f"event: chunk\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                            think_part, content_part = brain.strip_think_content(full_response)
                            if full_thinking.strip():
                                think_part = (think_part.strip() + "\n\n" + full_thinking.strip()).strip() if think_part.strip() else full_thinking.strip()
                            yield f"event: final_message\ndata: {json.dumps({'thinking': think_part, 'content': content_part, 'model': (profile_try.get('name') or profile_try.get('model_name') or '').strip(), 'model_id': (profile_try.get('model_name') or '').strip()}, ensure_ascii=False)}\n\n"
                            used_auto_profile_id = profile_id
                            used_model_name = (profile_try.get("name") or profile_try.get("model_name") or "").strip()
                            used_model_id = (profile_try.get("model_name") or "").strip()
                            used_profile_color = (profile_try.get("color") or "").strip() or "#38bdf8"
                            if used_profile_color:
                                yield f"event: profile_color\ndata: {json.dumps({'color': used_profile_color}, ensure_ascii=False)}\n\n"
                            break
                        except Exception as e:
                            last_fallback_error = e
                            log_detail("api", "AUTO_FALLBACK", profile_id=profile_id, error=str(e))
                            continue
                    if used_auto_profile_id:
                        p_used = next((x for x in profiles if x.get("id") == used_auto_profile_id), None)
                        if p_used:
                            record_auto_router_usage("local" if (p_used.get("provider") or "").strip().lower() == "local" else "api")
                    elif last_fallback_error is not None:
                        raise last_fallback_error
                if not (is_auto_selection and ordered_auto_ids):
                    if used_profile_color:
                        yield f"event: profile_color\ndata: {json.dumps({'color': used_profile_color}, ensure_ascii=False)}\n\n"
                    async for chunk in brain.generate_response_stream(
                            effective_message, history, user_id,
                            persona_override=persona,
                            conversation_summary=conversation_summary,
                            image_base64=req.image,
                            llm_override=llm_override,
                            is_anonymous=(user_obj is None),
                            routed_intent=routed_intent,
                        ):
                            if isinstance(chunk, dict):
                                if chunk.get("t") == "history_messages":
                                    history_messages = chunk.get("messages", [])
                                    continue
                                if chunk.get("t") == "thinking":
                                    c = chunk.get("content", "") or ""
                                    full_thinking += c
                                    yield f"event: thinking\ndata: {json.dumps({'content': c}, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "status":
                                    payload = {"type": chunk.get("type", ""), "label": chunk.get("label", "")}
                                    if chunk.get("labelKey") is not None:
                                        payload["labelKey"] = chunk["labelKey"]
                                    if chunk.get("params"):
                                        payload["params"] = chunk["params"]
                                    yield f"event: status\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "shell_done":
                                    yield f"event: shell_done\ndata: {json.dumps({'command': chunk.get('command', ''), 'exit_code': chunk.get('exit_code'), 'output_preview': chunk.get('output_preview', '')}, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "shell_request":
                                    yield f"event: shell_request\ndata: {json.dumps({'command': chunk.get('command', '')}, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "shell_suggest":
                                    yield f"event: shell_suggest\ndata: {json.dumps({'command': chunk.get('command', ''), 'reason': chunk.get('reason', '')}, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "proposal":
                                    yield f"event: proposal\ndata: {json.dumps(chunk.get('proposal', {}), ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "metrics":
                                    payload = {
                                        "completion_tokens": chunk.get("completion_tokens"),
                                        "prompt_tokens": chunk.get("prompt_tokens"),
                                        "total_tokens": chunk.get("total_tokens"),
                                        "ttft_ms": chunk.get("ttft_ms"),
                                        "llm_elapsed_ms": chunk.get("llm_elapsed_ms"),
                                        "total_elapsed_ms": chunk.get("total_elapsed_ms"),
                                    }
                                    yield f"event: metrics\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "clear_content":
                                    full_response = ""
                                    yield f"event: clear_content\ndata: {{}}\n\n"
                                    continue
                                if chunk.get("t") == "search_sources":
                                    sources = chunk.get('sources', [])
                                    if isinstance(sources, list):
                                        last_search_sources = sources
                                    yield f"event: search_sources\ndata: {json.dumps({'sources': chunk.get('sources', [])}, ensure_ascii=False)}\n\n"
                                    continue
                                if chunk.get("t") == "forge_preview":
                                    last_forge_preview = chunk.get('content', '') or ""
                                    last_forge_preview_language = chunk.get('language', 'python') or 'python'
                                    yield f"event: forge_preview\ndata: {json.dumps({'content': chunk.get('content', ''), 'language': chunk.get('language', 'python'), 'done': bool(chunk.get('done'))}, ensure_ascii=False)}\n\n"
                                    continue
                            full_response += chunk
                            if _stream_pace_sec > 0:
                                await asyncio.sleep(_stream_pace_sec)
                            yield f"event: chunk\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    think_part, content_part = brain.strip_think_content(full_response)
                    if full_thinking.strip():
                        think_part = (think_part.strip() + "\n\n" + full_thinking.strip()).strip() if think_part.strip() else full_thinking.strip()
                    yield f"event: final_message\ndata: {json.dumps({'thinking': think_part, 'content': content_part, 'model': used_model_name, 'model_id': used_model_id}, ensure_ascii=False)}\n\n"

            user_content = effective_message
            if req.image and not user_content:
                user_content = "[Imagine atașată]"
            session["messages"].append({"role": "user", "content": user_content, "timestamp": time.time()})
            # Compute thinking for persistence
            think_part_save, content_part_save = brain.strip_think_content(full_response)
            if full_thinking.strip():
                think_part_save = (think_part_save.strip() + "\n\n" + full_thinking.strip()).strip() if think_part_save.strip() else full_thinking.strip()

            if history_messages:
                for i, m in enumerate(history_messages):
                    msg = {"role": m.get("role", "assistant"), "content": m.get("content") or ""}
                    if m.get("tool_calls") is not None:
                        msg["tool_calls"] = m["tool_calls"]
                    if m.get("tool_call_id") is not None:
                        msg["tool_call_id"] = m["tool_call_id"]
                    if i == len(history_messages) - 1 and msg.get("role") == "assistant":
                        if used_profile_color:
                            msg["profile_color"] = used_profile_color
                        if used_model_name:
                            msg["model_name"] = used_model_name
                        if used_model_id:
                            msg["model_id"] = used_model_id
                        if think_part_save:
                            msg["thinking"] = think_part_save
                        if last_search_sources:
                            msg["search_sources"] = last_search_sources
                        if m.get("forge_preview"):
                            msg["forge_preview"] = m.get("forge_preview") or ""
                            msg["forge_preview_language"] = m.get("forge_preview_language") or "python"
                        elif last_forge_preview:
                            msg["forge_preview"] = last_forge_preview
                            msg["forge_preview_language"] = last_forge_preview_language
                    session["messages"].append(msg)
            else:
                session["messages"].append({
                    "role": "assistant",
                    "content": content_part_save,
                    "profile_color": used_profile_color,
                    **({"model_name": used_model_name} if used_model_name else {}),
                    **({"model_id": used_model_id} if used_model_id else {}),
                    **({"thinking": think_part_save} if think_part_save else {}),
                    **({"search_sources": last_search_sources} if last_search_sources else {}),
                    **({"forge_preview": last_forge_preview} if last_forge_preview else {}),
                    **({"forge_preview_language": last_forge_preview_language} if last_forge_preview else {}),
                })

            # Titlu automat pentru conversație
            if not session.get("title") or session.get("title") == "New Chat":
                raw_title = (req.message or "").strip()
                if not raw_title and session["messages"]:
                    raw_title = session["messages"][0].get("content", "").strip()
                if raw_title:
                    max_len = 45
                    title = raw_title[:max_len].strip()
                    if len(raw_title) > max_len:
                        title += "..."
                    session["title"] = title

            if session_user_id is not None:
                session["user_id"] = session_user_id
            storage.save_session(session["id"], session)
            log_conversation_reply(full_response, profile_name=effective_profile_name)
            log_detail("api", "CHAT_END", session_id=session["id"], reply_len=len(full_response), messages_in_session=len(session.get("messages", [])))

            # Always run memory pipeline — it handles dedup against existing memories
            # even when store_memory was called (the agent might have captured only one fact
            # while the conversation contained more worth remembering)
            post_response_manager.enqueue(user_id, effective_message or "", brain.strip_think(full_response), session["id"], history, skip_memory_pipeline=False)

        headers = {
            "X-Session-Id": session["id"],
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Memory-Status": (storage.get_collection_health().get("status") or "unknown"),
            "X-Memory-Mode": (storage.get_collection_health().get("mode") or "unknown"),
        }
        if profile:
            headers["X-Profile-Color"] = (profile.get("color") or "").strip() or "#38bdf8"
        return StreamingResponse(
            response_generator(),
            media_type="text/event-stream",
            headers=headers,
        )

    except HTTPException:
        raise
    except Exception as e:
        log_line("error", "⚠️", "EXCEPTION", traceback.format_exc())
        return JSONResponse(status_code=500, content={"error": "internal_server_error"})

if __name__ == "__main__":
    disabled_marker = os.path.join(os.path.dirname(__file__), ".server_disabled")
    if os.path.exists(disabled_marker):
        print("⛔ Server start blocked: .server_disabled marker found")
        print("Remove .server_disabled to allow start again.")
        sys.exit(1)

    port = settings.CFG.get('port', 8082)
    try:
        uvicorn.run(app, host="0.0.0.0", port=port, log_config=None, h11_max_incomplete_event_size=10 * 1024 * 1024)  # 10 MB body limit for image uploads
    except KeyboardInterrupt:
        print("\n👋 Shutting down...")