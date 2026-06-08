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

def _resolve_user(db, user_id: str):
    """Resolve brain user_id (e.g. 'user_1') to a User row."""
    if user_id and user_id.startswith("user_"):
        try:
            numeric_id = int(user_id.split("_", 1)[1])
            return db.query(models.User).filter(models.User.id == numeric_id).first()
        except (ValueError, IndexError):
            pass
    return db.query(models.User).filter(models.User.username == user_id).first()


def _planner_get_or_create_list(db, uid: int, list_name: str) -> models.TodoList:
    normalized = (list_name or "Inbox").strip()[:128] or "Inbox"
    todo_list = db.query(models.TodoList).filter(
        models.TodoList.user_id == uid,
        models.TodoList.title == normalized,
        models.TodoList.archived.is_(False),
    ).first()
    if todo_list:
        return todo_list
    todo_list = models.TodoList(user_id=uid, title=normalized)
    db.add(todo_list)
    db.flush()
    return todo_list


async def _exec_planner_add_list(args: Dict, user_id: str) -> str:
    title = (args.get("title") or "").strip()
    if not title:
        return "Error: title is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        existing = db.query(models.TodoList).filter(
            models.TodoList.user_id == user.id,
            models.TodoList.title == title,
            models.TodoList.archived.is_(False),
        ).first()
        if existing:
            return f"List already exists: '{existing.title}' (id={existing.id})."

        row = models.TodoList(
            user_id=user.id,
            title=title[:128],
            color=((args.get("color") or "").strip()[:64] or None),
            icon=((args.get("icon") or "").strip()[:64] or None),
            archived=False,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return f"Created list '{row.title}' (id={row.id})."
    finally:
        db.close()


async def _exec_planner_list_lists(args: Dict, user_id: str) -> str:
    include_archived = bool(args.get("include_archived", False))
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if not include_archived:
            q = q.filter(models.TodoList.archived.is_(False))
        rows = q.order_by(models.TodoList.updated_at.desc()).all()
        if not rows:
            return "No planner lists found."

        lines = [f"- id={row.id} title='{row.title}'" + (" [archived]" if row.archived else "") for row in rows]
        return f"Found {len(rows)} list(s):\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_delete_list(args: Dict, user_id: str) -> str:
    list_id = args.get("list_id")
    list_name = (args.get("list_name") or "").strip()
    if list_id is None and not list_name:
        return "Error: provide list_id or list_name."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        q = db.query(models.TodoList).filter(models.TodoList.user_id == user.id)
        if list_id is not None:
            q = q.filter(models.TodoList.id == int(list_id))
        else:
            q = q.filter(models.TodoList.title == list_name)
        row = q.first()
        if not row:
            return "Error: list not found."

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted list '{title}' (id={row.id})."
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Smart Home tool implementations
# ---------------------------------------------------------------------------

