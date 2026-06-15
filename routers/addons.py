"""
Add-ons API router.

Provides:
  GET   /api/addons              — list all addons (manifest + state)
  GET   /api/addons/{slug}       — get single addon details
  POST  /api/addons/{slug}/install   — install an addon (blocking)
  GET   /api/addons/{slug}/install/stream — install with SSE progress
  POST  /api/addons/{slug}/uninstall — uninstall an addon
  POST  /api/addons/{slug}/enable    — enable an addon
  POST  /api/addons/{slug}/disable   — disable an addon
  PATCH /api/addons/{slug}/config    — update addon config
  GET   /api/addons/{slug}/health    — health check
"""

import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket
from fastapi.responses import StreamingResponse

import core.auth as auth
import core.database as database
import core.models as models
from addons import registry
from addons import process_manager
from addons import ingress as addon_ingress
from core.http.errors import error_detail
from core.http.limiter import limiter

router = APIRouter(prefix="/api/addons", tags=["addons"])
log = logging.getLogger("addons.router")


def _require_admin(user: models.User = Depends(auth.get_current_user)):
    if not user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))


def _addon_http_exception(exc: Exception) -> HTTPException:
    msg = str(exc)
    if msg.startswith("Unknown addon:"):
        slug = msg.split(":", 1)[-1].strip()
        return HTTPException(status_code=404, detail=error_detail("hy.addon_not_found", {"slug": slug}))
    if msg.startswith("Addon ") and msg.endswith(" is not installed"):
        slug = msg[6:-len(" is not installed")].strip()
        return HTTPException(status_code=400, detail=error_detail("hy.addon_not_installed", {"slug": slug}))
    if msg.startswith("Addon ") and msg.endswith(" is disabled"):
        slug = msg[6:-len(" is disabled")].strip()
        return HTTPException(status_code=400, detail=error_detail("hy.addon_disabled", {"slug": slug}))
    return HTTPException(status_code=400, detail=error_detail("hy.addon_error", {"message": msg}))


async def _authenticate_ingress_admin(request, slug: str) -> models.User:
    db = next(database.get_db())
    try:
        token = None
        if hasattr(request, "query_params"):
            token = request.query_params.get("token")
        user = await addon_ingress.authenticate_ingress_request(
            request, slug, db=db, token=token,
        )
        if not user.is_admin:
            raise HTTPException(status_code=403, detail={"key": "common.admin_required"})
        return user
    finally:
        db.close()


@router.get("")
async def list_addons(user: models.User = Depends(auth.get_current_user)):
    """List all available addons with their install state."""
    return registry.list_all()


# ── process control (static paths BEFORE {slug} wildcard) ────────────────

@router.get("/process/status")
async def all_process_statuses(user: models.User = Depends(auth.get_current_user)):
    """Get process status for all addons that have a start_command."""
    return await process_manager.get_all_statuses_async()


@router.get("/{slug}/ui/open")
async def open_addon_ui(slug: str, request: Request):
    """Set a short-lived ingress cookie and redirect to the proxied Web UI."""
    user = await _authenticate_ingress_admin(request, slug)
    return addon_ingress.open_ingress_session(slug, user)


@router.api_route("/{slug}/ui", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
@router.api_route("/{slug}/ui/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def proxy_addon_ui_http(
    slug: str,
    request: Request,
    path: str = "",
):
    user = await _authenticate_ingress_admin(request, slug)
    return await addon_ingress.proxy_http(request, slug, path, user)


@router.websocket("/{slug}/ui")
@router.websocket("/{slug}/ui/{path:path}")
async def proxy_addon_ui_ws(slug: str, websocket: WebSocket, path: str = ""):
    try:
        user = await _authenticate_ingress_admin(websocket, slug)
    except HTTPException:
        await websocket.close(code=1008, reason="auth required")
        return
    await addon_ingress.proxy_websocket(websocket, slug, path, user)


@router.get("/{slug}")
async def get_addon(slug: str, user: models.User = Depends(auth.get_current_user)):
    """Get a single addon's manifest + state."""
    manifest = registry.get_manifest(slug)
    if not manifest:
        raise HTTPException(status_code=404, detail=error_detail("hy.addon_not_found", {"slug": slug}))
    return registry.addon_entry(manifest)


@router.get("/{slug}/install/preflight")
async def preflight(slug: str, user: models.User = Depends(_require_admin)):
    """Run pre-install checks (compiler, docker, etc.)."""
    checks = await registry.preflight_check(slug)
    return {"slug": slug, "checks": checks}


@router.post("/{slug}/install")
@limiter.limit("5/minute")
async def install_addon(request: Request, slug: str, user: models.User = Depends(_require_admin)):
    """Install an addon (downloads dependencies)."""
    try:
        state = registry.install_addon(slug)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=error_detail("hy.addon_install_failed", {"message": str(e)}),
        ) from e


@router.get("/{slug}/install/stream")
@limiter.limit("10/minute")
async def install_addon_stream(
    request: Request,
    slug: str,
    token: str | None = None,
):
    """SSE endpoint: install addon with live progress logs.

    Uses token query param for auth (EventSource can't send headers).
    """
    from sqlalchemy.orm import Session as SASession
    import core.database as database
    if not token:
        raise HTTPException(status_code=401, detail=error_detail("auth.token_required"))
    db = next(database.get_db())
    try:
        sse_payload = auth.consume_sse_exchange_token(token, db)
        if not sse_payload:
            raise HTTPException(status_code=401, detail=error_detail("auth.invalid_token"))
        username = sse_payload["sub"]
        user = db.query(models.User).filter(models.User.username == username).first()
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail=error_detail("common.admin_required"))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail=error_detail("auth.invalid_token"))
    finally:
        db.close()

    async def _generate():
        async for line in registry.install_addon_stream(slug):
            payload = json.dumps(line, ensure_ascii=False)
            yield f"data: {payload}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


@router.post("/{slug}/uninstall")
@limiter.limit("10/minute")
async def uninstall_addon(request: Request, slug: str, user: models.User = Depends(_require_admin)):
    """Uninstall an addon."""
    try:
        await process_manager.stop(slug)
        state = registry.uninstall_addon(slug)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e


@router.post("/{slug}/enable")
async def enable_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Enable an installed addon."""
    try:
        state = registry.set_addon_enabled(slug, True)
        manifest = registry.get_manifest(slug)
        if state.get("watchdog") and manifest and manifest.get("start_command"):
            try:
                await process_manager.start(slug)
            except Exception as exc:
                log.warning("Failed to auto-start %s after enable: %s", slug, exc)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e


@router.post("/{slug}/disable")
async def disable_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Disable an addon."""
    try:
        state = registry.set_addon_enabled(slug, False)
        await process_manager.stop(slug)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e


@router.post("/{slug}/watchdog")
async def set_watchdog(slug: str, request: Request, user: models.User = Depends(_require_admin)):
    """Enable/disable watchdog for an addon."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail=error_detail("common.invalid_json"))
    enabled = bool(body.get("enabled", False))
    try:
        state = registry.set_addon_watchdog(slug, enabled)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e


@router.patch("/{slug}/config")
async def update_config(slug: str, request: Request, user: models.User = Depends(_require_admin)):
    """Update addon configuration fields."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail=error_detail("common.invalid_json"))
    try:
        state = registry.update_addon_config(slug, body)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise _addon_http_exception(e) from e


@router.get("/{slug}/health")
async def health_check(slug: str, user: models.User = Depends(auth.get_current_user)):
    """Run a health check for an addon."""
    result = await registry.check_health(slug)
    return {"slug": slug, **result}


# ── process lifecycle ─────────────────────────────────────────────────────

@router.post("/{slug}/start")
async def start_process(slug: str, user: models.User = Depends(_require_admin)):
    """Start the addon process."""
    try:
        return await process_manager.start(slug)
    except ValueError as e:
        raise _addon_http_exception(e) from e
    except RuntimeError as e:
        raise HTTPException(
            status_code=500,
            detail=error_detail("hy.addon_process_error", {"message": str(e)}),
        ) from e


@router.post("/{slug}/stop")
async def stop_process(slug: str, user: models.User = Depends(_require_admin)):
    """Stop the addon process."""
    return await process_manager.stop(slug)


@router.post("/{slug}/restart")
async def restart_process(slug: str, user: models.User = Depends(_require_admin)):
    """Restart the addon process."""
    try:
        return await process_manager.restart(slug)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(
            status_code=500,
            detail=error_detail("hy.addon_process_error", {"message": str(e)}),
        ) from e


@router.get("/{slug}/status")
async def process_status(slug: str, user: models.User = Depends(auth.get_current_user)):
    """Get process status for a single addon."""
    return await process_manager.get_status_async(slug)


@router.get("/{slug}/logs")
async def process_logs(
    slug: str,
    tail: int = Query(200, ge=1, le=1000),
    user: models.User = Depends(auth.get_current_user),
):
    """Get the last `tail` log lines for a process."""
    return {"slug": slug, "lines": process_manager.get_logs(slug, tail)}


@router.get("/_helpers/detect-serial-ports")
async def detect_serial_ports(user: models.User = Depends(auth.get_current_user)):
    """Scan the host for likely USB serial adapters (Zigbee, Z-Wave, etc.).

    Cross-platform: looks at /dev/serial/by-id/*, /dev/ttyUSB*, /dev/ttyACM*
    on Linux and /dev/tty.usb*, /dev/cu.usb* on macOS. Returns a list of
    candidate paths plus a short hint extracted from the device name.
    """
    import glob
    import os

    patterns = [
        "/dev/serial/by-id/*",
        "/dev/ttyUSB*",
        "/dev/ttyACM*",
        "/dev/tty.usbserial*",
        "/dev/tty.usbmodem*",
        "/dev/tty.SLAB_USBtoUART*",
        "/dev/cu.usbserial*",
        "/dev/cu.usbmodem*",
        "/dev/cu.SLAB_USBtoUART*",
    ]
    seen: set[str] = set()
    ports: list[dict[str, str]] = []
    for pattern in patterns:
        for path in glob.glob(pattern):
            try:
                resolved = os.path.realpath(path)
            except OSError:
                resolved = path
            if resolved in seen:
                # Prefer the by-id symlink representation when available.
                if path != resolved and any(p["path"] == resolved for p in ports):
                    for entry in ports:
                        if entry["path"] == resolved:
                            entry["path"] = path
                            entry["hint"] = os.path.basename(path)
                            break
                continue
            seen.add(resolved)
            ports.append({
                "path": path,
                "hint": os.path.basename(path),
            })
    ports.sort(key=lambda item: ("/serial/by-id/" not in item["path"], item["path"]))
    return {"ports": ports}
