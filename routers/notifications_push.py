from __future__ import annotations

from datetime import datetime
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import auth
import database
import models
import push_fcm


router = APIRouter(tags=["notifications-push"])


class PushRegisterBody(BaseModel):
    token: str
    installation_id: str
    platform: str = "android"
    device_name: str | None = None
    app_version: str | None = None


class PushUnregisterBody(BaseModel):
    installation_id: str


@router.get("/api/notifications/push/status")
async def push_status(current_user: models.User = Depends(auth.get_current_user), db: Session = Depends(database.get_db)):
    items = db.query(models.PushDevice).filter(models.PushDevice.user_id == current_user.id).all()
    return {
        "fcm_enabled": push_fcm.is_fcm_enabled(),
        "devices": [
            {
                "id": item.id,
                "platform": item.platform,
                "installation_id": item.installation_id,
                "device_name": item.device_name,
                "app_version": item.app_version,
                "enabled": item.enabled,
                "last_seen_at": item.last_seen_at.isoformat() if item.last_seen_at else None,
            }
            for item in items
        ],
    }


@router.post("/api/notifications/push/register")
async def register_push_device(body: PushRegisterBody, current_user: models.User = Depends(auth.get_current_user), db: Session = Depends(database.get_db)):
    token = body.token.strip()
    installation_id = body.installation_id.strip()
    if not token:
        raise HTTPException(status_code=400, detail="token is required")
    if not installation_id:
        raise HTTPException(status_code=400, detail="installation_id is required")

    existing = db.query(models.PushDevice).filter(models.PushDevice.push_token == token).first()
    if existing is None:
        existing = db.query(models.PushDevice).filter(
            models.PushDevice.user_id == current_user.id,
            models.PushDevice.installation_id == installation_id,
            models.PushDevice.platform == body.platform,
        ).first()

    if existing is None:
        existing = models.PushDevice(
            user_id=current_user.id,
            platform=body.platform,
            installation_id=installation_id,
            push_token=token,
        )
        db.add(existing)

    existing.user_id = current_user.id
    existing.platform = body.platform
    existing.installation_id = installation_id
    existing.push_token = token
    existing.device_name = (body.device_name or "").strip() or None
    existing.app_version = (body.app_version or "").strip() or None
    existing.enabled = True
    existing.last_seen_at = datetime.now()
    db.commit()
    db.refresh(existing)
    return {"status": "ok", "device_id": existing.id}


@router.post("/api/notifications/push/unregister")
async def unregister_push_device(body: PushUnregisterBody, current_user: models.User = Depends(auth.get_current_user), db: Session = Depends(database.get_db)):
    installation_id = body.installation_id.strip()
    if not installation_id:
        raise HTTPException(status_code=400, detail="installation_id is required")
    updated = db.query(models.PushDevice).filter(
        models.PushDevice.user_id == current_user.id,
        models.PushDevice.installation_id == installation_id,
    ).update(
        {
            models.PushDevice.enabled: False,
            models.PushDevice.updated_at: datetime.now(),
        },
        synchronize_session=False,
    )
    db.commit()
    return {"status": "ok", "updated": int(updated or 0)}


@router.post("/api/notifications/push/test")
async def push_test_notification(current_user: models.User = Depends(auth.get_current_user)):
    user_id = f"user_{current_user.id}"
    sent_count = push_fcm.send_push_notification(
        user_id=user_id,
        title="Hyve",
        message="🧪 Test FCM notification",
        notification_id=f"test_fcm_{int(time.time())}",
        notification_type="reminder",
    )
    return {
        "status": "ok",
        "user_id": user_id,
        "fcm_enabled": push_fcm.is_fcm_enabled(),
        "sent_count": int(sent_count or 0),
    }