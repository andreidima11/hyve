from __future__ import annotations

import logging

import auth
import models
from addons.entity_store import SyncThrottledError, get_entity_store
from fastapi import Depends, HTTPException
from core.http.errors import error_detail
from integrations.errors import integration_retry_after, integration_sync_detail

from routers.integrations import helpers
from routers.integrations.router import router

log = logging.getLogger("integrations")


def _raise_sync_http_error(exc: Exception) -> None:
    detail = integration_sync_detail(exc)
    if detail is not None or "rate limit" in str(exc).lower():
        if isinstance(detail, dict) and detail.get("key"):
            payload = detail
        else:
            payload = error_detail("common.error_with_message", {"message": str(detail or exc)})
        raise HTTPException(
            status_code=429,
            detail=payload,
            headers={"Retry-After": str(integration_retry_after(exc))},
        )
    raise HTTPException(status_code=500, detail=error_detail("common.error_with_message", {"message": str(exc)}))


@router.get("/status/sync")
async def get_sync_status(user: models.User = Depends(auth.get_current_user)):
    import database
    from sqlalchemy import text

    db = next(database.get_db())
    try:
        rows = db.execute(text("""
            SELECT integration_slug, fetch_interval_seconds, enabled,
                   last_fetch_time, next_fetch_time
            FROM integration_entity_schedule
        """)).fetchall()
    finally:
        db.close()

    from integrations.source_refresh import all_refresh_status

    refresh_by_key = all_refresh_status()
    schedules = []
    for slug, interval, enabled, last_fetch, next_fetch in rows:
        entry = {
            "integration": slug,
            "interval_seconds": interval,
            "enabled": bool(enabled),
            "last_fetch_time": last_fetch,
            "next_fetch_time": next_fetch,
        }
        refresh = refresh_by_key.get(slug)
        if refresh:
            entry["refresh"] = refresh
        schedules.append(entry)
    return {"total_integrations": len(schedules), "schedules": schedules}


@router.post("/sync/{slug}")
async def trigger_sync(slug: str, user: models.User = Depends(auth.get_current_admin)):
    from integrations import get_integration_manager

    store = get_entity_store()
    manager = get_integration_manager()
    instances = manager.entries_for(slug)

    if not instances:
        if not store.get_fetcher(slug):
            registered = await helpers.ensure_fetcher(slug, store)
            if not registered:
                raise HTTPException(status_code=404, detail=error_detail("integrations.no_entity_sync", {"slug": slug}))
        try:
            await store.do_sync(slug, force=True)
            stored = store.get_entities(slug) or {}
            helpers.invalidate_all_entities_cache()
            from integrations.source_refresh import all_refresh_status

            return {
                "status": "ok",
                "slug": slug,
                "entity_count": len(stored.get("entities") or {}),
                "refresh": {slug: all_refresh_status().get(slug)},
            }
        except SyncThrottledError as e:
            raise HTTPException(
                status_code=429,
                detail=e.as_detail(),
                headers={"Retry-After": str(e.retry_after)},
            )
        except Exception as e:
            log.error("Manual sync failed for %s: %s", slug, e)
            _raise_sync_http_error(e)

    total = 0
    errors: list[str | dict] = []
    for inst in instances:
        if not inst.supports_sync:
            continue
        key = inst.store_key
        try:
            if not store.get_fetcher(key):
                helpers.register_instance_fetcher(store, inst)
                store.set_interval(key, inst.sync_interval(__import__("settings").CFG))
            await store.do_sync(key, force=True)
            try:
                items = await inst.list_entities(store)
                total += len(items)
            except Exception:
                pass
        except SyncThrottledError as exc:
            errors.append(exc.as_detail())
            log.warning("Manual sync throttled for %s: %s", key, exc)
        except Exception as exc:
            detail = integration_sync_detail(exc)
            if detail is not None:
                errors.append(detail)
            else:
                errors.append(f"{key}: {exc}")
            log.error("Manual sync failed for %s: %s", key, exc)

    if errors and total == 0:
        if all(isinstance(e, dict) and e.get("key") for e in errors):
            retry = 600
            for inst in instances:
                try:
                    wait = int(store.seconds_until_next_sync(inst.store_key))
                    if wait > 0:
                        retry = wait
                        break
                except Exception:
                    pass
            detail = errors[0] if len(errors) == 1 else {
                "key": "integrations.sync_rate_limited",
                "params": {},
            }
            raise HTTPException(
                status_code=429,
                detail=detail,
                headers={"Retry-After": str(retry)},
            )
        raise HTTPException(
            status_code=500,
            detail=error_detail(
                "common.error_with_message",
                {
                    "message": "; ".join(
                        e if isinstance(e, str) else str(e.get("key", e))
                        for e in errors
                    ),
                },
            ),
        )
    helpers.invalidate_all_entities_cache()
    from integrations.source_refresh import all_refresh_status

    refresh = {
        inst.store_key: all_refresh_status().get(inst.store_key)
        for inst in instances
        if inst.supports_sync
    }
    return {
        "status": "ok",
        "slug": slug,
        "entity_count": total,
        "errors": errors,
        "refresh": refresh,
    }
