"""Notifications API and user notification center endpoints."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core import notification_service
import core.database as database
import core.models as models
import core.auth as auth

router = APIRouter(tags=["notifications"])


class NotificationTestBody(BaseModel):
    title: str = Field("Hyve", max_length=120)
    body: str = Field("Test notification", max_length=1000)
    category: str = Field("system", max_length=32)


@router.get("/api/notifications/check")
async def check_notifications(current_user: models.User = Depends(auth.get_current_user)):
    """Legacy endpoint kept for older Android clients."""
    return []


@router.get("/api/notifications")
async def list_user_notifications(
    state: str = Query("all", pattern="^(all|unread|archived)$"),
    category: str | None = Query(None, max_length=32),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    items, total = notification_service.list_notifications(
        db,
        current_user.id,
        state=state,
        category=category,
        limit=limit,
        offset=offset,
    )
    return {
        "items": items,
        "total": total,
        "unread_count": notification_service.unread_count(db, current_user.id),
    }


@router.get("/api/notifications/counts")
async def notification_counts(
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    return {"unread_count": notification_service.unread_count(db, current_user.id)}


@router.delete("/api/notifications")
async def delete_all_notifications(
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    deleted = notification_service.delete_all_notifications(db, current_user.id)
    return {"status": "ok", "deleted": deleted, "unread_count": notification_service.unread_count(db, current_user.id)}


@router.patch("/api/notifications/{notification_id}/read")
async def mark_notification_read(
    notification_id: str,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    item = notification_service.mark_read(db, current_user.id, notification_id)
    return {"item": item, "unread_count": notification_service.unread_count(db, current_user.id)}


@router.post("/api/notifications/read-all")
async def mark_notifications_read(
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    updated = notification_service.mark_all_read(db, current_user.id)
    return {"status": "ok", "updated": updated, "unread_count": 0}


@router.patch("/api/notifications/{notification_id}/archive")
async def archive_notification(
    notification_id: str,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    item = notification_service.archive_notification(db, current_user.id, notification_id)
    return {"item": item, "unread_count": notification_service.unread_count(db, current_user.id)}


@router.delete("/api/notifications/{notification_id}")
async def delete_notification(
    notification_id: str,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    item = notification_service.delete_notification(db, current_user.id, notification_id)
    return {"status": "ok", "item": item, "unread_count": notification_service.unread_count(db, current_user.id)}


@router.post("/api/notifications/inbox-test")
async def create_inbox_test_notification(
    body: NotificationTestBody,
    current_user: models.User = Depends(auth.get_current_user),
):
    item = notification_service.create_and_dispatch(
        user_id=current_user.id,
        title=body.title,
        body=body.body,
        category=body.category,
    )
    return {"status": "ok", "item": item}


