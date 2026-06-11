"""
Auto-introspected "What can the Hyve app do" manifest + a topic-keyed help
function the chat assistant can call on demand (`get_app_help` tool).

Goal: keep the chat aware of the application without hardcoding long blocks
in the system prompt. The data is derived from already-existing registries
(ui_catalog, theme JSON descriptors, FastAPI routes, automation_definitions)
so when a new integration / card / theme is added, the assistant learns about
it automatically — no prompt edit required.

Public API:
    get_capabilities_manifest()  -> dict  (cached, full machine-readable view)
    get_app_help(topic: str)     -> str   (concise prose for the LLM)
    get_system_status(query: str, **filters) -> str  (live system snapshot for the agent)
    list_help_topics()           -> list[str]
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_THEMES_DIR = _PROJECT_ROOT / "static" / "css" / "themes"
_AUTOMATION_DEFS_PATH = _PROJECT_ROOT / "automation_definitions.py"

_CACHE: dict[str, Any] = {"manifest": None, "built_at": 0.0}
_CACHE_TTL_SECONDS = 60.0  # cheap rebuild; integrations/themes don't change every second


# ---------------------------------------------------------------------------
# Introspection sources
# ---------------------------------------------------------------------------

def _discover_themes() -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not _THEMES_DIR.exists():
        return out
    for json_path in sorted(_THEMES_DIR.glob("*.json")):
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        theme_id = str(data.get("id") or json_path.stem).strip()
        if not theme_id:
            continue
        out.append({
            "id": theme_id,
            "name": str(data.get("name") or theme_id.title()).strip(),
            "description": str(data.get("description") or "").strip(),
        })
    return out


def _discover_cards() -> list[dict[str, str]]:
    try:
        from core.ui_catalog import dashboard_card_catalog
    except Exception:
        return []
    cards: list[dict[str, str]] = []
    for entry in dashboard_card_catalog() or []:
        if not isinstance(entry, dict):
            continue
        if not entry.get("show_in_picker", True):
            continue
        cards.append({
            "id": str(entry.get("id") or ""),
            "label": str(entry.get("label") or ""),
            "renderer": str(entry.get("renderer") or ""),
            "requires_entity": bool(entry.get("requires_entity")),
            "entity_filter": str(entry.get("entity_filter") or ""),
        })
    return cards


def _discover_integrations() -> list[dict[str, Any]]:
    try:
        from core.ui_catalog import integration_catalog
        import core.settings as settings_mod
    except Exception:
        return []
    cfg = settings_mod.CFG or {}
    out: list[dict[str, Any]] = []
    for entry in integration_catalog() or []:
        if not isinstance(entry, dict):
            continue
        config_key = entry.get("config_key") or entry.get("slug")
        provider_cfg = cfg.get(config_key) if isinstance(config_key, str) else None
        enabled = bool(isinstance(provider_cfg, dict) and provider_cfg.get("enabled"))
        out.append({
            "slug": entry.get("slug"),
            "label": entry.get("label"),
            "description": entry.get("description") or "",
            "enabled": enabled,
            "supports_sync": bool(entry.get("supports_sync")),
        })
    return out


def _discover_automation_triggers() -> list[str]:
    """Extract supported automation trigger platforms via regex on automation_definitions.py."""
    if not _AUTOMATION_DEFS_PATH.exists():
        return []
    try:
        text = _AUTOMATION_DEFS_PATH.read_text(encoding="utf-8")
    except Exception:
        return []
    found: list[str] = []
    seen: set[str] = set()
    # Pattern: platform == "name" or elif platform == "name"
    for match in re.finditer(r'platform\s*==\s*"([a-z_]+)"', text):
        name = match.group(1)
        if name and name not in seen:
            seen.add(name)
            found.append(name)
    return found


def _discover_route_areas() -> list[dict[str, str]]:
    """Group FastAPI routes by top-level prefix."""
    try:
        from core.http.app import get_hyve_app

        fastapi_app = get_hyve_app().app
    except Exception:
        return []
    prefixes: dict[str, int] = {}
    for route in getattr(fastapi_app, "routes", []) or []:
        path = getattr(route, "path", "") or ""
        if not path.startswith("/api/"):
            continue
        parts = path.split("/", 3)  # ['', 'api', '<area>', ...]
        if len(parts) >= 3 and parts[2]:
            area = parts[2]
            prefixes[area] = prefixes.get(area, 0) + 1
    return [
        {"area": area, "routes": str(count)}
        for area, count in sorted(prefixes.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def _discover_ui_map() -> dict[str, Any]:
    """Primary hash routes and common invalid paths (for navigation help)."""
    return {
        "routes": [
            {"id": "dashboard", "path": "#/dashboard", "label": "Dashboard"},
            {"id": "settings", "path": "#/settings", "label": "Settings"},
            {"id": "automations", "path": "#/automations", "label": "Automations"},
            {"id": "hub", "path": "#hub", "label": "Hub (gear)"},
        ],
        "invalid_paths": [
            "Settings > Dashboard",
            "Settings → Dashboard",
        ],
    }


def _discover_tools_enabled() -> dict[str, bool]:
    """Quick flags for capability gating: are the most-used optional tools available?"""
    try:
        import core.settings as settings_mod
    except Exception:
        return {}
    cfg = settings_mod.CFG or {}
    searxng = cfg.get("searxng") or {}
    intel = cfg.get("intelligence") or {}
    return {
        "web_search": bool(searxng.get("enabled") and searxng.get("url")),
        "lazy_history": bool(intel.get("lazy_history", True)),
        "shell": bool((cfg.get("shell") or {}).get("enabled")),
        "pago": bool((cfg.get("pago") or {}).get("enabled")),
    }


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def _build_manifest() -> dict[str, Any]:
    return {
        "themes": _discover_themes(),
        "cards": _discover_cards(),
        "integrations": _discover_integrations(),
        "automation_triggers": _discover_automation_triggers(),
        "api_areas": _discover_route_areas(),
        "ui": _discover_ui_map(),
        "tools_enabled": _discover_tools_enabled(),
    }


def get_capabilities_manifest(force_refresh: bool = False) -> dict[str, Any]:
    now = time.time()
    if force_refresh or _CACHE["manifest"] is None or (now - _CACHE["built_at"]) > _CACHE_TTL_SECONDS:
        _CACHE["manifest"] = _build_manifest()
        _CACHE["built_at"] = now
    return _CACHE["manifest"]


def invalidate_capabilities_cache() -> None:
    _CACHE["manifest"] = None
    _CACHE["built_at"] = 0.0


# ---------------------------------------------------------------------------
# Topic-keyed help (concise prose for the LLM)
# ---------------------------------------------------------------------------

# Static "where in the UI" notes — the only hand-written piece. Kept short.
# Each topic returns a 2-4 line snippet PLUS dynamic data from the manifest.
_TOPIC_HOWTO: dict[str, str] = {
    "theme": (
        "Theme — global: open the Hub (gear icon, top-right) → tap the \"Aspect\" card → "
        "pick a theme.\n"
        "Per dashboard page: enter dashboard edit mode (pencil), open \"Editează pagina\" "
        "and choose from the \"Temă\" dropdown. There is no theme switch in the chat or in "
        "the main #settings page."
    ),
    "dashboard": (
        "Dashboard (#dashboard): one or more pages, each with panels (containers) that hold "
        "cards (widgets bound to entities).\n"
        "Enter edit mode with the pencil icon. Add a page from the page selector; add a panel "
        "with the \"+\" button while editing; add cards from a panel's menu. Pull-to-refresh "
        "reloads data."
    ),
    "page": (
        "Dashboard pages: top-of-dashboard selector lets you switch and \"+ pagina nouă\" creates one. "
        "In edit mode, \"Editează pagina\" opens the page modal where you set title, subtitle, icon, "
        "columns, theme and parent page. Page id is derived from the title (slug); changing the title "
        "renames the id and cascades references."
    ),
    "card": (
        "Dashboard cards: while in edit mode, a panel's menu has \"Adaugă card\". Pick a card type, "
        "bind an entity (if the card needs one), set title/subtitle/icon and size. Cards re-render "
        "live from entity state."
    ),
    "automation": (
        "Automations (#automations): trigger → (conditions) → actions, defined in YAML. "
        "Create one from the \"+\" button. You also have tools (validate / create / update / list "
        "/ get / enable / disable / delete / run automation) — when the user asks you to build or "
        "change an automation, prefer the tools instead of just describing the UI."
    ),
    "integration": (
        "Integrations: open #settings → \"Integrări\". Each provider has a card; toggle it on and "
        "fill the auto-generated form (fields come from the provider's CONFIG_SCHEMA). Some "
        "providers expose a \"Sincronizează\" button."
    ),
    "settings": (
        "Settings (#settings): General (profil, locație, fus orar, persona, agent instructions), "
        "Integrări (providers, see integration topic), Derived Entities (senzori virtuali), Skills, "
        "Memorie, Notificări/FCM. Theme is NOT in #settings — it's in the Hub (see theme topic)."
    ),
    "planner": (
        "Planner: liste și intrări. Adăugare/marcare complet/ștergere rapidă. "
        "You also have planner tools (add_planner_list, add_planner_entry, complete_planner_entry, "
        "delete_planner_entry, …) — use them to act on behalf of the user."
    ),
    "memory": (
        "Memory: long-term facts about the user. Stored via the `store_memory` tool (call it when "
        "the user shares personal info), retrieved via `recall_memory`. Visible in #settings → "
        "Memorie."
    ),
    "skills": (
        "Skills: reusable capability modules in `skills/`. The user manages them in #settings → "
        "Skills. As the assistant you can invoke one via the `run_skill` tool when relevant."
    ),
    "derived": (
        "Derived entities: virtual sensors computed from other entities via expressions "
        "(sum, avg, min, max, formulas). Managed in #settings → \"Senzori virtuali\" / Derived Entities."
    ),
    "notifications": (
        "Notifications: configured in #settings → Notificări (FCM tokens for push, channels)."
    ),
    "navigation": (
        "Navigation in Hyve: main views use hash routes — Dashboard (#/dashboard), Settings (#/settings), "
        "Automations (#/automations), Hub (gear icon). **Settings > Dashboard** is not a real Hyve path; "
        "the dashboard is never nested under Settings. Use Dashboard (#/dashboard) for pages, panels, and widgets."
    ),
}

# Dotted / granular topics (not returned by _TOPIC_HOWTO keys alone).
_EXTENDED_TOPIC_HOWTO: dict[str, str] = {
    "dashboard.widgets.delete": (
        "Șterge widget (delete dashboard card):\n"
        "1. Open Dashboard (#/dashboard) and enter **edit mode** (pencil icon).\n"
        "2. On the card, use the **trash button** (or panel menu → remove).\n"
        "3. Frontend: `static/js/dashboard.js` → `removeDashboardWidget`.\n"
        "4. API: `DELETE /api/dashboard/widgets/{widget_id}` (requires auth)."
    ),
}

# Keyword routing for partial / freeform topics ("how do I change the colors" → "theme")
_TOPIC_ALIASES: dict[str, str] = {
    "theme": "theme", "tema": "theme", "temă": "theme", "color": "theme", "colors": "theme",
    "appearance": "theme", "aspect": "theme", "dark mode": "theme", "light mode": "theme",
    "dashboard": "dashboard", "tablou": "dashboard",
    "page": "page", "pagina": "page", "pagină": "page", "pages": "page",
    "card": "card", "carduri": "card", "widget": "card", "widgets": "card",
    "automation": "automation", "automatizare": "automation", "automations": "automation",
    "trigger": "automation", "scenariu": "automation",
    "integration": "integration", "integrare": "integration", "integrări": "integration",
    "integrations": "integration", "provider": "integration", "providers": "integration",
    "settings": "settings", "setari": "settings", "setări": "settings", "configurare": "settings",
    "planner": "planner", "lista": "planner", "task": "planner", "tasks": "planner",
    "memory": "memory", "memorie": "memory", "amintire": "memory", "remember": "memory",
    "skill": "skills", "skills": "skills",
    "derived": "derived", "virtual sensor": "derived", "senzor virtual": "derived",
    "notification": "notifications", "notificare": "notifications", "fcm": "notifications",
    "push": "notifications",
    "navigation": "navigation", "navigare": "navigation", "menu": "navigation",
    "delete widget": "dashboard.widgets.delete", "remove widget": "dashboard.widgets.delete",
    "remove card": "dashboard.widgets.delete", "remove dashboard card": "dashboard.widgets.delete",
    "șterg widget": "dashboard.widgets.delete", "sterge widget": "dashboard.widgets.delete",
}


def list_help_topics() -> list[str]:
    return sorted(set(_TOPIC_HOWTO.keys()) | set(_EXTENDED_TOPIC_HOWTO.keys()))


def _resolve_topic(raw: str) -> str | None:
    key = (raw or "").strip().lower()
    if not key:
        return None
    delete_markers = (
        "șterg un widget", "sterge un widget", "delete widget", "remove widget",
        "remove dashboard card", "remove card", "șterge widget", "sterge widget",
    )
    if any(marker in key for marker in delete_markers):
        return "dashboard.widgets.delete"
    if key in _EXTENDED_TOPIC_HOWTO:
        return key
    if key in _TOPIC_HOWTO:
        return key
    if key in _TOPIC_ALIASES:
        return _TOPIC_ALIASES[key]
    # Substring match against aliases (longest first to avoid 'page' eating 'pagination').
    for alias in sorted(_TOPIC_ALIASES.keys(), key=len, reverse=True):
        if alias in key:
            resolved = _TOPIC_ALIASES[alias]
            if resolved in _EXTENDED_TOPIC_HOWTO or resolved in _TOPIC_HOWTO:
                return resolved
    for topic in list(_EXTENDED_TOPIC_HOWTO.keys()) + list(_TOPIC_HOWTO.keys()):
        if topic in key:
            return topic
    return None


def _format_manifest_facts(topic: str, manifest: dict[str, Any]) -> str:
    """Append topic-relevant dynamic data (themes list, card list, etc.) to the static how-to."""
    lines: list[str] = []
    if topic == "theme":
        themes = manifest.get("themes") or []
        if themes:
            names = ", ".join(t.get("name") or t.get("id") or "?" for t in themes)
            lines.append(f"Available themes right now: {names}.")
    elif topic == "card":
        cards = manifest.get("cards") or []
        if cards:
            names = ", ".join(c.get("label") or c.get("id") or "?" for c in cards)
            lines.append(f"Card types available: {names}.")
    elif topic == "integration":
        integ = manifest.get("integrations") or []
        if integ:
            enabled = [i.get("label") or i.get("slug") for i in integ if i.get("enabled")]
            available = [i.get("label") or i.get("slug") for i in integ if not i.get("enabled")]
            if enabled:
                lines.append(f"Currently enabled: {', '.join(enabled)}.")
            if available:
                lines.append(f"Available to enable: {', '.join(available)}.")
    elif topic == "automation":
        triggers = manifest.get("automation_triggers") or []
        if triggers:
            lines.append(f"Supported trigger platforms: {', '.join(triggers)}.")
    elif topic == "settings":
        areas = manifest.get("api_areas") or []
        if areas:
            names = ", ".join(a.get("area") for a in areas if a.get("area"))
            lines.append(f"Backend API areas (for reference): {names}.")
    elif topic == "navigation":
        ui = manifest.get("ui") or {}
        invalid = ui.get("invalid_paths") or []
        if invalid:
            lines.append(f"Invalid paths (do not suggest): {', '.join(invalid)}.")
        routes = ui.get("routes") or []
        if routes:
            paths = ", ".join(f"{r.get('label')} ({r.get('path')})" for r in routes if r.get("path"))
            if paths:
                lines.append(f"Valid top-level routes: {paths}.")
    return "\n".join(lines)


def get_app_help(topic: str | None = None) -> str:
    """Return concise help for `topic`. If topic is missing/unknown, return the
    topic index (so the model knows what it can ask about)."""
    manifest = get_capabilities_manifest()
    raw = (topic or "").strip()
    resolved = _resolve_topic(raw)
    if not resolved:
        if not raw:
            topics = list_help_topics()
            themes = [t.get("name") for t in (manifest.get("themes") or []) if t.get("name")]
            integ = [i.get("label") for i in (manifest.get("integrations") or []) if i.get("label")]
            lines = [
                "Hyve app help index. Call get_app_help with one of these topics:",
                ", ".join(topics) + ".",
            ]
            if themes:
                lines.append(f"Installed themes: {', '.join(themes)}.")
            if integ:
                lines.append(f"Integrations registered: {', '.join(integ)}.")
            return "\n".join(lines)
        return (
            "UNKNOWN_TOPIC: No documented Hyve UI help for that request. "
            "Do not invent menu paths, billing screens, or settings that are not listed in list_help_topics(). "
            "Tell the user you cannot locate that feature in Hyve, or suggest a related topic from the index."
        )
    if resolved in _EXTENDED_TOPIC_HOWTO:
        return _EXTENDED_TOPIC_HOWTO[resolved].rstrip()
    base = _TOPIC_HOWTO[resolved]
    extras = _format_manifest_facts(resolved, manifest)
    return f"{base}\n{extras}".rstrip()


_SYSTEM_STATUS_QUERIES = frozenset({
    "overview",
    "integrations",
    "entities",
    "health",
    "dashboard",
    "automations",
    "automation_history",
    "scenes",
    "areas",
    "notifications",
    "addons",
    "integration_detail",
})


def get_system_status(query: str, **filters: Any) -> str:
    """Return a concise text snapshot of Hyve runtime state for agent tools."""
    mode = (query or "").strip().lower()
    if mode not in _SYSTEM_STATUS_QUERIES:
        sample = ", ".join(sorted(_SYSTEM_STATUS_QUERIES))
        return f"Unknown query '{query}'. Available queries include: {sample}. Try 'overview' first."

    if mode == "overview":
        return _status_overview()
    if mode == "integrations":
        return _status_integrations()
    if mode == "integration_detail":
        return _status_integration_detail(filters.get("slug"))
    if mode == "entities":
        return _status_entities(filters)
    if mode == "health":
        return _status_health()
    if mode == "dashboard":
        return _status_dashboard()
    if mode == "automations":
        return _status_automations()
    if mode == "automation_history":
        return _status_automation_history()
    if mode == "scenes":
        return _status_scenes()
    if mode == "areas":
        return _status_areas()
    if mode == "notifications":
        return _status_notifications()
    if mode == "addons":
        return _status_addons()
    return f"Unknown query '{query}'. Try 'overview'."


def _status_overview() -> str:
    manifest = get_capabilities_manifest()
    lines = ["Hyve system overview:"]
    integ = manifest.get("integrations") or []
    enabled = sum(1 for i in integ if i.get("enabled"))
    lines.append(f"- Integrations: {enabled} enabled / {len(integ)} registered")
    lines.append(f"- Themes: {len(manifest.get('themes') or [])}")
    lines.append(f"- Dashboard card types: {len(manifest.get('cards') or [])}")
    try:
        from addons.entity_store import get_entity_store
        count = len(get_entity_store().get_all_entities())
        lines.append(f"- Entities in store: {count}")
    except Exception:
        lines.append("- Entities in store: unavailable")
    try:
        import core.storage as storage
        mem = storage.get_collection_health()
        lines.append(f"- Memory (Chroma): {mem.get('status') or 'unknown'}")
    except Exception:
        lines.append("- Memory (Chroma): unavailable")
    return "\n".join(lines)


def _status_integrations() -> str:
    rows = _discover_integrations()
    if not rows:
        return "No integrations registered in the catalog."
    lines = [f"Integrations ({len(rows)}):"]
    for row in rows:
        flag = "enabled" if row.get("enabled") else "disabled"
        label = row.get("label") or row.get("slug") or "?"
        lines.append(f"  - {label} ({row.get('slug')}) [{flag}]")
    return "\n".join(lines)


def _status_integration_detail(slug: Any) -> str:
    key = (slug or "").strip().lower()
    if not key:
        return "Error: provide `slug` for integration_detail (e.g. slug='frigate')."
    rows = _discover_integrations()
    match = next((r for r in rows if str(r.get("slug") or "").lower() == key), None)
    if not match:
        return f"No integration catalog entry for slug '{slug}'."
    lines = [
        f"Integration: {match.get('label') or key}",
        f"Slug: {match.get('slug')}",
        f"Enabled: {bool(match.get('enabled'))}",
        f"Supports sync: {bool(match.get('supports_sync'))}",
    ]
    desc = (match.get("description") or "").strip()
    if desc:
        lines.append(f"Description: {desc}")
    try:
        from integrations import config_entries
        entries = config_entries.list_entries(key)
        lines.append(f"Config entries: {len(entries)}")
    except Exception:
        pass
    return "\n".join(lines)


def _status_entities(filters: dict[str, Any]) -> str:
    source = (filters.get("source") or "").strip()
    domain = (filters.get("domain") or "").strip().lower()
    limit = max(1, min(int(filters.get("limit") or 40), 200))
    try:
        from addons.entity_store import get_entity_store
        entities = get_entity_store().get_all_entities()
    except Exception:
        return "Entity store unavailable."
    if source:
        entities = [e for e in entities if str(e.get("source") or "") == source]
    if domain:
        entities = [
            e for e in entities
            if str(e.get("entity_id") or "").split(".", 1)[0].lower() == domain
        ]
    if not entities:
        if source:
            return f"No entities found for source '{source}'."
        return "No entities found in the entity store."
    lines = [f"Entities ({len(entities)} shown, limit {limit}):"]
    for ent in entities[:limit]:
        eid = ent.get("entity_id") or ent.get("unique_id") or "?"
        name = ent.get("name") or (ent.get("attributes") or {}).get("friendly_name") or eid
        state = ent.get("state") or "unknown"
        src = ent.get("source") or "?"
        lines.append(f"  - {name} ({eid}): {state} [{src}]")
    if len(entities) > limit:
        lines.append(f"  … and {len(entities) - limit} more")
    return "\n".join(lines)


def _status_health() -> str:
    lines = ["Hyve health:"]
    try:
        import core.storage as storage
        mem = storage.get_collection_health()
        lines.append(f"- Memory (Chroma): {mem.get('status') or 'unknown'} ({mem.get('mode') or '?'})")
        if mem.get("last_error"):
            lines.append(f"  last_error: {mem.get('last_error')}")
    except Exception as exc:
        lines.append(f"- Memory (Chroma): error ({exc})")
    try:
        import core.scheduler_service as scheduler_service
        running = scheduler_service.scheduler.running
        lines.append(f"- Scheduler: {'running' if running else 'stopped'}")
    except Exception:
        lines.append("- Scheduler: unknown")
    try:
        import core.settings as settings_mod
        llm = (settings_mod.CFG or {}).get("llm") or {}
        configured = bool(llm.get("target_url") and llm.get("model_name"))
        lines.append(f"- LLM configured: {configured}")
    except Exception:
        lines.append("- LLM configured: unknown")
    return "\n".join(lines)


def _status_dashboard() -> str:
    try:
        from core.dashboard_store import load_store
        store = load_store()
    except Exception as exc:
        return f"Dashboard store unavailable: {exc}"
    pages = store.get("pages") or []
    widget_count = 0
    for page in pages:
        if not isinstance(page, dict):
            continue
        for panel in page.get("panels") or []:
            if isinstance(panel, dict):
                widget_count += len(panel.get("widgets") or [])
    lines = [
        f"Dashboard: {len(pages)} page(s), {widget_count} widget(s).",
    ]
    for page in pages[:8]:
        if not isinstance(page, dict):
            continue
        title = page.get("title") or page.get("id") or "?"
        lines.append(f"  - {title} (id={page.get('id') or '?'})")
    if len(pages) > 8:
        lines.append(f"  … and {len(pages) - 8} more pages")
    return "\n".join(lines)


def _status_automations() -> str:
    try:
        import core.database as database
        import core.models as models
        db = next(database.get_db())
        try:
            rows = db.query(models.AutomationDefinition).order_by(models.AutomationDefinition.updated_at.desc()).limit(50).all()
        finally:
            db.close()
    except Exception as exc:
        return f"Automations unavailable: {exc}"
    if not rows:
        return "No automation definitions found."
    lines = [f"Automations ({len(rows)} shown):"]
    for row in rows:
        flag = "on" if getattr(row, "enabled", True) else "off"
        title = getattr(row, "title", None) or getattr(row, "id", "?")
        lines.append(f"  - {title} [{flag}] id={getattr(row, 'id', '?')}")
    return "\n".join(lines)


def _status_automation_history() -> str:
    try:
        import core.database as database
        import core.models as models
        db = next(database.get_db())
        try:
            runs = (
                db.query(models.AutomationRun)
                .order_by(models.AutomationRun.started_at.desc())
                .limit(15)
                .all()
            )
        finally:
            db.close()
    except Exception as exc:
        return f"Automation history unavailable: {exc}"
    if not runs:
        return "No automation run history recorded yet."
    lines = [f"Recent automation runs ({len(runs)}):"]
    for run in runs:
        started = run.started_at.isoformat() if getattr(run, "started_at", None) else "?"
        lines.append(
            f"  - {getattr(run, 'status', '?')} automation={getattr(run, 'automation_id', '?')} "
            f"trigger={getattr(run, 'trigger_source', '?')} at {started}"
        )
    return "\n".join(lines)


def _status_scenes() -> str:
    try:
        import core.database as database
        import core.models as models
        db = next(database.get_db())
        try:
            rows = db.query(models.Scene).order_by(models.Scene.updated_at.desc()).limit(40).all()
        finally:
            db.close()
    except Exception as exc:
        return f"Scenes unavailable: {exc}"
    if not rows:
        return "No scenes configured."
    lines = [f"Scenes ({len(rows)}):"]
    for row in rows:
        lines.append(f"  - {getattr(row, 'name', '?')} id={getattr(row, 'id', '?')}")
    return "\n".join(lines)


def _status_areas() -> str:
    try:
        import core.database as database
        import core.models as models
        db = next(database.get_db())
        try:
            rows = db.query(models.Area).order_by(models.Area.ordering, models.Area.name).limit(60).all()
        finally:
            db.close()
    except Exception as exc:
        return f"Areas unavailable: {exc}"
    if not rows:
        return "No areas defined."
    lines = [f"Areas ({len(rows)}):"]
    for row in rows:
        lines.append(f"  - {getattr(row, 'name', '?')} id={getattr(row, 'id', '?')}")
    return "\n".join(lines)


def _status_notifications() -> str:
    try:
        import core.settings as settings_mod
        cfg = settings_mod.CFG or {}
    except Exception:
        return "Notifications config unavailable."
    notif = cfg.get("notifications") or {}
    fcm = cfg.get("fcm") or {}
    lines = [
        "Notifications:",
        f"- Push (FCM) configured: {bool(fcm.get('enabled') or fcm.get('server_key') or fcm.get('project_id'))}",
        f"- Notification prefs in config: {bool(notif)}",
    ]
    try:
        import core.database as database
        import core.models as models
        db = next(database.get_db())
        try:
            token_count = db.query(models.PushDevice).count()
        finally:
            db.close()
        lines.append(f"- Registered push devices: {token_count}")
    except Exception:
        pass
    return "\n".join(lines)


def _status_addons() -> str:
    try:
        from addons.registry import list_all
        rows = list_all()
    except Exception as exc:
        return f"Add-ons unavailable: {exc}"
    if not rows:
        return "No add-ons in the catalog."
    lines = [f"Add-ons ({len(rows)}):"]
    for row in rows:
        slug = row.get("slug") or "?"
        installed = "installed" if row.get("installed") else "available"
        enabled = "on" if row.get("enabled") else "off"
        lines.append(f"  - {row.get('name') or slug} ({slug}) [{installed}, {enabled}]")
    return "\n".join(lines)
