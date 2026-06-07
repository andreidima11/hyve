"""Schema constants + describe_schema() — pure data, no I/O.

These define what shapes the automation engine accepts (modes, trigger
platforms, action kinds, service data limits, weekday names, entity-id
regex). The legacy `automation_definitions` module re-exports these under
the original underscore-prefixed names for backwards compatibility.
"""

from __future__ import annotations

import re

# Strict entity_id format: lowercase domain.object_id (HA convention).
# Locked down to prevent path traversal / log injection / downstream confusion.
ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")

SUPPORTED_SERVICE_VERBS = frozenset({
    # Generic on/off/state
    "turn_on", "turn_off", "toggle", "set",
    # Vacuum / robot-cleaner
    "start", "pause", "stop", "resume", "return_to_base", "dock", "locate", "clean",
    # Cover
    "open_cover", "close_cover", "stop_cover",
    # Lock
    "lock", "unlock",
})
SERVICE_DATA_MAX_BYTES = 4096
# Allow only flat, JSON-serializable scalar containers in service data.
SERVICE_DATA_SCALAR_TYPES = (str, int, float, bool, type(None))

SUPPORTED_MODES = frozenset({"single", "restart", "queued", "parallel"})

SUPPORTED_TRIGGER_PLATFORMS = (
    "time", "datetime", "interval", "state", "numeric_state",
    "template", "sun", "event", "time_pattern",
)
SUPPORTED_CONDITION_KINDS = ("time_window", "state", "numeric_state")
SUPPORTED_ACTION_KINDS = (
    "service", "scene", "skill", "notify",
    "delay", "wait_template", "repeat", "choose",
)

SUPPORTED_WEEKDAYS = frozenset({
    "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
})


def describe_schema() -> dict:
    """Static, machine-readable description of what the automation engine
    accepts. Used by the editor UI to populate selectors and to validate
    drafts client-side before submitting to the API.

    Pure data, no I/O — safe to expose to any authenticated user."""
    return {
        "version": 1,
        "modes": sorted(SUPPORTED_MODES),
        "weekdays": sorted(SUPPORTED_WEEKDAYS),
        "trigger_platforms": list(SUPPORTED_TRIGGER_PLATFORMS),
        "condition_kinds": list(SUPPORTED_CONDITION_KINDS),
        "action_kinds": list(SUPPORTED_ACTION_KINDS),
        "service": {
            "verbs": sorted(SUPPORTED_SERVICE_VERBS),
            "entity_id_pattern": ENTITY_ID_RE.pattern,
            "data_max_bytes": SERVICE_DATA_MAX_BYTES,
            "supports_target_keys": ["entity_id"],
            "rejected_target_keys": ["area_id", "device_id", "label_id", "floor_id"],
        },
    }
