from __future__ import annotations

import logging

import core.auth as auth
import core.models as models
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


async def _sync_integration_slug(
    slug: str,
    store,
    manager,
    *,
    raise_on_total_failure: bool = True,
) -> dict:
    instances = manager.entries_for(slug)

    if not instances:
        if not store.get_fetcher(slug):
            registered = await helpers.ensure_fetcher(slug, store)
            if not registered:
                raise HTTPException(
                    status_code=404,
                    detail=error_detail("integrations.no_entity_sync", {"slug": slug}),
                )
        try:
            await store.do_sync(slug, force=True)
            stored = store.get_entities(slug) or {}
            from integrations.source_refresh import all_refresh_status

            return {
                "status": "ok",
                "slug": slug,
                "entity_count": len(stored.get("entities") or {}),
                "errors": [],
                "refresh": {slug: all_refresh_status().get(slug)},
            }
        except SyncThrottledError as e:
            if raise_on_total_failure:
                raise HTTPException(
                    status_code=429,
                    detail=e.as_detail(),
                    headers={"Retry-After": str(e.retry_after)},
                )
            return {
                "status": "error",
                "slug": slug,
                "entity_count": 0,
                "errors": [e.as_detail()],
                "refresh": {},
            }
        except Exception as e:
            log.error("Manual sync failed for %s: %s", slug, e)
            if raise_on_total_failure:
                _raise_sync_http_error(e)
            return {
                "status": "error",
                "slug": slug,
                "entity_count": 0,
                "errors": [str(e)],
                "refresh": {},
            }

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
        if raise_on_total_failure:
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
        return {
            "status": "error",
            "slug": slug,
            "entity_count": 0,
            "errors": errors,
            "refresh": {},
        }

    from integrations.source_refresh import all_refresh_status

    refresh = {
        inst.store_key: all_refresh_status().get(inst.store_key)
        for inst in instances
        if inst.supports_sync
    }
    return {
        "status": "partial" if errors else "ok",
        "slug": slug,
        "entity_count": total,
        "errors": errors,
        "refresh": refresh,
    }


@router.get("/status/sync")
async def get_sync_status(user: models.User = Depends(auth.get_current_user)):
    import core.database as database
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


@router.post("/sync-all")
async def trigger_sync_all(user: models.User = Depends(auth.get_current_admin)):
    from integrations import get_integration_manager

    store = get_entity_store()
    manager = get_integration_manager()
    synced_slugs: list[str] = []
    total_entities = 0
    errors: list[dict] = []

    for slug in sorted(manager.classes().keys()):
        if not manager.entries_for(slug):
            continue
        try:
            result = await _sync_integration_slug(
                slug,
                store,
                manager,
                raise_on_total_failure=False,
            )
        except HTTPException as exc:
            errors.append({"slug": slug, "detail": exc.detail, "status_code": exc.status_code})
            continue
        except Exception as exc:
            log.error("Manual sync-all failed for %s: %s", slug, exc)
            errors.append({"slug": slug, "detail": str(exc)})
            continue

        if result.get("status") in {"ok", "partial"}:
            synced_slugs.append(slug)
            total_entities += int(result.get("entity_count") or 0)
        for err in result.get("errors") or []:
            errors.append({"slug": slug, "detail": err})

    if not synced_slugs and errors:
        raise HTTPException(
            status_code=500,
            detail=error_detail(
                "common.error_with_message",
                {"message": f"sync failed for {len(errors)} integration(s)"},
            ),
        )

    helpers.invalidate_all_entities_cache()
    return {
        "status": "ok" if not errors else "partial",
        "synced_count": len(synced_slugs),
        "synced_slugs": synced_slugs,
        "entity_count": total_entities,
        "errors": errors,
    }


@router.post("/sync/{slug}")
async def trigger_sync(slug: str, user: models.User = Depends(auth.get_current_admin)):
    from integrations import get_integration_manager

    store = get_entity_store()
    manager = get_integration_manager()
    result = await _sync_integration_slug(slug, store, manager, raise_on_total_failure=True)
    helpers.invalidate_all_entities_cache()
    return result
