from __future__ import annotations

import re

import settings as settings_mod

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

