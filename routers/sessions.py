"""Session management API.
Handles multi-session chat support with context isolation and message history.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import core.storage as storage
import core.models as models
import core.auth as auth
import brain
from core.http.errors import error_detail

router = APIRouter(tags=["sessions"])


def _require_session(session_id: str, current_user: models.User) -> dict:
    s = storage.get_session(session_id)
    if not s:
        raise HTTPException(status_code=404, detail=error_detail("sessions.not_found"))
    session_owner = s.get("user_id")
    if session_owner is None and not current_user.is_admin:
        raise HTTPException(status_code=403, detail=error_detail("common.forbidden"))
    if session_owner is not None and session_owner != current_user.id:
        raise HTTPException(status_code=403, detail=error_detail("common.forbidden"))
    return s


@router.get("/api/sessions")
async def list_sess(
    current_user: models.User = Depends(auth.get_current_user),
    limit: int = 100,
    offset: int = 0,
):
    """List all sessions for the current user."""
    return storage.list_all_sessions(user_id=current_user.id, limit=limit, offset=offset)


@router.post("/api/sessions")
async def create_sess(current_user: models.User = Depends(auth.get_current_user)):
    """Create a new chat session for the current user."""
    return storage.create_session(user_id=current_user.id)


@router.get("/api/sessions/{session_id}")
async def get_sess(session_id: str, current_user: models.User = Depends(auth.get_current_user)):
    """Get a specific session. User can only access their own sessions."""
    return _require_session(session_id, current_user)


@router.delete("/api/sessions/{session_id}")
async def del_sess(session_id: str, current_user: models.User = Depends(auth.get_current_user)):
    """Delete a session and its context. User can only delete their own sessions."""
    s = _require_session(session_id, current_user)
    # Delete context (e.g. last HA device) for this user's session
    uid = s.get("user_id")
    if uid is not None:
        try:
            brain.USER_CONTEXT.pop(f"user_{uid}", None)
        except Exception:
            pass
    storage.delete_session_file(session_id)
    return {"status": "deleted"}


@router.patch("/api/sessions/{session_id}/message-stats")
async def save_message_stats(
    session_id: str,
    body: dict,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Save response stats on the last assistant message in a session."""
    s = _require_session(session_id, current_user)
    messages = s.get("messages", [])
    # Find the last assistant message (walking backwards)
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "assistant" and not messages[i].get("tool_calls"):
            stats = body.get("stats") or {}
            messages[i]["response_stats"] = {
                "elapsed": stats.get("elapsed"),
                "thinkingTime": stats.get("thinkingTime"),
                "generationTime": stats.get("generationTime"),
                "completionTokens": stats.get("completionTokens"),
                "promptTokens": stats.get("promptTokens"),
                "totalTokens": stats.get("totalTokens"),
            }
            storage.save_session(session_id, s)
            return {"status": "ok"}
    return {"status": "no_assistant_message"}


@router.post("/api/sessions/{session_id}/clear-context")
async def clear_session_context(session_id: str, current_user: models.User = Depends(auth.get_current_user)):
    """Clear conversation context for a session: reset messages and summary. Memories are unchanged."""
    s = _require_session(session_id, current_user)
    s["messages"] = []
    s["summary"] = ""
    s["title"] = "New Chat"
    storage.save_session(session_id, s)
    return {"status": "ok", "message": "Context cleared. Memories are unchanged."}


class NotificationBody(BaseModel):
    message: str
    notification_id: Optional[str] = None
    session_id: Optional[str] = None


@router.post("/api/sessions/notification")
async def save_notification_to_session(
    body: NotificationBody,
    current_user: models.User = Depends(auth.get_current_user),
):
    """Save a notification/reminder message to the user's session so it persists in chat history.
    If session_id is given, appends to that session; otherwise uses the latest session.
    Creates a new session if none exists. Returns the session_id used."""
    import time

    if body.session_id:
        session = storage.get_session(body.session_id)
        if session and (session.get("user_id") is None or session.get("user_id") == current_user.id):
            session["messages"].append({
                "role": "assistant",
                "content": body.message,
                "timestamp": time.time(),
                "notification": True,
                "notification_id": body.notification_id or f"notif_{int(time.time())}",
                "model_name": "Hyve",
            })
            storage.save_session(session["id"], session)
            return {"session_id": session["id"], "status": "saved"}

    # Fallback: latest session or create new
    sid = storage.append_notification_to_session(
        user_id=current_user.id,
        message=body.message,
        notification_id=body.notification_id,
    )
    return {"session_id": sid, "status": "saved"}
