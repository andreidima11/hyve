import asyncio
import json
import os
import re
import sys
from collections import deque
from typing import List

import core.settings as settings
import core.logger as log_mod
from rich.align import Align
from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.theme import Theme


custom_theme = Theme({
    "timestamp": "bold bright_black",
    "user_head": "bold green",
    "user_text": "green",
    "ai_head": "bold purple",
    "ai_text": "medium_purple1",
    "ha_head": "bold orange1",
    "mem_head": "bold hot_pink",
    "sys": "dim white",
    "success": "bold green",
    "error": "bold red",
    "job": "bold yellow",
    "think": "cyan",
    "mem": "magenta",
    "ai": "cyan",
    "router": "orange1",
    "intent": "green",
    "ha": "blue",
})
console = Console(theme=custom_theme, record=True)

log_queues: List[asyncio.Queue] = []
log_buffer: deque = deque(maxlen=5000)
_MAX_LOG_STREAMS = 20


async def broadcast_log(message: str):
    log_buffer.append(message)
    dead: List[asyncio.Queue] = []
    for q in log_queues:
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            dead.append(q)
        except Exception:
            dead.append(q)
    for q in dead:
        try:
            log_queues.remove(q)
        except ValueError:
            pass


log_detail = log_mod.log_detail
get_time = log_mod.get_time
log_conversation_start = log_mod.log_conversation_start
log_conversation_reply = log_mod.log_conversation_reply


def _broadcast_log_fn(style, icon, title, message=""):
    formatted_msg = f"{icon} {title}: {message}"
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(broadcast_log(json.dumps(formatted_msg)))
    except RuntimeError:
        pass


log_mod.set_logger(_broadcast_log_fn)


def log_line(style, icon, title, message=""):
    log_mod.log_line(style, icon, title, message)


class LogBroadcaster:
    """Tee stdout/stderr to WebSocket broadcast for console tab."""

    def __init__(self, original_stream):
        self.original_stream = original_stream
        self.ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

    def write(self, message):
        self.original_stream.write(message)
        self.original_stream.flush()
        if message.strip():
            clean_msg = self.ansi_escape.sub("", message).strip()
            if clean_msg:
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(broadcast_log(json.dumps(f"🖥️ {clean_msg}")))
                except RuntimeError:
                    pass

    def flush(self):
        self.original_stream.flush()

    def isatty(self):
        return False


def install_stream_capture():
    if not isinstance(sys.stdout, LogBroadcaster):
        sys.stdout = LogBroadcaster(sys.stdout)
    if not isinstance(sys.stderr, LogBroadcaster):
        sys.stderr = LogBroadcaster(sys.stderr)


install_stream_capture()


def print_banner():
    os.system("cls" if os.name == "nt" else "clear")
    version = settings.APP_VERSION
    port = int(settings.CFG.get("port", 8082))
    header = Text()
    header.append("Hyve", style="bold cyan")
    header.append(f"  {version}", style="dim")

    meta = Text()
    meta.append("Dashboard", style="bold white")
    meta.append("  ", style="dim")
    meta.append(f"http://localhost:{port}", style="bold bright_cyan")

    content = Text()
    content.append_text(header)
    content.append("\n")
    content.append_text(meta)

    console.print("")
    console.print(
        Panel(
            Align.center(content),
            title="🚀  Startup",
            border_style="bright_cyan",
            expand=False,
            padding=(1, 4),
        )
    )
    console.print("[dim]  Ready for requests.[/]")
    console.print("")
    log_line("sys", "🟢", "SYSTEM", "Online & Ready.")
