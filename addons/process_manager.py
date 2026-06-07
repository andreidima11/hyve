"""
Process manager — start, stop, restart addon processes and capture logs.

Each addon manifest may include a `start_command` block:
  { "command": "wyoming-piper",
    "args": ["--voice", "{voice}", ...],
    "description": "…" }

Placeholders like {voice}, {port} are resolved from the addon's config.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from addons import registry

log = logging.getLogger("process_manager")

_MAX_LOG_LINES = 500
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)


class _ManagedProcess:
    """Tracks one running subprocess + its log ring-buffer."""
    __slots__ = ("slug", "proc", "logs", "started_at", "_reader_tasks")

    def __init__(self, slug: str, proc: asyncio.subprocess.Process):
        self.slug = slug
        self.proc = proc
        self.logs: collections.deque[str] = collections.deque(maxlen=_MAX_LOG_LINES)
        self.started_at: float = time.time()
        self._reader_tasks: list[asyncio.Task] = []

    async def start_readers(self):
        if self.proc.stdout:
            self._reader_tasks.append(asyncio.create_task(self._read_stream(self.proc.stdout)))
        if self.proc.stderr:
            self._reader_tasks.append(asyncio.create_task(self._read_stream(self.proc.stderr)))

    async def _read_stream(self, stream: asyncio.StreamReader):
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                self.logs.append(text)
        except Exception:
            pass

    @property
    def running(self) -> bool:
        return self.proc.returncode is None

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.running else None

    @property
    def return_code(self) -> int | None:
        return self.proc.returncode

    async def stop(self, timeout: float = 5.0):
        if not self.running:
            return
        self.proc.terminate()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()
        for t in self._reader_tasks:
            t.cancel()


# ── singleton registry ─────────────────────────────────────────────────────

_processes: dict[str, _ManagedProcess] = {}
# Slugs that the user explicitly stopped — watchdog must not auto-restart them
# until the user starts them again (or restarts).
_intentionally_stopped: set[str] = set()


def _resolve_args(args: list[str], config: dict) -> list[str]:
    """Replace {key} placeholders in args with values from config."""
    resolved = []
    for a in args:
        for k, v in config.items():
            a = a.replace(f"{{{k}}}", str(v))
        resolved.append(a)
    return resolved


def _find_executable(command: str) -> str:
    """Find the command in the project venv first, then system PATH."""
    venv_bin = os.path.join(_PROJECT_ROOT, "venv", "bin", command)
    if os.path.isfile(venv_bin):
        return venv_bin
    return command

def _resolve_script_path(arg: str, addon_dir: Path | None) -> str:
    """Resolve a script-like argument to an absolute path.

    Search order (first hit wins):
      1. Path relative to the addon's own folder — lets community addons
         ship their scripts inside their own directory (HA-style).
      2. Path relative to the project root — backward-compat with the
         legacy ``./scripts/addons/run_*.sh`` layout.
      3. The argument as-is (system PATH or already absolute).
    """
    if not arg or os.path.isabs(arg):
        return arg
    if not (arg.endswith(".sh") or arg.startswith("./") or arg.startswith("scripts/")):
        return arg
    rel = arg[2:] if arg.startswith("./") else arg
    if addon_dir:
        candidate = addon_dir / rel
        if candidate.is_file():
            return str(candidate)
        # Also accept run.sh / start.sh shorthand next to manifest.json.
        candidate = addon_dir / Path(rel).name
        if candidate.is_file() and Path(rel).name in ("run.sh", "start.sh"):
            return str(candidate)
    candidate = Path(_PROJECT_ROOT) / rel
    if candidate.is_file():
        return str(candidate)
    return arg

async def _port_in_use(host: str, port: int) -> bool:
    """Check if a TCP port is already listening."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=2
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


def _pids_listening_on(port: int) -> list[int]:
    """Return PIDs of processes listening on the given TCP port (local only)."""
    if not port:
        return []
    try:
        import psutil  # local import keeps module light if unused
    except Exception:
        return []
    pids: set[int] = set()
    try:
        for conn in psutil.net_connections(kind="tcp"):
            try:
                if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port and conn.pid:
                    pids.add(conn.pid)
            except Exception:
                continue
    except (psutil.AccessDenied, PermissionError):
        # Fallback: lsof (works without elevated perms on macOS)
        try:
            out = subprocess.run(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                capture_output=True, text=True, timeout=3,
            )
            for line in out.stdout.splitlines():
                line = line.strip()
                if line.isdigit():
                    pids.add(int(line))
        except Exception:
            pass
    except Exception:
        pass
    return sorted(pids)


async def _kill_pids(pids: list[int], timeout: float = 5.0) -> list[int]:
    """SIGTERM then SIGKILL the given PIDs. Returns PIDs that were terminated."""
    killed: list[int] = []
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        except Exception as e:
            log.warning("SIGTERM pid=%s failed: %s", pid, e)
            continue
        # Wait for it to exit
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                killed.append(pid)
                break
            await asyncio.sleep(0.1)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
                killed.append(pid)
            except ProcessLookupError:
                killed.append(pid)
            except Exception as e:
                log.warning("SIGKILL pid=%s failed: %s", pid, e)
    return killed


async def start(slug: str) -> dict:
    """Start the addon process. Returns status dict."""
    # Explicit start clears any prior intentional-stop flag
    _intentionally_stopped.discard(slug)
    # If already running, return current status
    if slug in _processes and _processes[slug].running:
        return _status_dict(slug)

    manifest = registry.get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    start_cmd = manifest.get("start_command")
    if not start_cmd:
        raise ValueError(f"Addon {slug} has no start_command defined")

    state = registry.get_state(slug)
    config = state.get("config", {})

    # Check if the port is already in use (external process)
    hc = manifest.get("health_check", {})
    port_key = hc.get("port_key", "port")
    host_key = hc.get("host_key", "host")
    port = int(config.get(port_key, 0))
    host = hc.get("host") or config.get(host_key, "localhost")
    if port and await _port_in_use(host, port):
        log.info("Port %s:%d already in use — treating %s as externally running", host, port, slug)
        return {"slug": slug, "status": "running", "pid": None, "uptime": None, "external": True}

    command = _find_executable(start_cmd["command"])
    addon_dir = registry.get_addon_dir(slug)
    raw_args = _resolve_args(start_cmd.get("args", []), config)
    args = [_resolve_script_path(a, addon_dir) for a in raw_args]

    log.info("Starting %s: %s %s", slug, command, " ".join(args))

    proc = await asyncio.create_subprocess_exec(
        command, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=_PROJECT_ROOT,
    )

    mp = _ManagedProcess(slug, proc)
    await mp.start_readers()
    _processes[slug] = mp

    # Give it a moment to see if it crashes immediately
    await asyncio.sleep(0.3)
    if not mp.running:
        raise RuntimeError(
            f"Process exited immediately with code {mp.return_code}. "
            f"Last log: {list(mp.logs)[-3:] if mp.logs else '(empty)'}"
        )

    log.info("Started %s (PID %s)", slug, mp.pid)
    return _status_dict(slug)


async def stop(slug: str) -> dict:
    """Stop the addon process (managed or external orphan listening on its port)."""
    # Mark as intentionally stopped so the watchdog won't immediately restart it
    _intentionally_stopped.add(slug)
    mp = _processes.get(slug)
    if mp and mp.running:
        log.info("Stopping %s (PID %s)", slug, mp.pid)
        await mp.stop()
        log.info("Stopped %s", slug)
        return _status_dict(slug)

    # Not managed by us — try to terminate any orphan listening on the addon's port
    manifest = registry.get_manifest(slug)
    if manifest:
        hc = manifest.get("health_check", {})
        state = registry.get_state(slug)
        config = state.get("config", {})
        port = int(config.get(hc.get("port_key", "port"), 0) or 0)
        host = hc.get("host") or config.get(hc.get("host_key", "host"), "localhost")
        if port and await _port_in_use(host, port):
            pids = _pids_listening_on(port)
            # Don't kill ourselves
            self_pid = os.getpid()
            pids = [p for p in pids if p != self_pid]
            if pids:
                log.info("Stopping external %s by port %d (pids=%s)", slug, port, pids)
                killed = await _kill_pids(pids)
                log.info("Stopped external %s (killed pids=%s)", slug, killed)
            else:
                log.warning("Port %d in use for %s but no PID resolvable", port, slug)
    return _status_dict(slug)


async def restart(slug: str) -> dict:
    """Restart = stop + start."""
    await stop(slug)
    return await start(slug)


def get_logs(slug: str, tail: int = 200) -> list[str]:
    """Return the last `tail` log lines for a process."""
    mp = _processes.get(slug)
    if not mp:
        # External / orphan process — we never captured its stdout/stderr.
        return [
            f"[hyve] No captured logs for '{slug}'.",
            "[hyve] This process is running externally (started outside Hyve, or before the last restart).",
            "[hyve] Click Stop, then Start to relaunch it under Hyve and capture logs.",
        ]
    lines = list(mp.logs)
    return lines[-tail:]


def get_status(slug: str) -> dict:
    """Return current status for an addon process."""
    return _status_dict(slug)


async def get_status_async(slug: str) -> dict:
    """Return current status, checking port for external processes."""
    mp = _processes.get(slug)
    if mp and mp.running:
        return _status_dict(slug)

    # Check if running externally via port
    manifest = registry.get_manifest(slug)
    if manifest:
        hc = manifest.get("health_check", {})
        state = registry.get_state(slug)
        config = state.get("config", {})
        port = int(config.get(hc.get("port_key", "port"), 0))
        host = hc.get("host") or config.get(hc.get("host_key", "host"), "localhost")
        if port and await _port_in_use(host, port):
            return {"slug": slug, "status": "running", "pid": None, "uptime": None, "external": True}

    return _status_dict(slug)


async def get_all_statuses_async() -> dict[str, dict]:
    """Return status for every addon with a start_command (async, detects external)."""
    result = {}
    for manifest in registry.list_available():
        if manifest.get("start_command"):
            result[manifest["slug"]] = await get_status_async(manifest["slug"])
    return result


def get_all_statuses() -> dict[str, dict]:
    """Return status for every addon with a start_command."""
    result = {}
    for manifest in registry.list_available():
        if manifest.get("start_command"):
            result[manifest["slug"]] = _status_dict(manifest["slug"])
    return result


def _status_dict(slug: str) -> dict:
    mp = _processes.get(slug)
    if not mp:
        return {"slug": slug, "status": "stopped", "pid": None, "uptime": None}
    if mp.running:
        return {
            "slug": slug,
            "status": "running",
            "pid": mp.pid,
            "uptime": round(time.time() - mp.started_at),
        }
    return {
        "slug": slug,
        "status": "exited",
        "pid": None,
        "return_code": mp.return_code,
        "uptime": None,
    }


async def stop_all():
    """Stop all managed processes (called on app shutdown)."""
    await stop_watchdog()
    for slug in list(_processes.keys()):
        try:
            await stop(slug)
        except Exception as e:
            log.warning("Error stopping %s: %s", slug, e)


# ── WATCHDOG ───────────────────────────────────────────────────────────────

_watchdog_task: asyncio.Task | None = None
_WATCHDOG_INTERVAL = 10  # seconds between checks


async def _watchdog_loop():
    """Periodically check watchdog-enabled addons and restart crashed ones."""
    while True:
        await asyncio.sleep(_WATCHDOG_INTERVAL)
        try:
            slugs = registry.get_watchdog_addons()
            for slug in slugs:
                # Respect explicit user stop — don't fight the user
                if slug in _intentionally_stopped:
                    continue
                mp = _processes.get(slug)
                # Only restart if we previously managed it (or if it's never been started)
                if mp and not mp.running:
                    log.warning("Watchdog: %s exited (code %s), restarting...", slug, mp.return_code)
                    try:
                        await start(slug)
                        log.info("Watchdog: %s restarted successfully", slug)
                    except Exception as e:
                        log.error("Watchdog: failed to restart %s: %s", slug, e)
                elif mp is None:
                    # Not started yet (e.g. server just booted) — start it
                    log.info("Watchdog: auto-starting %s", slug)
                    try:
                        await start(slug)
                    except Exception as e:
                        log.error("Watchdog: failed to start %s: %s", slug, e)
        except Exception as e:
            log.error("Watchdog loop error: %s", e)


async def start_watchdog():
    """Start the watchdog background task."""
    global _watchdog_task
    if _watchdog_task and not _watchdog_task.done():
        return
    _watchdog_task = asyncio.create_task(_watchdog_loop())
    log.info("Addon watchdog started (interval=%ds)", _WATCHDOG_INTERVAL)


async def stop_watchdog():
    """Stop the watchdog background task."""
    global _watchdog_task
    if _watchdog_task and not _watchdog_task.done():
        _watchdog_task.cancel()
        try:
            await _watchdog_task
        except asyncio.CancelledError:
            pass
    _watchdog_task = None


async def auto_start_watchdog_addons():
    """Start all watchdog-enabled addons (called on server startup)."""
    slugs = registry.get_watchdog_addons()
    if not slugs:
        return
    log.info("Auto-starting watchdog addons: %s", ", ".join(slugs))
    for slug in slugs:
        try:
            await start(slug)
            log.info("Auto-started %s", slug)
        except Exception as e:
            log.warning("Failed to auto-start %s: %s", slug, e)
