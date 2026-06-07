"""Slash commands from the web chat input (/help, /restart, etc.)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import brain
import database
import models
import settings
import storage
from core.log_stream import console, log_line
from routers.system import get_health

router = APIRouter(tags=["slash"])

class SlashRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=200)
    session_id: Optional[str] = Field(None, max_length=128)

SLASH_COMMANDS = {
    "/restart":  {"desc": "Restart the server",              "admin": True},
    "/stop":     {"desc": "Stop the server",                 "admin": True},
    "/clear":    {"desc": "Clear current session context",   "admin": False},
    "/new":      {"desc": "Start a new chat session",        "admin": False},
    "/version":  {"desc": "Show app version",                "admin": False},
    "/status":   {"desc": "Show system health summary",      "admin": False},
    "/compact":  {"desc": "Summarize session context (optional: /compact <topic>)",  "admin": False},
    "/persona":  {"desc": "Switch AI persona (usage: /persona <name> or /persona list)", "admin": False},
    "/help":     {"desc": "List available slash commands",    "admin": False},
}

@router.get("/api/slash/commands")
async def list_slash_commands(current_user: models.User = Depends(auth.get_current_user)):
    """Return the list of available slash commands for autocomplete."""
    is_admin = getattr(current_user, "is_admin", False)
    cmds = []
    for cmd, meta in SLASH_COMMANDS.items():
        if meta["admin"] and not is_admin:
            continue
        cmds.append({"command": cmd, "description": meta["desc"], "admin": meta["admin"]})
    return cmds

@router.post("/api/slash")
async def execute_slash_command(
    req: SlashRequest,
    request: Request,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(database.get_db),
):
    """Execute a slash command issued from the chat input."""
    raw = req.command.strip()
    parts = raw.split(None, 1)
    cmd = parts[0].lower() if parts else ""
    is_admin = getattr(current_user, "is_admin", False)

    if cmd not in SLASH_COMMANDS:
        return JSONResponse(content={"ok": False, "message": f"Unknown command: `{cmd}`\nType /help for a list of commands."})

    meta = SLASH_COMMANDS[cmd]
    if meta["admin"] and not is_admin:
        return JSONResponse(status_code=403, content={"ok": False, "message": "🔒 Admin access required."})

    # ── /help ────────────────────────────────────────────────────
    if cmd == "/help":
        lines = ["**Available commands:**\n"]
        for c, m in SLASH_COMMANDS.items():
            if m["admin"] and not is_admin:
                continue
            tag = " 🔒" if m["admin"] else ""
            lines.append(f"`{c}` — {m['desc']}{tag}")
        return {"ok": True, "message": "\n".join(lines)}

    # ── /version ─────────────────────────────────────────────────
    if cmd == "/version":
        return {"ok": True, "message": f"**Hyve** v{settings.APP_VERSION}"}

    # ── /status ──────────────────────────────────────────────────
    if cmd == "/status":
        health = (await get_health(request, db)).body
        h = json.loads(health)
        parts_out = [
            f"**System status:** {'✅ OK' if h.get('status') == 'ok' else '⚠️ Degraded'}",
            f"Database: {'✅' if h.get('db') else '❌'}",
            f"Memory (Chroma): {h.get('chroma', '?')}",
            f"Scheduler: {h.get('scheduler', '?')}",
            f"LLM: {h.get('llm', {}).get('model_name') or 'not configured'}",
        ]
        return {"ok": True, "message": "\n".join(parts_out)}

    # ── /clear ───────────────────────────────────────────────────
    if cmd == "/clear":
        return {"ok": True, "message": "🧹 Context cleared.", "action": "clear_context"}

    # ── /new ─────────────────────────────────────────────────────
    if cmd == "/new":
        return {"ok": True, "message": "📂 New session started.", "action": "new_session"}

    # ── /restart ─────────────────────────────────────────────────
    if cmd == "/restart":
        async def _do_restart():
            await asyncio.sleep(0.5)
            console.print("")
            console.rule("[bold red]SYSTEM RESTART[/]")
            log_line("error", "🔄", "COMMAND", f"Restart via /restart by {current_user.username}")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        asyncio.get_event_loop().call_later(0.5, lambda: asyncio.ensure_future(_do_restart()))
        return {"ok": True, "message": "🔄 Restarting server…", "action": "restart"}

    # ── /stop ────────────────────────────────────────────────────
    if cmd == "/stop":
        import signal
        async def _do_stop():
            await asyncio.sleep(0.5)
            console.print("")
            console.rule("[bold red]SERVER STOP[/]")
            log_line("error", "🛑", "COMMAND", f"Stop via /stop by {current_user.username}")
            os.kill(os.getpid(), signal.SIGTERM)
        asyncio.get_event_loop().call_later(0.5, lambda: asyncio.ensure_future(_do_stop()))
        return {"ok": True, "message": "🛑 Server shutting down…", "action": "stop"}

    # ── /compact [topic] ─────────────────────────────────────────
    if cmd == "/compact":
        topic_hint = parts[1].strip() if len(parts) > 1 else ""
        sid = req.session_id
        if not sid:
            return {"ok": True, "message": "⚠️ No active session to compact."}
        session = storage.get_session(sid)
        if not session or not session.get("messages"):
            return {"ok": True, "message": "⚠️ Session is empty — nothing to compact."}
        msgs = session["messages"]
        summary = await brain.summarize_conversation(msgs)
        if topic_hint:
            summary = f"[Focus: {topic_hint}] {summary}"
        if summary:
            session["summary"] = summary
            storage.save_session(sid, session)
            return {"ok": True, "message": f"📋 **Session compacted.**\n\n{summary}"}
        return {"ok": True, "message": "⚠️ Could not generate summary. Try again later."}

    # ── /persona [name|list] ─────────────────────────────────────
    if cmd == "/persona":
        arg = parts[1].strip().lower() if len(parts) > 1 else ""
        personas = settings.CFG.get("personas") or {}
        if not personas:
            return {"ok": True, "message": "No personas configured. Add `personas` to config.json.\n\nExample:\n```json\n\"personas\": {\n  \"casual\": { \"label\": \"Casual\", \"system_note\": \"Be relaxed and friendly.\" },\n  \"formal\": { \"label\": \"Formal\", \"system_note\": \"Be professional and concise.\" }\n}\n```"}
        if not arg or arg == "list":
            active = settings.CFG.get("active_persona") or "default"
            lines = ["**Available personas:**\n"]
            lines.append(f"`default` — Default persona {'✅' if active == 'default' else ''}")
            for k, v in personas.items():
                label = v.get("label", k)
                marker = " ✅" if active == k else ""
                lines.append(f"`{k}` — {label}{marker}")
            lines.append(f"\nUsage: `/persona <name>` to switch.")
            return {"ok": True, "message": "\n".join(lines)}
        if arg == "default":
            settings.save_config({"active_persona": "default"})
            return {"ok": True, "message": "🎭 Switched to **default** persona."}
        if arg not in personas:
            return {"ok": True, "message": f"❌ Unknown persona `{arg}`. Use `/persona list` to see available options."}
        settings.save_config({"active_persona": arg})
        label = personas[arg].get("label", arg)
        return {"ok": True, "message": f"🎭 Switched to **{label}** persona."}

    return JSONResponse(content={"ok": False, "message": f"Command `{cmd}` not implemented yet."})
