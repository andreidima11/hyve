from datetime import datetime, timedelta
from typing import Any, Optional
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
import httpx
from sqlalchemy.orm import Session
from sqlalchemy import func

import core.auth as auth
import core.database as database
import core.models as models
import core.settings as settings
from core.http.errors import error_detail
import core.scheduler_service as scheduler_service
from brain.llm_client import get_llm_client


router = APIRouter(prefix="/api", tags=["entries"])

_ALLOWED_ENTRY_TYPES = {"task", "event"}
_ALLOWED_TASK_STATUS = {"todo", "in_progress", "done"}
_ALLOWED_STATUS = {"active", "archived"}


class CreateListBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=128)
    color: Optional[str] = Field(None, max_length=32)
    icon: Optional[str] = Field(None, max_length=64)


class UpdateListBody(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=128)
    color: Optional[str] = Field(None, max_length=32)
    icon: Optional[str] = Field(None, max_length=64)
    archived: Optional[bool] = None


class CreateEntryBody(BaseModel):
    list_id: int
    entry_type: str = Field(..., pattern="^(task|event)$")
    title: str = Field(..., min_length=1, max_length=200)
    content: Optional[str] = Field(None, max_length=5000)

    status: str = Field("active", pattern="^(active|archived)$")
    position: Optional[int] = Field(None, ge=0)

    task_status: Optional[str] = Field(None, pattern="^(todo|in_progress|done)$")
    priority: Optional[int] = Field(None, ge=1, le=5)
    due_at: Optional[datetime] = None

    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    all_day: Optional[bool] = None
    location: Optional[str] = Field(None, max_length=200)
    event_color: Optional[str] = Field(None, max_length=32)
    event_notify: Optional[bool] = True
    event_notify_minutes: Optional[int] = Field(30, ge=0, le=10080)
    event_action_enabled: Optional[bool] = False
    event_action_entity_id: Optional[str] = Field(None, max_length=255)
    event_action_service: Optional[str] = Field(None, pattern="^(turn_on|turn_off|toggle)$")
    event_action_offset_minutes: Optional[int] = Field(0, ge=0, le=10080)


class UpdateEntryBody(BaseModel):
    list_id: Optional[int] = None
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = Field(None, max_length=5000)
    status: Optional[str] = Field(None, pattern="^(active|archived)$")

    task_status: Optional[str] = Field(None, pattern="^(todo|in_progress|done)$")
    priority: Optional[int] = Field(None, ge=1, le=5)
    due_at: Optional[datetime] = None

    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    all_day: Optional[bool] = None
    location: Optional[str] = Field(None, max_length=200)
    event_color: Optional[str] = Field(None, max_length=32)
    event_notify: Optional[bool] = None
    event_notify_minutes: Optional[int] = Field(None, ge=0, le=10080)
    event_action_enabled: Optional[bool] = None
    event_action_entity_id: Optional[str] = Field(None, max_length=255)
    event_action_service: Optional[str] = Field(None, pattern="^(turn_on|turn_off|toggle)$")
    event_action_offset_minutes: Optional[int] = Field(None, ge=0, le=10080)
    position: Optional[int] = Field(None, ge=0)


class ConvertEntryBody(BaseModel):
    target_type: str = Field(..., pattern="^(task|event)$")


class ReorderEntryBody(BaseModel):
    list_id: int
    ordered_entry_ids: list[int] = Field(default_factory=list)


class AICaptureBody(BaseModel):
    text: str = Field(..., min_length=2, max_length=3000)
    list_id: Optional[int] = None


class AISuggestBody(BaseModel):
    view: str = Field("today", pattern="^(today|upcoming|overdue|recent)$")
    horizon_days: int = Field(7, ge=1, le=60)



def _serialize_list(row: models.TodoList) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "color": row.color,
        "icon": row.icon,
        "archived": bool(row.archived),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }



def _serialize_entry(row: models.Entry) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "list_id": row.list_id,
        "entry_type": row.entry_type,
        "title": row.title,
        "content": row.content,
        "status": row.status,
        "task_status": row.task_status,
        "priority": row.priority,
        "due_at": row.due_at.isoformat() if row.due_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        "start_at": row.start_at.isoformat() if row.start_at else None,
        "end_at": row.end_at.isoformat() if row.end_at else None,
        "all_day": row.all_day,
        "location": row.location,
        "event_color": row.event_color,
        "event_notify": row.event_notify,
        "event_notify_minutes": row.event_notify_minutes,
        "event_action_enabled": row.event_action_enabled,
        "event_action_entity_id": row.event_action_entity_id,
        "event_action_service": row.event_action_service,
        "event_action_offset_minutes": row.event_action_offset_minutes,
        "position": row.position,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _require_owned_list(db: Session, list_id: int, user_id: int) -> models.TodoList:
    row = db.query(models.TodoList).filter(
        models.TodoList.id == list_id,
        models.TodoList.user_id == user_id,
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=error_detail("planner.list_not_found"))
    return row



def _require_owned_entry(db: Session, entry_id: int, user_id: int) -> models.Entry:
    row = db.query(models.Entry).filter(
        models.Entry.id == entry_id,
        models.Entry.user_id == user_id,
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail=error_detail("planner.entry_not_found"))
    return row


def _planner_user_key(user: models.User) -> str:
    return f"user_{user.id}"


def _event_trigger_time(row: models.Entry) -> Optional[datetime]:
    if row.entry_type != "event" or not row.start_at or not bool(row.event_notify):
        return None
    minutes = int(row.event_notify_minutes or 0)
    if minutes < 0:
        minutes = 0
    return row.start_at - timedelta(minutes=minutes)


def _clear_event_jobs(row: models.Entry):
    if row.event_notify_job_id:
        scheduler_service.remove_reminder_job(row.event_notify_job_id)
        row.event_notify_job_id = None
    if row.event_action_job_id:
        scheduler_service.remove_reminder_job(row.event_action_job_id)
        row.event_action_job_id = None


def _sync_event_jobs(row: models.Entry, user: models.User):
    _clear_event_jobs(row)
    if row.entry_type != "event" or row.status == "archived":
        return

    user_key = _planner_user_key(user)
    channel = "web"
    now = datetime.now()

    notify_at = _event_trigger_time(row)
    if notify_at and notify_at > now:
        notify_id = scheduler_service.schedule_event_notification(
            user_id=user_key,
            entry_id=row.id,
            title=row.title,
            run_at=notify_at,
            channel=channel,
            minutes_before=int(row.event_notify_minutes or 0),
        )
        row.event_notify_job_id = notify_id

    can_run_action = bool(row.event_action_enabled) and bool((row.event_action_entity_id or "").strip()) and row.start_at
    if can_run_action:
        offset_min = int(row.event_action_offset_minutes or 0)
        if offset_min < 0:
            offset_min = 0
        action_at = row.start_at - timedelta(minutes=offset_min)
        if action_at > now:
            action_id = scheduler_service.schedule_event_action(
                user_id=user_key,
                entry_id=row.id,
                run_at=action_at,
                entity_id=(row.event_action_entity_id or "").strip(),
                action=(row.event_action_service or "turn_on"),
                channel=channel,
            )
            row.event_action_job_id = action_id


def _normalize_chat_url(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""
    if u.endswith("/chat/completions"):
        return u
    if u.endswith("/v1"):
        return f"{u}/chat/completions"
    if "/v1/" not in u and u.startswith("http"):
        return f"{u.rstrip('/')}/v1/chat/completions"
    return u


def _llm_headers(api_key: str) -> dict:
    key = (api_key or "").strip()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def _resolve_llm_config() -> tuple[str, str, str, float]:
    cfg = settings.CFG or {}
    aux = (cfg.get("intelligence") or {}).get("aux_llm") or {}
    llm = cfg.get("llm") or {}
    raw_url = (aux.get("target_url") or "").strip() or (llm.get("target_url") or "").strip()
    model = (aux.get("model_name") or "").strip() or (llm.get("model_name") or "").strip()
    api_key = (aux.get("api_key") or "").strip() or (llm.get("api_key") or "").strip()
    timeout = float((aux.get("timeout") or llm.get("timeout") or 60) or 60)
    return _normalize_chat_url(raw_url), model, api_key, timeout


def _fallback_ai_capture(text: str) -> list[dict[str, Any]]:
    text_clean = (text or "").strip()
    low = text_clean.lower()
    date_match = re.search(r"\b(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}))?\b", text_clean)
    dt_value = None
    if date_match:
        dt_value = date_match.group(1) + (f"T{date_match.group(2)}" if date_match.group(2) else "T09:00")

    event_keywords = ("meeting", "appointment", "call", "doctor", "party", "cinema", "dinner", "event")
    task_keywords = ("todo", "must", "need", "remember to", "fix", "buy", "pay", "send")

    if any(k in low for k in event_keywords):
        item: dict[str, Any] = {
            "entry_type": "event",
            "title": text_clean[:180],
            "content": text_clean,
        }
        if dt_value:
            item["start_at"] = dt_value
        return [item]

    if any(k in low for k in task_keywords):
        item = {
            "entry_type": "task",
            "title": text_clean[:180],
            "content": text_clean,
            "task_status": "todo",
        }
        if dt_value:
            item["due_at"] = dt_value
        return [item]

    return [{"entry_type": "event", "title": text_clean[:180], "content": text_clean}]


async def _ai_parse_entries(text: str) -> tuple[list[dict[str, Any]], str]:
    llm_url, llm_model, llm_api_key, timeout = _resolve_llm_config()
    fallback = _fallback_ai_capture(text)
    if not llm_url or not llm_model:
        return fallback, "fallback"

    prompt = (
        "You are a strict JSON planner parser. "
        "Convert user text into 1-5 planner items. "
        "Return only JSON with schema: "
        "{\"items\":[{\"entry_type\":\"task|event\",\"title\":\"...\",\"content\":\"...\","
        "\"task_status\":\"todo|in_progress|done\",\"priority\":1-5,\"due_at\":\"YYYY-MM-DDTHH:MM\","
        "\"start_at\":\"YYYY-MM-DDTHH:MM\",\"end_at\":\"YYYY-MM-DDTHH:MM\",\"all_day\":true|false,\"location\":\"...\"}]}. "
        "Only include fields when relevant."
    )

    payload = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
    }

    try:
        client = await get_llm_client()
        resp = await client.post(llm_url, json=payload, timeout=timeout, headers=_llm_headers(llm_api_key))
        if resp.status_code >= 300:
            return fallback, "fallback"
        data = resp.json() or {}
        content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not content:
            return fallback, "fallback"

        if "```" in content:
            content = content.replace("```json", "").replace("```", "").strip()
        parsed = json.loads(content)
        items = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(items, list) or not items:
            return fallback, "fallback"
        return items[:5], "ai"
    except (json.JSONDecodeError, ValueError, TypeError, httpx.HTTPError):
        return fallback, "fallback"


def _sanitize_ai_item(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    entry_type = (item.get("entry_type") or "").strip().lower()
    if entry_type not in _ALLOWED_ENTRY_TYPES:
        return None
    title = (item.get("title") or "").strip()
    if not title:
        return None

    clean: dict[str, Any] = {
        "entry_type": entry_type,
        "title": title[:200],
        "content": ((item.get("content") or "").strip() or None),
    }

    if entry_type == "task":
        task_status = (item.get("task_status") or "todo").strip().lower()
        if task_status not in _ALLOWED_TASK_STATUS:
            task_status = "todo"
        clean["task_status"] = task_status
        try:
            if item.get("priority") is not None:
                p = int(item.get("priority"))
                if 1 <= p <= 5:
                    clean["priority"] = p
        except (TypeError, ValueError):
            pass
        if item.get("due_at"):
            clean["due_at"] = item.get("due_at")

    if entry_type == "event":
        if item.get("start_at"):
            clean["start_at"] = item.get("start_at")
        if item.get("end_at"):
            clean["end_at"] = item.get("end_at")
        if isinstance(item.get("all_day"), bool):
            clean["all_day"] = item.get("all_day")
        location = (item.get("location") or "").strip()
        if location:
            clean["location"] = location[:200]

    return clean


def _parse_optional_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _smart_view_query(
    db: Session,
    user_id: int,
    view: str,
    horizon_days: int,
    now: Optional[datetime] = None,
):
    now = now or datetime.now()
    start_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_day = start_day + timedelta(days=1)
    horizon_end = now + timedelta(days=horizon_days)

    q = db.query(models.Entry).filter(models.Entry.user_id == user_id, models.Entry.status != "archived")

    if view == "today":
        q = q.filter(
            (
                (models.Entry.entry_type == "task")
                & (models.Entry.task_status != "done")
                & (models.Entry.due_at.isnot(None))
                & (models.Entry.due_at >= start_day)
                & (models.Entry.due_at < end_day)
            )
            |
            (
                (models.Entry.entry_type == "event")
                & (models.Entry.start_at.isnot(None))
                & (models.Entry.start_at >= start_day)
                & (models.Entry.start_at < end_day)
            )
        )
    elif view == "upcoming":
        q = q.filter(
            (
                (models.Entry.entry_type == "task")
                & (models.Entry.task_status != "done")
                & (models.Entry.due_at.isnot(None))
                & (models.Entry.due_at >= now)
                & (models.Entry.due_at <= horizon_end)
            )
            |
            (
                (models.Entry.entry_type == "event")
                & (models.Entry.start_at.isnot(None))
                & (models.Entry.start_at >= now)
                & (models.Entry.start_at <= horizon_end)
            )
        )
    elif view == "overdue":
        q = q.filter(
            models.Entry.entry_type == "task",
            models.Entry.task_status != "done",
            models.Entry.due_at.isnot(None),
            models.Entry.due_at < now,
        )
    elif view == "recent":
        q = q.filter(models.Entry.created_at >= now - timedelta(days=horizon_days))

    return q


@router.get("/lists")
def list_lists(
    include_archived: bool = Query(False),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    q = db.query(models.TodoList).filter(models.TodoList.user_id == current_user.id)
    if not include_archived:
        q = q.filter(models.TodoList.archived.is_(False))
    rows = q.order_by(models.TodoList.updated_at.desc()).all()
    return {"lists": [_serialize_list(r) for r in rows]}


@router.post("/lists")
def create_list(
    body: CreateListBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = models.TodoList(
        user_id=current_user.id,
        title=body.title.strip(),
        color=(body.color or "").strip() or None,
        icon=(body.icon or "").strip() or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _serialize_list(row)


@router.patch("/lists/{list_id}")
def update_list(
    list_id: int,
    body: UpdateListBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_list(db, list_id, current_user.id)
    if body.title is not None:
        row.title = body.title.strip()
    if body.color is not None:
        row.color = body.color.strip() or None
    if body.icon is not None:
        row.icon = body.icon.strip() or None
    if body.archived is not None:
        row.archived = body.archived
    db.commit()
    db.refresh(row)
    return _serialize_list(row)


@router.delete("/lists/{list_id}")
def delete_list(
    list_id: int,
    hard_delete: bool = Query(False),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_list(db, list_id, current_user.id)
    if hard_delete:
        db.delete(row)
        db.commit()
        return {"status": "deleted"}
    row.archived = True
    db.commit()
    return {"status": "archived"}


@router.get("/entries")
def list_entries(
    list_id: Optional[int] = Query(None, ge=1),
    entry_type: Optional[str] = Query(None),
    task_status: Optional[str] = Query(None),
    due_before: Optional[datetime] = Query(None),
    due_after: Optional[datetime] = Query(None),
    q: Optional[str] = Query(None),
    include_archived: bool = Query(False),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    query = db.query(models.Entry).filter(models.Entry.user_id == current_user.id)

    if list_id is not None:
        _require_owned_list(db, list_id, current_user.id)
        query = query.filter(models.Entry.list_id == list_id)

    if entry_type:
        if entry_type not in _ALLOWED_ENTRY_TYPES:
            raise HTTPException(status_code=422, detail=error_detail("planner.invalid_entry_type"))
        query = query.filter(models.Entry.entry_type == entry_type)

    if task_status:
        if task_status not in _ALLOWED_TASK_STATUS:
            raise HTTPException(status_code=422, detail=error_detail("planner.invalid_task_status"))
        query = query.filter(models.Entry.task_status == task_status)

    if due_before is not None:
        query = query.filter(models.Entry.due_at.isnot(None), models.Entry.due_at <= due_before)
    if due_after is not None:
        query = query.filter(models.Entry.due_at.isnot(None), models.Entry.due_at >= due_after)

    if not include_archived:
        query = query.filter(models.Entry.status != "archived")

    if q:
        term = f"%{q.strip()}%"
        query = query.filter((models.Entry.title.ilike(term)) | (models.Entry.content.ilike(term)))

    rows = query.order_by(models.Entry.position.asc(), models.Entry.updated_at.desc()).offset(offset).limit(limit).all()
    return {"entries": [_serialize_entry(r) for r in rows]}


@router.get("/entries/smart")
def smart_entries(
    view: str = Query("today", pattern="^(today|upcoming|overdue|recent)$"),
    horizon_days: int = Query(7, ge=1, le=60),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    rows = _smart_view_query(db, current_user.id, view, horizon_days).order_by(
        models.Entry.due_at.asc().nulls_last(),
        models.Entry.start_at.asc().nulls_last(),
        models.Entry.updated_at.desc(),
    ).limit(limit).all()
    return {"view": view, "entries": [_serialize_entry(r) for r in rows]}


@router.get("/entries/calendar")
def calendar_entries(
    start_at: Optional[datetime] = Query(None),
    end_at: Optional[datetime] = Query(None),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    q = db.query(models.Entry).filter(
        models.Entry.user_id == current_user.id,
        models.Entry.entry_type == "event",
        models.Entry.status != "archived",
    )
    if start_at is not None:
        q = q.filter(models.Entry.start_at.isnot(None), models.Entry.start_at >= start_at)
    if end_at is not None:
        q = q.filter(models.Entry.start_at.isnot(None), models.Entry.start_at <= end_at)
    rows = q.order_by(models.Entry.start_at.asc().nulls_last(), models.Entry.updated_at.desc()).all()
    return {"entries": [_serialize_entry(r) for r in rows]}


@router.get("/entries/{entry_id}")
def get_entry(
    entry_id: int,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_entry(db, entry_id, current_user.id)
    return _serialize_entry(row)


@router.post("/entries")
def create_entry(
    body: CreateEntryBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    _require_owned_list(db, body.list_id, current_user.id)

    # Normalise datetimes to naive (strip timezone) to avoid comparison errors
    if body.start_at and body.start_at.tzinfo:
        body.start_at = body.start_at.replace(tzinfo=None)
    if body.end_at and body.end_at.tzinfo:
        body.end_at = body.end_at.replace(tzinfo=None)
    if body.due_at and body.due_at.tzinfo:
        body.due_at = body.due_at.replace(tzinfo=None)

    if body.end_at and body.start_at and body.end_at < body.start_at:
        raise HTTPException(status_code=400, detail=error_detail("planner.end_before_start"))

    task_status = body.task_status
    if body.entry_type == "task" and task_status is None:
        task_status = "todo"

    if body.entry_type != "task":
        task_status = None


    row = models.Entry(
        user_id=current_user.id,
        list_id=body.list_id,
        entry_type=body.entry_type,
        title=body.title.strip(),
        content=(body.content or "").strip() or None,
        status=body.status,
        task_status=task_status,
        priority=body.priority if body.entry_type == "task" else None,
        due_at=body.due_at if body.entry_type == "task" else None,
        start_at=body.start_at if body.entry_type == "event" else None,
        end_at=body.end_at if body.entry_type == "event" else None,
        all_day=body.all_day if body.entry_type == "event" else None,
        location=(body.location or "").strip() or None if body.entry_type == "event" else None,
        event_color=(body.event_color or "").strip() or "#4f46e5" if body.entry_type == "event" else None,
        event_notify=bool(body.event_notify) if body.entry_type == "event" else None,
        event_notify_minutes=int(body.event_notify_minutes or 0) if body.entry_type == "event" else None,
        event_action_enabled=bool(body.event_action_enabled) if body.entry_type == "event" else None,
        event_action_entity_id=(body.event_action_entity_id or "").strip() or None if body.entry_type == "event" else None,
        event_action_service=(body.event_action_service or "turn_on") if body.entry_type == "event" else None,
        event_action_offset_minutes=int(body.event_action_offset_minutes or 0) if body.entry_type == "event" else None,
        position=body.position if body.position is not None else 0,
    )
    db.add(row)
    db.flush()
    _sync_event_jobs(row, current_user)
    db.commit()
    db.refresh(row)
    return _serialize_entry(row)


@router.patch("/entries/{entry_id}")
def update_entry(
    entry_id: int,
    body: UpdateEntryBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_entry(db, entry_id, current_user.id)

    if body.list_id is not None:
        _require_owned_list(db, body.list_id, current_user.id)
        row.list_id = body.list_id
    if body.title is not None:
        row.title = body.title.strip()
    if body.content is not None:
        row.content = body.content.strip() or None
    if body.status is not None:
        if body.status not in _ALLOWED_STATUS:
            raise HTTPException(status_code=422, detail=error_detail("planner.invalid_status"))
        row.status = body.status

    if row.entry_type == "task":
        if body.task_status is not None:
            row.task_status = body.task_status
            row.completed_at = datetime.now() if body.task_status == "done" else None
        if body.priority is not None:
            row.priority = body.priority
        if body.due_at is not None:
            row.due_at = body.due_at

    if row.entry_type == "event":
        if body.start_at is not None:
            row.start_at = body.start_at.replace(tzinfo=None) if hasattr(body.start_at, 'tzinfo') and body.start_at.tzinfo else body.start_at
        if body.end_at is not None:
            row.end_at = body.end_at.replace(tzinfo=None) if hasattr(body.end_at, 'tzinfo') and body.end_at.tzinfo else body.end_at
        if row.end_at and row.start_at:
            _end = row.end_at.replace(tzinfo=None) if hasattr(row.end_at, 'tzinfo') and row.end_at.tzinfo else row.end_at
            _start = row.start_at.replace(tzinfo=None) if hasattr(row.start_at, 'tzinfo') and row.start_at.tzinfo else row.start_at
            if _end < _start:
                raise HTTPException(status_code=400, detail=error_detail("planner.end_before_start"))
        if body.all_day is not None:
            row.all_day = body.all_day
        if body.location is not None:
            row.location = body.location.strip() or None
        if body.event_color is not None:
            row.event_color = (body.event_color or "").strip() or "#4f46e5"
        if body.event_notify is not None:
            row.event_notify = bool(body.event_notify)
        if body.event_notify_minutes is not None:
            row.event_notify_minutes = int(body.event_notify_minutes)
        if body.event_action_enabled is not None:
            row.event_action_enabled = bool(body.event_action_enabled)
        if body.event_action_entity_id is not None:
            row.event_action_entity_id = (body.event_action_entity_id or "").strip() or None
        if body.event_action_service is not None:
            row.event_action_service = body.event_action_service
        if body.event_action_offset_minutes is not None:
            row.event_action_offset_minutes = int(body.event_action_offset_minutes)

        if not bool(row.event_notify):
            pass
        if not bool(row.event_action_enabled):
            row.event_action_entity_id = None

        _sync_event_jobs(row, current_user)


    if body.position is not None:
        row.position = body.position

    db.commit()
    db.refresh(row)
    return _serialize_entry(row)


@router.delete("/entries/{entry_id}")
def delete_entry(
    entry_id: int,
    hard_delete: bool = Query(False),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_entry(db, entry_id, current_user.id)
    _clear_event_jobs(row)
    if hard_delete:
        db.delete(row)
        db.commit()
        return {"status": "deleted"}
    row.status = "archived"
    db.commit()
    return {"status": "archived"}


@router.post("/entries/{entry_id}/convert")
def convert_entry(
    entry_id: int,
    body: ConvertEntryBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    row = _require_owned_entry(db, entry_id, current_user.id)
    target = body.target_type
    if target == row.entry_type:
        return _serialize_entry(row)

    row.entry_type = target
    if target == "task":
        _clear_event_jobs(row)
        row.task_status = row.task_status or "todo"
        if row.completed_at is None and row.task_status == "done":
            row.completed_at = datetime.now()
        row.start_at = None
        row.end_at = None
        row.all_day = None
        row.location = None
        row.event_color = None
        row.event_notify = None
        row.event_notify_minutes = None
        row.event_notify_job_id = None
        row.event_action_enabled = None
        row.event_action_entity_id = None
        row.event_action_service = None
        row.event_action_offset_minutes = None
        row.event_action_job_id = None
    elif target == "event":
        row.task_status = None
        row.priority = None
        row.due_at = None
        row.completed_at = None
        if row.start_at is None:
            row.start_at = datetime.now()
        row.event_color = row.event_color or "#4f46e5"
        row.event_notify = True if row.event_notify is None else row.event_notify
        row.event_notify_minutes = 30 if row.event_notify_minutes is None else row.event_notify_minutes
        row.event_action_enabled = False if row.event_action_enabled is None else row.event_action_enabled
        row.event_action_service = row.event_action_service or "turn_on"
        row.event_action_offset_minutes = 0 if row.event_action_offset_minutes is None else row.event_action_offset_minutes
        _sync_event_jobs(row, current_user)

    db.commit()
    db.refresh(row)
    return _serialize_entry(row)


@router.post("/entries/reorder")
def reorder_entries(
    body: ReorderEntryBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    _require_owned_list(db, body.list_id, current_user.id)
    if not body.ordered_entry_ids:
        return {"updated": 0}

    rows = db.query(models.Entry).filter(
        models.Entry.user_id == current_user.id,
        models.Entry.list_id == body.list_id,
        models.Entry.id.in_(body.ordered_entry_ids),
    ).all()
    by_id = {r.id: r for r in rows}

    updated = 0
    for idx, entry_id in enumerate(body.ordered_entry_ids):
        row = by_id.get(entry_id)
        if not row:
            continue
        if row.position != idx:
            row.position = idx
            updated += 1

    db.commit()
    return {"updated": updated}


@router.post("/entries/ai/capture")
async def ai_capture_entries(
    body: AICaptureBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    target_list_id = body.list_id
    if target_list_id is not None:
        _require_owned_list(db, target_list_id, current_user.id)
    else:
        first_list = db.query(models.TodoList).filter(
            models.TodoList.user_id == current_user.id,
            models.TodoList.archived.is_(False),
        ).order_by(models.TodoList.updated_at.desc()).first()
        if first_list is None:
            first_list = models.TodoList(user_id=current_user.id, title="Inbox")
            db.add(first_list)
            db.commit()
            db.refresh(first_list)
        target_list_id = first_list.id

    parsed_items, mode = await _ai_parse_entries(body.text)
    valid_items = []
    for item in parsed_items:
        clean = _sanitize_ai_item(item if isinstance(item, dict) else {})
        if clean:
            valid_items.append(clean)
    if not valid_items:
        valid_items = _fallback_ai_capture(body.text)

    max_pos = db.query(func.max(models.Entry.position)).filter(
        models.Entry.user_id == current_user.id,
        models.Entry.list_id == target_list_id,
    ).scalar()
    next_pos = int(max_pos or 0)

    created = []
    for item in valid_items:
        next_pos += 1
        row = models.Entry(
            user_id=current_user.id,
            list_id=target_list_id,
            entry_type=item.get("entry_type"),
            title=(item.get("title") or "")[:200],
            content=item.get("content"),
            status="active",
            task_status=item.get("task_status") if item.get("entry_type") == "task" else None,
            priority=item.get("priority") if item.get("entry_type") == "task" else None,
            due_at=_parse_optional_datetime(item.get("due_at")),
            start_at=_parse_optional_datetime(item.get("start_at")),
            end_at=_parse_optional_datetime(item.get("end_at")),
            all_day=item.get("all_day") if item.get("entry_type") == "event" else None,
            location=item.get("location") if item.get("entry_type") == "event" else None,
            position=next_pos,
        )
        db.add(row)
        db.flush()
        created.append(_serialize_entry(row))

    db.commit()
    return {"mode": mode, "created": created, "list_id": target_list_id}


@router.post("/entries/ai/suggest")
async def ai_suggest_entries(
    body: AISuggestBody,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    rows = _smart_view_query(db, current_user.id, body.view, body.horizon_days).order_by(
        models.Entry.due_at.asc().nulls_last(),
        models.Entry.start_at.asc().nulls_last(),
        models.Entry.updated_at.desc(),
    ).limit(120).all()

    if not rows:
        return {
            "mode": "fallback",
            "brief": "No entries found for this view. You can add tasks or events with AI capture.",
            "stats": {"total": 0},
        }

    task_open = sum(1 for r in rows if r.entry_type == "task" and r.task_status != "done")
    task_done = sum(1 for r in rows if r.entry_type == "task" and r.task_status == "done")
    events = sum(1 for r in rows if r.entry_type == "event")

    llm_url, llm_model, llm_api_key, timeout = _resolve_llm_config()
    fallback_brief = (
        f"View: {body.view}. Open tasks: {task_open}. Completed tasks: {task_done}. "
        f"Events: {events}. "
        "Focus first on overdue/high-priority tasks, then time-block upcoming events."
    )

    if not llm_url or not llm_model:
        return {
            "mode": "fallback",
            "brief": fallback_brief,
            "stats": {"total": len(rows), "open_tasks": task_open, "done_tasks": task_done, "events": events},
        }

    compact = []
    for row in rows[:80]:
        when = row.due_at or row.start_at
        compact.append({
            "type": row.entry_type,
            "title": row.title,
            "status": row.task_status if row.entry_type == "task" else row.status,
            "when": when.isoformat() if when else None,
            "priority": row.priority,
        })

    prompt = (
        "You are a personal productivity strategist. "
        "Given planner entries, produce concise actionable advice in markdown with sections: "
        "1) Top Priorities, 2) Suggested Schedule, 3) Risks. Keep under 180 words."
    )

    payload = {
        "model": llm_model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps({"view": body.view, "horizon_days": body.horizon_days, "entries": compact}, ensure_ascii=False)},
        ],
        "temperature": 0.2,
    }

    try:
        client = await get_llm_client()
        resp = await client.post(llm_url, json=payload, timeout=timeout, headers=_llm_headers(llm_api_key))
        if resp.status_code >= 300:
            raise HTTPException(status_code=resp.status_code, detail=error_detail("planner.llm_unavailable"))
        data = resp.json() or {}
        text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not text:
            text = fallback_brief
            mode = "fallback"
        else:
            mode = "ai"
    except Exception:
        text = fallback_brief
        mode = "fallback"

    return {
        "mode": mode,
        "brief": text,
        "stats": {"total": len(rows), "open_tasks": task_open, "done_tasks": task_done, "events": events},
    }
