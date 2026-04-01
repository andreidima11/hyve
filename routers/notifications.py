"""
Notifications API.
Legacy polling endpoint — kept for backward compatibility with older Android clients.
Notifications are now persisted in session history and delivered via WebSocket.
"""
from fastapi import APIRouter, Depends
import models
import auth

router = APIRouter(tags=["notifications"])


@router.get("/api/notifications/check")
async def check_notifications(current_user: models.User = Depends(auth.get_current_user)):
    """Legacy endpoint — notifications are now in session history. Always returns empty list."""
    return []
