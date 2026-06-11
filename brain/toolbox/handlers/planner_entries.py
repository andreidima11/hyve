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
from brain.toolbox.handlers.planner_lists import _planner_get_or_create_list, _resolve_user
from brain.toolbox.state import _lazy_history_store

async def _exec_planner_add_entry(args: Dict, user_id: str) -> str:
    items = args.get("items") or []
    if not isinstance(items, list) or not items:
        return "Error: 'items' must be a non-empty array."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        created = []
        for item in items[:10]:
            entry_type = (item.get("entry_type") or "task").strip().lower()
            if entry_type not in ("task", "event"):
                entry_type = "task"
            title = (item.get("title") or "").strip()
            if not title:
                continue

            # Resolve list
            list_name = (item.get("list_name") or "Inbox").strip()[:128]
            todo_list = _planner_get_or_create_list(db, uid, list_name)

            from sqlalchemy import func as sa_func
            max_pos = db.query(sa_func.max(models.Entry.position)).filter(
                models.Entry.user_id == uid,
                models.Entry.list_id == todo_list.id,
            ).scalar()
            next_pos = int(max_pos or 0) + 1

            due_at = _planner_parse_dt(item.get("due_at"))
            start_at = _planner_parse_dt(item.get("start_at"))
            end_at = _planner_parse_dt(item.get("end_at"))
            priority = None
            if item.get("priority") is not None:
                try:
                    p = int(item["priority"])
                    if 1 <= p <= 5:
                        priority = p
                except (TypeError, ValueError):
                    pass

            row = models.Entry(
                user_id=uid,
                list_id=todo_list.id,
                entry_type=entry_type,
                title=title[:200],
                content=(item.get("content") or "")[:5000] or None,
                status="active",
                task_status="todo" if entry_type == "task" else None,
                priority=priority if entry_type == "task" else None,
                due_at=due_at if entry_type == "task" else None,
                start_at=start_at if entry_type == "event" else None,
                end_at=end_at if entry_type == "event" else None,
                all_day=item.get("all_day") if entry_type == "event" else None,
                location=(item.get("location") or "")[:200] or None if entry_type == "event" else None,
                position=next_pos,
            )
            db.add(row)
            db.flush()

            # Sync scheduler jobs for events (notifications + actions)
            if entry_type == "event":
                try:
                    from routers.entries import _sync_event_jobs
                    _sync_event_jobs(row, user)
                except Exception:
                    pass

            created.append(f"- [{entry_type}] {title} (id={row.id}, list='{todo_list.title}')")

        db.commit()
        if not created:
            return "No valid items to create. Each item must have a title."
        return f"Created {len(created)} planner entry(ies):\n" + "\n".join(created)
    finally:
        db.close()


async def _exec_planner_update_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
            models.Entry.status == "active",
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."

        changed = []

        if "title" in args:
            title = (args.get("title") or "").strip()
            if not title:
                return "Error: title cannot be empty."
            row.title = title[:200]
            changed.append("title")

        if "content" in args:
            content = (args.get("content") or "").strip()
            row.content = content[:5000] if content else None
            changed.append("content")

        if "list_name" in args:
            target_list = _planner_get_or_create_list(db, user.id, (args.get("list_name") or "Inbox"))
            row.list_id = target_list.id
            changed.append("list")

        if row.entry_type == "task":
            if "due_at" in args:
                due_raw = args.get("due_at")
                if due_raw in (None, ""):
                    row.due_at = None
                else:
                    due_at = _planner_parse_dt(due_raw)
                    if due_at is None:
                        return "Error: due_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    row.due_at = due_at
                changed.append("due_at")

            if "priority" in args:
                priority_raw = args.get("priority")
                if priority_raw in (None, ""):
                    row.priority = None
                else:
                    try:
                        priority = int(priority_raw)
                    except (ValueError, TypeError):
                        return "Error: priority must be an integer 1-5."
                    if priority < 1 or priority > 5:
                        return "Error: priority must be between 1 and 5."
                    row.priority = priority
                changed.append("priority")

            if "task_status" in args:
                task_status = (args.get("task_status") or "").strip().lower()
                if task_status not in {"todo", "in_progress", "done"}:
                    return "Error: task_status must be todo, in_progress, or done."
                row.task_status = task_status
                row.completed_at = datetime.now() if task_status == "done" else None
                changed.append("task_status")
        else:
            next_start = row.start_at
            next_end = row.end_at

            if "start_at" in args:
                start_raw = args.get("start_at")
                if start_raw in (None, ""):
                    next_start = None
                else:
                    parsed = _planner_parse_dt(start_raw)
                    if parsed is None:
                        return "Error: start_at must be ISO datetime (e.g. 2026-03-25T17:00)."
                    next_start = parsed
                changed.append("start_at")

            if "end_at" in args:
                end_raw = args.get("end_at")
                if end_raw in (None, ""):
                    next_end = None
                else:
                    parsed = _planner_parse_dt(end_raw)
                    if parsed is None:
                        return "Error: end_at must be ISO datetime (e.g. 2026-03-25T18:00)."
                    next_end = parsed
                changed.append("end_at")

            if next_start and next_end and next_end <= next_start:
                return "Error: end_at must be after start_at."

            row.start_at = next_start
            row.end_at = next_end

            if "all_day" in args:
                row.all_day = bool(args.get("all_day"))
                changed.append("all_day")

            if "location" in args:
                location = (args.get("location") or "").strip()
                row.location = location[:200] if location else None
                changed.append("location")

            if "event_color" in args:
                color = (args.get("event_color") or "").strip()
                row.event_color = color[:32] if color else None
                changed.append("event_color")

        if not changed:
            return f"No changes requested for entry {row.id}."

        db.commit()
        return f"Updated entry '{row.title}' (id={row.id}): {', '.join(changed)}."
    finally:
        db.close()


async def _exec_planner_list_entries(args: Dict, user_id: str) -> str:
    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."
        uid = user.id

        q = db.query(models.Entry).filter(
            models.Entry.user_id == uid,
            models.Entry.status == "active",
        )

        entry_type = (args.get("entry_type") or "").strip().lower()
        if entry_type in ("task", "event"):
            q = q.filter(models.Entry.entry_type == entry_type)

        status_filter = (args.get("status") or "all").strip().lower()
        if status_filter == "open":
            q = q.filter(
                (models.Entry.entry_type != "task") |
                (models.Entry.task_status != "done")
            )
        elif status_filter == "done":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status == "done",
            )

        view = (args.get("view") or "all").strip().lower()
        now = datetime.now()
        if view == "today":
            start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
            q = q.filter(
                (models.Entry.due_at.between(start, end)) |
                (models.Entry.start_at.between(start, end))
            )
        elif view == "upcoming":
            q = q.filter(
                (models.Entry.due_at > now) | (models.Entry.start_at > now)
            )
        elif view == "overdue":
            q = q.filter(
                models.Entry.entry_type == "task",
                models.Entry.task_status != "done",
                models.Entry.due_at < now,
            )

        list_name = (args.get("list_name") or "").strip()
        if list_name:
            todo_list = db.query(models.TodoList).filter(
                models.TodoList.user_id == uid,
                models.TodoList.title == list_name,
            ).first()
            if todo_list:
                q = q.filter(models.Entry.list_id == todo_list.id)
            else:
                return f"No list named '{list_name}' found."

        rows = q.order_by(
            models.Entry.due_at.asc().nulls_last(),
            models.Entry.start_at.asc().nulls_last(),
            models.Entry.position.asc(),
        ).limit(50).all()

        if not rows:
            return "No planner entries found matching your criteria."

        lines = []
        for r in rows:
            when = r.due_at or r.start_at
            when_str = when.strftime("%Y-%m-%d %H:%M") if when else ""
            status = ""
            if r.entry_type == "task":
                status = f" [{r.task_status or 'todo'}]"
                if r.priority:
                    status += f" P{r.priority}"
            lines.append(f"- id={r.id} [{r.entry_type}]{status} {r.title}{(' | ' + when_str) if when_str else ''}")

        return f"Found {len(rows)} entries:\n" + "\n".join(lines)
    finally:
        db.close()


async def _exec_planner_complete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    if entry_id is None:
        return "Error: entry_id is required."
    done = args.get("done", True)

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = db.query(models.Entry).filter(
            models.Entry.id == int(entry_id),
            models.Entry.user_id == user.id,
        ).first()
        if not row:
            return f"Error: entry {entry_id} not found."
        if row.entry_type != "task":
            return f"Entry {entry_id} is a {row.entry_type}, not a task. Only tasks can be marked done."

        row.task_status = "done" if done else "todo"
        if done:
            row.completed_at = datetime.now()
        else:
            row.completed_at = None
        db.commit()
        return f"Task '{row.title}' (id={row.id}) marked as {'done' if done else 'todo'}."
    finally:
        db.close()


async def _exec_planner_delete_entry(args: Dict, user_id: str) -> str:
    entry_id = args.get("entry_id")
    entry_type = (args.get("entry_type") or "").strip().lower()
    title_contains = (args.get("title_contains") or "").strip().lower()
    date_str = (args.get("date") or "").strip()
    time_hm = (args.get("time_hm") or "").strip()

    db = next(database.get_db())
    try:
        user = _resolve_user(db, user_id)
        if not user:
            return f"Error: user '{user_id}' not found."

        row = None
        if entry_id is not None:
            row = db.query(models.Entry).filter(
                models.Entry.id == int(entry_id),
                models.Entry.user_id == user.id,
            ).first()
            if not row:
                return f"Error: entry {entry_id} not found."
        else:
            q = db.query(models.Entry).filter(
                models.Entry.user_id == user.id,
                models.Entry.status == "active",
            )
            if entry_type in ("task", "event"):
                q = q.filter(models.Entry.entry_type == entry_type)

            candidates = q.all()
            if title_contains:
                candidates = [c for c in candidates if title_contains in (c.title or "").lower()]
            if date_str:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%Y-%m-%d") == date_str)
                ]
            if time_hm:
                candidates = [
                    c for c in candidates
                    if ((c.start_at or c.due_at) and (c.start_at or c.due_at).strftime("%H:%M") == time_hm)
                ]

            if not candidates:
                return "Error: no matching entry found for delete filters."
            if len(candidates) > 1:
                preview = "\n".join(
                    f"- id={c.id} [{c.entry_type}] {c.title}"
                    + (f" | {(c.start_at or c.due_at).strftime('%Y-%m-%d %H:%M')}" if (c.start_at or c.due_at) else "")
                    for c in candidates[:5]
                )
                return "Multiple entries match. Please specify entry_id.\n" + preview
            row = candidates[0]

        title = row.title
        db.delete(row)
        db.commit()
        return f"Deleted entry '{title}' (id={row.id})."
    finally:
        db.close()


def _planner_parse_dt(value) -> Optional[datetime]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None

