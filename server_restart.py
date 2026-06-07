"""In-process server restart via os.execv (used after updates, /api/restart, etc.)."""
from __future__ import annotations

import os
import sys
import threading
import time
from typing import Optional

from logger import log_line


def restart_process(delay: float = 0.5, log_msg: str = "Restart sequence initiated...") -> None:
    if delay > 0:
        time.sleep(delay)
    try:
        from rich.console import Console

        console = Console()
        console.print("")
        console.rule("[bold red]SYSTEM RESTART[/]")
    except Exception:
        pass
    log_line("error", "🔄", "COMMAND", log_msg)
    # Best-effort cleanup for components that may allocate multiprocessing
    # primitives (e.g. embedding model pools) before replacing the process.
    try:
        import storage

        storage.shutdown_storage()
    except Exception:
        pass
    os.execv(sys.executable, [sys.executable] + sys.argv)


def schedule_restart(delay: float = 0.5, log_msg: Optional[str] = None) -> None:
    """Schedule restart in a daemon thread (safe from sync or async route handlers)."""
    msg = log_msg or "Restart sequence initiated..."
    threading.Thread(target=restart_process, args=(delay, msg), daemon=True).start()
