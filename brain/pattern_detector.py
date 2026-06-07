"""Pattern Detector — tracks repeated manual device control actions and proposes automations.

Listens to the event bus for manual control events (via dashboard/API, NOT automations).
Tracks patterns like "user turns off living room light at ~23:00 every night" and after
N repetitions, generates an automation YAML draft and offers it via notification.

Config (intelligence.pattern_detector):
    enabled: true/false
    min_occurrences: 4        # how many times before proposing
    time_window_minutes: 30   # actions within this window are "same time of day"
    max_proposals_per_day: 3
"""

from __future__ import annotations

import json
import os
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, Optional

import settings as settings_mod
from core import i18n as core_i18n
from logger import log_line, log_detail

_STATE_PATH = os.path.join("output", "pattern_detector_state.json")

_patterns: dict[str, dict[str, Any]] = {}
_proposals_today: int = 0
_last_proposal_date: str = ""


def _cfg() -> dict:
    intel = settings_mod.CFG.get("intelligence") or {}
    return intel.get("pattern_detector") or {}


def is_enabled() -> bool:
    return bool(_cfg().get("enabled", False))


def _load_state() -> None:
    global _patterns
    try:
        with open(_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _patterns = data.get("patterns") or {}
    except FileNotFoundError:
        _patterns = {}
    except Exception as exc:
        log_detail("patterns", "LOAD_ERR", error=str(exc))
        _patterns = {}


def _save_state() -> None:
    try:
        os.makedirs(os.path.dirname(_STATE_PATH), exist_ok=True)
        tmp = _STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"patterns": _patterns}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _STATE_PATH)
    except Exception as exc:
        log_detail("patterns", "SAVE_ERR", error=str(exc))


def _pattern_key(entity_id: str, action: str, hour: int) -> str:
    """Generate a stable key for a recurring action at a time-of-day."""
    cfg = _cfg()
    window = int(cfg.get("time_window_minutes", 30) or 30)
    bucket = (hour * 60) // window
    return f"{entity_id}:{action}:bucket_{bucket}"


def record_manual_control(entity_id: str, action: str, source: str = "user") -> None:
    """Record a manual device control action for pattern detection.
    Called from the integration control endpoint."""
    if not is_enabled():
        return
    if source in ("automation", "ambient", "system"):
        return

    now = datetime.now()
    key = _pattern_key(entity_id, action, now.hour)

    if key not in _patterns:
        _patterns[key] = {
            "entity_id": entity_id,
            "action": action,
            "occurrences": [],
            "proposed": False,
        }

    entry = _patterns[key]
    entry["occurrences"].append({
        "timestamp": now.isoformat(),
        "weekday": now.strftime("%A"),
        "hour": now.hour,
        "minute": now.minute,
    })

    # Keep only last 30 occurrences
    entry["occurrences"] = entry["occurrences"][-30:]
    _save_state()

    _check_for_proposal(key)


def _check_for_proposal(key: str) -> None:
    """Check if a pattern has enough occurrences to propose an automation."""
    global _proposals_today, _last_proposal_date

    cfg = _cfg()
    min_occ = int(cfg.get("min_occurrences", 4) or 4)
    max_per_day = int(cfg.get("max_proposals_per_day", 3) or 3)

    entry = _patterns.get(key)
    if not entry or entry.get("proposed"):
        return

    occurrences = entry.get("occurrences") or []
    if len(occurrences) < min_occ:
        return

    today = datetime.now().strftime("%Y-%m-%d")
    if _last_proposal_date != today:
        _proposals_today = 0
        _last_proposal_date = today
    if _proposals_today >= max_per_day:
        return

    # Analyze the pattern
    hours = [o["hour"] for o in occurrences[-min_occ:]]
    avg_hour = sum(hours) / len(hours)
    avg_minute = sum(o["minute"] for o in occurrences[-min_occ:]) / min_occ

    # Check if times are consistent (within the window)
    window = int(cfg.get("time_window_minutes", 30) or 30)
    time_spread = max(hours) - min(hours)
    if time_spread > 2:
        return

    entry["proposed"] = True
    _proposals_today += 1
    _save_state()

    _propose_automation(entry, avg_hour, avg_minute)


def _propose_automation(entry: dict, avg_hour: float, avg_minute: float) -> None:
    """Generate and send an automation proposal notification."""
    import database
    import models

    entity_id = entry["entity_id"]
    action = entry["action"]
    hour = int(avg_hour)
    minute = int(avg_minute)

    # Get entity name
    entity_name = entity_id
    try:
        from addons.entity_store import get_entity_store
        store = get_entity_store()
        for e in store.get_all_entities():
            if e.get("entity_id") == entity_id:
                entity_name = e.get("name") or e.get("attributes", {}).get("friendly_name") or entity_id
                break
    except Exception:
        pass

    # Generate automation YAML
    automation_yaml = f"""id: auto_{entity_id.replace('.', '_')}_{action}_{hour:02d}{minute:02d}
title: "{action.replace('_', ' ').title()} {entity_name} la {hour:02d}:{minute:02d}"
trigger:
  - type: time
    at: "{hour:02d}:{minute:02d}"
action:
  - type: service
    entity_id: "{entity_id}"
    action: "{action}"
"""

    title = core_i18n.t("brain.pattern_detector.title")
    body = core_i18n.t(
        "brain.pattern_detector.body",
        action=action.replace("_", " "),
        entity_name=entity_name,
        hour=f"{hour:02d}",
        minute=f"{minute:02d}",
    )

    # Find admin user
    db = database.SessionLocal()
    try:
        user = (
            db.query(models.User)
            .filter(models.User.is_admin == True, models.User.is_active == True)
            .order_by(models.User.id.asc())
            .first()
        )
        if not user:
            return
        user_id = user.id
    finally:
        db.close()

    from core import notification_service
    notification_service.create_and_dispatch(
        user_id=user_id,
        title=title,
        body=body,
        category="ambient",
        severity="info",
        dedupe_key=f"pattern:{entity_id}:{action}",
        payload={
            "ambient": True,
            "kind": "automation_proposal",
            "pattern_key": f"{entity_id}:{action}",
            "suggested_actions": [{
                "index": 0,
                "label": core_i18n.t("brain.pattern_detector.create_automation_label"),
                "tool": "create_automation_definition",
                "args": {"source_yaml": automation_yaml},
            }],
        },
    )
    log_line("success", "⚙️", "PATTERNS", f"Proposed automation for {entity_name} {action} at {hour:02d}:{minute:02d}")


def init_pattern_detector() -> None:
    """Initialize pattern detector at startup."""
    if not is_enabled():
        return
    _load_state()
    log_line("success", "📊", "PATTERNS", f"detector initialized ({len(_patterns)} patterns tracked)")
