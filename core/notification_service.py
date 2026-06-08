from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import datetime
from typing import Any

import httpx

import database
import models
import push_fcm
import settings
from logger import log_detail, log_line


def numeric_user_id(user_id: str | int | None) -> int | None:
    value = str(user_id or "").strip()
    if value.startswith("user_"):
        value = value.split("_", 1)[1]
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def user_key(user_id: str | int | None) -> str:
    uid = numeric_user_id(user_id)
    return f"user_{uid}" if uid is not None else str(user_id or "")


def serialize_notification(row: models.Notification, include_deliveries: bool = False) -> dict:
    payload = {}
    if row.payload_json:
        try:
            payload = json.loads(row.payload_json)
        except Exception:
            payload = {}
    item = {
        "id": row.id,
        "user_id": row.user_id,
        "title": row.title or "Hyve",
        "body": row.body or "",
        "category": row.category or "system",
        "source_type": row.source_type,
        "source_id": row.source_id,
        "severity": row.severity or "info",
        "priority": row.priority or "normal",
        "payload": payload,
        "action_url": row.action_url,
        "read_at": row.read_at.isoformat() if row.read_at else None,
        "archived_at": row.archived_at.isoformat() if row.archived_at else None,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if include_deliveries:
        item["deliveries"] = [
            {
                "transport": delivery.transport,
                "target": delivery.target,
                "status": delivery.status,
                "attempts": delivery.attempts,
                "error": delivery.error,
                "sent_at": delivery.sent_at.isoformat() if delivery.sent_at else None,
                "delivered_at": delivery.delivered_at.isoformat() if delivery.delivered_at else None,
            }
            for delivery in (row.deliveries or [])
        ]
    return item


def unread_count(db, user_id: int) -> int:
    return int(
        db.query(models.Notification)
        .filter(
            models.Notification.user_id == user_id,
            models.Notification.read_at.is_(None),
            models.Notification.archived_at.is_(None),
        )
        .count()
        or 0
    )


def list_notifications(db, user_id: int, state: str = "all", category: str | None = None, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
    query = db.query(models.Notification).filter(models.Notification.user_id == user_id)
    if state == "unread":
        query = query.filter(models.Notification.read_at.is_(None), models.Notification.archived_at.is_(None))
    elif state == "archived":
        query = query.filter(models.Notification.archived_at.isnot(None))
    else:
        query = query.filter(models.Notification.archived_at.is_(None))
    if category:
        query = query.filter(models.Notification.category == category)
    total = int(query.count() or 0)
    rows = query.order_by(models.Notification.created_at.desc()).offset(max(0, offset)).limit(max(1, min(100, limit))).all()
    return [serialize_notification(row) for row in rows], total


def create_notification(
    user_id: str | int,
    title: str = "Hyve",
    body: str = "",
    category: str = "system",
    source_type: str | None = None,
    source_id: str | None = None,
    severity: str = "info",
    priority: str = "normal",
    dedupe_key: str | None = None,
    payload: dict[str, Any] | None = None,
    action_url: str | None = None,
    notification_id: str | None = None,
) -> dict | None:
    uid = numeric_user_id(user_id)
    if uid is None:
        log_detail("notifications", "CREATE_INVALID_USER", user_id=str(user_id))
        return None
    clean_body = str(body or "").strip() or "Notification"
    clean_title = str(title or "Hyve").strip() or "Hyve"
    db = database.SessionLocal()
    try:
        if dedupe_key:
            existing = db.query(models.Notification).filter(
                models.Notification.user_id == uid,
                models.Notification.dedupe_key == dedupe_key,
                models.Notification.archived_at.is_(None),
            ).order_by(models.Notification.created_at.desc()).first()
            if existing:
                return serialize_notification(existing)
        row = models.Notification(
            id=notification_id or f"notif_{uid}_{int(time.time())}_{uuid.uuid4().hex[:8]}",
            user_id=uid,
            title=clean_title[:255],
            body=clean_body,
            category=str(category or "system").strip().lower() or "system",
            source_type=(source_type or None),
            source_id=(source_id or None),
            severity=str(severity or "info").strip().lower() or "info",
            priority=str(priority or "normal").strip().lower() or "normal",
            dedupe_key=dedupe_key,
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
            action_url=action_url,
        )
        db.add(row)
        db.flush()
        _record_delivery(db, row.id, "in_app", "stored")
        db.commit()
        db.refresh(row)
        return serialize_notification(row)
    finally:
        db.close()


def create_and_dispatch(
    user_id: str | int,
    title: str = "Hyve",
    body: str = "",
    category: str = "system",
    transport_hint: str | None = None,
    **kwargs,
) -> dict | None:
    item = create_notification(user_id=user_id, title=title, body=body, category=category, **kwargs)
    if item:
        dispatch_notification(item["id"], transport_hint=transport_hint)
    return item


def mark_read(db, user_id: int, notification_id: str) -> dict:
    row = _owned_notification(db, user_id, notification_id)
    if row.read_at is None:
        row.read_at = datetime.now()
        db.commit()
        db.refresh(row)
    _emit_counts(user_id)
    _emit_event(user_key(user_id), "notification.updated", {"notification": serialize_notification(row), "unread_count": unread_count(db, user_id)})
    return serialize_notification(row)


def mark_all_read(db, user_id: int) -> int:
    now = datetime.now()
    updated = db.query(models.Notification).filter(
        models.Notification.user_id == user_id,
        models.Notification.read_at.is_(None),
        models.Notification.archived_at.is_(None),
    ).update({models.Notification.read_at: now, models.Notification.updated_at: now}, synchronize_session=False)
    db.commit()
    _emit_counts(user_id)
    return int(updated or 0)


def archive_notification(db, user_id: int, notification_id: str) -> dict:
    row = _owned_notification(db, user_id, notification_id)
    now = datetime.now()
    row.archived_at = now
    if row.read_at is None:
        row.read_at = now
    db.commit()
    db.refresh(row)
    _emit_counts(user_id)
    _emit_event(user_key(user_id), "notification.updated", {"notification": serialize_notification(row), "unread_count": unread_count(db, user_id)})
    return serialize_notification(row)


def delete_notification(db, user_id: int, notification_id: str) -> dict:
    row = _owned_notification(db, user_id, notification_id)
    db.delete(row)
    db.commit()
    count = unread_count(db, user_id)
    _emit_event(user_key(user_id), "notification.deleted", {"notification_id": notification_id, "unread_count": count})
    return {"id": notification_id}


def delete_all_notifications(db, user_id: int) -> int:
    rows = db.query(models.Notification).filter(
        models.Notification.user_id == user_id,
        models.Notification.archived_at.is_(None),
    ).all()
    deleted = len(rows)
    for row in rows:
        db.delete(row)
    db.commit()
    count = unread_count(db, user_id)
    _emit_event(user_key(user_id), "notification.deleted", {"deleted_count": deleted, "state": "active", "unread_count": count})
    return deleted


def dispatch_notification(notification_id: str, transport_hint: str | None = None) -> dict:
    db = database.SessionLocal()
    try:
        row = db.query(models.Notification).filter(models.Notification.id == notification_id).first()
        if row is None:
            return {"websocket": False, "firebase": 0, "waha": False}
        item = serialize_notification(row)
        user = db.query(models.User).filter(models.User.id == row.user_id).first()
        prefs = _load_user_prefs(user)
        cfg = settings.CFG

        ws_sent = False
        if prefs.get("app", True):
            ws_sent = _emit_event(
                user_key(row.user_id),
                "notification.created",
                {
                    "notification": item,
                    "unread_count": unread_count(db, row.user_id),
                    "type": item["category"],
                    "title": item["title"],
                    "message": item["body"],
                    "notification_id": item["id"],
                    "timestamp": int(time.time()),
                },
            )
            _record_delivery(db, row.id, "websocket", "sent" if ws_sent else "skipped")

        fcm_sent = 0
        if prefs.get("app", True) and _should_send_fcm(cfg, ws_sent):
            try:
                fcm_sent = push_fcm.send_push_notification(
                    user_id=user_key(row.user_id),
                    title=item["title"],
                    message=item["body"],
                    notification_id=item["id"],
                    notification_type=item["category"],
                )
                _record_delivery(db, row.id, "firebase", "sent" if fcm_sent else "skipped", attempts=1)
            except Exception as exc:
                _record_delivery(db, row.id, "firebase", "failed", attempts=1, error=str(exc))
                log_line("error", "❌", "FCM", f"Push send failed: {exc}")

        want_waha = str(transport_hint or "").lower() in {"waha", "whatsapp"} or bool(prefs.get("whatsapp"))
        waha_ok = False
        if want_waha and (cfg.get("waha") or {}).get("enabled"):
            try:
                target = _waha_target_for_user(user, cfg)
                if target:
                    _send_waha(target, item["body"], cfg)
                    waha_ok = True
                    _record_delivery(db, row.id, "waha", "sent", target=target, attempts=1)
                else:
                    _record_delivery(db, row.id, "waha", "skipped", error="no_target")
            except Exception as exc:
                _record_delivery(db, row.id, "waha", "failed", attempts=1, error=str(exc))
                log_line("error", "❌", "WAHA", f"Notification send failed: {exc}")
        db.commit()
        return {"websocket": ws_sent, "firebase": fcm_sent, "waha": waha_ok}
    finally:
        db.close()


def _owned_notification(db, user_id: int, notification_id: str) -> models.Notification:
    row = db.query(models.Notification).filter(
        models.Notification.id == notification_id,
        models.Notification.user_id == user_id,
    ).first()
    if row is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Notification not found")
    return row


def _record_delivery(db, notification_id: str, transport: str, status: str, target: str | None = None, attempts: int = 0, error: str | None = None) -> None:
    db.add(models.NotificationDelivery(
        notification_id=notification_id,
        transport=transport,
        target=target,
        status=status,
        attempts=attempts,
        error=error,
        sent_at=datetime.now() if status == "sent" else None,
        delivered_at=datetime.now() if status in {"sent", "stored"} else None,
    ))
    db.flush()


def _load_user_prefs(user: models.User | None) -> dict:
    prefs = {"app": True, "whatsapp": False}
    if user and user.notification_preferences:
        try:
            loaded = json.loads(user.notification_preferences)
            if isinstance(loaded, dict):
                prefs.update(loaded)
        except Exception:
            pass
    return prefs


def _should_send_fcm(cfg: dict, ws_sent: bool) -> bool:
    fcm_cfg = cfg.get("fcm") or {}
    mode = str(fcm_cfg.get("transport_mode") or "hybrid").strip().lower()
    if mode not in {"websocket", "firebase", "hybrid"}:
        mode = "hybrid"
    if mode == "websocket" or not fcm_cfg.get("enabled"):
        return False
    if mode == "firebase":
        return True
    return not ws_sent if fcm_cfg.get("send_when_ws_disconnected", True) else True


def _emit_counts(user_id: int) -> bool:
    db = database.SessionLocal()
    try:
        return _emit_event(user_key(user_id), "notification.counts", {"unread_count": unread_count(db, user_id)})
    finally:
        db.close()


def _emit_event(user_id: str, event: str, payload: dict) -> bool:
    message = {"event": event, **payload}
    try:
        from routers.notifications_ws import manager
        if not manager.has_active_connection(str(user_id)):
            return False

        async def _send():
            return await manager.broadcast_to_user(str(user_id), message)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop and loop.is_running():
            from task_utils import create_tracked_task
            create_tracked_task(_send(), name="notification_ws_send")
            return True
        try:
            from core.http.runtime import run_coroutine_on_main_loop

            return bool(run_coroutine_on_main_loop(_send(), timeout=5))
        except Exception as exc:
            log_detail("notifications", "WS_LOOP_ERROR", error=str(exc))
            return False
    except Exception as exc:
        log_detail("notifications", "WS_EMIT_ERROR", error=str(exc))
        return False


def _sanitize_text_for_waha(text: str) -> str:
    value = re.sub(r"<think>\s*.*?\s*</think>", " ", str(text or ""), flags=re.DOTALL | re.IGNORECASE)
    value = re.sub(r"<thinking>\s*.*?\s*</thinking>", " ", value, flags=re.DOTALL | re.IGNORECASE)
    value = re.sub(r"\s+", " ", value).strip()
    return (value or "Notification").replace("<", "«").replace(">", "»")


def _waha_target_for_user(user: models.User | None, cfg: dict) -> str | None:
    if user and user.phone_numbers:
        return user.phone_numbers[0].waha_id
    allowed = (cfg.get("security") or {}).get("allowed_numbers") or []
    if not allowed:
        return None
    target = str(allowed[0]).strip()
    return target if "@c.us" in target else f"{target}@c.us"


def _send_waha(target_chat: str, message: str, cfg: dict) -> None:
    waha = cfg.get("waha") or {}
    url = f"{str(waha.get('api_url') or '').rstrip('/')}/api/sendText"
    payload = {"chatId": target_chat, "text": f"*Hyve:*\n{_sanitize_text_for_waha(message)}", "session": "default"}
    headers = {"X-Api-Key": waha.get("api_key", ""), "Content-Type": "application/json"}
    with httpx.Client(timeout=5) as client:
        response = client.post(url, json=payload, headers=headers, timeout=10)
    if response.status_code not in {200, 201}:
        raise RuntimeError(f"WAHA HTTP {response.status_code}: {(response.text or '')[:160]}")