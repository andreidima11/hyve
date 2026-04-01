"""Integrations management router — entities & unified integration API."""

import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

import database
from auth import get_current_user
from addons.entity_store import get_entity_store
import models

log = logging.getLogger("integrations")

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


@router.get("/{slug}/entities")
async def get_integration_entities(slug: str, user: models.User = Depends(get_current_user)):
    """Get stored entity data for an integration."""
    store = get_entity_store()
    entities = store.get_entities(slug)
    if not entities:
        raise HTTPException(status_code=404, detail=f"No entities found for integration '{slug}'")
    schedule = store.get_schedule(slug)
    if schedule:
        entities["schedule"] = schedule
    return entities


@router.get("")
async def list_integration_entities(user: models.User = Depends(get_current_user)):
    """List all integrations that have synced entity data."""
    db = next(database.get_db())
    try:
        rows = db.execute(
            text("SELECT integration_slug, timestamp, last_error FROM integration_entities")
        ).fetchall()
    finally:
        db.close()

    integrations = []
    for slug, timestamp, last_error in rows:
        integrations.append({
            "slug": slug,
            "last_updated": timestamp,
            "has_error": last_error is not None,
            "error": last_error,
        })
    return {"integrations": integrations}


@router.get("/status/sync")
async def get_sync_status(user: models.User = Depends(get_current_user)):
    """Get entity sync schedule status across all integrations."""
    db = next(database.get_db())
    try:
        rows = db.execute(text("""
            SELECT integration_slug, fetch_interval_seconds, enabled,
                   last_fetch_time, next_fetch_time
            FROM integration_entity_schedule
        """)).fetchall()
    finally:
        db.close()

    schedules = []
    for slug, interval, enabled, last_fetch, next_fetch in rows:
        schedules.append({
            "integration": slug,
            "interval_seconds": interval,
            "enabled": bool(enabled),
            "last_fetch_time": last_fetch,
            "next_fetch_time": next_fetch,
        })
    return {"total_integrations": len(schedules), "schedules": schedules}


@router.post("/sync/{slug}")
async def trigger_sync(slug: str, user: models.User = Depends(get_current_user)):
    """Manually trigger immediate entity sync for an integration."""
    store = get_entity_store()
    if not store.get_fetcher(slug):
        raise HTTPException(status_code=404,
                            detail=f"No entity sync available for '{slug}'")
    try:
        entities = await store.do_sync(slug)
        return {"status": "ok", "slug": slug, "entity_count": len(entities)}
    except Exception as e:
        log.error("Manual sync failed for %s: %s", slug, e)
        raise HTTPException(status_code=500, detail=str(e))
