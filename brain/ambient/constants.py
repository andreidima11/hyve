from __future__ import annotations

_LONG_ON_MINUTES = 45        # lights / switches / fans left ON

_LONG_OPEN_MINUTES = 20      # doors / windows / covers open, locks unlocked, motion stuck

_ENTITY_COOLDOWN_S = 60.0

_DEDUPE_TTL_S = 1800.0

_SKIP_ENTITY_STATES = frozenset({"unavailable", "unknown", "offline", "none", ""})

CHECKIN_JOB_PREFIX = "ambient_checkin_"

_TRIGGER_DOMAINS = {"light", "switch", "lock", "cover", "binary_sensor", "climate", "fan", "alarm_control_panel"}

_CONTEXT_DOMAINS = {"light", "switch", "lock", "cover", "climate", "fan", "media_player", "alarm_control_panel"}

_ON_STATES = {"on", "open", "unlocked", "playing", "heat", "cool", "auto"}