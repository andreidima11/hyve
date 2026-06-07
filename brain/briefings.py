"""AI Briefings — proactive morning/evening intelligence reports.

Gathers context (weather, planner events, home state) and runs one LLM call
to produce a concise, actionable briefing pushed as a notification.

Config (intelligence.briefings):
    enabled: true/false
    morning_time: "07:30"
    evening_time: "21:00"
    include_weather: true
    include_planner: true
    include_home_status: true
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, date, timedelta
from typing import Any, Optional

import settings as settings_mod
from core import i18n as core_i18n
from logger import log_line, log_detail


def _cfg() -> dict:
    intel = settings_mod.CFG.get("intelligence") or {}
    return intel.get("briefings") or {}


def is_enabled() -> bool:
    return bool(_cfg().get("enabled", False))


def _normalize_chat_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/chat/completions"):
        return url
    return (url + "/v1/chat/completions") if "/v1" not in url else (url + "/chat/completions")


def _resolve_profile() -> Optional[dict]:
    """The model profile chosen for briefings (or None = use the active profile)."""
    pid = str(_cfg().get("profile_id") or "").strip()
    if not pid:
        return None
    for p in (settings_mod.CFG.get("model_profiles") or []):
        if str(p.get("id") or "") == pid:
            return p
    return None


def _llm_endpoint() -> tuple[str, str, str]:
    """Resolve LLM endpoint for briefings (selected profile or active profile)."""
    prof = _resolve_profile()
    if prof:
        url = _normalize_chat_url(prof.get("target_url", ""))
        model = (prof.get("model_name") or "").strip()
        api_key = (prof.get("api_key") or "").strip()
        return url, model, api_key

    llm_cfg = settings_mod.CFG.get("llm") or {}
    url = _normalize_chat_url(llm_cfg.get("target_url", ""))
    model = (llm_cfg.get("model_name") or "").strip()
    api_key = (llm_cfg.get("api_key") or "").strip()
    return url, model, api_key


def _provider() -> str:
    """Provider of the active profile. A bare llm config is always local."""
    prof = _resolve_profile()
    if prof:
        return str(prof.get("provider") or "").strip().lower()
    return "local"


def _strip_think(raw: str) -> str:
    """Remove <think>…</think> reasoning blocks emitted by thinking models."""
    out = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)
    out = re.sub(r"<think>.*", "", out, flags=re.S)
    out = out.strip()
    # If stripping removed everything (model never closed the think tag, or the
    # whole reply was reasoning), fall back to the raw text minus the opening tag.
    if not out and raw.strip():
        out = raw.replace("<think>", "").replace("</think>", "").strip()
    return out


async def _llm_complete(messages: list[dict], max_tokens: int = 1200) -> str:
    from llm_client import get_llm_client
    url, model, api_key = _llm_endpoint()
    log_line("info", "📋", "BRIEFING", f"LLM call → url={url} model={model or '(none)'}")
    if not url or not model:
        log_line("error", "📋", "BRIEFING", "LLM endpoint not configured (empty url/model)")
        return ""
    msgs = [dict(m) for m in messages]
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict = {
        "model": model,
        "messages": msgs,
        "temperature": 0.4,
        "max_tokens": max_tokens,
        "stream": False,
    }
    from brain.thinking_control import apply_thinking_suppression
    payload, msgs = apply_thinking_suppression(
        payload,
        msgs,
        target_url=url,
        model_name=model,
        provider=_provider(),
        suppress=True,
    )
    payload["messages"] = msgs
    try:
        client = await get_llm_client()
        resp = await client.post(url, json=payload, headers=headers, timeout=240.0)
    except Exception as exc:
        log_line("error", "📋", "BRIEFING", f"LLM request failed: {type(exc).__name__}: {exc}")
        return ""
    log_line("info", "📋", "BRIEFING", f"LLM HTTP {resp.status_code}")
    if resp.status_code != 200:
        log_line("error", "📋", "BRIEFING", f"LLM error body: {resp.text[:300]}")
        return ""
    try:
        data = resp.json()
    except Exception as exc:
        log_line("error", "📋", "BRIEFING", f"LLM non-JSON response: {resp.text[:300]} ({exc})")
        return ""
    choices = data.get("choices") or [{}]
    msg = choices[0].get("message", {}) or {}
    raw = msg.get("content", "") or ""
    if not raw:
        raw = msg.get("reasoning_content", "") or ""
    log_line("info", "📋", "BRIEFING", f"LLM raw len={len(raw)} preview={raw[:200]!r}")
    result = _strip_think(raw)
    if not result:
        log_line("error", "📋", "BRIEFING", f"Empty after strip. finish_reason={choices[0].get('finish_reason')} msg_keys={list(msg.keys())}")
    return result


def _get_weather_context() -> str:
    """Get current weather data from the entity store."""
    try:
        from routers.integrations import _build_all_entities_uncached
        entities = _build_all_entities_uncached(include_derived=False)
        weather_entities = [e for e in entities if "weather" in (e.get("entity_id") or "").lower()
                           or "temperature" in (e.get("entity_id") or "").lower()
                           or "humidity" in (e.get("entity_id") or "").lower()]
        if not weather_entities:
            return ""
        lines = []
        for e in weather_entities[:10]:
            name = e.get("name") or e.get("entity_id") or "?"
            state = e.get("state") or "?"
            unit = (e.get("attributes") or {}).get("unit_of_measurement") or ""
            lines.append(f"  {name}: {state}{' ' + unit if unit else ''}")
        return "Weather/sensors:\n" + "\n".join(lines)
    except Exception:
        return ""


def _get_planner_context(user_id: int) -> str:
    """Get today's planner entries for the user."""
    try:
        import database
        import models
        db = database.SessionLocal()
        try:
            today = date.today()
            tomorrow = today + timedelta(days=1)
            entries = (
                db.query(models.Entry)
                .filter(
                    models.Entry.user_id == user_id,
                    models.Entry.start_at >= datetime.combine(today, datetime.min.time()),
                    models.Entry.start_at < datetime.combine(tomorrow, datetime.min.time()),
                )
                .order_by(models.Entry.start_at.asc())
                .limit(20)
                .all()
            )
            if not entries:
                # Also check pending tasks
                tasks = (
                    db.query(models.Entry)
                    .filter(
                        models.Entry.user_id == user_id,
                        models.Entry.entry_type == "task",
                        models.Entry.task_status == "open",
                    )
                    .order_by(models.Entry.priority.desc())
                    .limit(10)
                    .all()
                )
                if not tasks:
                    return ""
                lines = ["Pending tasks:"]
                for t in tasks:
                    lines.append(f"  - {t.title}" + (f" (priority {t.priority})" if t.priority else ""))
                return "\n".join(lines)

            lines = ["Today's events:"]
            for e in entries:
                time_str = e.start_at.strftime("%H:%M") if e.start_at else ""
                lines.append(f"  - {time_str} {e.title}")
            return "\n".join(lines)
        finally:
            db.close()
    except Exception as exc:
        log_detail("briefing", "PLANNER_ERR", error=str(exc))
        return ""


def _get_home_status_context() -> str:
    """Get compact home state for relevant devices."""
    try:
        from routers.integrations import _build_all_entities_uncached
        entities = _build_all_entities_uncached(include_derived=False)
        relevant_domains = {"light", "switch", "lock", "cover", "climate", "fan", "alarm_control_panel"}
        on_states = {"on", "open", "unlocked", "heat", "cool", "auto", "playing"}

        active = []
        for e in entities:
            eid = e.get("entity_id") or ""
            domain = eid.split(".", 1)[0] if "." in eid else ""
            if domain not in relevant_domains:
                continue
            state = str(e.get("state") or "").lower()
            if state in on_states:
                name = e.get("name") or (e.get("attributes") or {}).get("friendly_name") or eid
                area = e.get("area") or ""
                active.append(f"  {name}{' (' + area + ')' if area else ''}: {state}")

        if not active:
            return "Home: All devices off/closed."
        return f"Active devices ({len(active)}):\n" + "\n".join(active[:15])
    except Exception:
        return ""


def _get_ui_language() -> str:
    """Return the full language name based on user's UI setting."""
    return core_i18n.t("brain.language_name")


async def generate_briefing(kind: str, user_id: int, force: bool = False) -> Optional[dict]:
    """Generate a briefing. kind is 'morning' or 'evening'."""
    if not force and not is_enabled():
        return None

    cfg = _cfg()
    context_parts = []

    now = datetime.now()
    context_parts.append(f"Current time: {now.strftime('%Y-%m-%d %H:%M (%A)')}")

    if cfg.get("include_weather", True):
        weather = _get_weather_context()
        if weather:
            context_parts.append(weather)

    if cfg.get("include_planner", True):
        planner = _get_planner_context(user_id)
        if planner:
            context_parts.append(planner)

    if cfg.get("include_home_status", True):
        home = _get_home_status_context()
        if home:
            context_parts.append(home)

    if not context_parts:
        return None

    context = "\n\n".join(context_parts)
    lang_name = _get_ui_language()
    system = core_i18n.t("brain.briefings.system_prompt", kind=kind, language_name=lang_name)
    user_msg = f"Generate a {kind} briefing based on this context:\n\n{context}"

    try:
        # Big budget so reasoning ("thinking") models can finish their chain
        # and still emit the briefing text. Non-thinking models stop at EOS.
        result = await _llm_complete(
            [{"role": "system", "content": system}, {"role": "user", "content": user_msg}],
            max_tokens=4000,
        )
        if not result:
            return None

        title = core_i18n.t("brain.briefings.title_morning") if kind == "morning" else core_i18n.t("brain.briefings.title_evening")
        return {"title": title, "body": result, "kind": kind}
    except Exception as exc:
        log_detail("briefing", "GENERATE_ERR", error=str(exc))
        return None


def _get_primary_admin_id() -> Optional[int]:
    import database
    import models
    db = database.SessionLocal()
    try:
        user = (
            db.query(models.User)
            .filter(models.User.is_admin == True, models.User.is_active == True)
            .order_by(models.User.id.asc())
            .first()
        )
        return int(user.id) if user else None
    finally:
        db.close()


async def run_briefing(kind: str) -> None:
    """Run a briefing and dispatch as notification."""
    user_id = _get_primary_admin_id()
    if user_id is None:
        return

    result = await generate_briefing(kind, user_id)
    if not result:
        return

    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=result["title"],
        body=result["body"],
        category="briefing",
        severity="info",
        dedupe_key=f"briefing:{kind}:{date.today().isoformat()}",
    )
    log_line("success", "📋", "BRIEFING", f"{kind} briefing sent to user {user_id}")


def _briefing_job(kind: str) -> None:
    """APScheduler thread callback."""
    if not is_enabled():
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(run_briefing(kind))
        else:
            asyncio.run(run_briefing(kind))
    except Exception as exc:
        log_detail("briefing", "JOB_ERR", error=str(exc))


def schedule_briefings() -> None:
    """Register/update APScheduler jobs for briefings."""
    try:
        from scheduler_service import scheduler
    except Exception:
        return

    for job in list(scheduler.get_jobs()):
        if job.id and job.id.startswith("briefing_"):
            try:
                scheduler.remove_job(job.id)
            except Exception:
                pass

    if not is_enabled():
        return

    cfg = _cfg()

    morning_time = str(cfg.get("morning_time", "07:30"))
    evening_time = str(cfg.get("evening_time", "21:00"))

    try:
        mh, mm = morning_time.split(":")
        scheduler.add_job(
            _briefing_job, kwargs={"kind": "morning"},
            trigger="cron", hour=int(mh), minute=int(mm),
            id="briefing_morning", replace_existing=True,
        )
    except Exception as exc:
        log_detail("briefing", "SCHED_ERR", kind="morning", error=str(exc))

    try:
        eh, em = evening_time.split(":")
        scheduler.add_job(
            _briefing_job, kwargs={"kind": "evening"},
            trigger="cron", hour=int(eh), minute=int(em),
            id="briefing_evening", replace_existing=True,
        )
    except Exception as exc:
        log_detail("briefing", "SCHED_ERR", kind="evening", error=str(exc))

    log_line("success", "📋", "BRIEFING", f"scheduled: morning={morning_time}, evening={evening_time}")
