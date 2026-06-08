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

import automation_definitions
import database
import models
import settings as settings_mod
from logger import log_line, log_detail
from memory_context import get_memory_context
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

def _automation_owner_id(user_id: str) -> str:
    return str(user_id or "user_1")


def _automation_actor(user_id: str) -> str:
    return f"assistant:{user_id or 'unknown'}"



async def _exec_validate_automation_yaml(args: Dict) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    try:
        normalized = automation_definitions.validate_source_yaml(source_yaml)
    except automation_definitions.AutomationValidationError as exc:
        return f"Invalid automation YAML: {exc}"
    return (
        f"Valid automation YAML: id='{normalized['id']}', title='{normalized['title']}', "
        f"triggers={json.dumps(normalized.get('trigger') or [], ensure_ascii=False)}, "
        f"actions={json.dumps(normalized.get('action') or [], ensure_ascii=False)}"
    )


async def _exec_list_automation_definitions(user_id: str) -> str:
    db = database.SessionLocal()
    try:
        items = automation_definitions.list_definitions(db, _automation_owner_id(user_id))
        if not items:
            return "No automation definitions found."
        lines = []
        for index, item in enumerate(items, 1):
            serialized = automation_definitions.serialize_definition(item)
            next_run = serialized.get("next_runs") or []
            next_text = next_run[0].get("next_run_at") if next_run else "none"
            lines.append(
                f"{index}. [AutomationDefinition] {serialized['title']} — id: {serialized['id']}, revision: {serialized['revision']}, "
                f"enabled: {serialized['enabled']}, next_run: {next_text}, yaml: {serialized['yaml_path']}"
            )
        return "\n".join(lines)
    finally:
        db.close()


async def _exec_get_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        serialized = automation_definitions.serialize_definition(item)
        return json.dumps(serialized, ensure_ascii=False)
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_create_automation_definition(args: Dict, user_id: str) -> str:
    source_yaml = (args.get("source_yaml") or "").strip()
    if not source_yaml:
        return "Error: source_yaml is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.create_definition(
            db,
            owner_id=_automation_owner_id(user_id),
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
        )
        serialized = automation_definitions.serialize_definition(item)
        return f"Created automation definition '{serialized['id']}' revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_update_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    source_yaml = (args.get("source_yaml") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or not source_yaml or expected_revision is None:
        return "Error: automation_id, source_yaml, and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.replace_definition(
            db,
            item,
            actor=_automation_actor(user_id),
            source_yaml=source_yaml,
            expected_revision=int(expected_revision),
        )
        serialized = automation_definitions.serialize_definition(updated)
        return f"Updated automation definition '{serialized['id']}' to revision={serialized['revision']} yaml='{serialized['yaml_path']}'"
    except automation_definitions.AutomationValidationError as exc:
        return f"Error: {exc}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_enable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, True)


async def _exec_disable_automation_definition(args: Dict, user_id: str) -> str:
    return await _exec_toggle_automation_definition(args, user_id, False)


async def _exec_toggle_automation_definition(args: Dict, user_id: str, enabled: bool) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    expected_revision = args.get("expected_revision")
    if not automation_id or expected_revision is None:
        return "Error: automation_id and expected_revision are required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        updated = automation_definitions.set_enabled(db, item, _automation_actor(user_id), enabled, int(expected_revision))
        serialized = automation_definitions.serialize_definition(updated)
        return f"Automation definition '{serialized['id']}' enabled={serialized['enabled']} revision={serialized['revision']}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_delete_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        automation_definitions.delete_definition(db, item)
        return f"Deleted automation definition '{automation_id}'."
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


async def _exec_run_automation_definition(args: Dict, user_id: str) -> str:
    automation_id = (args.get("automation_id") or "").strip()
    if not automation_id:
        return "Error: automation_id is required."
    db = database.SessionLocal()
    try:
        item = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        await asyncio.to_thread(automation_definitions.execute_automation_definition, item.id, "manual")
        refreshed = automation_definitions.get_definition_for_owner(db, automation_id, _automation_owner_id(user_id))
        history = automation_definitions.list_history(db, refreshed, limit=1)
        return f"Ran automation definition '{automation_id}'. Last run: {json.dumps(history[0] if history else {}, ensure_ascii=False)}"
    except HTTPException as exc:
        return f"Error: {exc.detail}"
    finally:
        db.close()


