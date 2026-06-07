"""Ambient Brain — proactive perception → reasoning → action loop.

Turns HYVE from a reactive "chat with commands" assistant into one that
*notices* things and offers help on its own. It subscribes to the in-process
event bus (entity state changes / remote actions) and to scheduled check-ins,
then runs a heavily rate-limited reasoning cycle that can either:

  - **observe**     : only log what it *would* do (validation / dry-run)
  - **suggest**     : push an actionable notification (human-in-the-loop)
  - **autonomous**  : run whitelisted tools directly, then notify

Phases implemented here:
  F0  observe       — subscribe + log only, zero side effects
  F1  suggest       — actionable notifications with accept/dismiss
  F2  reasoning     — LLM proposes concrete tool actions
  F3  autonomous    — execute whitelisted actions without asking
  F4  learning      — remember accepted suggestions, propose automations

Cost & safety controls: interesting-domain filter, burst debounce, per-entity
cooldown, per-hour cap, min spacing between thoughts, quiet hours, an optional
cheap aux-LLM gate before the main reasoner, and a strict autonomous whitelist.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections import deque
from datetime import datetime, time as dtime
from typing import Any, Optional

import settings as settings_mod
from core import i18n as core_i18n
from logger import log_line, log_detail

# ── Module state ──────────────────────────────────────────────────────────

_loop: Optional[asyncio.AbstractEventLoop] = None
_queue: "Optional[asyncio.Queue[dict]]" = None
_worker: Optional[asyncio.Task] = None
_scan_task: Optional[asyncio.Task] = None
_started = False

# Per-entity "since": when each entity entered its current state (wall-clock).
# Drives duration awareness ("light on for an hour") for the periodic scan.
_state_since: dict[str, dict[str, Any]] = {}

# How long (minutes) a device must stay in a "wasteful/risky" state before the
# periodic scan considers it worth a proactive thought.
_LONG_ON_MINUTES = 45        # lights / switches / fans left ON
_LONG_OPEN_MINUTES = 20      # doors / windows / covers open, locks unlocked, motion stuck

# Rate limiting / spacing
_thought_times: deque[float] = deque(maxlen=64)   # monotonic timestamps of emitted thoughts
_last_thought_at: float = 0.0
_entity_cooldown: dict[str, float] = {}            # entity_id -> monotonic last-seen
_recent_keys: dict[str, float] = {}                # dedupe key -> monotonic

_ENTITY_COOLDOWN_S = 60.0
_DEDUPE_TTL_S = 1800.0

# States treated as "no useful signal" for proactive alerts (test placeholders, etc.)
_SKIP_ENTITY_STATES = frozenset({"unavailable", "unknown", "offline", "none", ""})

CHECKIN_JOB_PREFIX = "ambient_checkin_"

# Domains worth reacting to (triggers) and worth describing (context).
_TRIGGER_DOMAINS = {"light", "switch", "lock", "cover", "binary_sensor", "climate", "fan", "alarm_control_panel"}
_CONTEXT_DOMAINS = {"light", "switch", "lock", "cover", "climate", "fan", "media_player", "alarm_control_panel"}

# Persisted learning + "already told the user" issue memory.
_STATE_PATH = os.path.join("output", "ambient_state.json")
_pattern_counts: dict[str, dict[str, Any]] = {}
_notified_issues: dict[str, dict[str, Any]] = {}


# ── Config helpers ──────────────────────────────────────────────────────────

def _cfg() -> dict:
    intel = settings_mod.CFG.get("intelligence") or {}
    return intel.get("ambient") or {}


def is_enabled() -> bool:
    c = _cfg()
    return bool(c.get("enabled")) and str(c.get("mode", "suggest")).lower() != "off"


def _mode() -> str:
    return str(_cfg().get("mode", "suggest")).lower()


def _ignore_unavailable_entities() -> bool:
    """When true, never track or alert about unavailable entities (full mute)."""
    return bool(_cfg().get("ignore_unavailable_entities"))


def _ignored_sources() -> set[str]:
    """Integration slugs excluded from proactive context and integration alerts."""
    raw = _cfg().get("ignore_sources") or []
    if isinstance(raw, str):
        raw = [part.strip() for part in re.split(r"[,;\s]+", raw) if part.strip()]
    return {str(slug).strip().lower() for slug in raw if str(slug).strip()}


def _entity_source(ent: dict) -> str:
    return str(ent.get("source") or "").strip().lower()


def _should_skip_entity(eid: str, ent: dict) -> bool:
    """Only skip entities from integrations the user muted entirely."""
    return _entity_source(ent) in _ignored_sources()


def _integration_sync_issues() -> list[dict[str, str]]:
    """Integrations whose last sync failed (excluding muted slugs)."""
    issues: list[dict[str, str]] = []
    ignored = _ignored_sources()
    try:
        from addons.entity_store import get_entity_store

        store = get_entity_store()
        for slug in sorted(getattr(store, "_fetchers", {}).keys()):
            slug_key = str(slug).strip().lower()
            if slug_key in ignored:
                continue
            row = store.get_entities(slug)
            if not row:
                continue
            err = str(row.get("last_error") or "").strip()
            if err:
                issues.append({"slug": slug_key, "error": err[:240]})
    except Exception as exc:
        log_detail("ambient", "INTEGRATION_ISSUES_ERR", error=str(exc))
    return issues


# ── Persistence (learning) ───────────────────────────────────────────────────

def _load_state() -> None:
    global _pattern_counts, _notified_issues
    try:
        with open(_STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            _pattern_counts = data.get("patterns") or {}
            _notified_issues = data.get("notified_issues") or {}
    except FileNotFoundError:
        _pattern_counts = {}
        _notified_issues = {}
    except Exception as exc:
        log_detail("ambient", "STATE_LOAD_ERR", error=str(exc))
        _pattern_counts = {}
        _notified_issues = {}


def _save_state() -> None:
    try:
        os.makedirs(os.path.dirname(_STATE_PATH), exist_ok=True)
        tmp = _STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(
                {"patterns": _pattern_counts, "notified_issues": _notified_issues},
                fh,
                ensure_ascii=False,
                indent=2,
            )
        os.replace(tmp, _STATE_PATH)
    except Exception as exc:
        log_detail("ambient", "STATE_SAVE_ERR", error=str(exc))


def _unavailable_clusters() -> list[dict[str, Any]]:
    """Group unavailable entities by integration source (one alert per source)."""
    snapshot = _snapshot()
    by_source: dict[str, list[str]] = {}
    for eid, ent in snapshot.items():
        if _entity_source(ent) in _ignored_sources():
            continue
        state = str(ent.get("state") or "").strip().lower()
        if state not in _SKIP_ENTITY_STATES:
            continue
        src = _entity_source(ent) or "unknown"
        by_source.setdefault(src, []).append(_entity_name(ent) or eid)

    clusters: list[dict[str, Any]] = []
    for src, names in sorted(by_source.items()):
        if not names:
            continue
        clusters.append({
            "key": f"unavailable:{src}",
            "kind": "unavailable",
            "source": src,
            "count": len(names),
            "examples": names[:5],
            "label": core_i18n.t("brain.ambient.issues.unavailable_entities", count=len(names), source=src),
        })
    return clusters


def _current_proactive_issues() -> tuple[list[dict[str, Any]], set[str]]:
    """Structured issues visible right now (sync failures + unavailable clusters)."""
    issues: list[dict[str, Any]] = []
    keys: set[str] = set()

    for row in _integration_sync_issues():
        key = f"sync:{row['slug']}"
        keys.add(key)
        issues.append({
            "key": key,
            "kind": "sync",
            "source": row["slug"],
            "error": row["error"],
            "label": core_i18n.t("brain.ambient.issues.sync_failed", slug=row["slug"]),
        })

    if not _ignore_unavailable_entities():
        for cluster in _unavailable_clusters():
            keys.add(cluster["key"])
            issues.append(cluster)

    return issues, keys


def _reconcile_notified_issues(current_keys: set[str]) -> None:
    """Forget issues that cleared — user can be told again if they return."""
    removed = [k for k in _notified_issues if k not in current_keys]
    if not removed:
        return
    for key in removed:
        _notified_issues.pop(key, None)
    _save_state()
    log_detail("ambient", "ISSUE_RESOLVED", keys=",".join(removed[:8]))


def _new_issue_keys(current_keys: set[str]) -> set[str]:
    return {key for key in current_keys if key not in _notified_issues}


def _mark_issues_notified(issue_keys: set[str], *, title: str = "") -> None:
    if not issue_keys:
        return
    now = time.time()
    for key in issue_keys:
        _notified_issues[key] = {
            "at": now,
            "title": str(title or "")[:120],
        }
    _save_state()


def _attach_issue_awareness(context: dict) -> set[str]:
    """Enrich context with new vs already-notified issues; return new issue keys."""
    all_issues, current_keys = _current_proactive_issues()
    _reconcile_notified_issues(current_keys)
    new_keys = _new_issue_keys(current_keys)

    context["proactive_issues"] = all_issues
    context["new_proactive_issues"] = [item for item in all_issues if item.get("key") in new_keys]
    context["already_notified_issues"] = [
        {"key": key, **(_notified_issues.get(key) or {})}
        for key in sorted(current_keys)
        if key in _notified_issues
    ]
    context["new_proactive_issue_keys"] = sorted(new_keys)
    context["proactive_policy"] = core_i18n.t("brain.ambient.proactive_policy")
    return new_keys


# ── Quiet hours / rate limiting ──────────────────────────────────────────────

def _parse_hhmm(value: str, default: dtime) -> dtime:
    try:
        h, m = str(value).split(":")
        return dtime(int(h), int(m))
    except Exception:
        return default


def _in_quiet_hours(now: Optional[datetime] = None) -> bool:
    qh = _cfg().get("quiet_hours") or {}
    start = _parse_hhmm(qh.get("start", "23:00"), dtime(23, 0))
    end = _parse_hhmm(qh.get("end", "07:00"), dtime(7, 0))
    if start == end:
        return False
    now_t = (now or datetime.now()).time()
    if start < end:
        return start <= now_t < end
    # Window wraps midnight (e.g. 23:00 → 07:00)
    return now_t >= start or now_t < end


def _rate_ok() -> tuple[bool, str]:
    c = _cfg()
    now = time.monotonic()
    min_gap = float(c.get("min_seconds_between_thoughts", 90) or 0)
    if min_gap and (now - _last_thought_at) < min_gap:
        return False, "min_spacing"
    max_hr = int(c.get("max_per_hour", 6) or 0)
    if max_hr:
        cutoff = now - 3600.0
        recent = sum(1 for t in _thought_times if t >= cutoff)
        if recent >= max_hr:
            return False, "hourly_cap"
    return True, ""


def _mark_thought() -> None:
    global _last_thought_at
    now = time.monotonic()
    _last_thought_at = now
    _thought_times.append(now)


def _dedupe_ttl_s(key: str) -> float:
    c = _cfg()
    if key.startswith("ambient:integration:"):
        hours = float(c.get("integration_alert_cooldown_hours", 24) or 24)
        return max(3600.0, hours * 3600.0)
    if key.startswith("ambient:unavailable:"):
        hours = float(c.get("unavailable_alert_cooldown_hours", 12) or 12)
        return max(1800.0, hours * 3600.0)
    return _DEDUPE_TTL_S


def _dedupe_ok(key: str) -> bool:
    if not key:
        return True
    now = time.monotonic()
    ttl = _dedupe_ttl_s(key)
    for k, ts in list(_recent_keys.items()):
        if now - ts > _dedupe_ttl_s(k):
            _recent_keys.pop(k, None)
    if key in _recent_keys and (now - _recent_keys[key]) < ttl:
        return False
    _recent_keys[key] = now
    return True


def _navigates_to_integrations(decision: dict) -> bool:
    for action in decision.get("actions") or []:
        if not isinstance(action, dict):
            continue
        if action.get("tool") != "navigate":
            continue
        args = action.get("args") if isinstance(action.get("args"), dict) else {}
        url = str(args.get("url") or "").lower()
        if "integration" in url:
            return True
    return False


def _mentions_health_topic(decision: dict) -> bool:
    blob = f"{decision.get('title') or ''} {decision.get('body') or ''} {decision.get('pattern_key') or ''}".lower()
    return any(
        token in blob
        for token in ("unavailable", "indisponibil", "offline", "deconectat", "integrat", "integration", "sync", "sincroniz")
    )


def _stable_dedupe_key(decision: dict, issue_keys: set[str] | None = None) -> str:
    """Stable notification dedupe — prefer issue keys when present."""
    if issue_keys:
        return "ambient:issues:" + "|".join(sorted(issue_keys))
    pattern_key = str(decision.get("pattern_key") or "").strip()
    title = str(decision.get("title") or "HYVE").strip()[:80]
    return f"ambient:{pattern_key or title}"


# ── Event subscription (F0) ───────────────────────────────────────────────────

def _domain(entity_id: str) -> str:
    return (entity_id or "").split(".", 1)[0]


def _on_state_event(payload: dict) -> None:
    """event_bus handler (runs in the publisher's task). Keep it cheap:
    filter, dedupe per-entity cooldown, then hand off to the async worker."""
    try:
        if not is_enabled():
            return
        entity_id = str(payload.get("entity_id") or "")
        if _domain(entity_id) not in _TRIGGER_DOMAINS:
            return
        # Track when this entity entered its new state (for duration awareness).
        new_state = payload.get("new_state")
        prev = _state_since.get(entity_id)
        if not prev or str(prev.get("state")) != str(new_state):
            _state_since[entity_id] = {"state": new_state, "since": time.time()}
        now = time.monotonic()
        last = _entity_cooldown.get(entity_id, 0.0)
        if (now - last) < _ENTITY_COOLDOWN_S:
            return
        _entity_cooldown[entity_id] = now
        _enqueue({
            "type": "event",
            "entity_id": entity_id,
            "old_state": payload.get("old_state"),
            "new_state": payload.get("new_state"),
            "at": time.time(),
        })
    except Exception as exc:
        log_detail("ambient", "EVENT_HANDLER_ERR", error=str(exc))


def _enqueue(trigger: dict) -> None:
    """Thread/loop-safe enqueue onto the async worker queue."""
    if _loop is None or _queue is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is _loop:
        try:
            _queue.put_nowait(trigger)
        except Exception:
            pass
    else:
        try:
            _loop.call_soon_threadsafe(_queue.put_nowait, trigger)
        except Exception as exc:
            log_detail("ambient", "ENQUEUE_ERR", error=str(exc))


# ── Worker: debounce + run cycle ──────────────────────────────────────────────

# ── Context building ──────────────────────────────────────────────────────────

def _entity_name(entity: dict) -> str:
    attrs = entity.get("attributes") or {}
    return str(entity.get("name") or attrs.get("friendly_name") or entity.get("entity_id") or "?")


def _entity_area(entity: dict) -> str:
    attrs = entity.get("attributes") or {}
    return str(entity.get("area") or entity.get("area_name") or attrs.get("area") or "").strip()


def _snapshot() -> dict[str, dict]:
    try:
        from core import state_observer
        return dict(state_observer._last_snapshot or {})
    except Exception:
        return {}


_ON_STATES = {"on", "open", "unlocked", "playing", "heat", "cool", "auto"}


def _minutes_in_state(eid: str, ent: dict) -> Optional[int]:
    """How many minutes the entity has held its current state, if known.
    Lazily initialises tracking for entities that were already in this state
    when ambient started (so durations accrue from first sight)."""
    state = ent.get("state")
    rec = _state_since.get(eid)
    if not rec or str(rec.get("state")) != str(state):
        _state_since[eid] = {"state": state, "since": time.time()}
        return 0
    return int(max(0, (time.time() - float(rec.get("since", time.time()))) / 60.0))


def _is_long_running(eid: str, state: Any, minutes: Optional[int]) -> bool:
    if minutes is None:
        return False
    dom = _domain(eid)
    st = str(state or "").lower()
    if st not in _ON_STATES:
        return False
    if dom in {"light", "switch", "fan", "media_player"}:
        return minutes >= _LONG_ON_MINUTES
    if dom in {"cover", "lock", "binary_sensor", "alarm_control_panel"}:
        return minutes >= _LONG_OPEN_MINUTES
    return False


def _get_weather_forecast() -> list[dict]:
    """Get weather/sensor data from entity store for predictive reasoning."""
    try:
        from addons.entity_store import get_entity_store
        store = get_entity_store()
        entities = store.get_all_entities()
        weather = []
        for e in entities:
            eid = e.get("entity_id") or ""
            if any(k in eid.lower() for k in ("weather", "temperature", "humidity", "rain", "wind")):
                weather.append({
                    "entity_id": eid,
                    "name": e.get("name") or eid,
                    "state": e.get("state"),
                    "unit": (e.get("attributes") or {}).get("unit_of_measurement", ""),
                })
        return weather[:10]
    except Exception:
        return []


def _get_upcoming_events() -> list[dict]:
    """Get today's upcoming planner events for context-aware reasoning."""
    try:
        import database
        import models
        from datetime import date as _date
        db = database.SessionLocal()
        try:
            now = datetime.now()
            end_of_day = datetime.combine(_date.today(), datetime.max.time())
            entries = (
                db.query(models.Entry)
                .filter(
                    models.Entry.start_at >= now,
                    models.Entry.start_at <= end_of_day,
                    models.Entry.entry_type == "event",
                )
                .order_by(models.Entry.start_at.asc())
                .limit(5)
                .all()
            )
            return [
                {"title": e.title, "starts_in_min": max(0, int((e.start_at - now).total_seconds() / 60))}
                for e in entries if e.start_at
            ]
        finally:
            db.close()
    except Exception:
        return []


def _build_context(batch: list[dict]) -> dict:
    snapshot = _snapshot()
    now = datetime.now()

    # Triggering events (resolved against the snapshot for names/areas).
    events = []
    seen = set()
    for t in batch:
        if t.get("type") != "event":
            continue
        eid = t.get("entity_id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        ent = snapshot.get(eid) or {}
        if ent and _should_skip_entity(eid, ent):
            continue
        events.append({
            "entity_id": eid,
            "name": _entity_name(ent) if ent else eid,
            "area": _entity_area(ent) if ent else "",
            "from": t.get("old_state"),
            "to": t.get("new_state"),
        })

    # Compact home state for the relevant domains, with duration awareness.
    home = []
    long_running = []
    for eid, ent in snapshot.items():
        if _domain(eid) not in _CONTEXT_DOMAINS:
            continue
        if _should_skip_entity(eid, ent):
            continue
        mins = _minutes_in_state(eid, ent)
        row = {
            "entity_id": eid,
            "name": _entity_name(ent),
            "area": _entity_area(ent),
            "state": ent.get("state"),
            "minutes_in_state": mins,
        }
        home.append(row)
        if _is_long_running(eid, ent.get("state"), mins):
            long_running.append(row)
    home = home[:120]

    checkin = next((t for t in batch if t.get("type") == "checkin"), None)
    scan = next((t for t in batch if t.get("type") == "scan"), None)
    trigger = "checkin" if checkin else ("scan" if scan else "event")

    # Predictive context: weather + upcoming events
    weather = _get_weather_forecast() if trigger in {"checkin", "scan"} else []
    upcoming_events = _get_upcoming_events() if trigger in {"checkin", "scan"} else []

    ctx = {
        "now": now.strftime("%Y-%m-%d %H:%M (%A)"),
        "hour": now.hour,
        "trigger": trigger,
        "checkin_kind": checkin.get("kind") if checkin else None,
        "events": events,
        "home": home,
        "long_running": long_running,
        "weather": weather,
        "upcoming_events": upcoming_events,
    }
    _attach_issue_awareness(ctx)
    return ctx


# ── LLM access (mirrors intent_router pattern) ────────────────────────────────

def _normalize_chat_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/chat/completions"):
        return url
    return (url + "/v1/chat/completions") if "/v1" not in url else (url + "/chat/completions")


def _resolve_profile() -> Optional[dict]:
    """The model profile chosen for ambient (or None = use the active profile)."""
    pid = str(_cfg().get("profile_id") or "").strip()
    if not pid:
        return None
    for p in (settings_mod.CFG.get("model_profiles") or []):
        if str(p.get("id") or "") == pid:
            return p
    return None


def _llm_endpoint(prefer_aux: bool) -> tuple[str, str, str]:
    prof = _resolve_profile()
    if prof:
        if prefer_aux:
            # Only use the aux model when the chosen profile actually defines one;
            # otherwise return empty so the gate is skipped (fail open to reasoner).
            if not prof.get("aux_llm_enabled"):
                return "", "", ""
            aux = prof.get("aux_llm") or {}
            url, model, api_key = aux.get("target_url", ""), aux.get("model_name", ""), aux.get("api_key", "")
        else:
            url, model, api_key = prof.get("target_url", ""), prof.get("model_name", ""), prof.get("api_key", "")
        return _normalize_chat_url(url), model, (api_key or "").strip()

    # Fallback: active profile (mirrored into the flat llm / intelligence.aux_llm blocks).
    intel = settings_mod.CFG.get("intelligence") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}
    aux = intel.get("aux_llm") or {}
    if prefer_aux:
        url = (aux.get("target_url") or "").strip() or llm_cfg.get("target_url", "")
        model = (aux.get("model_name") or "").strip() or llm_cfg.get("model_name", "")
        api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()
    else:
        url = llm_cfg.get("target_url", "")
        model = llm_cfg.get("model_name", "")
        api_key = (llm_cfg.get("api_key") or "").strip()
    return _normalize_chat_url(url), model, api_key


async def _llm_complete(messages: list[dict], *, prefer_aux: bool, max_tokens: int, temperature: float = 0.2, timeout: float = 30.0) -> str:
    from llm_client import get_llm_client
    url, model, api_key = _llm_endpoint(prefer_aux)
    if not url or not model:
        return ""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    client = await get_llm_client()
    resp = await client.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code != 200:
        log_detail("ambient", "LLM_HTTP", status=resp.status_code)
        return ""
    raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S)
    raw = re.sub(r"<think>.*", "", raw, flags=re.S)
    return raw.strip()


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except Exception:
            return None
    return None


# ── Gate (cheap pre-filter before the expensive reasoner) ──────────────────────

async def _aux_gate(context: dict) -> bool:
    """Optional cheap yes/no gate. Returns True when a proactive thought is
    worth the main reasoner call. Fails open (True) when no aux LLM."""
    if not _cfg().get("use_aux_llm_gate", True):
        return True
    url, model, _ = _llm_endpoint(prefer_aux=True)
    if not url or not model:
        return True  # no aux model → let the main reasoner decide

    if context.get("trigger") in {"checkin", "scan"}:
        return True  # check-ins/scans are throttled by schedule + duration pre-filter

    ev = context.get("events") or []
    if not ev:
        return False
    summary = "; ".join(f"{e['name']} ({e['area'] or 'n/a'}): {e['from']}→{e['to']}" for e in ev[:8])
    sys = core_i18n.t("brain.ambient.aux_gate_system")
    usr = f"Time: {context['now']}\nEvents: {summary}\nWorth a proactive thought?"
    try:
        out = await _llm_complete(
            [{"role": "system", "content": sys}, {"role": "user", "content": usr + " /no_think"}],
            prefer_aux=True, max_tokens=8, temperature=0.0, timeout=10.0,
        )
        return "yes" in out.lower()
    except Exception:
        return True


# ── Reasoner (F2) ──────────────────────────────────────────────────────────────


def _get_ui_language() -> str:
    """Return the full language name based on user's UI setting."""
    return core_i18n.t("brain.language_name")


# ── Action catalog (injected per request — strings from locales/{lang}.json) ─

def _ambient_action_specs() -> list[dict[str, Any]]:
    raw = core_i18n.get("brain.ambient.action_specs")
    if not isinstance(raw, list):
        return []
    specs: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        spec = dict(item)
        spec["tags"] = set(spec.get("tags") or [])
        specs.append(spec)
    return specs


def _ambient_context_tags(context: dict[str, Any]) -> set[str]:
    tags: set[str] = set()
    if context.get("long_running"):
        tags.add("long_running")
    if context.get("events"):
        tags.add("events")
    if context.get("weather"):
        tags.add("weather")
    if context.get("upcoming_events"):
        tags.add("calendar")
    if context.get("home"):
        tags.add("devices")
    for issue in context.get("new_proactive_issues") or []:
        kind = str(issue.get("kind") or "").strip().lower()
        if kind == "sync":
            tags.add("sync_issues")
        elif kind == "unavailable":
            tags.add("unavailable")
    return tags


def ambient_actions_for_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Return action specs relevant to this reasoning cycle."""
    tags = _ambient_context_tags(context)
    if not tags:
        tags = {"devices"}
    out: list[dict[str, Any]] = []
    for spec in _ambient_action_specs():
        spec_tags = set(spec.get("tags") or set())
        if spec_tags & tags:
            out.append(spec)
    # Always offer dismiss when there is something to act on.
    if tags & {"sync_issues", "unavailable", "long_running"}:
        dismiss = next((s for s in _ambient_action_specs() if s["tool"] == "ambient_dismiss"), None)
        if dismiss and dismiss not in out:
            out.append(dismiss)
    return out


def format_ambient_actions_catalog(context: dict[str, Any]) -> str:
    compact = []
    for spec in ambient_actions_for_context(context):
        compact.append({
            "tool": spec["tool"],
            "description": spec["description"],
            "when": spec.get("when"),
            "args": spec.get("args"),
            "label_hint": spec.get("label_hint"),
        })
    return json.dumps(compact, ensure_ascii=False, indent=2)


def _allowed_ambient_tools(context: dict[str, Any]) -> set[str]:
    return {str(s["tool"]) for s in ambient_actions_for_context(context)}


def _sanitize_decision_actions(decision: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
    allowed = _allowed_ambient_tools(context)
    clean: list[dict[str, Any]] = []
    for a in decision.get("actions") or []:
        if not isinstance(a, dict):
            continue
        tool = str(a.get("tool") or "").strip()
        if tool not in allowed:
            log_detail("ambient", "DROP_ACTION", tool=tool, allowed=sorted(allowed))
            continue
        clean.append(a)
    return clean


def default_reasoner_prompt() -> str:
    """Built-in system prompt for the ambient reasoner (settings default / reset)."""
    return core_i18n.t("brain.ambient.reasoner_system_prompt")


def reasoner_system_prompt(language_name: str | None = None) -> str:
    """Configured reasoner prompt with {language_name} substituted."""
    custom = str(_cfg().get("reasoner_prompt") or "").strip()
    template = custom or default_reasoner_prompt()
    lang = language_name or _get_ui_language()
    return template.replace("{language_name}", lang)


async def _reason(context: dict) -> Optional[dict]:
    weather_section = ""
    if context.get("weather"):
        weather_section = "\n\nWeather/sensors:\n" + json.dumps(context["weather"], ensure_ascii=False)
    events_section = ""
    if context.get("upcoming_events"):
        events_section = "\n\nUpcoming calendar events:\n" + json.dumps(context["upcoming_events"], ensure_ascii=False)

    policy = str(context.get("proactive_policy") or "").strip()
    issues_section = ""
    if context.get("new_proactive_issues") is not None:
        issues_section = (
            "\n\nNEW issues (notify now — user has NOT been told yet):\n"
            + (json.dumps(context.get("new_proactive_issues") or [], ensure_ascii=False) or "[]")
            + "\n\nAlready notified (do NOT repeat):\n"
            + (json.dumps(context.get("already_notified_issues") or [], ensure_ascii=False) or "[]")
        )

    usr = (
        f"Time: {context['now']}\n"
        f"Trigger: {context['trigger']}"
        + (f" ({context['checkin_kind']})" if context.get("checkin_kind") else "")
        + (f"\n\nPolicy: {policy}" if policy else "")
        + issues_section
        + "\n\nRecent events:\n"
        + (json.dumps(context["events"], ensure_ascii=False) if context["events"] else "(none)")
        + "\n\nLong-running devices (left ON/open a while — likely worth acting on):\n"
        + (json.dumps(context.get("long_running") or [], ensure_ascii=False) if context.get("long_running") else "(none)")
        + "\n\nHome state (relevant devices, with minutes_in_state):\n"
        + json.dumps(context["home"], ensure_ascii=False)
        + weather_section
        + events_section
        + "\n\nAvailable actions (use ONLY these tools in actions[]):\n"
        + format_ambient_actions_catalog(context)
        + "\n\nDecide. Respond with ONLY the JSON object."
    )
    system_prompt = reasoner_system_prompt()
    out = await _llm_complete(
        [{"role": "system", "content": system_prompt}, {"role": "user", "content": usr}],
        prefer_aux=False, max_tokens=600, temperature=0.2, timeout=45.0,
    )
    decision = _extract_json(out)
    if not isinstance(decision, dict):
        return None
    return decision


# ── User targeting ──────────────────────────────────────────────────────────

def _primary_admin() -> Optional[int]:
    import database
    import models
    db = database.SessionLocal()
    try:
        user = (
            db.query(models.User)
            .filter(models.User.is_admin == True, models.User.is_active == True)  # noqa: E712
            .order_by(models.User.id.asc())
            .first()
        )
        return int(user.id) if user else None
    finally:
        db.close()


# ── Main cycle (F0–F4) ────────────────────────────────────────────────────────

async def run_ambient_cycle(batch: list[dict]) -> None:
    if not is_enabled():
        return
    mode = _mode()

    if _in_quiet_hours():
        log_detail("ambient", "SKIP", reason="quiet_hours")
        return
    ok, why = _rate_ok()
    if not ok:
        log_detail("ambient", "SKIP", reason=why)
        return

    context = _build_context(batch)
    new_issue_keys = set(context.get("new_proactive_issue_keys") or [])

    if context["trigger"] == "event" and not context["events"] and not new_issue_keys:
        return
    # Periodic scan/check-in: skip when user was already told and nothing else is urgent.
    if context["trigger"] in {"scan", "checkin"} and not new_issue_keys and not context.get("long_running"):
        log_detail("ambient", "SKIP", reason="already_aware", new_issues=0)
        return

    if not await _aux_gate(context):
        log_detail("ambient", "GATE", result="no")
        return

    decision = await _reason(context)
    if decision is not None:
        decision["_notify_issue_keys"] = sorted(new_issue_keys)
        decision["actions"] = _sanitize_decision_actions(decision, context)
    await _dispatch_decision(decision, mode=mode)


async def _dispatch_decision(decision: Optional[dict], *, mode: str, force: bool = False) -> dict:
    """Turn a reasoner decision into a notification / autonomous action.
    Returns a summary dict (used by the manual test entrypoint)."""
    if not decision or not decision.get("act"):
        log_detail("ambient", "DECISION", act=False)
        return {"acted": False, "decision": decision or {}}

    title = str(decision.get("title") or "HYVE").strip()[:120]
    body = str(decision.get("body") or "").strip()
    actions = decision.get("actions") if isinstance(decision.get("actions"), list) else []
    notify_keys = set(decision.get("_notify_issue_keys") or [])
    if not force and _mentions_health_topic(decision) and not notify_keys:
        log_detail("ambient", "SKIP", reason="repeat_health", title=title[:60])
        return {"acted": False, "reason": "repeat_health", "decision": decision}

    pattern_key = str(decision.get("pattern_key") or "").strip()
    dedupe = f"ambient:test:{pattern_key or title}" if force else _stable_dedupe_key(decision, notify_keys or None)

    if not force and not _dedupe_ok(dedupe):
        log_detail("ambient", "SKIP", reason="dedupe", key=dedupe)
        return {"acted": False, "reason": "dedupe", "decision": decision}

    # F0: observe-only — log what we WOULD do, no side effects (tests still emit).
    if mode == "observe" and not force:
        log_line("ambient", "👁️", "OBSERVE", f"would suggest: {title} | {body[:80]} | actions={len(actions)}")
        _mark_thought()
        return {"acted": False, "reason": "observe", "decision": decision}

    user_id = _primary_admin()
    if user_id is None:
        log_detail("ambient", "SKIP", reason="no_admin_user")
        return {"acted": False, "reason": "no_admin_user", "decision": decision}

    # F3: autonomous execution when allowed + whitelisted (never during a test).
    allowed = set(_cfg().get("allowed_autonomous_actions") or [])
    want_auto = (not force) and mode == "autonomous" and bool(decision.get("autonomous")) and actions
    can_auto = want_auto and all((a.get("tool") in allowed) for a in actions)

    if want_auto and can_auto:
        results = await _execute_actions(actions, user_id)
        _mark_thought()
        done_body = body or title
        from core import notification_service
        notification_service.create_and_dispatch(
            user_id=user_id,
            title=title,
            body=f"{done_body}\n\n✅ Am rezolvat automat.",
            category="ambient",
            severity="info",
            dedupe_key=dedupe,
            payload={
                "ambient": True,
                "kind": "autonomous_done",
                "pattern_key": pattern_key,
                "reason": decision.get("reason"),
                "executed": results,
            },
        )
        if not force and notify_keys:
            _mark_issues_notified(notify_keys, title=title)
        log_line("ambient", "🤖", "AUTO", f"{title} → executed {len(results)} action(s)")
        return {"acted": True, "kind": "autonomous_done", "decision": decision}

    # F1/F2: suggest (actionable notification, human-in-the-loop).
    suggested = []
    for a in actions:
        if not isinstance(a, dict) or not a.get("tool"):
            continue
        suggested.append({
            "index": len(suggested),
            "label": str(a.get("label") or core_i18n.t("brain.ambient.action_apply_label")).strip()[:60],
            "tool": str(a.get("tool")),
            "args": a.get("args") if isinstance(a.get("args"), dict) else {},
        })

    if not force:
        _mark_thought()
    # If actions include navigate, set action_url for the notification card
    nav_url = None
    for a in suggested:
        if a.get("tool") == "navigate" and isinstance(a.get("args"), dict):
            nav_url = a["args"].get("url")
            break
    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=(f"[TEST] {title}" if force else title)[:120],
        body=body or title,
        category="ambient",
        severity="info",
        dedupe_key=dedupe,
        action_url=nav_url,
        payload={
            "ambient": True,
            "kind": "suggestion",
            "pattern_key": pattern_key,
            "reason": decision.get("reason"),
            "issue_keys": sorted(notify_keys),
            "suggested_actions": suggested,
        },
    )
    if not force and notify_keys:
        _mark_issues_notified(notify_keys, title=title)
    log_line("ambient", "💡", "SUGGEST", f"{'[TEST] ' if force else ''}{title} ({len(suggested)} action(s))")
    return {"acted": True, "kind": "suggestion", "actions": len(suggested), "decision": decision}


async def run_test() -> dict:
    """Manual trigger from settings: reason over the CURRENT home (treating any
    on/open device as a candidate, ignoring duration) and emit a [TEST] result,
    bypassing quiet hours / rate limits. Never runs autonomous actions."""
    if not is_enabled():
        return {"ok": False, "error": "disabled"}
    url, model, _ = _llm_endpoint(prefer_aux=False)
    if not url or not model:
        return {"ok": False, "error": "no_llm"}
    context = _build_context([{"type": "scan"}])
    context["trigger"] = "test"
    context["long_running"] = [
        r for r in context["home"] if str(r.get("state") or "").lower() in _ON_STATES
    ]
    decision = await _reason(context)
    if decision is not None:
        decision["actions"] = _sanitize_decision_actions(decision, context)
    summary = await _dispatch_decision(decision, mode=_mode(), force=True)
    return {
        "ok": True,
        "candidates": len(context["long_running"]),
        "acted": summary.get("acted", False),
        "title": (decision or {}).get("title"),
        "body": (decision or {}).get("body"),
    }


def _normalize_ambient_tool(tool: str, label: str) -> str:
    """Map LLM-invented tool names / localized button labels to supported ambient actions."""
    t = (tool or "").strip().lower()
    lbl = (label or "").strip().lower()
    if t in {"sync_integration", "sync_integrations", "restart_services", "restart_integrations", "resync_integrations"}:
        return "sync_integration"
    if t in {"ambient_dismiss", "ignore_for_now", "dismiss_issues", "snooze_issues"}:
        return "ambient_dismiss"
    if "reporn" in lbl or "restart" in lbl or "resync" in lbl or "sincroniz" in lbl or "resincroniz" in lbl:
        return "sync_integration"
    if ("ignor" in lbl and "acum" in lbl) or "ignore for now" in lbl or "snooze" in lbl:
        return "ambient_dismiss"
    return tool


async def _ambient_sync_slugs(slugs: list[str]) -> str:
    from integrations import get_integration_manager
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    manager = get_integration_manager()
    if not slugs:
        issues, _ = _current_proactive_issues()
        slugs = sorted({str(i.get("source") or "").strip().lower() for i in issues if i.get("source")})
    if not slugs:
        return core_i18n.t("brain.ambient.sync.no_integrations")

    done: list[str] = []
    errors: list[str] = []
    for raw in slugs:
        slug = str(raw or "").strip().lower()
        if not slug:
            continue
        instances = manager.entries_for(slug)
        keys: list[str] = []
        if instances:
            keys = [inst.store_key for inst in instances if inst.supports_sync]
        elif store.get_fetcher(slug):
            keys = [slug]
        else:
            errors.append(core_i18n.t("brain.ambient.sync.unknown_integration", slug=slug))
            continue
        for key in keys:
            try:
                inst = manager.get_by_entry(key.split(":", 1)[1]) if ":" in key else manager.get(slug)
                if inst and not store.get_fetcher(key):
                    import settings as s
                    store.register_fetcher(
                        key,
                        inst.fetch_entities,
                        inst.format_context,
                        description=getattr(inst, "description", "") or "",
                    )
                    store.init_schedule(key, inst.sync_interval(s.CFG))
                await store.do_sync(key)
                done.append(key)
            except Exception as exc:
                errors.append(f"{key}: {exc}")
    try:
        from routers.dashboard import invalidate_available_entities_cache
        invalidate_available_entities_cache()
    except Exception:
        pass
    try:
        from routers.integrations import invalidate_all_entities_cache
        invalidate_all_entities_cache()
    except Exception:
        pass
    if done and not errors:
        return core_i18n.t("brain.ambient.sync.resynced", done=", ".join(done))
    if done:
        return core_i18n.t("brain.ambient.sync.partial_success", done=", ".join(done), errors="; ".join(errors[:3]))
    raise RuntimeError("; ".join(errors[:3]) or core_i18n.t("brain.ambient.sync.failed"))


async def _ambient_dismiss_issues(issue_keys: list[str] | None = None) -> str:
    keys = {str(k).strip() for k in (issue_keys or []) if str(k).strip()}
    if not keys:
        _, current = _current_proactive_issues()
        keys = set(current)
    if keys:
        _mark_issues_notified(keys, title="Dismissed by user")
    return core_i18n.t("brain.ambient.dismiss.message")


async def _execute_actions(actions: list[dict], user_id: int) -> list[dict]:
    from brain import toolbox
    results = []
    for a in actions:
        if not isinstance(a, dict) or not a.get("tool"):
            continue
        tool = str(a.get("tool"))
        label = str(a.get("label") or "")
        args = a.get("args") if isinstance(a.get("args"), dict) else {}
        tool = _normalize_ambient_tool(tool, label)
        try:
            if tool == "sync_integration":
                slugs = args.get("slugs") if isinstance(args.get("slugs"), list) else []
                if args.get("slug"):
                    slugs = list(slugs) + [args["slug"]]
                out = await _ambient_sync_slugs([str(s) for s in slugs])
                results.append({"tool": tool, "args": args, "ok": True, "result": out[:300]})
                continue
            if tool == "ambient_dismiss":
                keys = args.get("issue_keys") if isinstance(args.get("issue_keys"), list) else []
                out = await _ambient_dismiss_issues(keys)
                results.append({"tool": tool, "args": args, "ok": True, "result": out[:300]})
                continue
            out = await toolbox.execute_tool(tool, args, str(user_id))
            results.append({"tool": tool, "args": args, "ok": True, "result": str(out)[:300]})
        except Exception as exc:
            results.append({"tool": tool, "args": args, "ok": False, "error": str(exc)})
            log_detail("ambient", "ACTION_ERR", tool=tool, error=str(exc))
    return results


# ── Accepting a suggestion + learning (F4) ────────────────────────────────────

async def act_on_suggestion(user_id: int, notification_id: str, action_index: int) -> dict:
    """Execute one suggested action from an ambient notification, then record
    the acceptance for pattern learning."""
    import database
    import models
    from core import notification_service

    db = database.SessionLocal()
    try:
        row = (
            db.query(models.Notification)
            .filter(models.Notification.id == notification_id, models.Notification.user_id == user_id)
            .first()
        )
        if row is None:
            return {"ok": False, "error": "not_found"}
        try:
            payload = json.loads(row.payload_json or "{}")
        except Exception:
            payload = {}
        actions = payload.get("suggested_actions") or []
        match = next((a for a in actions if int(a.get("index", -1)) == int(action_index)), None)
        if not match:
            return {"ok": False, "error": "action_not_found"}
        pattern_key = str(payload.get("pattern_key") or "")
        issue_keys = payload.get("issue_keys") if isinstance(payload.get("issue_keys"), list) else []
    finally:
        db.close()

    tool = _normalize_ambient_tool(str(match.get("tool") or ""), str(match.get("label") or ""))
    action_args = dict(match.get("args") or {})
    if tool == "ambient_dismiss" and issue_keys and "issue_keys" not in action_args:
        action_args["issue_keys"] = issue_keys
    if tool == "sync_integration" and not action_args.get("slugs") and not action_args.get("slug") and issue_keys:
        slugs = sorted({str(k).split(":", 1)[1] for k in issue_keys if ":" in str(k)})
        if slugs:
            action_args["slugs"] = slugs

    # navigate is a frontend-only tool — mark as success without calling toolbox
    if tool == "navigate":
        results = [{"tool": "navigate", "args": action_args, "ok": True, "result": "navigated"}]
    else:
        results = await _execute_actions([{"tool": tool, "label": match.get("label"), "args": action_args}], user_id)
    ok = bool(results and results[0].get("ok"))
    navigate_url = ""
    if tool == "navigate":
        navigate_url = str(action_args.get("url") or "").strip()

    # Mark the notification handled.
    db = database.SessionLocal()
    try:
        notification_service.mark_read(db, user_id, notification_id)
        if ok:
            notification_service.archive_notification(db, user_id, notification_id)
    except Exception:
        pass
    finally:
        db.close()

    if ok and pattern_key:
        _record_acceptance(pattern_key, {**match, "tool": tool, "args": action_args}, user_id)

    return {"ok": ok, "results": results, "navigate_url": navigate_url,
            "message": (results[0].get("result") if ok and results else None) or (results[0].get("error") if results else None),
            "error": None if ok else (results[0].get("error") if results else "failed")}


def _record_acceptance(pattern_key: str, action: dict, user_id: int) -> None:
    if not _cfg().get("learn_patterns", True):
        return
    entry = _pattern_counts.get(pattern_key) or {"count": 0, "example": None, "proposed": False}
    entry["count"] = int(entry.get("count", 0)) + 1
    entry["example"] = {"tool": action.get("tool"), "args": action.get("args")}
    _pattern_counts[pattern_key] = entry
    _save_state()

    threshold = int(_cfg().get("learn_threshold", 3) or 3)
    if entry["count"] >= threshold and not entry.get("proposed"):
        entry["proposed"] = True
        _save_state()
        _enqueue({"type": "propose_automation", "pattern_key": pattern_key, "user_id": user_id})


async def _propose_automation(pattern_key: str, user_id: int) -> None:
    """F4: after repeated acceptance, ask the reasoner for an automation YAML and
    offer to create it with one click."""
    entry = _pattern_counts.get(pattern_key) or {}
    example = entry.get("example") or {}
    sys = core_i18n.t("brain.ambient.automation_learner_system")
    usr = (
        f"Situation key: {pattern_key}\n"
        f"Action repeatedly approved: {json.dumps(example, ensure_ascii=False)}\n"
        f"The user approved this {entry.get('count')} times. Propose an automation."
    )
    out = await _llm_complete(
        [{"role": "system", "content": sys}, {"role": "user", "content": usr}],
        prefer_aux=False, max_tokens=500, temperature=0.2, timeout=45.0,
    )
    proposal = _extract_json(out)
    if not isinstance(proposal, dict) or not proposal.get("source_yaml"):
        return
    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=str(proposal.get("title") or core_i18n.t("brain.ambient.automation_proposal.title")).strip()[:120],
        body=str(proposal.get("body") or core_i18n.t("brain.ambient.automation_proposal.body")).strip(),
        category="ambient",
        severity="info",
        dedupe_key=f"ambient:automate:{pattern_key}",
        payload={
            "ambient": True,
            "kind": "automation_proposal",
            "pattern_key": pattern_key,
            "suggested_actions": [{
                "index": 0,
                "label": core_i18n.t("brain.ambient.automation_proposal.create_label"),
                "tool": "create_automation_definition",
                "args": {"source_yaml": proposal.get("source_yaml")},
            }],
        },
    )
    log_line("ambient", "⚙️", "LEARN", f"proposed automation for pattern '{pattern_key}'")


# ── Check-ins (scheduled) ─────────────────────────────────────────────────────

def _checkin_job(kind: str) -> None:
    """APScheduler thread callback → push a check-in trigger to the worker."""
    if not is_enabled():
        return
    _enqueue({"type": "checkin", "kind": kind, "at": time.time()})


async def _scan_loop() -> None:
    """Periodic home scan — catches *duration* situations (light left on for an
    hour, door open too long) that never re-fire as events. Cheap: skipped
    entirely unless something has been running long (see run_ambient_cycle)."""
    log_line("ambient", "🔁", "AMBIENT", "scan loop started")
    while True:
        try:
            interval = max(2, int(_cfg().get("scan_interval_min", 15) or 15))
            await asyncio.sleep(interval * 60)
            if is_enabled():
                _enqueue({"type": "scan", "at": time.time()})
        except asyncio.CancelledError:
            log_line("ambient", "🔁", "AMBIENT", "scan loop stopped")
            break
        except Exception as exc:
            log_detail("ambient", "SCAN_LOOP_ERR", error=str(exc))
            await asyncio.sleep(60)


_subscribed = False


def _apply_subscription() -> None:
    """Subscribe to state events only while enabled, so the state observer does
    not compute diffs for us when ambient is off."""
    global _subscribed
    try:
        from core import event_bus, state_observer
    except Exception:
        return
    want = is_enabled()
    if want and not _subscribed:
        event_bus.subscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state", _on_state_event)
        _subscribed = True
    elif not want and _subscribed:
        event_bus.unsubscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state")
        _subscribed = False


def reschedule_checkins() -> None:
    """(Re)register APScheduler cron jobs for ambient check-ins based on config."""
    try:
        from scheduler_service import scheduler
    except Exception as exc:
        log_detail("ambient", "SCHED_IMPORT_ERR", error=str(exc))
        return

    # Clear existing ambient jobs.
    # Re-evaluate the event subscription whenever config changes.
    _apply_subscription()

    for job in list(scheduler.get_jobs()):
        if job.id and job.id.startswith(CHECKIN_JOB_PREFIX):
            try:
                scheduler.remove_job(job.id)
            except Exception:
                pass

    if not is_enabled():
        return

    plan = str(_cfg().get("checkin", "off")).lower()
    specs: list[tuple[str, dict]] = []
    if plan == "hourly":
        specs.append(("hourly", {"trigger": "cron", "minute": 0}))
    if plan in {"morning", "morning_evening"}:
        specs.append(("morning", {"trigger": "cron", "hour": 8, "minute": 0}))
    if plan in {"evening", "morning_evening"}:
        specs.append(("evening", {"trigger": "cron", "hour": 21, "minute": 0}))

    for kind, kw in specs:
        try:
            scheduler.add_job(
                _checkin_job, kwargs={"kind": kind},
                id=f"{CHECKIN_JOB_PREFIX}{kind}", replace_existing=True, **kw,
            )
        except Exception as exc:
            log_detail("ambient", "SCHED_ADD_ERR", kind=kind, error=str(exc))
    if specs:
        log_line("ambient", "⏰", "AMBIENT", f"check-ins scheduled: {', '.join(k for k, _ in specs)}")


# ── Lifecycle ──────────────────────────────────────────────────────────────────

def init_ambient(loop: asyncio.AbstractEventLoop) -> None:
    """Called once at startup from the main event loop."""
    global _loop, _queue, _worker, _scan_task, _started
    if _started:
        return
    _started = True
    _loop = loop
    _queue = asyncio.Queue()
    _load_state()

    _apply_subscription()

    _worker = loop.create_task(_run_worker_router())
    _scan_task = loop.create_task(_scan_loop())
    reschedule_checkins()
    log_line("success", "🧠", "AMBIENT", f"brain initialised (mode={_mode()}, enabled={is_enabled()})")


async def _run_worker_router() -> None:
    """Top-level worker: routes queue items to the right coroutine."""
    assert _queue is not None
    log_line("ambient", "🧠", "AMBIENT", "worker started")
    while True:
        try:
            trigger = await _queue.get()
        except asyncio.CancelledError:
            log_line("ambient", "🧠", "AMBIENT", "worker stopped")
            break

        kind = trigger.get("type")
        if kind == "propose_automation":
            try:
                await _propose_automation(trigger.get("pattern_key", ""), int(trigger.get("user_id")))
            except Exception as exc:
                log_detail("ambient", "PROPOSE_ERR", error=str(exc))
            continue

        # Aggregate a burst of events into a single reasoning cycle.
        batch = [trigger]
        debounce = float(_cfg().get("event_debounce_s", 8) or 0)
        if kind == "event" and debounce > 0:
            deadline = time.monotonic() + debounce
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    nxt = await asyncio.wait_for(_queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                except asyncio.CancelledError:
                    return
                if nxt.get("type") == "propose_automation":
                    # don't lose it — handle after the batch
                    _enqueue(nxt)
                    break
                batch.append(nxt)

        try:
            await run_ambient_cycle(batch)
        except Exception as exc:
            log_detail("ambient", "CYCLE_ERR", error=str(exc))


def shutdown_ambient() -> None:
    global _worker, _scan_task, _started, _subscribed
    try:
        from core import event_bus, state_observer
        event_bus.unsubscribe(state_observer.TOPIC_STATE_CHANGED, "ambient:state")
        _subscribed = False
    except Exception:
        pass
    if _worker is not None:
        _worker.cancel()
        _worker = None
    if _scan_task is not None:
        _scan_task.cancel()
        _scan_task = None
    _started = False
