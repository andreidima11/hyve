import asyncio
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

import settings as settings_mod
from logger import log_line


_SHELL_LOCK = threading.Lock()
_SHELL_ALLOWED: Dict[str, float] = {}
_SHELL_TTL = 300
_SHELL_LAST_RUN: Optional[Dict[str, Any]] = None
_SHELL_RATE: Dict[str, List[float]] = {}
_LAST_SUGGEST_SHELL: Optional[Dict[str, Any]] = None


def _tool_guardrails_enabled() -> bool:
    return (settings_mod.CFG.get("security") or {}).get("tool_guardrails", True)


def _is_shell_allowed(user_id: str) -> bool:
    with _SHELL_LOCK:
        exp = _SHELL_ALLOWED.get(user_id, 0)
        if time.time() > exp:
            _SHELL_ALLOWED.pop(user_id, None)
            return False
        return True


def _shell_config() -> Dict[str, Any]:
    return (settings_mod.CFG.get("intelligence") or {}).get("shell") or {}


def _shell_check_rate_limit(user_id: str) -> Optional[str]:
    cfg = _shell_config()
    limit = int(cfg.get("rate_limit_per_minute", 5))
    if limit <= 0:
        return None
    now = time.time()
    window = 60.0
    if user_id not in _SHELL_RATE:
        _SHELL_RATE[user_id] = []
    times = _SHELL_RATE[user_id]
    times[:] = [timestamp for timestamp in times if now - timestamp < window]
    if len(times) >= limit:
        return f"Rate limit: max {limit} commands per minute. Try again in a moment."
    times.append(now)
    return None


def get_last_shell_run() -> Optional[Dict[str, Any]]:
    global _SHELL_LAST_RUN
    out = _SHELL_LAST_RUN
    _SHELL_LAST_RUN = None
    return out


def allow_shell_for_user(user_id: str) -> None:
    with _SHELL_LOCK:
        _SHELL_ALLOWED[user_id] = time.time() + _SHELL_TTL


def get_last_suggest_shell() -> Optional[Dict[str, Any]]:
    global _LAST_SUGGEST_SHELL
    out = _LAST_SUGGEST_SHELL
    _LAST_SUGGEST_SHELL = None
    return out


def exec_allow_shell(user_id: str) -> str:
    cfg = _shell_config()
    if not cfg.get("enabled", True):
        return "Shell is disabled in configuration. An admin can enable it under Intelligence -> Shell."
    with _SHELL_LOCK:
        _SHELL_ALLOWED[user_id] = time.time() + _SHELL_TTL
    log_line("agent", "🔓", "SHELL", f"Shell allowed for {user_id} (expires in {_SHELL_TTL}s)")
    return f"Shell access enabled for {_SHELL_TTL // 60} minutes. You can now run the command the user asked for with run_shell."


async def exec_run_shell(args: Dict[str, Any], user_id: str, project_root: str) -> str:
    global _SHELL_LAST_RUN
    cfg = _shell_config()
    if not cfg.get("enabled", True):
        return "Shell is disabled in configuration."
    if not _is_shell_allowed(user_id):
        if not _tool_guardrails_enabled():
            _SHELL_ALLOWED[user_id] = time.time() + _SHELL_TTL
            log_line("agent", "🔓", "SHELL", f"Auto-approved (guardrails off) for {user_id}")
        else:
            command = (args.get("command") or "").strip()
            _SHELL_LAST_RUN = {"requested_but_denied": True, "command": command}
            return (
                "Shell is not allowed yet. Ask the user: 'Do you want me to run this command?' "
                "If they say yes, call allow_shell first, then call run_shell again with the same command."
            )
    command = (args.get("command") or "").strip()
    if not command:
        return "Error: No command specified."
    try:
        parts = shlex.split(command)
    except ValueError as exc:
        return f"Error: Invalid command (could not parse): {exc}"
    if not parts:
        return "Error: Empty command."
    exe = parts[0].lower()
    if "/" in exe:
        exe = exe.split("/")[-1]
    allowed = cfg.get("allowed_commands") or []
    if allowed and isinstance(allowed, list) and exe not in [item.lower() for item in allowed]:
        try:
            from brain.shell_audit import append_run

            append_run(user_id, command, blocked_reason="command not in allowlist")
        except Exception as exc:
            log_line("error", "⚠️", "AUDIT", f"shell_audit.append_run failed: {exc}")
        return f"Error: Command '{exe}' is not in the allowed list. Allowed: {', '.join(allowed[:15])}{'...' if len(allowed) > 15 else ''}."
    blocked = cfg.get("blocked_patterns") or []
    dangerous_patterns = [
        r"rm\s+.*-[^\s]*[rf].*\/",
        r">(\s*)\/dev\/",
        r"mkfs",
        r"dd\s+if=",
        r":\(\)\{\s*:\|",
        r"\bchmod\s+.*777\s+\/",
        r"\bcurl\b.*\|\s*(ba)?sh",
        r"\bwget\b.*\|\s*(ba)?sh",
        r"\bpython[23]?\s+-c\s",
        r"\bnode\s+-e\s",
        r"\beval\b",
    ]
    cmd_lower = command.lower()
    for pattern in dangerous_patterns:
        if re.search(pattern, cmd_lower):
            try:
                from brain.shell_audit import append_run

                append_run(user_id, command, blocked_reason=f"dangerous pattern: {pattern[:40]}")
            except Exception as exc:
                log_line("error", "⚠️", "AUDIT", f"shell_audit.append_run failed: {exc}")
            return "Error: Command blocked for security (dangerous pattern detected)."
    if blocked and isinstance(blocked, list):
        for pattern in blocked:
            if pattern and pattern.lower() in cmd_lower:
                try:
                    from brain.shell_audit import append_run

                    append_run(user_id, command, blocked_reason=f"blocked pattern: {pattern[:30]}")
                except Exception as exc:
                    log_line("error", "⚠️", "AUDIT", f"shell_audit.append_run failed: {exc}")
                return "Error: Command blocked for security (forbidden pattern)."
    rate_limit_error = _shell_check_rate_limit(user_id)
    if rate_limit_error:
        return rate_limit_error
    timeout = int(cfg.get("timeout_seconds", 15))
    max_out = int(cfg.get("max_output_chars", 8000))
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            parts,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        log_line("agent", "⚠️", "SHELL", f"Timeout running: {command[:60]}")
        try:
            from brain.shell_audit import append_run

            append_run(user_id, command, exit_code=-1, output_preview="(timeout)", output_len=0)
        except Exception as exc:
            log_line("error", "⚠️", "AUDIT", f"shell_audit.append_run failed: {exc}")
        return f"Command timed out after {timeout}s. Output so far was not captured."
    except FileNotFoundError:
        return f"Error: Command not found (no such program: {parts[0]})."
    except Exception as exc:
        log_line("error", "⚠️", "SHELL", f"{command[:50]}: {exc}")
        return f"Error running command: {type(exc).__name__}: {exc}"
    out = (result.stdout or "").strip()
    err = (result.stderr or "").strip()
    full_out = (out + "\n" + err).strip() if err else out
    if len(full_out) > max_out:
        full_out = full_out[:max_out] + "\n... (truncated)"
    log_line("agent", "✅", "SHELL", f"Ran: {command[:50]}... exit={result.returncode}")
    try:
        from brain.shell_audit import append_run

        append_run(user_id, command, exit_code=result.returncode, output_preview=full_out[:500], output_len=len(out) + len(err))
    except Exception as exc:
        log_line("error", "⚠️", "AUDIT", f"shell_audit.append_run failed: {exc}")
    _SHELL_LAST_RUN = {"command": command, "exit_code": result.returncode, "output_preview": full_out[:1500]}
    lines = [f"Command: {command}", f"Exit code: {result.returncode}"]
    if out:
        lines.append(f"Output:\n{full_out}" if not err else f"Stdout:\n{out}\nStderr:\n{err}")
    elif err:
        lines.append(f"Stderr:\n{err}")
    return "\n".join(lines)


def exec_suggest_shell(args: Dict[str, Any], user_id: str) -> str:
    global _LAST_SUGGEST_SHELL
    command = (args.get("command") or "").strip()
    reason = (args.get("reason") or "").strip()
    if not command:
        return "Error: No command specified for suggest_shell."
    _LAST_SUGGEST_SHELL = {"command": command, "reason": reason}
    log_line("agent", "💡", "SHELL", f"Suggested: {command[:60]}...")
    return (
        f"Suggested command: {command}. "
        "The user will see it and can Run, Edit, or Cancel. If they confirm, call allow_shell then run_shell with the same command."
    )


async def exec_run_script(args: Dict[str, Any], user_id: str, project_root: str) -> str:
    if not _is_shell_allowed(user_id):
        return "Shell access is required for run_script. Ask the user to confirm, then call allow_shell, then run_script again."
    cfg = (settings_mod.CFG.get("intelligence") or {}).get("run_script") or {}
    if not cfg.get("enabled", True):
        return "run_script is disabled in configuration."
    lang = (args.get("language") or "shell").strip().lower()
    if lang not in ("shell", "python"):
        return "Error: language must be 'shell' or 'python'."
    script = (args.get("script") or "").strip()
    if not script:
        return "Error: No script content provided."
    timeout = min(15, max(5, int(args.get("timeout_seconds") or cfg.get("timeout_seconds", 10))))
    max_out = int(cfg.get("max_output_chars", 20000))
    rate_limit = int(cfg.get("rate_limit_per_minute", 3))
    now = time.time()
    if user_id not in _SHELL_RATE:
        _SHELL_RATE[user_id] = []
    script_times = [timestamp for timestamp in _SHELL_RATE[user_id] if now - timestamp < 60.0]
    if len(script_times) >= rate_limit:
        return f"Rate limit: max {rate_limit} scripts per minute."
    _SHELL_RATE[user_id] = script_times + [now]
    fd, path = tempfile.mkstemp(suffix=".py" if lang == "python" else ".sh", prefix="hyve_")
    try:
        with open(fd, "w") as _:
            pass
    except Exception:
        pass
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(script)
        cmd = [sys.executable or "python3", path] if lang == "python" else ["/bin/sh", path]
        result = await asyncio.to_thread(
            subprocess.run,
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=project_root,
        )
        out = (result.stdout or "").strip()
        err = (result.stderr or "").strip()
        full = (out + "\n" + err).strip() if err else out
        if len(full) > max_out:
            full = full[:max_out] + "\n... (truncated)"
        log_line("agent", "✅", "RUN_SCRIPT", f"{lang} exit={result.returncode}")
        return f"Exit code: {result.returncode}\nOutput:\n{full}"
    except subprocess.TimeoutExpired:
        return f"Script timed out after {timeout}s."
    except Exception as exc:
        return f"Error: {type(exc).__name__}: {exc}"
    finally:
        try:
            import os

            os.unlink(path)
        except Exception:
            pass