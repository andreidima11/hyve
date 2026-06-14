"""
Updates API router — Hyve self-update + add-on update management.

Provides:
  GET   /api/updates/hyve           — current vs latest GitHub release
  POST  /api/updates/hyve/check       — refresh latest release from GitHub
  POST  /api/updates/hyve/apply       — git checkout tag + deps + restart
  GET   /api/updates/addons           — list installed add-ons + available-update flags
  POST  /api/updates/addons/check     — recompute available updates + notify admins
  POST  /api/updates/addons/update    — update one/all add-ons to the bundled version
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import core.auth as auth
import core.models as models
import core.settings as settings
from addons import registry
from core.hyve_update import HyveUpdateError, apply_update as apply_hyve_update
from core.hyve_update import check_for_update as check_hyve_update
from core.hyve_update import get_status as get_hyve_status
from core.http.errors import error_detail

log = logging.getLogger(__name__)

_ADDON_CHECK_JOB_ID = "hyve_addon_check"

# In-memory cache for the last check results (drives the hub badge).
_last_check: dict[str, Any] = {"outdated": [], "checked_at": None}


def _persist_addons_last_check() -> None:
    try:
        settings.save_config({"updates": {"addons_last_check": dict(_last_check)}})
    except Exception as exc:
        log.debug("persist addons last check failed: %s", exc)


def _hydrate_addons_last_check() -> None:
    global _last_check
    stored = (settings.CFG.get("updates") or {}).get("addons_last_check")
    if isinstance(stored, dict) and stored.get("checked_at"):
        _last_check = {
            "outdated": list(stored.get("outdated") or []),
            "checked_at": stored.get("checked_at"),
        }


_hydrate_addons_last_check()

router = APIRouter(prefix="/api/updates", tags=["updates"])


def _require_admin(user: models.User = Depends(auth.get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Admin only")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _refresh_all_addon_versions() -> None:
    """Resolve real installed + latest versions for every installed add-on.

    Blocking (subprocess + network) — callers must run it off the event loop.
    """
    for addon in registry.list_all():
        state = addon.get("state") or {}
        if not state.get("installed"):
            continue
        slug = addon.get("slug", "")
        try:
            registry.refresh_addon_versions(slug)
        except Exception as e:
            log.warning("Failed to refresh versions for %s: %s", slug, e)


def _collect_addon_updates() -> list[dict[str, Any]]:
    """Return installed add-ons that have a newer version available.

    Update detection is delegated to ``registry`` so the logic is shared with
    the Add-ons page — fully generic, nothing hardcoded per add-on.
    """
    updates: list[dict[str, Any]] = []
    for addon in registry.list_all():
        if not addon.get("update_available"):
            continue
        state = addon.get("state") or {}
        updates.append({
            "slug": addon.get("slug", ""),
            "name": addon.get("name", addon.get("slug", "")),
            "icon": addon.get("icon", "fas fa-puzzle-piece"),
            "color": addon.get("color", "slate"),
            "image": addon.get("image", ""),
            "current": state.get("version") or "",
            "latest": state.get("latest_version") or addon.get("version") or "",
        })
    updates.sort(key=lambda a: a["name"].lower())
    return updates


def _hyve_update_count() -> int:
    return 1 if get_hyve_status().get("update_available") else 0


# ---------------------------------------------------------------------------
# Hyve self-update (GitHub releases + git checkout)
# ---------------------------------------------------------------------------

@router.get("/hyve")
async def get_hyve_update_status(_: models.User = Depends(_require_admin)):
    return get_hyve_status()


@router.post("/hyve/check")
async def check_hyve_updates(_: models.User = Depends(_require_admin)):
    import asyncio

    return await asyncio.to_thread(check_hyve_update)


@router.post("/hyve/apply")
async def apply_hyve_updates(_: models.User = Depends(_require_admin)):
    import asyncio

    try:
        return await asyncio.to_thread(apply_hyve_update)
    except HyveUpdateError as exc:
        raise HTTPException(status_code=400, detail=error_detail(exc.key, exc.params or None)) from exc


# ---------------------------------------------------------------------------
# GET /addons — list installed add-ons with update flags
# ---------------------------------------------------------------------------

@router.get("/addons")
async def list_addon_updates(_: models.User = Depends(_require_admin)):
    """List installed add-ons together with an ``update_available`` flag."""
    addons: list[dict[str, Any]] = []
    update_count = 0
    for addon in registry.list_all():
        state = addon.get("state") or {}
        if not state.get("installed"):
            continue
        available = bool(addon.get("update_available"))
        if available:
            update_count += 1
        addons.append({
            "slug": addon.get("slug", ""),
            "name": addon.get("name", addon.get("slug", "")),
            "icon": addon.get("icon", "fas fa-puzzle-piece"),
            "color": addon.get("color", "slate"),
            "image": addon.get("image", ""),
            "current": state.get("version") or "",
            "latest": state.get("latest_version") or addon.get("version") or "",
            "update_available": available,
        })
    addons.sort(key=lambda a: (not a["update_available"], a["name"].lower()))
    hyve = get_hyve_status()
    total_updates = update_count + _hyve_update_count()
    return {
        "hyve": hyve,
        "addons": addons,
        "total_updates": total_updates,
        "last_check": _last_check if _last_check["checked_at"] else None,
    }


# ---------------------------------------------------------------------------
# POST /addons/check — recompute + notify
# ---------------------------------------------------------------------------

@router.post("/addons/check")
async def check_addon_updates(_: models.User = Depends(_require_admin)):
    import asyncio
    import datetime as _dt

    # Live registry lookups (npm/pip) can be slow — keep them off the loop.
    await asyncio.to_thread(_refresh_all_addon_versions)

    updates = _collect_addon_updates()
    _last_check["outdated"] = updates
    _last_check["checked_at"] = _dt.datetime.now().isoformat()
    _persist_addons_last_check()

    if updates:
        try:
            _notify_addon_updates(updates)
        except Exception as e:
            log.warning("Failed to send add-on update notification: %s", e)

    return {"updates": updates, "total": len(updates)}


# ---------------------------------------------------------------------------
# POST /addons/update — update one/all add-ons
# ---------------------------------------------------------------------------

class _UpdateBody(BaseModel):
    slugs: list[str] | None = None
    all: bool = False


@router.post("/addons/update")
async def update_addons(body: _UpdateBody, _: models.User = Depends(_require_admin)):
    if body.all:
        targets = [u["slug"] for u in _collect_addon_updates()]
    else:
        targets = list(body.slugs or [])

    if not targets:
        return {"status": "ok", "message": "Toate add-on-urile sunt la zi.", "updated": [], "failed": []}

    updated: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []
    for slug in targets:
        try:
            state = registry.update_addon(slug)
            updated.append({"slug": slug, "version": state.get("version", "")})
        except Exception as e:
            log.warning("Add-on update failed for %s: %s", slug, e)
            failed.append({"slug": slug, "error": str(e)[:300]})

    # Refresh the cached check so the badge clears for the updated add-ons.
    _last_check["outdated"] = _collect_addon_updates()
    import datetime as _dt
    _last_check["checked_at"] = _dt.datetime.now().isoformat()
    _persist_addons_last_check()

    status = "ok" if not failed else ("partial" if updated else "error")
    if status == "ok":
        message = f"{len(updated)} add-on-uri actualizate."
    elif status == "partial":
        message = f"{len(updated)} actualizate, {len(failed)} eșuate."
    else:
        message = "Actualizarea add-on-urilor a eșuat."
    return {"status": status, "message": message, "updated": updated, "failed": failed}


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

def _notify_addon_updates(updates: list[dict]):
    """Create a notification for all admin users about available add-on updates."""
    import core.database as database
    from core import notification_service

    count = len(updates)
    names = ", ".join(u["name"] for u in updates[:5])
    suffix = f" și alte {count - 5}" if count > 5 else ""
    body = f"{count} add-on-uri au versiuni noi: {names}{suffix}."

    db = next(database.get_db())
    try:
        admins = db.query(models.User).filter(
            models.User.is_admin == True,
            models.User.is_active == True,
        ).all()
        for user in admins:
            notification_service.create_and_dispatch(
                user_id=user.id,
                title="Actualizări add-on disponibile",
                body=body,
                category="updates",
                severity="info",
                action_url="#updates/addons",
                dedupe_key="addon_updates_available",
            )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Scheduled add-on check
# ---------------------------------------------------------------------------

def _scheduled_addon_check():
    """APScheduler job — recompute add-on updates, notify, optionally auto-update."""
    import datetime as _dt

    log.info("Running scheduled add-on update check...")
    _refresh_all_addon_versions()
    updates = _collect_addon_updates()
    _last_check["outdated"] = updates
    _last_check["checked_at"] = _dt.datetime.now().isoformat()
    _persist_addons_last_check()

    if not updates:
        log.info("Scheduled add-on check: all up to date.")
        return

    log.info("Scheduled add-on check: %d add-on(s) with updates.", len(updates))
    _notify_addon_updates(updates)

    import core.settings as settings
    auto = settings.CFG.get("updates", {}).get("addons", {}).get("auto_update", False)
    if auto:
        for u in updates:
            slug = u["slug"]
            try:
                registry.update_addon(slug)
                log.info("Auto-updated add-on %s", slug)
            except Exception as e:
                log.warning("Auto-update failed for %s: %s", slug, e)
        _last_check["outdated"] = _collect_addon_updates()
        _persist_addons_last_check()


def schedule_addon_check():
    """Register or remove the APScheduler cron job based on config."""
    import core.settings as settings
    from core.scheduler_service import scheduler

    interval = settings.CFG.get("updates", {}).get("addons", {}).get("check_interval", "never")

    if scheduler.get_job(_ADDON_CHECK_JOB_ID):
        scheduler.remove_job(_ADDON_CHECK_JOB_ID)

    if interval == "never":
        return

    cron_kwargs: dict[str, Any] = {"hour": 4, "minute": 0}
    if interval == "weekly":
        cron_kwargs["day_of_week"] = "mon"
    elif interval == "monthly":
        cron_kwargs["day"] = 1

    scheduler.add_job(
        _scheduled_addon_check,
        "cron",
        id=_ADDON_CHECK_JOB_ID,
        replace_existing=True,
        **cron_kwargs,
    )
    log.info("Add-on update check scheduled: %s (cron: %s)", interval, cron_kwargs)
