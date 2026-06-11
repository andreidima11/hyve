from __future__ import annotations

import asyncio
import base64
import html
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx
import yaml
from fastapi import HTTPException

import core.automation_definitions as automation_definitions
import core.database as database
import core.models as models
import core.settings as settings_mod
from core.logger import log_line, log_detail
from brain.memory_context import get_memory_context
from brain.injection_guard import sanitize_untrusted_content
from brain.tool_shell import (
    exec_allow_shell,
    exec_run_script,
    exec_run_shell,
    exec_suggest_shell,
    get_last_shell_run,
    get_last_suggest_shell,
)
from brain.tool_workspace import (
    apply_proposal,
    exec_propose_file,
    exec_propose_patch,
    exec_read_file,
    get_last_proposal,
    project_root,
)
from brain.web_search import (
    _extract_by_selectors,
    _extract_relevant_paragraphs,
    _fetch_page_html,
    _fetch_page_text,
    _is_internal_url,
    _searxng_defaults,
    clear_last_search_sources,
    get_last_search_sources,
    searxng_search,
    searxng_search_images,
    set_last_search_sources,
)
from brain.toolbox.guardrails import _guard, _is_explicit_skill_request, _tool_guardrails_enabled
from brain.toolbox.state import _lazy_history_store

async def _exec_control_device(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    action = (args.get("action") or "").strip()
    data = args.get("data") if isinstance(args.get("data"), dict) else {}
    if not entity_id:
        return "Error: entity_id is required."
    if not action:
        return "Error: action is required (turn_on, turn_off, toggle, set)."

    from integrations import get_integration_manager
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    all_entities = store.get_all_entities()

    target_id = entity_id
    target_integration = None
    for ent in all_entities:
        if ent.get("entity_id") == entity_id or ent.get("unique_id") == entity_id:
            target_id = str(ent.get("unique_id") or entity_id)
            source = ent.get("source") or ""
            entry_id = ent.get("entry_id") or ""
            manager = get_integration_manager()
            if entry_id:
                target_integration = manager.get_by_entry(entry_id)
            if not target_integration and source:
                target_integration = manager.get(source)
            break

    if not target_integration:
        manager = get_integration_manager()
        for integration in manager.all():
            try:
                if hasattr(integration, "control_entity"):
                    target_integration = integration
                    break
            except Exception:
                continue
        if not target_integration:
            return f"Error: Could not find an integration that owns '{entity_id}'."

    try:
        result = await target_integration.control_entity(target_id, action, data)
        name = entity_id
        for ent in all_entities:
            if ent.get("entity_id") == entity_id:
                name = ent.get("name") or ent.get("attributes", {}).get("friendly_name") or entity_id
                break
        return f"OK: {action} on '{name}' ({entity_id}). Result: {result or 'success'}"
    except NotImplementedError:
        return f"Error: The integration does not support controlling '{entity_id}'."
    except Exception as exc:
        return f"Error controlling '{entity_id}': {type(exc).__name__}: {exc}"


_HOME_STATUS_MAX_ENTITIES = 40
_HOME_STATUS_MAX_CHARS = 2800


def _format_home_status_entry(e: Dict) -> str:
    extra = ""
    if "brightness" in e:
        extra += f", brightness={e['brightness']}"
    if "temperature" in e:
        extra += f", temp={e['temperature']}"
    if "current_temperature" in e:
        extra += f", current_temp={e['current_temperature']}"
    if "unit" in e:
        extra += f" {e['unit']}"
    return f"  - {e['name']} ({e['entity_id']}): {e['state']}{extra}"


async def _exec_get_home_status(args: Dict) -> str:
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    all_entities = store.get_all_entities()

    if not all_entities:
        return "No smart home devices found. Integrations may not be configured."

    by_area: Dict[str, list] = {}
    for ent in all_entities:
        area = ent.get("area") or ent.get("area_name") or "Unassigned"
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or ent.get("entity_id") or "?"
        state = ent.get("state") or "unknown"
        entry = {
            "entity_id": ent.get("entity_id") or ent.get("unique_id") or "?",
            "name": name,
            "state": state,
        }
        if attrs.get("brightness") is not None:
            entry["brightness"] = attrs["brightness"]
        if attrs.get("temperature") is not None:
            entry["temperature"] = attrs["temperature"]
        if attrs.get("current_temperature") is not None:
            entry["current_temperature"] = attrs["current_temperature"]
        if attrs.get("unit_of_measurement"):
            entry["unit"] = attrs["unit_of_measurement"]
        by_area.setdefault(area, []).append(entry)

    flat_entries = []
    for area in sorted(by_area.keys()):
        for e in sorted(by_area[area], key=lambda x: x["name"]):
            flat_entries.append((area, e))

    total = len(flat_entries)
    capped = flat_entries[:_HOME_STATUS_MAX_ENTITIES]
    lines = []
    current_area = None
    for area, e in capped:
        if area != current_area:
            lines.append(f"\n## {area}")
            current_area = area
        lines.append(_format_home_status_entry(e))

    omitted = total - len(capped)
    if omitted > 0:
        lines.append(
            f"\n... ({omitted} more entities omitted — use get_device_state(entity_id) for a specific device)"
        )

    header = f"Smart home status ({total} entities"
    if omitted > 0:
        header += f", showing {len(capped)}"
    header += "):"
    body = header + "\n" + "\n".join(lines)
    if len(body) > _HOME_STATUS_MAX_CHARS:
        body = body[:_HOME_STATUS_MAX_CHARS].rstrip() + "\n... (truncated — use get_device_state for details)"
    return body


async def _exec_get_device_state(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    if not entity_id:
        return "Error: entity_id is required."
    from addons.entity_store import get_entity_store

    store = get_entity_store()
    for ent in store.get_all_entities():
        eid = str(ent.get("entity_id") or ent.get("unique_id") or "")
        if eid != entity_id and ent.get("unique_id") != entity_id:
            continue
        attrs = ent.get("attributes") or {}
        name = ent.get("name") or attrs.get("friendly_name") or eid
        lines = [
            f"Entity: {name} ({eid})",
            f"State: {ent.get('state') or 'unknown'}",
            f"Domain: {eid.split('.', 1)[0] if '.' in eid else '?'}",
            f"Source: {ent.get('source') or '?'}",
        ]
        area = ent.get("area") or ent.get("area_name")
        if area:
            lines.append(f"Area: {area}")
        for key in ("brightness", "temperature", "current_temperature", "unit_of_measurement"):
            if attrs.get(key) is not None:
                lines.append(f"{key}: {attrs[key]}")
        return "\n".join(lines)
    return f"No entity found for '{entity_id}'."


async def _exec_get_entity_history(args: Dict) -> str:
    entity_id = (args.get("entity_id") or "").strip()
    hours = min(float(args.get("hours") or 24), 336)
    if not entity_id:
        return "Error: entity_id is required."

    from core.entity_history import get_history

    data = get_history(entity_id, hours=hours, max_points=60)
    if not data:
        return f"No history data found for '{entity_id}' in the last {hours:.0f} hours."

    values = [d["value"] for d in data if d.get("value") is not None]
    if not values:
        return f"No numeric values recorded for '{entity_id}' in the last {hours:.0f} hours."

    avg = sum(values) / len(values)
    mn, mx = min(values), max(values)
    latest = values[-1]

    lines = [
        f"History for '{entity_id}' (last {hours:.0f}h, {len(data)} samples):",
        f"  Current: {latest}",
        f"  Average: {avg:.2f}",
        f"  Min: {mn}, Max: {mx}",
        f"  Trend: {'rising' if len(values) > 2 and values[-1] > values[0] else 'falling' if len(values) > 2 and values[-1] < values[0] else 'stable'}",
        "",
        "Recent samples (newest first):",
    ]
    for d in reversed(data[-10:]):
        ts = d.get("ts") or ""
        lines.append(f"  {ts}: {d.get('value')}")

    return "\n".join(lines)


