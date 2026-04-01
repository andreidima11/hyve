"""Logging shared by brain, router, device_resolver, memory_context. Main can inject broadcast via set_logger.
Verbose mode (verbose_logging in config): log ABSOLUT TOT — request/response, intent, reminder steps, jobs.
Structured JSONL file sink — every log_line / log_detail call also writes a JSON line to logs/memini.jsonl."""
import time
import json
import os
import contextvars
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich import box

_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

# ── JSONL file sink ──────────────────────────────────────────────────
_JSONL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(_JSONL_DIR, exist_ok=True)
_JSONL_PATH = os.path.join(_JSONL_DIR, "memini.jsonl")
_jsonl_lock = threading.Lock()


def _write_jsonl(record: dict) -> None:
    """Append one JSON line to the structured log file (thread-safe)."""
    try:
        line = json.dumps(record, ensure_ascii=False, default=str)
        with _jsonl_lock:
            with open(_JSONL_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass  # never let file I/O crash the app


def _jsonl_record(level: str, scope: str, event: str, message: str = "", **extra) -> dict:
    """Build a structured JSONL record."""
    now = time.time()
    rec = {
        "ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        "epoch": round(now, 3),
        "level": level,
        "scope": scope,
        "event": event,
    }
    rid = _request_id_var.get(None)
    if rid:
        rec["request_id"] = rid
    if message:
        rec["message"] = message
    if extra:
        rec["extra"] = {k: v for k, v in extra.items() if v is not None}
    return rec


def set_request_id(request_id: str):
    return _request_id_var.set(request_id)


def reset_request_id(token):
    _request_id_var.reset(token)


def get_request_id() -> str | None:
    return _request_id_var.get()

console = Console()
_extra_log_fn = None

# Channel labels for conversations (where the user wrote from)
CHANNEL_LABELS = {
    "web": "Web interface",
    "whatsapp": "WhatsApp",
    "ha": "Home Assistant",
}

# Culori pentru toate tipurile de acțiuni (consola + broadcast)
STYLE_COLORS = {
    "mem": "magenta",
    "ai": "cyan",
    "router": "orange1",
    "reply": "medium_purple1",
    "error": "red",
    "dim": "white",
    "intent": "green",
    "ha": "deepsky_blue1",
    "job": "yellow",
    "sys": "dim white",
    "success": "bold green",
    "ha_head": "bold orange1",
    "user_head": "bold green",
    "mem_head": "bold hot_pink",
    "audit": "bright_black",
    "agent": "cyan",
    "web": "deepsky_blue1",
    "whatsapp": "green",
}

# Chei pe care nu le logăm niciodată (valorile sunt redactate)
REDACT_KEYS = frozenset({"password", "token", "secret", "api_key", "authorization", "cookie"})

# In non-verbose mode we suppress very chatty agent events.
_COMPACT_SUPPRESSED_AGENT_TITLES = {
    "THINKING",
    "TOOL CALL",
    "AGENT START",
    "AGENT DONE",
    "AGENT DONE (fallback)",
    "EMPTY RESPONSE",
    "TRIM",
    "PROMPT TRIM",
    "TOOL TRUNCATE",
    "SEARCH_LIMIT",
    "READ_PAGE_LIMIT",
}

_CHIP_BG = "#0f172a"
_CHIP_WIDTH = 20


def _chip(icon: str, title: str, color: str, width: int = _CHIP_WIDTH) -> Text:
    label = f"{icon} {title}".strip()
    if len(label) > width:
        label = label[: width - 1] + "…"
    t = Text(f" {label:<{width}} ")
    t.stylize(f"bold {color} on {_CHIP_BG}")
    return t


def get_time() -> str:
    return f"[{time.strftime('%H:%M:%S')}]"


def get_time_ms() -> str:
    """Timestamp cu milisecunde pentru audit detaliat. Același format cu paranteze ca get_time()."""
    t = time.time()
    ms = int((t % 1) * 1000)
    s = time.strftime(f"%H:%M:%S.{ms:03d}", time.localtime(t))
    return f"[{s}]"


def _is_verbose() -> bool:
    """Citește verbose_logging din config (lazy import ca să evite circular import)."""
    try:
        import settings as _s
        return bool(_s.CFG.get("verbose_logging"))
    except Exception:
        return False


def _safe_value(k: str, v: Any) -> Any:
    if k.lower() in REDACT_KEYS or "token" in k.lower() or "secret" in k.lower():
        return "[REDACTED]"
    if isinstance(v, str) and len(v) > 500:
        return v[:500] + "..."
    return v


def _safe_payload(**kwargs: Any) -> str:
    """Serializează kwargs pentru log; redactează chei sensibile."""
    out = {}
    for k, v in kwargs.items():
        if v is None:
            continue
        out[k] = _safe_value(k, v)
    try:
        return json.dumps(out, ensure_ascii=False, default=str)
    except Exception:
        return str(out)


def set_logger(fn):
    """Set an extra callback (e.g. broadcast to UI). Called after console print."""
    global _extra_log_fn
    _extra_log_fn = fn


def log_line(style: str, icon: str, title: str, message: str = ""):
    """Log o acțiune în consolă și opțional în UI. style = cheie din STYLE_COLORS."""
    if not _is_verbose() and style == "agent" and title in _COMPACT_SUPPRESSED_AGENT_TITLES:
        return
    col = STYLE_COLORS.get(style, "white")
    ts = get_time_ms() if _is_verbose() else get_time()
    msg = (message or "")
    if not _is_verbose() and len(msg) > 180:
        msg = msg[:177] + "..."
    line = Text()
    line.append(f"{ts} ", style="bold bright_black")
    line.append_text(_chip(icon, title, col))
    if msg:
        line.append(f" {msg}", style="white")
    console.print(line)
    # JSONL file sink
    _write_jsonl(_jsonl_record("info", style, title, message))
    if _extra_log_fn:
        try:
            _extra_log_fn(style, icon, title, msg)
        except Exception:
            pass


def log_conversation_start(channel: str, user_id: str, message: str, has_image: bool = False) -> None:
    """Log conversation start: channel, who, what they wrote."""
    canal = CHANNEL_LABELS.get(channel, channel)
    preview = (message or "").strip()
    if has_image and not preview:
        preview = "[image]"
    elif len(preview) > 280:
        preview = preview[:277] + "..."
    ts = get_time_ms() if _is_verbose() else get_time()
    console.print(Panel.fit(
        Text.assemble(("💬  Conversation", "bold cyan"), (f"  ·  {canal}", "dim")),
        border_style="bright_cyan",
        box=box.ROUNDED,
        padding=(0, 1),
    ))
    line = Text()
    line.append(f"{ts} ", style="bold bright_black")
    line.append_text(_chip("👤", "USER", "green"))
    line.append(f" ({user_id}) {preview}", style="white")
    console.print(line)
    if _extra_log_fn:
        try:
            _extra_log_fn("user_head", "💬", "CONVERSATION", f"{canal} | {user_id} | {preview[:150]}")
        except Exception:
            pass
    _write_jsonl(_jsonl_record("info", "conversation", "START", channel=canal, user_id=user_id, has_image=has_image))


def log_conversation_model_activity(activity: str, detail: str = "") -> None:
    """Log what the model is doing: thinking, calling tool, etc."""
    if not _is_verbose() and activity in {"working", "calls"}:
        return
    ts = get_time_ms() if _is_verbose() else get_time()
    compact_detail = detail or ""
    if not _is_verbose() and len(compact_detail) > 120:
        compact_detail = compact_detail[:117] + "..."
    line = Text()
    line.append(f"{ts} ", style="bold bright_black")
    line.append_text(_chip("🤖", f"MODEL {activity.upper()}", "cyan"))
    if compact_detail:
        line.append(f" {compact_detail}", style="white")
    console.print(line)
    if _extra_log_fn:
        try:
            _extra_log_fn("agent", "🤖", activity, compact_detail[:200])
        except Exception:
            pass


def log_conversation_reply(reply: str, turns: int = 0, profile_name: Optional[str] = None) -> None:
    """Log the model's final reply. If profile_name is set, show which model/profile produced it."""
    ts = get_time_ms() if _is_verbose() else get_time()
    preview = (reply or "").strip()
    if len(preview) > 320:
        preview = preview[:317] + "..."
    line = Text()
    line.append(f"{ts} ", style="bold bright_black")
    title = "REPLY" + (f" x{turns}" if turns else "")
    if profile_name:
        title += f" · {profile_name}"
    line.append_text(_chip("✅", title, "medium_purple1"))
    line.append(f" {preview}", style="white")
    console.print(line)
    if _extra_log_fn:
        try:
            _extra_log_fn("reply", "✅", "REPLY", preview[:150])
        except Exception:
            pass
    _write_jsonl(_jsonl_record("info", "conversation", "REPLY", turns=turns, profile=profile_name, reply_len=len(reply or "")))


def log_detail(scope: str, event: str, **kwargs: Any) -> None:
    """Log structurat de audit: CE S-A ÎNTÂMPLAT și CÂND. Doar când verbose_logging=True.
    scope = 'router'|'cortex'|'reminder'|'scheduler'|'api'|'memory'|'intelligence'
    event = nume scurt al evenimentului
    **kwargs = date relevante (fără parole/token-uri)."""
    # Always write to JSONL regardless of verbose flag
    safe_kw = {k: _safe_value(k, v) for k, v in kwargs.items() if v is not None}
    _write_jsonl(_jsonl_record("debug", scope, event, **safe_kw))
    if not _is_verbose():
        return
    ts = get_time_ms()
    payload = _safe_payload(**kwargs)
    msg = f"[{scope}] {event} | {payload}"
    line = Text()
    line.append(f"{ts} ", style="bold bright_black")
    line.append_text(_chip("📋", "AUDIT", "bright_black"))
    line.append(f" {msg}", style="white")
    console.print(line)
    if _extra_log_fn:
        try:
            _extra_log_fn("audit", "📋", f"AUDIT [{scope}] {event}", payload[:500] if len(payload) > 500 else payload)
        except Exception:
            pass
