from __future__ import annotations

from datetime import datetime, time as dtime
from typing import Optional

from brain.ambient import config, constants, runtime

from brain.ambient.config import _cfg, _entity_source, _ignore_unavailable_entities, _ignored_sources, _mode, _should_skip_entity, is_enabled

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
    if min_gap and (now - runtime._last_thought_at) < min_gap:
        return False, "min_spacing"
    max_hr = int(c.get("max_per_hour", 6) or 0)
    if max_hr:
        cutoff = now - 3600.0
        recent = sum(1 for t in runtime._thought_times if t >= cutoff)
        if recent >= max_hr:
            return False, "hourly_cap"
    return True, ""

def _mark_thought() -> None:
    now = time.monotonic()
    runtime._last_thought_at = now
    runtime._thought_times.append(now)

def _dedupe_ttl_s(key: str) -> float:
    c = _cfg()
    if key.startswith("ambient:integration:"):
        hours = float(c.get("integration_alert_cooldown_hours", 24) or 24)
        return max(3600.0, hours * 3600.0)
    if key.startswith("ambient:unavailable:"):
        hours = float(c.get("unavailable_alert_cooldown_hours", 12) or 12)
        return max(1800.0, hours * 3600.0)
    return constants._DEDUPE_TTL_S

def _dedupe_ok(key: str) -> bool:
    if not key:
        return True
    now = time.monotonic()
    ttl = _dedupe_ttl_s(key)
    for k, ts in list(runtime._recent_keys.items()):
        if now - ts > _dedupe_ttl_s(k):
            runtime._recent_keys.pop(k, None)
    if key in runtime._recent_keys and (now - runtime._recent_keys[key]) < ttl:
        return False
    runtime._recent_keys[key] = now
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

