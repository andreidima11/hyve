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


def _addon_enabled(slug: str) -> bool:
    """Return whether the addon is enabled in registry state."""
    return bool(registry.get_state(slug).get("enabled"))


def _resolve_args(args: list[str], config: dict) -> list[str]:
    """Replace {key} placeholders in args with values from config."""
    resolved = []
    for a in args:
        for k, v in config.items():
            a = a.replace(f"{{{k}}}", str(v))
        resolved.append(a)
    return resolved


def _effective_config(manifest: dict, stored: dict | None) -> dict:
    """Merge config_schema defaults with stored addon config."""
    schema = manifest.get("config_schema") or []
    defaults = {
        field["key"]: field.get("default", "")
        for field in schema
        if field.get("key")
    }
    return {**defaults, **(stored or {})}


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
    manifest = registry.get_manifest(slug)
    if not manifest:
        raise ValueError(f"Unknown addon: {slug}")

    if not _addon_enabled(slug):
        raise ValueError(f"Addon {slug} is disabled")

    # Explicit start clears any prior intentional-stop flag
    _intentionally_stopped.discard(slug)
    registry.set_process_user_stopped(slug, False)
    # If already running, return current status
    if slug in _processes and _processes[slug].running:
        _watchdog_on_success(slug)
        return _status_dict(slug)

    start_cmd = manifest.get("start_command")
    if not start_cmd:
        raise ValueError(f"Addon {slug} has no start_command defined")

    state = registry.get_state(slug)
    config = _effective_config(manifest, state.get("config"))

    # Check if the port is already in use (external process)
    hc = manifest.get("health_check", {})
    port_key = hc.get("port_key", "port")
    host_key = hc.get("host_key", "host")
    port = int(config.get(port_key, 0))
    host = hc.get("host") or config.get(host_key, "localhost")
    if port and await _port_in_use(host, port):
        log.info("Port %s:%d already in use — treating %s as externally running", host, port, slug)
        _watchdog_on_success(slug)
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
    _watchdog_on_success(slug)
    return _status_dict(slug)


async def stop(slug: str) -> dict:
    """Stop the addon process (managed or external orphan listening on its port)."""
    # Mark as intentionally stopped so the watchdog won't immediately restart it
    _intentionally_stopped.add(slug)
    registry.set_process_user_stopped(slug, True)
    _watchdog_retry_state.pop(slug, None)
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
    if not _addon_enabled(slug):
        return {"slug": slug, "status": "stopped", "pid": None, "uptime": None, "disabled": True}

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
# Home Assistant–style: restart only unexpected exits, with exponential backoff
# and a long pause after repeated failures (no tight restart loops on bad config).

_watchdog_task: asyncio.Task | None = None
_WATCHDOG_CHECK_INTERVAL = 30  # seconds between health checks
_WATCHDOG_INITIAL_BACKOFF = 30  # first retry delay after a crash/failed start
_WATCHDOG_MAX_BACKOFF = 600  # cap between retries (10 minutes)
_WATCHDOG_GIVE_UP_AFTER = 6  # consecutive failures before a long pause
_WATCHDOG_GIVE_UP_PAUSE = 3600  # 1 hour — then retry once more slowly

# slug -> { failures, next_retry_at, paused_until, last_log_at }
_watchdog_retry_state: dict[str, dict[str, float | int]] = {}


def _watchdog_backoff_seconds(failures: int) -> float:
    if failures <= 0:
        return 0.0
    exponent = min(max(failures - 1, 0), 4)
    return float(min(_WATCHDOG_MAX_BACKOFF, _WATCHDOG_INITIAL_BACKOFF * (2 ** exponent)))


def _watchdog_on_success(slug: str) -> None:
    _watchdog_retry_state.pop(slug, None)


def _watchdog_on_failure(slug: str, *, reason: str = "") -> None:
    now = time.time()
    st = _watchdog_retry_state.setdefault(
        slug,
        {"failures": 0, "next_retry_at": 0.0, "paused_until": 0.0, "last_log_at": 0.0},
    )
    st["failures"] = int(st.get("failures", 0)) + 1
    failures = int(st["failures"])
    detail = f": {reason}" if reason else ""

    if failures >= _WATCHDOG_GIVE_UP_AFTER:
        st["paused_until"] = now + _WATCHDOG_GIVE_UP_PAUSE
        st["failures"] = 0
        st["next_retry_at"] = st["paused_until"]
        log.warning(
            "Watchdog: %s failed %d times%s — pausing auto-restart for %ds",
            slug,
            _WATCHDOG_GIVE_UP_AFTER,
            detail,
            _WATCHDOG_GIVE_UP_PAUSE,
        )
        st["last_log_at"] = now
        return

    delay = _watchdog_backoff_seconds(failures)
    st["next_retry_at"] = now + delay
    # Avoid log spam: at most one warning per backoff window.
    if now - float(st.get("last_log_at", 0.0)) >= max(delay * 0.5, 15.0):
        log.warning(
            "Watchdog: %s restart failed%s — next attempt in %.0fs (failure %d/%d)",
            slug,
            detail,
            delay,
            failures,
            _WATCHDOG_GIVE_UP_AFTER,
        )
        st["last_log_at"] = now


def _watchdog_can_retry(slug: str) -> bool:
    now = time.time()
    st = _watchdog_retry_state.get(slug)
    if not st:
        return True
    paused_until = float(st.get("paused_until", 0.0))
    if paused_until > now:
        return False
    if paused_until and paused_until <= now:
        st["paused_until"] = 0.0
        log.info("Watchdog: %s long pause ended — resuming supervised restarts", slug)
    return now >= float(st.get("next_retry_at", 0.0))


async def _watchdog_loop():
    """Periodically check watchdog-enabled addons and restart unexpected exits."""
    while True:
        await asyncio.sleep(_WATCHDOG_CHECK_INTERVAL)
        try:
            slugs = registry.get_watchdog_addons()
            for slug in slugs:
                if not _addon_enabled(slug):
                    continue
                if slug in _intentionally_stopped:
                    continue
                if not _watchdog_can_retry(slug):
                    continue

                status = await get_status_async(slug)
                if status.get("status") == "running":
                    _watchdog_on_success(slug)
                    continue

                try:
                    log.info("Watchdog: %s is %s — attempting restart", slug, status.get("status"))
                    await start(slug)
                    log.info("Watchdog: %s restarted successfully", slug)
                except Exception as exc:
                    _watchdog_on_failure(slug, reason=str(exc))
        except Exception as e:
            log.error("Watchdog loop error: %s", e)


async def start_watchdog():
    """Start the watchdog background task."""
    global _watchdog_task
    if _watchdog_task and not _watchdog_task.done():
        return
    _watchdog_task = asyncio.create_task(_watchdog_loop())
    log.info("Addon watchdog started (interval=%ds)", _WATCHDOG_CHECK_INTERVAL)


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
        if not _addon_enabled(slug):
            continue
        if slug in _intentionally_stopped or registry.is_process_user_stopped(slug):
            continue
        try:
            status = await get_status_async(slug)
            if status.get("status") == "running":
                _watchdog_on_success(slug)
                continue
            await start(slug)
            log.info("Auto-started %s", slug)
        except Exception as e:
            _watchdog_on_failure(slug, reason=str(e))
            log.warning("Failed to auto-start %s: %s", slug, e)
