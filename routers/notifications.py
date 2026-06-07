"""Notifications API and user notification center endpoints."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from core import notification_service
import database
import models
import auth

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


class AmbientActBody(BaseModel):
    action_index: int = Field(0, ge=0, le=20)


@router.get("/api/ambient/default-reasoner-prompt")
async def ambient_default_reasoner_prompt(current_user: models.User = Depends(auth.get_current_user)):
    """Return the built-in ambient reasoner system prompt (for settings reset / initial display)."""
    if not current_user.is_admin:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Admin only")
    from brain.ambient import default_reasoner_prompt
    return {"prompt": default_reasoner_prompt()}


@router.get("/api/ambient/action-catalog")
async def ambient_action_catalog_preview(current_user: models.User = Depends(auth.get_current_user)):
    """Preview which tools the ambient reasoner sees for the current home state."""
    if not current_user.is_admin:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Admin only")
    from brain import ambient
    context = ambient._build_context([{"type": "scan"}])
    return {
        "context_tags": sorted(ambient._ambient_context_tags(context)),
        "actions": ambient.ambient_actions_for_context(context),
        "catalog_json": ambient.format_ambient_actions_catalog(context),
    }


@router.post("/api/ambient/test")
async def test_ambient_now(current_user: models.User = Depends(auth.get_current_user)):
    """Run one ambient reasoning cycle over the current home state right now, so
    the user can verify the proactive pipeline without waiting for the scheduler."""
    if not current_user.is_admin:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Admin only")
    from brain import ambient
    return await ambient.run_test()


@router.post("/api/ambient/suggestions/{notification_id}/act")
async def act_on_ambient_suggestion(
    notification_id: str,
    body: AmbientActBody,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    """Execute one suggested action attached to an ambient notification, then
    record the acceptance so HYVE can learn the user's habits (F4)."""
    from brain import ambient
    result = await ambient.act_on_suggestion(current_user.id, notification_id, body.action_index)
    return {
        **result,
        "unread_count": notification_service.unread_count(db, current_user.id),
    }


@router.post("/api/briefings/test")
async def test_briefing_now(current_user: models.User = Depends(auth.get_current_user)):
    """Generate a test briefing on demand."""
    if not current_user.is_admin:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Admin only")
    from brain.briefings import generate_briefing, _llm_endpoint
    url, model, _ = _llm_endpoint()
    if not url or not model:
        return {"ok": False, "error": "Niciun model LLM configurat pentru profilul ales."}
    result = await generate_briefing("test", current_user.id, force=True)
    if not result:
        return {"ok": False, "error": "Modelul nu a returnat conținut. Verifică profilul/modelul."}
    return {"ok": True, **result}
