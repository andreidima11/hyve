from __future__ import annotations

import os
from datetime import datetime

import database
import models
import settings
from logger import log_detail, log_line


def _numeric_user_id(user_id: str) -> int | None:
    value = str(user_id or "").strip()
    if value.startswith("user_"):
        value = value.split("_", 1)[1]
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _get_fcm_credentials_path() -> str:
    env_path = (os.environ.get("HYVE_FCM_SERVICE_ACCOUNT_PATH") or "").strip()
    if env_path:
        return env_path
    cfg = settings.CFG.get("fcm") or {}
    return str(cfg.get("service_account_path") or "").strip()


def is_fcm_enabled() -> bool:
    cfg = settings.CFG.get("fcm") or {}
    return bool(cfg.get("enabled") and _get_fcm_credentials_path())


def _get_firebase_app():
    import firebase_admin
    from firebase_admin import credentials

    path = _get_fcm_credentials_path()
    if not path:
        raise RuntimeError("FCM service account path is not configured")
    existing = firebase_admin._apps.get("hyve-fcm")  # type: ignore[attr-defined]
    if existing:
        return existing
    cred = credentials.Certificate(path)
    project_id = str((settings.CFG.get("fcm") or {}).get("project_id") or "").strip() or None
    options = {"projectId": project_id} if project_id else None
    return firebase_admin.initialize_app(cred, options=options, name="hyve-fcm")


def send_push_notification(
    user_id: str,
    title: str,
    message: str,
    notification_id: str | None = None,
    session_id: str | None = None,
    notification_type: str = "reminder",
) -> int:
    if not is_fcm_enabled():
        log_detail("notifications", "FCM_DISABLED", user_id=str(user_id))
        return 0

    uid = _numeric_user_id(user_id)
    if uid is None:
        return 0

    import firebase_admin
    from firebase_admin import messaging

    _get_firebase_app()

    db = database.SessionLocal()
    try:
        devices = db.query(models.PushDevice).filter(
            models.PushDevice.user_id == uid,
            models.PushDevice.enabled.is_(True),
        ).all()
        if not devices:
            log_detail("notifications", "FCM_NO_DEVICES", user_id=str(user_id))
            return 0

        sent = 0
        invalid_tokens: list[str] = []
        data = {
            "title": str(title or "Hyve"),
            "message": str(message or ""),
            "type": str(notification_type or "reminder"),
            "notification_id": str(notification_id or ""),
            "session_id": str(session_id or ""),
        }
        for device in devices:
            msg = messaging.Message(
                token=device.push_token,
                data=data,
                android=messaging.AndroidConfig(priority="high"),
            )
            try:
                messaging.send(msg, app=firebase_admin.get_app("hyve-fcm"))
                device.last_seen_at = datetime.now()
                sent += 1
            except Exception as exc:
                err_text = str(exc)
                log_line("error", "⚠️", "FCM_SEND", f"token={device.id}: {err_text}")
                if "registration-token" in err_text.lower() or "unregistered" in err_text.lower() or "not found" in err_text.lower():
                    invalid_tokens.append(device.push_token)

        if invalid_tokens:
            db.query(models.PushDevice).filter(models.PushDevice.push_token.in_(invalid_tokens)).update(
                {models.PushDevice.enabled: False},
                synchronize_session=False,
            )
        db.commit()
        log_detail("notifications", "FCM_SENT", user_id=str(user_id), sent=sent)
        return sent
    finally:
        db.close()