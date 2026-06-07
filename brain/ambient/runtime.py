from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from typing import Any, Optional

from logger import log_detail

_loop: Optional[asyncio.AbstractEventLoop] = None

_queue: "Optional[asyncio.Queue[dict]]" = None

_worker: Optional[asyncio.Task] = None

_scan_task: Optional[asyncio.Task] = None

_started = False

_state_since: dict[str, dict[str, Any]] = {}

_thought_times: deque[float] = deque(maxlen=64)   # monotonic timestamps of emitted thoughts

_last_thought_at: float = 0.0

_entity_cooldown: dict[str, float] = {}            # entity_id -> monotonic last-seen

_recent_keys: dict[str, float] = {}                # dedupe key -> monotonic

STATE_PATH = os.path.join("output", "ambient_state.json")

_pattern_counts: dict[str, dict[str, Any]] = {}

_notified_issues: dict[str, dict[str, Any]] = {}

_subscribed = False

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

