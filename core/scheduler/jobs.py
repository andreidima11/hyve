"""Scheduler jobs: automations, reminders, notifications, consolidation."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta

import settings as settings_mod
from logger import log_detail, log_line

from core.scheduler.engine import reload_config_if_needed, scheduler, start_scheduler, stop_scheduler, to_naive_local
from core.scheduler.meta import (
    delete_automation_spec,
    get_automation_spec,
    get_automation_specs_bulk,
    get_reminder_display,
    get_reminder_displays_bulk,
    set_automation_spec,
    set_reminder_display,
)

def run_automation(job_id):
    """Rulează acțiunile pentru job_id: HA (commands) sau skill (run_skill + notify cu rezultat). Optimizat: config reload throttle, un singur client HA, device list încărcat o dată."""
    spec = get_automation_spec(job_id)
    if not spec:
        log_detail("scheduler", "AUTO_RUN_NO_SPEC", job_id=job_id)
        # Job orfan (spec șters la delete): îl scoatem din scheduler ca să nu mai ruleze la următoarea trigger
        try:
            scheduler.remove_job(str(job_id))
            log_detail("scheduler", "JOB_REMOVE_ORPHAN", job_id=job_id)
        except Exception:
            pass  # already removed by APScheduler; harmless
        return
    reload_config_if_needed()
    user_id = spec.get("user_id", "")
    channel = spec.get("channel", "web")
    action_type = (spec.get("action_type") or "ha").strip().lower()

    if action_type == "skill":
        skill_name = (spec.get("skill_name") or "").strip()
        skill_input = spec.get("skill_input") or {}
        if not skill_name:
            log_detail("scheduler", "AUTO_RUN_SKILL_NO_NAME", job_id=job_id)
            return
        try:
            import skills as skills_mod
            # Inject SearXNG URL so sandboxed skills can make web requests
            allow_network = False
            from integrations import entry_settings

            searxng = entry_settings.searxng_settings()
            if searxng.get("url"):
                skill_input["_searxng_url"] = searxng["url"].strip()
                allow_network = True
            result = skills_mod.run_skill(skill_name, skill_input, allow_network=allow_network)
            msg = _format_skill_result(skill_name, result)
            log_detail("scheduler", "AUTO_RUN_SKILL_OK", job_id=job_id, skill=skill_name)
            trigger_notification(user_id, msg, channel, notification_type="automation")
        except Exception as e:
            log_detail("scheduler", "AUTO_RUN_SKILL_ERROR", job_id=job_id, skill=skill_name, error=str(e))
            trigger_notification(user_id, f"⚠️ Automatizare {skill_name}: eroare — {e}", channel, notification_type="automation")
        return

    # Non-skill actions are no-ops; emit notify_message if present.
    if action_type == "ha":
        commands = spec.get("commands") or []
        for cmd in commands:
            target = (cmd.get("target") or "").strip()
            action = (cmd.get("action") or "").strip()
            data = cmd.get("data") or {}
            if not target or not action:
                continue
            try:
                _execute_ha_action(target, action, data)
                log_detail("scheduler", "AUTO_RUN_HA_OK", job_id=job_id, target=target, action=action)
            except Exception as e:
                log_detail("scheduler", "AUTO_RUN_HA_ERROR", job_id=job_id, target=target, action=action, error=str(e))
        if spec.get("notify_message"):
            trigger_notification(user_id, spec.get("notify_message", ""), channel, notification_type="automation")
        return

    log_detail("scheduler", "AUTO_RUN_UNSUPPORTED", job_id=job_id, action_type=action_type)
    if spec.get("notify_message"):
        trigger_notification(user_id, spec.get("notify_message", ""), channel, notification_type="automation")


def _execute_ha_action(entity_id: str, action: str, data: dict | None = None):
    """Resolve entity_id → integration and execute control_entity on the main loop."""
    from core.device_control import ControlTargetNotFound, control_entity_sync

    try:
        return control_entity_sync(entity_id, action, data or {})
    except ControlTargetNotFound as exc:
        raise RuntimeError(str(exc)) from exc

def _format_skill_result(skill_name, result):
    """Format a skill execution result into a readable notification message.
    Prefers rich 'summary' field (e.g. news_summary markdown) over raw key-value dumps."""
    if not result or not isinstance(result, dict):
        return f"Skill {skill_name} ran (no result)."
    msg = result.get("message") or ""
    data = result.get("data") or {}
    if not result.get("success"):
        return msg or f"Skill {skill_name} failed."
    if isinstance(data, dict):
        # Prefer rich summary field (news_summary, etc.)
        if data.get("summary"):
            return data["summary"]
        if data.get("result"):
            r = data["result"]
            return r if isinstance(r, str) else str(r)
        # Structured key-value fallback — format nicely with markdown
        if data:
            parts = []
            for k, v in data.items():
                if v is not None and k not in ("symbol", "name", "raw"):
                    parts.append(f"**{k}**: {v}")
            if parts:
                return "\n".join(parts)
    return msg or f"Skill {skill_name} ran."

def _sanitize_text_for_waha(text):
    """Strip <think>/</think> and escape < > so WAHA (Puppeteer evaluate) doesn't 500."""
    if not text or not isinstance(text, str):
        return (text or "").strip()
    s = re.sub(r"<think>\s*.*?\s*</think>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<thinking>\s*.*?\s*</thinking>", " ", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"\s*<think>\s*|\s*<thinking>\s*", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*</think>\s*|\s*</thinking>\s*", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("<", "«").replace(">", "»")
    return s or "Reminder"

# --- NOTIFICATION DEDUPLICATION ---
_notification_dedup_lock = threading.Lock()
_notification_dedup_cache = {}  # key: (user_id, message_hash) -> last_sent_time
_DEDUP_WINDOW_SECONDS = 30

def _should_send_notification(user_id, message):
    """Return True if this notification should be sent (not a duplicate within the dedup window)."""
    import hashlib
    key = (str(user_id), hashlib.md5((message or "").encode()).hexdigest())
    now = time.time()
    with _notification_dedup_lock:
        last_sent = _notification_dedup_cache.get(key, 0)
        if now - last_sent < _DEDUP_WINDOW_SECONDS:
            log_line("job", "🔇", "DEDUP", f"Skipped duplicate notification for {user_id} (within {_DEDUP_WINDOW_SECONDS}s window)")
            return False
        _notification_dedup_cache[key] = now
        # Evict expired entries when cache grows large (proper LRU instead of clearing all)
        if len(_notification_dedup_cache) > 500:
            cutoff = now - _DEDUP_WINDOW_SECONDS * 2
            expired_keys = [k for k, ts in _notification_dedup_cache.items() if ts < cutoff]
            for k in expired_keys:
                del _notification_dedup_cache[k]
        return True

# --- WEBSOCKET NOTIFICATION HELPER ---
def _try_send_websocket_notification(user_id, message, notification_id=None, session_id=None, notification_type="reminder"):
    """Try to send notification via WebSocket if connection exists (non-blocking).
    APScheduler runs jobs in a thread pool, so we need to get the main asyncio loop.
    Returns True if WebSocket delivery succeeded, False otherwise."""
    try:
        from routers.notifications_ws import send_reminder_via_websocket, manager
        
        # Quick check: skip if no active connection for this user
        if not manager.has_active_connection(str(user_id)):
            log_line("websocket", "📵", "REMINDER_WS", f"No WS connection for {user_id}, skipping")
            return False
        
        # APScheduler runs in a thread — we need the main event loop
        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        
        _kwargs = dict(notification_id=notification_id, session_id=session_id, notification_type=notification_type)
        
        if loop and loop.is_running():
            # We're somehow in the async context — schedule it (can't wait for result)
            from task_utils import create_tracked_task
            create_tracked_task(send_reminder_via_websocket(str(user_id), message, **_kwargs), name="reminder_ws_send")
            return True  # Optimistic — connection exists
        else:
            try:
                from core.http.runtime import run_coroutine_on_main_loop

                result = run_coroutine_on_main_loop(
                    send_reminder_via_websocket(str(user_id), message, **_kwargs),
                    timeout=5,
                )
                return bool(result)
            except Exception as inner_e:
                log_line("error", "⚠️", "REMINDER_WS", f"Loop dispatch failed: {inner_e}")
                return False
    except Exception as e:
        log_line("error", "❌", "REMINDER_WS", f"WebSocket send failed: {e}")
        log_detail("scheduler", "WEBSOCKET_SEND_ERROR", error=str(e))
    return False

# --- FUNCȚIA EXECUTATĂ CÂND SONĂ CEASUL ---

def _get_user_notification_prefs(user_id: str) -> dict:
    """Load notification preferences for a user from DB. Returns defaults if not set."""
    defaults = {"app": True, "whatsapp": True}
    try:
        import database, models, json
        db = next(database.get_db())
        try:
            # user_id is "user_N" — extract N
            uid_num = int(user_id.replace("user_", "")) if user_id.startswith("user_") else None
            if uid_num is None:
                return defaults
            user = db.query(models.User).filter(models.User.id == uid_num).first()
            if user and user.notification_preferences:
                return json.loads(user.notification_preferences)
        finally:
            db.close()
    except Exception as e:
        log_line("error", "⚠️", "NOTIF_PREFS", f"Error loading prefs for {user_id}: {e}")
    return defaults

def trigger_notification(user_id, message, channel, notification_type="reminder"):
    """Create a persistent notification and dispatch it to live/push transports.
    Dedup: skips if same user+message within 30s."""
    # --- Strip think tags from ALL notification channels ---
    from brain.cortex import strip_think
    message = strip_think(message or "")
    if not message:
        message = "Notification"
    # --- DEDUP CHECK: prevent duplicate notifications within short window ---
    if not _should_send_notification(user_id, message):
        log_detail("scheduler", "TRIGGER_DEDUP_SKIP", user_id=user_id, message_preview=(message or "")[:80])
        return

    log_detail("scheduler", "TRIGGER_START", user_id=user_id, channel=channel, message_len=len(message or ""), message_preview=(message or "")[:80])
    reload_config_if_needed()
    cfg = settings_mod.CFG
    log_line("job", "⏰", "REMINDER", f"{user_id}: {(message or '')[:120]}")
    try:
        from core import notification_service
        notification_service.create_and_dispatch(
            user_id=user_id,
            title="Hyve",
            body=message,
            category=notification_type or "reminder",
            transport_hint="waha" if str(channel or "").strip().lower() in {"whatsapp", "waha"} else None,
        )
    except Exception as e:
        log_line("error", "❌", "REMINDER", f"Notification dispatch failed: {e}")
        log_detail("scheduler", "TRIGGER_NOTIFICATION_EXCEPTION", error=str(e))

def to_naive_local(dt):
    if dt is None or dt.tzinfo is None:
        return dt
    try:
        return dt.astimezone().replace(tzinfo=None)
    except Exception:
        return datetime.now()


def _run_biweekly_reminder(user_id, message, channel, weekday, recurrence_time):
    """Trigger notification then schedule next run in 14 days (same weekday)."""
    trigger_notification(user_id, message, channel)
    next_run = datetime.now() + timedelta(days=14)
    schedule_reminder(user_id, message, channel, run_at=next_run, recurrence="biweekly", weekday=weekday, recurrence_time=recurrence_time)


def _run_biweekly_automation(job_id, weekday, recurrence_time):
    """Run automation then reschedule in 14 days. Old job_id is one-shot so spec is removed after copy."""
    run_automation(job_id)
    spec = get_automation_spec(job_id)
    if not spec:
        return
    next_run = datetime.now() + timedelta(days=14)
    if (spec.get("action_type") or "ha") == "skill":
        schedule_automation(
            spec.get("user_id", ""),
            channel=spec.get("channel", "web"),
            run_at=next_run,
            recurrence="biweekly",
            weekday=weekday,
            recurrence_time=recurrence_time,
            display_message=spec.get("display_message"),
            skill_name=spec.get("skill_name"),
            skill_input=spec.get("skill_input") or {},
        )
    else:
        schedule_automation(
            spec.get("user_id", ""),
            spec.get("commands", []),
            channel=spec.get("channel", "web"),
            run_at=next_run,
            recurrence="biweekly",
            weekday=weekday,
            recurrence_time=recurrence_time,
            notify_message=spec.get("notify_message"),
            display_message=spec.get("display_message"),
        )
    delete_automation_spec(job_id)  # one-shot job finished; new job has its own id and spec


def schedule_automation(
    user_id,
    commands=None,
    channel="web",
    run_at=None,
    recurrence="none",
    weekday=None,
    recurrence_time="09:00",
    notify_message=None,
    display_message=None,
    skill_name=None,
    skill_input=None,
):
    """
    Programează o automatizare: HA (commands) sau skill (skill_name + skill_input).
    La trigger: HA = rulează comenzile; skill = rulează skill-ul și trimite rezultatul utilizatorului.
    recurrence/weekday/recurrence_time: ca la schedule_reminder.
    Returns human-readable when it will run.
    """
    recurrence = (recurrence or "none").strip().lower()
    recurrence_time = (recurrence_time or "09:00").strip()
    parts = recurrence_time.replace(".", ":").split(":")
    hour = int(parts[0]) if parts else 9
    minute = int(parts[1]) if len(parts) > 1 else 0
    minute = min(59, max(0, minute))
    hour = min(23, max(0, hour))
    commands = list(commands) if commands else []
    job_id = f"auto_{user_id}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    if (skill_name or "").strip():
        action_type = "skill"
        spec = {
            "user_id": user_id,
            "channel": channel,
            "action_type": "skill",
            "skill_name": (skill_name or "").strip(),
            "skill_input": skill_input if isinstance(skill_input, dict) else {},
            "display_message": (display_message or "").strip() or f"Skill: {skill_name}",
        }
    else:
        action_type = "ha"
        spec = {
            "user_id": user_id,
            "channel": channel,
            "action_type": "ha",
            "commands": commands,
            "notify_message": notify_message or "",
            "display_message": (display_message or "").strip() or _automation_display_summary(commands),
        }
    set_automation_spec(job_id, spec)
    log_detail("scheduler", "AUTO_ADD_START", job_id=job_id, recurrence=recurrence)

    if recurrence == "daily":
        scheduler.add_job(
            run_automation,
            "cron",
            hour=hour,
            minute=minute,
            args=[job_id],
            id=job_id,
            replace_existing=True,
        )
        eta_str = f"daily at {hour:02d}:{minute:02d}"
        log_detail("scheduler", "AUTO_ADD_DONE", job_id=job_id, trigger="cron_daily", eta=eta_str)
        return eta_str

    if recurrence == "weekly" and weekday:
        dow = weekday.strip().lower()[:3]
        scheduler.add_job(
            run_automation,
            "cron",
            day_of_week=dow,
            hour=hour,
            minute=minute,
            args=[job_id],
            id=job_id,
            replace_existing=True,
        )
        eta_str = f"every {weekday} at {hour:02d}:{minute:02d}"
        log_detail("scheduler", "AUTO_ADD_DONE", job_id=job_id, trigger="cron_weekly", eta=eta_str)
        return eta_str

    if recurrence == "biweekly" and weekday and run_at is not None:
        run_date = to_naive_local(run_at)
        scheduler.add_job(
            _run_biweekly_automation,
            "date",
            run_date=run_date,
            args=[job_id, weekday.strip().lower(), recurrence_time],
            id=job_id,
            replace_existing=True,
        )
        eta_str = run_date.strftime("%Y-%m-%d %H:%M") + " (every 2 weeks)"
        log_detail("scheduler", "AUTO_ADD_DONE", job_id=job_id, trigger="date_biweekly", eta=eta_str)
        return eta_str

    # One-off
    if run_at is not None:
        run_date = to_naive_local(run_at)
    else:
        run_date = datetime.now()
    scheduler.add_job(
        run_automation,
        "date",
        run_date=run_date,
        args=[job_id],
        id=job_id,
        replace_existing=True,
    )
    eta_str = run_date.strftime("%Y-%m-%d %H:%M")
    log_detail("scheduler", "AUTO_ADD_DONE", job_id=job_id, trigger="date", eta=eta_str)
    return eta_str


def _automation_display_summary(commands):
    """Short text for list: e.g. 'Aprinde light.living, închide cover.blind'."""
    if not commands:
        return "Automatizare HA"
    out = []
    for c in commands:
        act = (c.get("action") or "toggle").strip().lower()
        t = (c.get("target") or "?").strip()
        if act == "turn_on":
            out.append(f"Aprinde {t}")
        elif act == "turn_off":
            out.append(f"Stinge {t}")
        else:
            out.append(f"Toggle {t}")
    return ", ".join(out)[:200]


def schedule_reminder(
    user_id,
    message,
    channel="web",
    run_at=None,
    recurrence="none",
    weekday=None,
    recurrence_time="09:00",
    display_message=None,
    job_id=None,
):
    """
    Schedule a reminder: one-off (run_at), daily (cron), weekly (cron), or biweekly (self-rescheduling).
    message: text sent to user when reminder fires (e.g. "Nu uita să bei apă").
    display_message: optional text shown in reminders list (e.g. "Amintește-i utilizatorului să bea apă"). If omitted, message is used.
    weekday: lowercase english (monday..sunday). recurrence_time: "HH:MM" 24h.
    Returns human-readable description of when it will run.
    """
    recurrence = (recurrence or "none").strip().lower()
    recurrence_time = (recurrence_time or "09:00").strip()
    parts = recurrence_time.replace(".", ":").split(":")
    hour = int(parts[0]) if parts else 9
    minute = int(parts[1]) if len(parts) > 1 else 0
    minute = min(59, max(0, minute))
    hour = min(23, max(0, hour))

    if not job_id:
        job_id = f"remind_{user_id}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    log_detail("scheduler", "JOB_ADD_START", job_id=job_id, recurrence=recurrence, weekday=weekday, recurrence_time=recurrence_time, run_at=str(run_at) if run_at else None)

    if recurrence == "daily":
        scheduler.add_job(
            trigger_notification,
            "cron",
            hour=hour,
            minute=minute,
            args=[user_id, message, channel],
            id=job_id,
            replace_existing=True,
        )
        if display_message:
            set_reminder_display(job_id, display_message)
        eta_str = f"daily at {hour:02d}:{minute:02d}"
        log_detail("scheduler", "JOB_ADD_DONE", job_id=job_id, trigger="cron_daily", eta=eta_str)
        return eta_str

    if recurrence == "weekly" and weekday:
        dow = weekday.strip().lower()[:3]  # mon, tue, ...
        scheduler.add_job(
            trigger_notification,
            "cron",
            day_of_week=dow,
            hour=hour,
            minute=minute,
            args=[user_id, message, channel],
            id=job_id,
            replace_existing=True,
        )
        if display_message:
            set_reminder_display(job_id, display_message)
        eta_str = f"every {weekday} at {hour:02d}:{minute:02d}"
        log_detail("scheduler", "JOB_ADD_DONE", job_id=job_id, trigger="cron_weekly", eta=eta_str)
        return eta_str

    if recurrence == "biweekly" and weekday and run_at is not None:
        run_date = to_naive_local(run_at)
        scheduler.add_job(
            _run_biweekly_reminder,
            "date",
            run_date=run_date,
            args=[user_id, message, channel, weekday.strip().lower(), recurrence_time],
            id=job_id,
            replace_existing=True,
        )
        if display_message:
            set_reminder_display(job_id, display_message)
        eta_str = run_date.strftime("%Y-%m-%d %H:%M") + " (every 2 weeks)"
        log_detail("scheduler", "JOB_ADD_DONE", job_id=job_id, trigger="date_biweekly", eta=eta_str)
        return eta_str

    # One-off
    if run_at is not None:
        run_date = to_naive_local(run_at)
    else:
        run_date = datetime.now()
    scheduler.add_job(
        trigger_notification,
        "date",
        run_date=run_date,
        args=[user_id, message, channel],
        id=job_id,
        replace_existing=True,
    )
    if display_message:
        set_reminder_display(job_id, display_message)
    eta_str = run_date.strftime("%Y-%m-%d %H:%M")
    log_detail("scheduler", "JOB_ADD_DONE", job_id=job_id, trigger="date", eta=eta_str)
    return eta_str


def schedule_at(user_id, message, channel, date_ymd, time_hm, timezone_str=None, display_message=None):
    """
    Schedule a one-off reminder at an exact calendar date and time (cron-like).
    message: text sent when reminder fires. display_message: optional text for list.
    date_ymd: "YYYY-MM-DD", time_hm: "HH:MM" or "H:MM". No parsing, no LLM — exact values.
    Returns human-readable when it will run, or None if date/time invalid.
    """
    try:
        y, mo, d = [int(x) for x in str(date_ymd).strip().split("-")]
        parts = str(time_hm).strip().replace(".", ":").split(":")
        h = int(parts[0]) if parts else 0
        m = int(parts[1]) if len(parts) > 1 else 0
        h, m = min(23, max(0, h)), min(59, max(0, m))
        run = datetime(y, mo, d, h, m, 0, 0)
        if timezone_str and str(timezone_str).strip():
            try:
                from zoneinfo import ZoneInfo
                run = run.replace(tzinfo=ZoneInfo(str(timezone_str).strip()))
            except Exception as e:
                log_detail("scheduler", "INVALID_TIMEZONE", tz=str(timezone_str), error=str(e))
        run_naive = to_naive_local(run) if run.tzinfo else run
        if run_naive <= datetime.now():
            return None
        return schedule_reminder(user_id, message, channel, run_at=run, display_message=display_message)
    except Exception as e:
        log_detail("scheduler", "SCHEDULE_AT_ERROR", error=str(e))
        return None


def schedule_event_notification(user_id, entry_id, title, run_at, channel="web", minutes_before=0):
    """Schedule a one-off planner event reminder notification. Returns job_id or None."""
    try:
        if run_at is None:
            return None
        run_date = to_naive_local(run_at)
        if run_date <= datetime.now():
            return None
        uid = str(user_id)
        job_id = f"evt_notify_{uid}_{int(entry_id)}"
        message = f"Eveniment: {title}" if title else "Eveniment"
        display = f"{title} ({int(minutes_before)} min înainte)" if title else "Event reminder"
        schedule_reminder(
            uid,
            message,
            channel=channel,
            run_at=run_date,
            recurrence="none",
            display_message=display,
            job_id=job_id,
        )
        return job_id
    except Exception as e:
        log_detail("scheduler", "EVENT_NOTIFY_SCHEDULE_ERROR", entry_id=str(entry_id), error=str(e))
        return None


def schedule_event_action(user_id, entry_id, run_at, entity_id, action="turn_on", channel="web"):
    """Schedule a one-off HA action tied to a planner event reminder. Returns job_id or None."""
    try:
        if run_at is None:
            return None
        run_date = to_naive_local(run_at)
        if run_date <= datetime.now():
            return None
        uid = str(user_id)
        target = str(entity_id or "").strip()
        if not target:
            return None
        act = str(action or "turn_on").strip().lower()
        if act not in ("turn_on", "turn_off", "toggle"):
            act = "turn_on"
        job_id = f"evt_action_{uid}_{int(entry_id)}"
        set_automation_spec(job_id, {
            "user_id": uid,
            "channel": channel,
            "action_type": "ha",
            "commands": [{"target": target, "action": act}],
            "notify_message": "",
            "display_message": f"Event action: {act} {target}",
        })
        scheduler.add_job(
            run_automation,
            "date",
            run_date=run_date,
            args=[job_id],
            id=job_id,
            replace_existing=True,
        )
        return job_id
    except Exception as e:
        log_detail("scheduler", "EVENT_ACTION_SCHEDULE_ERROR", entry_id=str(entry_id), error=str(e))
        return None


def list_automation_jobs(user_id=None):
    """Return list of automation jobs (id, run_at, message, user_id, channel, recurring). Bulk DB read for performance."""
    out = []
    try:
        jobs = scheduler.get_jobs()
        auto_jobs = [j for j in jobs if j.id and j.id.startswith("auto_")]
        if not auto_jobs:
            return out
        job_ids = [j.id for j in auto_jobs]
        specs_by_id = get_automation_specs_bulk(job_ids)
        for job in auto_jobs:
            spec = specs_by_id.get(job.id)
            if not spec:
                continue
            uid = spec.get("user_id", "")
            if user_id is not None and str(uid) != str(user_id):
                continue
            atype = spec.get("action_type") or "ha"
            msg = spec.get("display_message") or (_automation_display_summary(spec.get("commands") or []) if atype == "ha" else f"Skill: {spec.get('skill_name', '?')}")
            run_at = None
            if job.next_run_time:
                run_at = job.next_run_time.strftime("%Y-%m-%dT%H:%M:%S") if hasattr(job.next_run_time, "strftime") else str(job.next_run_time)
            recurring = getattr(job.trigger, "__class__", None) and "cron" in job.trigger.__class__.__name__.lower()
            item = {
                "id": job.id,
                "run_at": run_at,
                "message": msg,
                "user_id": uid,
                "channel": spec.get("channel", "web"),
                "recurring": recurring,
                "action_type": atype,
            }
            if atype == "skill":
                item["skill_name"] = spec.get("skill_name", "")
                item["skill_input"] = spec.get("skill_input") or {}
            out.append(item)
    except Exception as e:
        log_line("error", "⚠️", "SCHEDULER", f"list_automation_jobs error: {e}")
    return out


def get_automation_job(job_id):
    """Get one automation job by id. Returns dict or None."""
    if not job_id or not str(job_id).startswith("auto_"):
        return None
    try:
        job = scheduler.get_job(str(job_id))
        if not job:
            return None
        spec = get_automation_spec(job_id)
        if not spec:
            return None
        run_at = None
        if job.next_run_time:
            run_at = job.next_run_time.strftime("%Y-%m-%dT%H:%M:%S") if hasattr(job.next_run_time, "strftime") else str(job.next_run_time)
        recurring = getattr(job.trigger, "__class__", None) and "cron" in job.trigger.__class__.__name__.lower()
        atype = spec.get("action_type") or "ha"
        msg = spec.get("display_message") or (_automation_display_summary(spec.get("commands") or []) if atype == "ha" else f"Skill: {spec.get('skill_name', '?')}")
        out = {
            "id": job.id,
            "run_at": run_at,
            "message": msg,
            "user_id": spec.get("user_id"),
            "channel": spec.get("channel", "web"),
            "recurring": recurring,
            "action_type": atype,
        }
        if atype == "skill":
            out["skill_name"] = spec.get("skill_name", "")
            out["skill_input"] = spec.get("skill_input") or {}
        return out
    except Exception as e:
        log_line("error", "⚠️", "SCHEDULER", f"get_automation_job error: {e}")
        return None


def list_reminder_jobs(user_id=None):
    """Return list of reminder jobs (id, run_at, message, user_id, channel, recurring). Bulk DB read for performance."""
    out = []
    try:
        jobs = scheduler.get_jobs()
        remind_jobs = [j for j in jobs if j.id and j.id.startswith("remind_")]
        if not remind_jobs:
            return out
        displays = get_reminder_displays_bulk([j.id for j in remind_jobs])
        for job in remind_jobs:
            args = list(job.args) if job.args else []
            if len(args) >= 3:
                uid, notif_msg, ch = args[0], args[1], args[2]
            else:
                uid, notif_msg, ch = "", "?", "web"
            if user_id is not None and str(uid) != str(user_id):
                continue
            msg = displays.get(job.id) or notif_msg
            run_at = None
            if job.next_run_time:
                run_at = job.next_run_time.strftime("%Y-%m-%dT%H:%M:%S") if hasattr(job.next_run_time, "strftime") else str(job.next_run_time)
            recurring = getattr(job.trigger, "trigger", None) is not None and job.trigger.__class__.__name__.lower() == "crontrigger"
            if not recurring and hasattr(job, "trigger") and hasattr(job.trigger, "__class__"):
                recurring = "cron" in job.trigger.__class__.__name__.lower()
            out.append({
                "id": job.id,
                "run_at": run_at,
                "message": msg,
                "user_id": uid,
                "channel": ch,
                "recurring": recurring,
            })
    except Exception as e:
        log_line("error", "⚠️", "SCHEDULER", f"list_reminder_jobs error: {e}")
    return out


def remove_reminder_job(job_id):
    """Remove a reminder or automation job by id. Returns True if removed."""
    if not job_id:
        return False
    s = str(job_id)
    if not (s.startswith("remind_") or s.startswith("auto_") or s.startswith("evt_notify_") or s.startswith("evt_action_")):
        return False
    try:
        log_detail("scheduler", "JOB_REMOVE", job_id=job_id)
        # Pentru automatizări: ștergem spec-ul ÎNAINTE de remove_job, ca la orice trigger ulterior
        # (inclusiv după restart, dacă job-ul a rămas în jobs.sqlite) să nu se mai trimită notificarea.
        if s.startswith("auto_") or s.startswith("evt_action_"):
            delete_automation_spec(job_id)
        scheduler.remove_job(s)
        if s.startswith("remind_") or s.startswith("evt_notify_"):
            set_reminder_display(job_id, None)
        return True
    except Exception as e:
        log_detail("scheduler", "JOB_REMOVE_ERROR", job_id=job_id, error=str(e))
        return False


def bulk_remove_reminder_jobs(job_ids, user_id=None):
    """Remove multiple reminder/automation jobs. If user_id is set, only remove jobs belonging to that user. Returns number removed."""
    removed = 0
    for jid in job_ids or []:
        if not jid:
            continue
        s = str(jid)
        if not (s.startswith("remind_") or s.startswith("auto_")):
            continue
        job = get_reminder_job(jid) or get_automation_job(jid)
        if job and (user_id is None or str(job.get("user_id")) == str(user_id)):
            if remove_reminder_job(jid):
                removed += 1
    return removed


def get_reminder_job(job_id):
    """Get one reminder job by id. Returns dict or None. message = display text for list."""
    if not job_id or not str(job_id).startswith("remind_"):
        return None
    try:
        job = scheduler.get_job(str(job_id))
        if not job or not job.args or len(job.args) < 3:
            return None
        uid, notif_msg, ch = job.args[0], job.args[1], job.args[2]
        msg = get_reminder_display(job.id) or notif_msg
        run_at = None
        if job.next_run_time:
            run_at = job.next_run_time.strftime("%Y-%m-%dT%H:%M:%S") if hasattr(job.next_run_time, "strftime") else str(job.next_run_time)
        recurring = getattr(job.trigger, "__class__", None) and "cron" in job.trigger.__class__.__name__.lower()
        return {"id": job.id, "run_at": run_at, "message": msg, "user_id": uid, "channel": ch, "recurring": recurring}
    except Exception as e:
        log_line("error", "⚠️", "SCHEDULER", f"get_reminder_job error: {e}")
        return None


def update_reminder_job(job_id, user_id, message=None, channel="web", run_at=None):
    """Edit a one-off reminder: remove old and add new with same or new message/run_at. Returns new eta or None."""
    job = get_reminder_job(job_id)
    if not job or job.get("recurring"):
        return None
    msg = message if message is not None else job.get("message", "Reminder")
    uid = user_id or job.get("user_id", "user_1")
    ch = channel or job.get("channel", "web")
    next_run = run_at
    if next_run is None and job.get("run_at"):
        try:
            from datetime import datetime
            next_run = datetime.fromisoformat(job["run_at"].replace("Z", "+00:00"))
            if next_run.tzinfo:
                next_run = to_naive_local(next_run)
        except Exception as e:
            log_line("error", "⚠️", "SCHEDULER", f"update_reminder_job date parse error: {e}")
            return None
    if next_run is None:
        return None
    remove_reminder_job(job_id)
    return schedule_reminder(uid, msg, ch, run_at=next_run, display_message=msg)


# --- CONSOLIDARE MEMORII (la oră setată) ---
CONSOLIDATION_JOB_ID = "memory_consolidation"


def _run_consolidation_job():
    """Wrapper: dedupe + opțional AI prune (LLM decide ce fapte să șteargă)."""
    try:
        import settings as settings_mod
        settings_mod.reload_config()
        cfg = settings_mod.CFG.get("intelligence", {}).get("consolidation", {})
        if not cfg.get("enabled"):
            return
        threshold = float(cfg.get("similarity_threshold", 0.92))
        from core.memory_maintenance import run_consolidation, run_ai_prune, consolidate_all_sessions_daily_mvp
        run_consolidation(threshold=threshold)
        daily_out = consolidate_all_sessions_daily_mvp(max_sessions=300)
        log_line("mem", "🗂️", "MEMORY_DAILY", f"processed={daily_out.get('processed', 0)} consolidated={daily_out.get('consolidated', 0)} errors={daily_out.get('errors', 0)}")
        if cfg.get("ai_prune"):
            aux = settings_mod.CFG.get("intelligence", {}).get("aux_llm") or {}
            llm = settings_mod.CFG.get("llm") or {}
            llm_url = (aux.get("target_url") or "").strip() or (llm.get("target_url") or "").strip()
            llm_model = (aux.get("model_name") or "").strip() or (llm.get("model_name") or "").strip()
            if llm_url and llm_model:
                run_ai_prune(cfg, llm_url, llm_model)
    except Exception as e:
        log_line("error", "❌", "CONSOLIDATION", str(e))


def schedule_consolidation_job():
    """Programează consolidarea memoriilor la ora configurată (cron)."""
    try:
        import settings as settings_mod
        settings_mod.reload_config()
        cfg = settings_mod.CFG.get("intelligence", {}).get("consolidation", {})
        if scheduler.get_job(CONSOLIDATION_JOB_ID):
            scheduler.remove_job(CONSOLIDATION_JOB_ID)
        if not cfg.get("enabled") or not cfg.get("time"):
            return
        time_str = str(cfg.get("time", "03:00")).strip()
        parts = time_str.replace(".", ":").split(":")
        hour = int(parts[0]) if parts else 3
        minute = int(parts[1]) if len(parts) > 1 else 0
        interval = (cfg.get("interval") or "daily").lower()
        if interval == "weekly":
            scheduler.add_job(_run_consolidation_job, "cron", day_of_week="sun", hour=hour, minute=minute, id=CONSOLIDATION_JOB_ID, replace_existing=True)
        else:
            scheduler.add_job(_run_consolidation_job, "cron", hour=hour, minute=minute, id=CONSOLIDATION_JOB_ID, replace_existing=True)
        log_line("job", "✅", "CONSOLIDATION", f"Scheduled at {hour:02d}:{minute:02d} ({interval})")
    except Exception as e:
        log_line("error", "❌", "CONSOLIDATION", f"Schedule error: {e}")


