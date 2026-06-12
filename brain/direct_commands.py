"""Fast device-control paths for chat (regex, semantic LLM, scenes).

Regex tier: instant parsing + device_resolver fuzzy match → control_entity.
Semantic tier: aux_llm extracts entity_ids from catalogue → control_entity.
Scene tier: activate a saved scene by name.

All execution goes through ``core.device_control`` — no legacy smart-home shim.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import List, Optional, Tuple

import httpx

import core.settings as settings_mod
from addons.entity_store import get_entity_store
from core.device_control import ControlTargetNotFound, control_entity
from core.logger import log_line

# ── Regex patterns (Tier 1) ───────────────────────────────────────────────

_DIRECT_PATTERNS: List[Tuple[re.Pattern, str]] = [
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
    (re.compile(r"^\s*turn\s+on\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*turn\s+off\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*switch\s+on\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*switch\s+off\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
    (re.compile(r"^\s*enable\s+(?:the\s+)?(.+)$", re.I), "turn_on"),
    (re.compile(r"^\s*disable\s+(?:the\s+)?(.+)$", re.I), "turn_off"),
]

_PRE = r"(?:(?:te\s+rog|please|pls|te\s+rog\s+frumos|hey|hei|uite|bro|frate|bă|ba|mai)\s*[,]?\s*)?"
_POST = r"(?:\s*(?:te\s+rog|please|pls|ok|okay|da|dă|vrei|va\s+rog|ms|mulțumesc|mersi|thx|thanks)[?!.]*)?$"

_NATURAL_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(rf"^\s*{_PRE}d[aă][\s-]+(?:i[\s-]+)?drumul?\s+(?:la\s+)?(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}ia[\s-]+i?\s*drumul?\s+(?:la\s+)?(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}f[aă][\s-]+(?:mi\s+)?(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:po[tț]i|ai\s+putea|vrei|vreau)\s+(?:sa\s+|să\s+)?(?:aprinzi|pornești|pornesti|deschizi|activezi)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:po[tț]i|ai\s+putea|vrei|vreau)\s+(?:sa\s+|să\s+)?(?:stingi|oprești|opresti|închizi|inchizi|dezactivezi)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}aprinde[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}stinge[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}pornește[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}porneste[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}oprește[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}opreste[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}deschide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}închide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}inchide[\s-]+(?:mi|ne|le|i)\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}(?:vreau|aș\s+vrea|as\s+vrea|doresc)\s+(?:sa\s+(?:fie\s+)?|să\s+(?:fie\s+)?)?(.+?)\s+(?:aprins[aă]?|pornit[aă]?|deschis[aă]?|activat[aă]?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:vreau|aș\s+vrea|as\s+vrea|doresc)\s+(?:sa\s+(?:fie\s+)?|să\s+(?:fie\s+)?)?(.+?)\s+(?:stins[aă]?|oprit[aă]?|închis[aă]?|inchis[aă]?|dezactivat[aă]?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}las[aă][\s-]+(?:mi\s+)?(.+?)\s+(?:aprins[aă]?|pornit[aă]?|deschis[aă]?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}las[aă][\s-]+(?:mi\s+)?(.+?)\s+(?:stins[aă]?|oprit[aă]?|închis[aă]?|inchis[aă]?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}bag[aă]\s+(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}scoate\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}taie\s+(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}(?:can\s+you|could\s+you|would\s+you|will\s+you)\s+(?:please\s+)?(?:turn\s+on|switch\s+on|enable)\s+(?:the\s+)?(.+?){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:can\s+you|could\s+you|would\s+you|will\s+you)\s+(?:please\s+)?(?:turn\s+off|switch\s+off|disable)\s+(?:the\s+)?(.+?){_POST}", re.I), "turn_off"),
    (re.compile(rf"^\s*{_PRE}(?:i\s+want|i'?d\s+like)\s+(?:the\s+)?(.+?)\s+(?:on|turned\s+on|enabled|switched\s+on){_POST}", re.I), "turn_on"),
    (re.compile(rf"^\s*{_PRE}(?:i\s+want|i'?d\s+like)\s+(?:the\s+)?(.+?)\s+(?:off|turned\s+off|disabled|switched\s+off){_POST}", re.I), "turn_off"),
]

_MULTI_SPACES = re.compile(r"\s{2,}")
_MULTI_TARGET_HINTS = re.compile(
    r"(?:,|\b(?:și|si|and|plus|both|all|toate|toti|toți|multiple|mai\s+multe)\b)",
    re.I,
)
_ACTION_VERBS = re.compile(
    r"\b(?:aprinde|stinge|pornește|pornesti|oprește|opresti|deschide|închide|inchide"
    r"|activează|dezactivează|turn\s+on|turn\s+off|switch\s+on|switch\s+off"
    r"|enable|disable)\b",
    re.I,
)
_SPLIT_CONJ = re.compile(
    r"\s*(?:,\s*(?:și|si|and|dar|but|apoi|then|after\s+that|după\s+aia|dupa\s+aia)?\s*"
    r"|(?:\s+și\s+|\s+si\s+|\s+and\s+|\s+dar\s+|\s+but\s+|\s+apoi\s+|\s+then\s+))\s*",
    re.I,
)

_CONTROLLABLE_DOMAINS = frozenset(
    {"light", "switch", "lock", "cover", "climate", "fan", "media_player", "vacuum", "lawn_mower"}
)


def _clean_target(raw: str) -> str:
    t = raw.strip().rstrip(".!?,;:")
    t = re.sub(r"^(?:la|pe|din|de|în|in|the|a|an)\s+", "", t, flags=re.I).strip()
    return _MULTI_SPACES.sub(" ", t).strip()


def _should_defer_target_to_semantic(message: str, target: str) -> bool:
    if not target:
        return False
    target_norm = _MULTI_SPACES.sub(" ", target.strip().lower())
    message_norm = _MULTI_SPACES.sub(" ", (message or "").strip().lower())
    if _MULTI_TARGET_HINTS.search(target_norm):
        return True
    if target_norm and target_norm in message_norm and _MULTI_TARGET_HINTS.search(message_norm):
        return True
    return False


def _parse_regex(text: str) -> Optional[Tuple[str, str]]:
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


def _parse_regex_multi(text: str) -> List[Tuple[str, str]]:
    if not text or not isinstance(text, str):
        return []
    line = text.strip()
    if len(line) > 250:
        return []

    single = _parse_regex(line)
    deferred_single = False
    if single:
        action, target = single
        if not _should_defer_target_to_semantic(line, target):
            return [(action, target)]
        deferred_single = True

    fragments = [f.strip() for f in _SPLIT_CONJ.split(line) if f and f.strip()]
    if len(fragments) < 2:
        return []

    results: List[Tuple[str, str]] = []
    for frag in fragments:
        parsed = _parse_regex(frag)
        if parsed:
            results.append(parsed)

    if deferred_single:
        if len(results) < 2 or len(results) != len(fragments):
            return []
    return results


# ── Execution helpers ─────────────────────────────────────────────────────

def _action_reply(action: str, name: str, service_data: dict | None = None) -> str:
    suffix = ""
    if service_data:
        if service_data.get("brightness") is not None:
            pct = round(service_data["brightness"] / 255 * 100)
            suffix = f" la {pct}%"
        if service_data.get("color_temp_kelvin") is not None:
            suffix += f" ({service_data['color_temp_kelvin']}K)"
    if action == "turn_on":
        return f"Am aprins {name}{suffix}."
    if action == "turn_off":
        return f"Am stins {name}."
    return f"Am executat comanda pentru {name}{suffix}."


async def _run_control(entity_id: str, action: str, data: dict | None, display_name: str) -> Optional[str]:
    try:
        await control_entity(entity_id, action, data or {})
        log_line("ha", "✅", "EXEC", f"{action} {display_name} ({entity_id})")
        return _action_reply(action, display_name, data)
    except ControlTargetNotFound:
        log_line("ha", "❌", "EXEC", f"No integration for {entity_id}")
        return None
    except Exception as exc:
        log_line("ha", "❌", "EXEC", f"Control failed {entity_id}: {exc}")
        return None


async def _execute_parsed_commands(commands: List[Tuple[str, str]], user_id: str) -> Optional[str]:
    if not commands:
        return None
    from core.device_resolver import find_device_details

    resolved = await asyncio.gather(
        *[find_device_details(target, user_id, user_message=target) for _, target in commands]
    )

    tasks: list = []
    meta: list[tuple[str, str, str]] = []
    for (action, target), (entity_id, friendly_name) in zip(commands, resolved):
        if not entity_id:
            log_line("ha", "❌", "REGEX_CMD", f"No device for '{target}'")
            continue
        name = friendly_name or entity_id
        tasks.append(_run_control(entity_id, action, None, name))
        meta.append((action, entity_id, name))

    if not tasks:
        return None

    replies = [r for r in await asyncio.gather(*tasks) if r]
    return " ".join(replies) if replies else None


# ── Scene fast-path (Tier 0) ──────────────────────────────────────────────

_SCENE_PATTERNS: List[re.Pattern] = [
    re.compile(r"^\s*(?:te\s+rog\s+)?(?:activeaz[aă]|porne[sș]te|porneste|ruleaz[aă]|ruleaza|execut[aă]|executa|pune|d[aă])\s+scena\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scena\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scen[aă]:\s*(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*(?:please\s+)?(?:activate|run|trigger|launch|start|play|enable)\s+(?:the\s+)?scene\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scene\s+(.+?)\s*[?!.]*$", re.I),
    re.compile(r"^\s*scene:\s*(.+?)\s*[?!.]*$", re.I),
]


def _normalize_scene_query(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _match_scene_for_user(query: str, user_id: str):
    if not query:
        return None
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    try:
        import core.database as database
        import core.models as models
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

        for s in rows:
            if _name_norm(s) == q_norm:
                return s
        for s in rows:
            if q_compact and _name_compact(s) == q_compact:
                return s
        candidates = [s for s in rows if q_norm and q_norm in _name_norm(s)]
        if len(candidates) == 1:
            return candidates[0]
        candidates = [s for s in rows if q_compact and q_compact in _name_compact(s)]
        if len(candidates) == 1:
            return candidates[0]
        return None
    finally:
        db.close()


async def try_scene_command(message: str, user_id: str) -> Optional[str]:
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
        import core.database as database
        from routers import scenes as scenes_module
    except Exception as exc:
        log_line("error", "⚠️", "SCENE_CMD", f"import failed: {exc}")
        return None

    db = database.SessionLocal()
    try:
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


# ── Regex fast-path (Tier 1) ──────────────────────────────────────────────

async def try_regex_command(message: str, user_id: str) -> Optional[str]:
    """Instant regex path: parse → resolve target → control_entity."""
    commands = _parse_regex_multi(message)
    if not commands:
        if message and _MULTI_TARGET_HINTS.search(message):
            log_line("ha", "↪️", "REGEX_CMD", "Deferring coordinated target to semantic parser")
        return None
    return await _execute_parsed_commands(commands, user_id)


# ── Semantic extraction (Tier 2) ──────────────────────────────────────────

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
  - "brightness": integer 0-255 (OPTIONAL)
  - "color_temp_kelvin": integer 2000-10000 (OPTIONAL)
- Use ONLY entity_ids from the list above. Never invent entity_ids.
- If no commands can be mapped to devices, return: []
- Reply with ONLY the JSON array. No markdown, no explanation."""


def _build_catalogue_from_store() -> str:
    store = get_entity_store()
    lines: list[str] = []
    for ent in store.get_all_entities():
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
    intel = settings_mod.CFG.get("intelligence") or {}
    aux = intel.get("aux_llm") or {}
    llm_cfg = settings_mod.CFG.get("llm") or {}
    url = (aux.get("target_url") or "").strip() or (llm_cfg.get("target_url") or "").strip()
    model = (aux.get("model_name") or "").strip() or (llm_cfg.get("model_name") or "").strip()
    api_key = (aux.get("api_key") or "").strip() or (llm_cfg.get("api_key") or "").strip()
    if not url or not model:
        return None
    url = url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions" if "/v1" in url else "/v1/chat/completions"
    return url, model, api_key


async def _llm_extract(message: str, catalogue: str) -> Optional[List[dict]]:
    cfg = _get_aux_llm_config()
    if not cfg:
        log_line("ha", "⚠️", "SEMANTIC", "No aux_llm configured — skipping semantic extraction")
        return None

    url, model, api_key = cfg
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SEMANTIC_SYSTEM.format(catalogue=catalogue)},
            {"role": "user", "content": message.strip()[:500] + " /no_think"},
        ],
        "temperature": 0.0,
        "max_tokens": 256,
        "stream": False,
    }

    start = time.monotonic()
    try:
        from brain.llm_client import get_llm_client

        client = await get_llm_client()
        resp = await client.post(url, json=payload, headers=headers, timeout=15.0)
        elapsed_ms = (time.monotonic() - start) * 1000
        if resp.status_code != 200:
            log_line("ha", "⚠️", "SEMANTIC", f"HTTP {resp.status_code} ({elapsed_ms:.0f}ms)")
            return None

        raw = (resp.json().get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()
        raw = re.sub(r"<think>.*", "", raw, flags=re.S).strip()
        if "```" in raw:
            raw = re.sub(r"```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```", "", raw).strip()

        bracket_start, bracket_end = raw.find("["), raw.rfind("]")
        if bracket_start == -1 or bracket_end == -1:
            return None
        cmds = json.loads(raw[bracket_start : bracket_end + 1])
        if not isinstance(cmds, list):
            return None

        valid: list[dict] = []
        for item in cmds:
            eid = (item.get("entity_id") or "").strip()
            action = (item.get("action") or "").strip()
            if not eid or action not in ("turn_on", "turn_off") or "." not in eid:
                continue
            entry: dict = {"entity_id": eid, "action": action}
            if item.get("brightness") is not None:
                try:
                    bri = max(0, min(255, int(item["brightness"])))
                    entry["brightness"] = bri
                    entry["action"] = "turn_off" if bri == 0 else "turn_on"
                except (ValueError, TypeError):
                    pass
            if item.get("color_temp_kelvin") is not None:
                try:
                    ct = int(item["color_temp_kelvin"])
                    if 1000 <= ct <= 10000:
                        entry["color_temp_kelvin"] = ct
                        entry["action"] = "turn_on"
                except (ValueError, TypeError):
                    pass
            valid.append(entry)

        log_line(
            "ha",
            "🧠",
            "SEMANTIC",
            f"{len(valid)} commands extracted ({elapsed_ms:.0f}ms)",
        )
        return valid
    except httpx.TimeoutException:
        log_line("ha", "⏳", "SEMANTIC", f"Timeout ({(time.monotonic() - start) * 1000:.0f}ms)")
        return None
    except Exception as exc:
        log_line("ha", "⚠️", "SEMANTIC", f"{type(exc).__name__}: {exc}")
        return None


async def try_semantic_commands(message: str, user_id: str) -> Optional[str]:
    """LLM extracts entity_ids from catalogue → control_entity."""
    catalogue = _build_catalogue_from_store()
    if not catalogue:
        return None

    commands = await _llm_extract(message, catalogue)
    if not commands:
        return None

    store = get_entity_store()
    by_id = {e.get("entity_id"): e for e in store.get_all_entities() if e.get("entity_id")}

    async def _control_one(cmd: dict) -> Optional[str]:
        eid = cmd["entity_id"]
        if eid not in by_id:
            log_line("ha", "⚠️", "SEMANTIC", f"LLM returned unknown entity_id: {eid}")
            return None
        ent = by_id[eid]
        data = {}
        if cmd.get("brightness") is not None:
            data["brightness"] = cmd["brightness"]
        if cmd.get("color_temp_kelvin") is not None:
            data["color_temp_kelvin"] = cmd["color_temp_kelvin"]
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or eid
        return await _run_control(eid, cmd["action"], data, name)

    results = await asyncio.gather(*[_control_one(c) for c in commands])
    replies = [r for r in results if r]
    return " ".join(replies) if replies else None
