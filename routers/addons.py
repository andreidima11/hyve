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
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import auth
import models
from addons import registry
from addons import process_manager

router = APIRouter(prefix="/api/addons", tags=["addons"])


def _require_admin(user: models.User = Depends(auth.get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Admin only")


def _sync_integration_enabled(slug: str, enabled: bool):
    """Sync addon enabled state to the top-level integration config."""
    manifest = registry.get_manifest(slug)
    integration_key = (manifest or {}).get("integration_key", slug)
    if integration_key:
        from settings import save_config, _load_config_raw
        current = dict(_load_config_raw().get(integration_key) or {})
        current["enabled"] = enabled
        save_config({integration_key: current})


@router.get("")
async def list_addons(user: models.User = Depends(auth.get_current_user)):
    """List all available addons with their install state."""
    return registry.list_all()


# ── process control (static paths BEFORE {slug} wildcard) ────────────────

@router.get("/process/status")
async def all_process_statuses(user: models.User = Depends(auth.get_current_user)):
    """Get process status for all addons that have a start_command."""
    return await process_manager.get_all_statuses_async()


@router.get("/{slug}")
async def get_addon(slug: str, user: models.User = Depends(auth.get_current_user)):
    """Get a single addon's manifest + state."""
    manifest = registry.get_manifest(slug)
    if not manifest:
        raise HTTPException(404, f"Addon {slug} not found")
    state = registry.get_state(slug)
    return {**manifest, "state": state, "update_available": registry.is_update_available(manifest, state)}


@router.get("/{slug}/install/preflight")
async def preflight(slug: str, user: models.User = Depends(_require_admin)):
    """Run pre-install checks (compiler, docker, etc.)."""
    checks = await registry.preflight_check(slug)
    return {"slug": slug, "checks": checks}


@router.post("/{slug}/install")
async def install_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Install an addon (downloads dependencies)."""
    try:
        state = registry.install_addon(slug)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Install failed: {e}")


@router.get("/{slug}/install/stream")
async def install_addon_stream(slug: str, token: str | None = None, request: Request = None):
    """SSE endpoint: install addon with live progress logs.

    Uses token query param for auth (EventSource can't send headers).
    """
    from sqlalchemy.orm import Session as SASession
    import database
    if not token:
        raise HTTPException(401, "Token required")
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
                raise HTTPException(401, "Invalid token")
            db: SASession = next(database.get_db())
            jti = payload.get("jti", "")
            if jti and db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
                raise HTTPException(401, "Token revoked")
        db_check: SASession = next(database.get_db())
        user = db_check.query(models.User).filter(models.User.username == username).first()
        if not user or not user.is_admin:
            raise HTTPException(403, "Admin only")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Invalid token")

    async def _generate():
        async for line in registry.install_addon_stream(slug):
            payload = json.dumps(line, ensure_ascii=False)
            yield f"data: {payload}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


@router.post("/{slug}/uninstall")
async def uninstall_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Uninstall an addon."""
    try:
        state = registry.uninstall_addon(slug)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/{slug}/enable")
async def enable_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Enable an installed addon."""
    try:
        state = registry.set_addon_enabled(slug, True)
        _sync_integration_enabled(slug, True)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{slug}/disable")
async def disable_addon(slug: str, user: models.User = Depends(_require_admin)):
    """Disable an addon."""
    try:
        state = registry.set_addon_enabled(slug, False)
        _sync_integration_enabled(slug, False)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{slug}/watchdog")
async def set_watchdog(slug: str, request: Request, user: models.User = Depends(_require_admin)):
    """Enable/disable watchdog for an addon."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    enabled = bool(body.get("enabled", False))
    try:
        state = registry.set_addon_watchdog(slug, enabled)
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/{slug}/config")
async def update_config(slug: str, request: Request, user: models.User = Depends(_require_admin)):
    """Update addon configuration fields."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    try:
        state = registry.update_addon_config(slug, body)
        # Sync addon config to top-level section so clients (TTS/STT/etc.) pick it up.
        # Uses integration_key from the manifest (defaults to the slug itself).
        manifest = registry.get_manifest(slug)
        integration_key = (manifest or {}).get("integration_key", slug)
        if integration_key:
            from settings import save_config, _load_config_raw
            current = dict(_load_config_raw().get(integration_key) or {})
            current.update(body)
            save_config({integration_key: current})
        return {"slug": slug, "state": state}
    except ValueError as e:
        raise HTTPException(400, str(e))


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
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


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
        raise HTTPException(500, str(e))


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
