"""
direct_commands.py — Smart device command handler (semantic, language-agnostic).

Architecture:
─────────────────────────────────────────────────────────────────────

  Message ──► Regex fast-path? ──yes──► device_resolver ─► execute ─► done
                    │ no                                       (~5ms)
                    ▼
              (caller checks intent_router → device_control?)
                    │ yes
                    ▼
              Semantic extraction (aux_llm + device catalogue)
              LLM receives: user message + entity_id list
              LLM returns:  [{entity_id, action}] directly
                    │                              (~300-800ms)
                    ▼
              Execute all commands ─► done

─────────────────────────────────────────────────────────────────────

Tier 1 (regex): Instant, zero-latency path for trivial single commands.
    "aprinde becul", "turn on the light", "stinge lampa" etc.
    Uses device_resolver for fuzzy-matching target → entity_id.

Tier 2 (semantic): LLM-based extraction, called ONLY when intent_router
    classifies the message as device_control. The LLM receives the full
    device catalogue (entity_ids + friendly names + aliases) and returns
    resolved entity_ids directly — no fuzzy matching needed.
    Works with any language, any number of commands.

Exported functions:
    try_regex_command(message, user_id) → Optional[str]
        Fast regex path. Returns reply string or None.

    try_semantic_commands(message, user_id) → Optional[str]
        LLM semantic path. Returns reply string or None.
"""

from __future__ import annotations

import json
import re
import time
from typing import List, Optional, Tuple

import httpx

import settings as settings_mod
import smart_home_registry
from addons.entity_store import get_entity_store
from logger import log_line


class _NoOpSmartHome:
    """Backwards-compatible no-op shim that replaces the old
    legacy smart-home module. The smart-home control integration
    has been removed; there is no direct device-control path here anymore,
    so every command transparently fails closed and the caller falls back
    to the agent loop."""

    CONTROLLABLE_DOMAINS = smart_home_registry.CONTROLLABLE_DOMAINS

    @staticmethod
    def load_config() -> list:
        try:
            overrides = get_entity_store().get_overrides() or {}
        except Exception:
            return []
        return [
            {
                "entity_id": eid,
                "name": ov.get("custom_name") or eid,
                "aliases": ov.get("aliases") or [],
                "selected": bool(ov.get("selected")),
            }
            for eid, ov in overrides.items()
        ]

    @staticmethod
    async def call_service(domain, action, entity_id, service_data=None):  # noqa: D401
        return {"ok": False, "error": "smart_home_unavailable"}


_smart_home = _NoOpSmartHome()


# ═══════════════════════════════════════════════════════════════════════
#  REGEX PATTERNS  (Tier 1 — single command, instant)
# ═══════════════════════════════════════════════════════════════════════

_DIRECT_PATTERNS: List[Tuple[re.Pattern, str]] = [
    # ── RO: imperativ ──
    (re.compile(r"^\s*aprinde\s+(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*stinge\s+(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*pornește\s+(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*pornești\s+(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*oprește\s+(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*oprești\s+(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*deschide\s+(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*închide\s+(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*activează\s+(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*dezactivează\s+(.+)$", re.I), "turn_off"),
    # ── EN: verb first ──
    (re.compile(r"^\s*turn\s+on\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*turn\s+off\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*switch\s+on\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*switch\s+off\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*enable\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*disable\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
]

# Prefixe / sufixe opționale pentru forme naturale
_PRE = r"(?:(?:te\s+rog|please|pls|te\s+rog\s+frumos|hey|hei|uite|bro|frate|bă|ba|mai)\s*[,]?\s*)?"
_POST = r"(?:\s*(?:te\s+rog|please|pls|ok|okay|da|dă|vrei|va\s+rog|ms|mulțumesc|mersi|thx|thanks)[?!.]*)?$"

_NATURAL_PATTERNS: List[Tuple[re.Pattern, str]] = [
    # RO: "dă drumul la X"
    (re.compile(rf"^\s*{_PRE}d[aă][\s-]+(?:i[\s-]+)?drumul?\s+(?:la\s+)?(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}ia[\s-]+i?\s*drumul?\s+(?:la\s+)?(.+?){_POST}", re.I), "turn_off"),
    # RO: "fă lumina"
    (re.compile(rf"^\s*{_PRE}f[aă][\s-]+(?:mi\s+)?(.+?){_POST}", re.I), "turn_on"),
    # RO: "poți să aprinzi X"
    (re.compile(rf"^\s*{_PRE}(?:po[tț]i|ai\s+putea|vrei|vreau)\s+(?:sa\s+|să\s+)?(?:aprinzi|pornești|pornesti|deschizi|activezi)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:po[tț]i|ai\s+putea|vrei|vreau)\s+(?:sa\s+|să\s+)?(?:stingi|oprești|opresti|închizi|inchizi|dezactivezi)\s+(.+?){_POST}", re.I), "turn_off"),
    # RO: "aprinde-mi X"
    (re.compile(rf"^\s*{_PRE}aprinde[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}stinge[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}pornește[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}porneste[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}oprește[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}opreste[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}deschide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}închide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}inchide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    # RO: "vreau X aprins/stins"
    (re.compile(rf"^\s*{_PRE}(?:vreau|aș\s+vrea|as\s+vrea|doresc)\s+(?:sa\s+(?:fie\s+)?|să\s+(?:fie\s+)?)?(.+?)\s+(?:aprins[aă]?|pornit[aă]?|deschis[aă]?|activat[aă]?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:vreau|aș\s+vrea|as\s+vrea|doresc)\s+(?:sa\s+(?:fie\s+)?|să\s+(?:fie\s+)?)?(.+?)\s+(?:stins[aă]?|oprit[aă]?|închis[aă]?|inchis[aă]?|dezactivat[aă]?){_POST}", re.I), "turn_off"),
    # RO: "lasă X aprins/stins"
    (re.compile(rf"^\s*{_PRE}las[aă][\s-]+(?:mi\s+)?(.+?)\s+(?:aprins[aă]?|pornit[aă]?|deschis[aă]?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}las[aă][\s-]+(?:mi\s+)?(.+?)\s+(?:stins[aă]?|oprit[aă]?|închis[aă]?|inchis[aă]?){_POST}", re.I), "turn_off"),
    # RO: informal
    (re.compile(rf"^\s*{_PRE}bag[aă]\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}scoate\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}taie\s+(.+?){_POST}", re.I), "turn_off"),
    # EN: "can you turn on X"
    (re.compile(rf"^\s*{_PRE}(?:can\s+you|could\s+you|would\s+you|will\s+you)\s+(?:please\s+)?(?:turn\s+on|switch\s+on|enable)\s+(?:the\s+)?(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:can\s+you|could\s+you|would\s+you|will\s+you)\s+(?:please\s+)?(?:turn\s+off|switch\s+off|disable)\s+(?:the\s+)?(.+?){_POST}", re.I), "turn_off"),
    # EN: "I want X on/off"
    (re.compile(rf"^\s*{_PRE}(?:i\s+want|i'?d\s+like)\s+(?:the\s+)?(.+?)\s+(?:on|turned\s+on|enabled|switched\s+on){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:i\s+want|i'?d\s+like)\s+(?:the\s+)?(.+?)\s+(?:off|turned\s+off|disabled|switched\s+off){_POST}", re.I), "turn_off"),
]

_MULTI_SPACES = re.compile(r"\s{2,}")

# Structural hints that a single extracted target actually refers to multiple
# entities/areas and should be handled semantically instead of the regex fast-path.
_MULTI_TARGET_HINTS = re.compile(
    r"(?:,|\b(?:și|si|and|plus|both|all|toate|toti|toți|multiple|mai\s+multe)\b)",
    re.I,
)

# Action keywords that signal a multi-command (target shouldn't contain these)
_ACTION_VERBS = re.compile(
    r"\b(?:aprinde|stinge|pornește|pornesti|oprește|opresti|deschide|închide|inchide"
    r"|activează|dezactivează|turn\s+on|turn\s+off|switch\s+on|switch\s+off"
    r"|enable|disable)\b",
    re.I,
)


def _clean_target(raw: str) -> str:
    """Strip noise / politeness words from a regex-extracted target."""
    t = raw.strip().rstrip(".!?,;:")
    t = re.sub(r"^(?:la|pe|din|de|în|in|the|a|an)\s+", "", t, flags=re.I).strip()
    return _MULTI_SPACES.sub(" ", t).strip()


def _should_defer_target_to_semantic(message: str, target: str) -> bool:
    """
    Detect coordinated / plural targets that the regex path should NOT execute.

    Examples that should go semantic:
      - "turn off kitchen and bedroom lights"
      - "stinge luminile din sufragerie și dormitor"
      - "aprinde toate luminile"
    """
    if not target:
        return False

    target_norm = _MULTI_SPACES.sub(" ", target.strip().lower())
    message_norm = _MULTI_SPACES.sub(" ", (message or "").strip().lower())

    # Coordinated target/list/quantifier inside the extracted target.
    if _MULTI_TARGET_HINTS.search(target_norm):
        return True

    # If the full message clearly contains list separators but regex only found
    # one target phrase, prefer the semantic path.
    if target_norm and target_norm in message_norm and _MULTI_TARGET_HINTS.search(message_norm):
        return True

    return False


def _parse_regex(text: str) -> Optional[Tuple[str, str]]:
    """Try to match text against regex patterns. Returns (action, target) or None."""
    if not text or not isinstance(text, str):
        return None
    line = text.strip()
    if len(line) > 150:
        return None

    for pattern, action in _DIRECT_PATTERNS:
        m = pattern.match(line)
        if m:
            target = _clean_target(m.group(1))
            if target and not _ACTION_VERBS.search(target):
                return (action, target)

    for pattern, action in _NATURAL_PATTERNS:
        m = pattern.match(line)
        if m:
            target = _clean_target(m.group(1))
            if target and len(target) < 60 and not _ACTION_VERBS.search(target):
                return (action, target)

    return None


# ── Multi-command split: "aprinde X și stinge Y" → [(action, target), ...] ──

# Conjunctions / separators for splitting multi-command messages
_SPLIT_CONJ = re.compile(
    r"\s*(?:,\s*(?:și|si|and|dar|but|apoi|then|after\s+that|după\s+aia|dupa\s+aia)?\s*"
    r"|(?:\s+și\s+|\s+si\s+|\s+and\s+|\s+dar\s+|\s+but\s+|\s+apoi\s+|\s+then\s+))\s*",
    re.I,
)


def _parse_regex_multi(text: str) -> List[Tuple[str, str]]:
    """Split text on conjunctions and parse each fragment. Returns list of (action, target)."""
    if not text or not isinstance(text, str):
        return []
    line = text.strip()
    if len(line) > 250:
        return []

    # First try as a single command
    single = _parse_regex(line)
    deferred_single = False
    if single:
        action, target = single
        # Avoid hijacking coordinated / plural targets; let semantic extraction
        # map them to multiple concrete entities from the device catalogue.
        if not _should_defer_target_to_semantic(line, target):
            return [(action, target)]
        deferred_single = True

    # Split on conjunctions and try each fragment
    fragments = _SPLIT_CONJ.split(line)
    fragments = [f.strip() for f in fragments if f and f.strip()]
    if len(fragments) < 2:
        return []

    results: List[Tuple[str, str]] = []
    for frag in fragments:
        parsed = _parse_regex(frag)
        if parsed:
            results.append(parsed)

    # If the original command looked coordinated but we could only parse some
    # fragments, don't execute a partial result — let the semantic path handle it.
    if deferred_single:
        if len(results) < 2 or len(results) != len(fragments):
            return []

    return results


# ═══════════════════════════════════════════════════════════════════════
#  EXECUTION  (shared by both tiers)
# ═══════════════════════════════════════════════════════════════════════

def _action_reply(action: str, name: str, service_data: dict | None = None) -> str:
    """Human-friendly reply for a completed action."""
    suffix = ""
    if service_data:
        if service_data.get("brightness") is not None:
            pct = round(service_data["brightness"] / 255 * 100)
            suffix = f" la {pct}%"
        if service_data.get("color_temp_kelvin") is not None:
            suffix += f" ({service_data['color_temp_kelvin']}K)"
    if action == "turn_on":
        return f"Am aprins {name}{suffix}."
    elif action == "turn_off":
        return f"Am stins {name}."
    return f"Am executat comanda pentru {name}{suffix}."


async def _execute_by_entity_id(entity_id: str, action: str, service_data: dict | None = None) -> Optional[str]:
    """Execute action on a known entity_id. Returns reply or None on failure."""
    domain = entity_id.split(".")[0]
    result = await _smart_home.call_service(domain, action, entity_id, service_data=service_data)
    if not result.get("ok"):
        err = result.get("error") or "Eroare"
        log_line("ha", "❌", "EXEC", f"HA call failed for {entity_id}: {err}")
        return None
    # Find friendly name from config
    config = _smart_home.load_config()
    name = entity_id
    for d in config:
        if d.get("entity_id") == entity_id:
            name = d.get("name") or entity_id
            break
    log_line("ha", "✅", "EXEC", f"{action} {name} ({entity_id})" + (f" data={service_data}" if service_data else ""))
    return _action_reply(action, name, service_data=service_data)


# ═══════════════════════════════════════════════════════════════════════
#  TIER 0: Scene activation fast-path  (exported)
# ═══════════════════════════════════════════════════════════════════════

_SCENE_PATTERNS: List[re.Pattern] = [
    # RO
    re.compile(r"^\s*(?:te\s+rog\s+)?(?:activeaz[aă]|porne[sș]te|porneste|ruleaz[aă]|ruleaza|execut[aă]|executa|pune|d[aă])\s+scena\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scena\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scen[aă]:\s*(.+?)\s*[?!.]*$", re.I),
    # EN
    re.compile(r"^\s*(?:please\s+)?(?:activate|run|trigger|launch|start|play|enable)\s+(?:the\s+)?scene\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scene\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scene:\s*(.+?)\s*[?!.]*$", re.I),
]


def _normalize_scene_query(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _match_scene_for_user(query: str, user_id: str):
    """Find a scene visible to the user whose name best matches `query`.

    Returns the SQLAlchemy `Scene` row or None. Matching strategy:
    1. exact case-insensitive match on name
    2. exact match on slug-like name (no punctuation)
    3. substring match (query in name)
    """
    if not query:
        return None
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    try:
        import database
        import models
        from routers import scenes as scenes_module
    except Exception:
        return None

    db = database.SessionLocal()
    try:
        user = db.query(models.User).filter(models.User.id == uid).first()
        if not user:
            return None
        rows = scenes_module._query_visible(db, user).all()
        if not rows:
            return None
        q_norm = _normalize_scene_query(query)
        q_compact = re.sub(r"[^a-z0-9]+", "", q_norm)

        def _name_norm(s):
            return _normalize_scene_query(s.name or "")

        def _name_compact(s):
            return re.sub(r"[^a-z0-9]+", "", _name_norm(s))

        # 1. exact name
        for s in rows:
            if _name_norm(s) == q_norm:
                return s
        # 2. exact compact (ignore punctuation/spaces)
        for s in rows:
            if q_compact and _name_compact(s) == q_compact:
                return s
        # 3. substring
        candidates = [s for s in rows if q_norm and q_norm in _name_norm(s)]
        if len(candidates) == 1:
            return candidates[0]
        # 4. compact substring
        candidates = [s for s in rows if q_compact and q_compact in _name_compact(s)]
        if len(candidates) == 1:
            return candidates[0]
        return None
    finally:
        db.close()


async def try_scene_command(message: str, user_id: str) -> Optional[str]:
    """Detect 'activate scene X' style messages and run the scene.

    Returns a reply string on success/failure-with-context, or None if the
    message is not a scene command (so the caller can try other handlers).
    """
    text = (message or "").strip()
    if not text:
        return None
    query = ""
    for pat in _SCENE_PATTERNS:
        m = pat.match(text)
        if m:
            query = m.group(1).strip().strip("\"'")
            break
    if not query:
        return None

    scene = _match_scene_for_user(query, user_id)
    if not scene:
        log_line("scene", "❓", "VOICE", f"No scene matched for query '{query}'")
        return f"Nu am găsit o scenă cu numele „{query}”."

    try:
        import database
        from routers import scenes as scenes_module
    except Exception as exc:
        log_line("error", "⚠️", "SCENE_CMD", f"import failed: {exc}")
        return None

    db = database.SessionLocal()
    try:
        # Re-fetch in this session to avoid detached-instance issues
        fresh = db.query(scene.__class__).filter(scene.__class__.id == scene.id).first()
        if not fresh:
            return f"Nu am găsit scena „{scene.name}”."
        try:
            result = await scenes_module.activate_scene_internal(db, fresh)
        except Exception as exc:
            log_line("scene", "❌", "VOICE", f"activate {fresh.name} failed: {exc}")
            return f"Nu am putut activa scena „{fresh.name}”."
        total = int(result.get("total") or 0)
        ok = int(result.get("succeeded") or 0)
        log_line("scene", "✅", "VOICE", f"activated '{fresh.name}' ({ok}/{total})")
        if total == 0:
            return f"Am activat scena „{fresh.name}”."
        if ok == total:
            return f"Am activat scena „{fresh.name}” ({ok}/{total} acțiuni)."
        return f"Scenă parțial activată: „{fresh.name}” ({ok}/{total} acțiuni)."
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════════════
#  TIER 1: Regex fast-path  (exported)
# ═══════════════════════════════════════════════════════════════════════

async def try_regex_command(message: str, user_id: str) -> Optional[str]:
    """
    Instant regex check for device commands (single or multi-command).
    "aprinde becul dormitor și stinge becul bucătărie" → handles both.
    Returns a reply string if matched + executed, else None.
    """
    if True:  # smart-home control disabled (legacy HA integration removed)
        return None
    # Direct control path removed with the legacy smart-home integration.
    return None

    commands = _parse_regex_multi(message)
    if not commands:
        if message and _MULTI_TARGET_HINTS.search(message):
            log_line("ha", "↪️", "REGEX_CMD", "Deferring coordinated target to semantic parser")
        return None

    from device_resolver import find_device_details
    import asyncio

    # Resolve all targets in parallel
    resolve_tasks = [find_device_details(target, user_id, user_message=target) for _action, target in commands]
    resolved = await asyncio.gather(*resolve_tasks)

    # Execute all resolved commands in parallel
    exec_tasks = []
    exec_names = []
    for (action, target), (entity_id, friendly_name) in zip(commands, resolved):
        if not entity_id:
            log_line("ha", "❌", "REGEX_CMD", f"No device for '{target}'")
            continue
        domain = entity_id.split(".")[0]
        exec_tasks.append(_smart_home.call_service(domain, action, entity_id))
        exec_names.append((action, entity_id, friendly_name or entity_id))

    if not exec_tasks:
        return None

    results = await asyncio.gather(*exec_tasks)

    replies: list[str] = []
    for (action, entity_id, name), result in zip(exec_names, results):
        if result.get("ok"):
            log_line("ha", "✅", "REGEX_CMD", f"{action} {name} ({entity_id})")
            replies.append(_action_reply(action, name))
        else:
            err = result.get("error") or "Eroare"
            log_line("ha", "❌", "REGEX_CMD", f"HA call failed for {entity_id}: {err}")

    return " ".join(replies) if replies else None


# ═══════════════════════════════════════════════════════════════════════
#  TIER 2: Semantic extraction via aux_llm  (exported)
# ═══════════════════════════════════════════════════════════════════════

_SEMANTIC_SYSTEM = """\
You are a smart-home command parser. Do NOT reason or think — reply with ONLY the JSON array.

Available devices:
{catalogue}

Instructions:
- Extract ALL device commands from the user message.
- Match each command to the most likely device from the list above.
- Return a JSON array of objects with these fields:
  - "entity_id": string (REQUIRED) — must be from the list above
  - "action": "turn_on"|"turn_off" (REQUIRED)
  - "brightness": integer 0-255 (OPTIONAL) — only if user specifies brightness/dimming. 0=off, 128=~50%, 255=full. Requires action=turn_on.
  - "color_temp_kelvin": integer 2000-10000 (OPTIONAL) — only if user specifies color temperature (warm=2700, neutral=4000, cool/daylight=5500-6500). Requires action=turn_on.
- Examples: "dim bedroom light to 50%" → [{{"entity_id":"light.bedroom","action":"turn_on","brightness":128}}]
  "set warm light in bedroom" → [{{"entity_id":"light.bedroom","action":"turn_on","color_temp_kelvin":2700}}]
- Use ONLY entity_ids from the list above. Never invent entity_ids.
- If no commands can be mapped to devices, return: []
- Reply with ONLY the JSON array. No markdown, no explanation, no reasoning."""


def _build_catalogue() -> str:
    """Legacy catalogue builder — kept for backwards compat."""
    return _build_catalogue_from_store()


_CONTROLLABLE_DOMAINS = {"light", "switch", "lock", "cover", "climate", "fan", "media_player", "vacuum"}


def _build_catalogue_from_store() -> str:
    """
    Build a compact device catalogue from the integration entity store.
    Format: entity_id | Friendly Name | area
    Only includes controllable domains.
    """
    store = get_entity_store()
    all_entities = store.get_all_entities()
    lines: list[str] = []
    for ent in all_entities:
        eid = ent.get("entity_id") or ""
        domain = eid.split(".", 1)[0] if "." in eid else ""
        if domain not in _CONTROLLABLE_DOMAINS:
            continue
        parts = [eid]
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or ""
        if name:
            parts.append(name)
        area = ent.get("area") or ent.get("area_name") or ""
        if area:
            parts.append(area)
        lines.append(" | ".join(parts))
    return "\n".join(lines)


def _get_aux_llm_config() -> Optional[Tuple[str, str, str]]:
    """Returns (url, model, api_key) for aux_llm, or None if not configured."""
    intel = settings_mod.CFG.get("intelligence") or {}
    aux = intel.get("aux_llm") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}

    url = (aux.get("target_url") or "").strip() or (llm_cfg.get("target_url") or "").strip()
    model = (aux.get("model_name") or "").strip() or (llm_cfg.get("model_name") or "").strip()
    api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()

    if not url or not model:
        return None

    # Normalize to /chat/completions endpoint
    url = url.rstrip("/")
    if not url.endswith("/chat/completions"):
        if "/v1" in url:
            url += "/chat/completions"
        else:
            url += "/v1/chat/completions"

    return url, model, api_key


async def _llm_extract(message: str, catalogue: str) -> Optional[List[dict]]:
    """
    Call aux_llm to extract device commands.
    Returns list of {entity_id, action} dicts, or None on failure.
    """
    cfg = _get_aux_llm_config()
    if not cfg:
        log_line("ha", "⚠️", "SEMANTIC", "No aux_llm configured — skipping semantic extraction")
        return None

    url, model, api_key = cfg
    system_prompt = _SEMANTIC_SYSTEM.format(catalogue=catalogue)

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": message.strip()[:500] + " /no_think"},
        ],
        "temperature": 0.0,
        "max_tokens": 256,
        "stream": False,
    }

    start = time.monotonic()
    try:
        from llm_client import get_llm_client
        client = await get_llm_client()
        resp = await client.post(url, json=payload, headers=headers, timeout=15.0)

        elapsed_ms = (time.monotonic() - start) * 1000

        if resp.status_code != 200:
            log_line("ha", "⚠️", "SEMANTIC", f"HTTP {resp.status_code} ({elapsed_ms:.0f}ms)")
            return None

        raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()

        # Some models wrap in ```json ... ``` or include <think> tags
        # Strip complete thinking tags first
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()
        # Strip unclosed <think> tags (when max_tokens cuts off mid-thinking)
        raw = re.sub(r"<think>.*", "", raw, flags=re.S).strip()
        # Strip markdown fences
        if "```" in raw:
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```", "", raw)
            raw = raw.strip()

        # Extract first JSON array from response
        bracket_start = raw.find("[")
        bracket_end = raw.rfind("]")
        if bracket_start == -1 or bracket_end == -1:
            log_line("ha", "⚠️", "SEMANTIC", f"No JSON array in response ({elapsed_ms:.0f}ms): {raw[:100]}")
            return None
        raw = raw[bracket_start:bracket_end + 1]

        cmds = json.loads(raw)
        if not isinstance(cmds, list):
            log_line("ha", "⚠️", "SEMANTIC", f"Expected array, got {type(cmds).__name__}")
            return None

        # Validate each command
        valid: list[dict] = []
        for item in cmds:
            eid = (item.get("entity_id") or "").strip()
            action = (item.get("action") or "").strip()
            if eid and action in ("turn_on", "turn_off") and "." in eid:
                entry: dict = {"entity_id": eid, "action": action}
                # Optional brightness (0-255)
                if item.get("brightness") is not None:
                    try:
                        bri = int(item["brightness"])
                        entry["brightness"] = max(0, min(255, bri))
                        if bri == 0:
                            entry["action"] = "turn_off"
                        elif action != "turn_on":
                            entry["action"] = "turn_on"
                    except (ValueError, TypeError):
                        pass
                # Optional color_temp_kelvin (2000-10000)
                if item.get("color_temp_kelvin") is not None:
                    try:
                        ct = int(item["color_temp_kelvin"])
                        if 1000 <= ct <= 10000:
                            entry["color_temp_kelvin"] = ct
                            if entry["action"] != "turn_on":
                                entry["action"] = "turn_on"
                    except (ValueError, TypeError):
                        pass
                valid.append(entry)

        log_line("ha", "🧠", "SEMANTIC",
                 f"{len(valid)} commands extracted ({elapsed_ms:.0f}ms)"
                 + (": " + ", ".join(f"{c['action']}→{c['entity_id']}" for c in valid) if valid else ""))
        return valid

    except httpx.TimeoutException:
        elapsed_ms = (time.monotonic() - start) * 1000
        log_line("ha", "⏳", "SEMANTIC", f"Timeout ({elapsed_ms:.0f}ms)")
        return None
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        log_line("ha", "⚠️", "SEMANTIC", f"{type(exc).__name__}: {exc} ({elapsed_ms:.0f}ms)")
        return None


async def try_semantic_commands(message: str, user_id: str) -> Optional[str]:
    """
    Semantic device command extraction using aux_llm + device catalogue.
    The LLM receives the full device list and returns entity_ids directly.
    Supports any language, any number of commands.

    Called from main.py ONLY when intent_router classifies as device_control.
    Returns combined reply string, or None if extraction/execution fails.
    """
    catalogue = _build_catalogue_from_store()
    if not catalogue:
        return None

    commands = await _llm_extract(message, catalogue)
    if not commands:
        return None

    from integrations import get_integration_manager
    store = get_entity_store()
    all_entities = store.get_all_entities()
    known_ids = {e.get("entity_id") for e in all_entities if e.get("entity_id")}

    import asyncio

    async def _control_one(eid: str, action: str, data: dict) -> str:
        manager = get_integration_manager()
        target_id = eid
        target_integration = None
        for ent in all_entities:
            if ent.get("entity_id") == eid:
                target_id = str(ent.get("unique_id") or eid)
                entry_id = ent.get("entry_id") or ""
                source = ent.get("source") or ""
                if entry_id:
                    target_integration = manager.get_by_entry(entry_id)
                if not target_integration and source:
                    target_integration = manager.get(source)
                break
        if not target_integration:
            return ""
        try:
            await target_integration.control_entity(target_id, action, data)
            name = eid
            for ent in all_entities:
                if ent.get("entity_id") == eid:
                    name = ent.get("name") or ent.get("attributes", {}).get("friendly_name") or eid
                    break
            return f"✓ {action} → {name}"
        except Exception as exc:
            log_line("ha", "⚠️", "SEMANTIC", f"Control failed {eid}: {exc}")
            return ""

    exec_tasks = []
    for cmd in commands:
        eid = cmd["entity_id"]
        action = cmd["action"]
        if eid not in known_ids:
            log_line("ha", "⚠️", "SEMANTIC", f"LLM returned unknown entity_id: {eid}")
            continue
        data = {}
        if cmd.get("brightness") is not None:
            data["brightness"] = cmd["brightness"]
        if cmd.get("color_temp_kelvin") is not None:
            data["color_temp_kelvin"] = cmd["color_temp_kelvin"]
        exec_tasks.append(_control_one(eid, action, data))

    if not exec_tasks:
        return None

    results = await asyncio.gather(*exec_tasks)
    replies = [r for r in results if r]
    return " ".join(replies) if replies else None

