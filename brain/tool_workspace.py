import os
import time
from typing import Any, Dict, List, Optional, Tuple

import settings as settings_mod
from logger import log_line


_FILE_READ_RATE: Dict[str, List[float]] = {}
_LAST_PROPOSAL: Optional[Dict[str, Any]] = None


def project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resolve_safe_path(relative_path: str, allowed_roots: Optional[List[str]] = None) -> Optional[str]:
    if not relative_path or ".." in relative_path or relative_path.startswith("/"):
        return None
    path = relative_path.strip().lstrip("/")
    root = project_root()
    try:
        root_real = os.path.realpath(root)
    except Exception:
        root_real = root
    allowed = list(allowed_roots) if allowed_roots else [root]
    for base in allowed:
        if not base:
            base = root
        elif not os.path.isabs(base):
            base = os.path.join(root, base)
        base = os.path.normpath(base)
        full = os.path.normpath(os.path.join(base, path))
        try:
            full_real = os.path.realpath(full)
        except Exception:
            continue
        if not full_real.startswith(os.path.realpath(base)):
            continue
        if os.path.isfile(full):
            return full
    full = os.path.normpath(os.path.join(root, path))
    try:
        if os.path.realpath(full).startswith(root_real) and os.path.isfile(full):
            return full
    except Exception:
        pass
    return None


def _file_read_rate_limit(user_id: str) -> Optional[str]:
    cfg = (settings_mod.CFG.get("intelligence") or {}).get("file_read") or {}
    limit = int(cfg.get("rate_limit_per_minute", 10))
    if limit <= 0:
        return None
    now = time.time()
    if user_id not in _FILE_READ_RATE:
        _FILE_READ_RATE[user_id] = []
    times = _FILE_READ_RATE[user_id]
    times[:] = [timestamp for timestamp in times if now - timestamp < 60.0]
    if len(times) >= limit:
        return f"Rate limit: max {limit} file reads per minute."
    times.append(now)
    return None


async def exec_read_file(args: Dict[str, Any], user_id: str) -> str:
    cfg = (settings_mod.CFG.get("intelligence") or {}).get("file_read") or {}
    if not cfg.get("enabled", True):
        return "File read is disabled in configuration."
    rate_limit_error = _file_read_rate_limit(user_id)
    if rate_limit_error:
        return rate_limit_error
    path_arg = (args.get("path") or "").strip()
    limit_lines = args.get("limit_lines")
    if isinstance(limit_lines, (int, float)):
        limit_lines = max(0, min(5000, int(limit_lines)))
    else:
        limit_lines = None
    allowed_roots = cfg.get("allowed_roots") or []
    full = resolve_safe_path(path_arg, allowed_roots if allowed_roots else None)
    if not full:
        return f"Error: Path not allowed or not found: {path_arg}. Use a relative path under the project."
    max_bytes = int(cfg.get("max_bytes", 51200))
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as handle:
            content = handle.read(max_bytes + 1)
    except Exception as exc:
        return f"Error reading file: {type(exc).__name__}: {exc}"
    if len(content) > max_bytes:
        content = content[:max_bytes] + "\n... (truncated)"
    if limit_lines and limit_lines > 0:
        lines = content.splitlines()
        if len(lines) > limit_lines:
            content = "\n".join(lines[-limit_lines:])
    log_line("agent", "📄", "READ_FILE", f"{path_arg} ({len(content)} chars)")
    return f"File: {path_arg}\n\n{content}"


def get_last_proposal() -> Optional[Dict[str, Any]]:
    global _LAST_PROPOSAL
    out = _LAST_PROPOSAL
    _LAST_PROPOSAL = None
    return out


def _allowed_propose_dirs() -> List[str]:
    cfg = (settings_mod.CFG.get("intelligence") or {}).get("propose_patch") or {}
    dirs = cfg.get("allowed_dirs") or ["scripts", "docs", "ai_suggestions"]
    root = project_root()
    return [os.path.join(root, directory) for directory in dirs]


def _path_under_allowed(path_arg: str) -> Optional[str]:
    if not path_arg or ".." in path_arg or path_arg.startswith("/"):
        return None
    path = path_arg.strip().lstrip("/")
    root = project_root()
    for base in _allowed_propose_dirs():
        full = os.path.normpath(os.path.join(base, path))
        if not os.path.normpath(full).startswith(os.path.normpath(base)):
            continue
        return full
    full = os.path.normpath(os.path.join(root, path))
    for base in _allowed_propose_dirs():
        if full.startswith(base):
            return full
    return None


async def exec_propose_patch(args: Dict[str, Any], user_id: str) -> str:
    global _LAST_PROPOSAL
    path_arg = (args.get("path") or "").strip()
    old_snippet = args.get("old_snippet") or ""
    new_snippet = args.get("new_snippet") or ""
    if not path_arg or not old_snippet:
        return "Error: path and old_snippet are required."
    full = _path_under_allowed(path_arg)
    if not full:
        return f"Error: Path must be under one of: scripts/, docs/, ai_suggestions/. Got: {path_arg}"
    if not os.path.isfile(full):
        return f"Error: File not found: {path_arg}"
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as handle:
            content = handle.read()
    except Exception as exc:
        return f"Error reading file: {type(exc).__name__}: {exc}"
    if old_snippet not in content:
        return "Error: old_snippet not found in file. It must match exactly (including spaces)."
    diff_preview = f"- {repr(old_snippet[:200])}\n+ {repr(new_snippet[:200])}"
    _LAST_PROPOSAL = {
        "type": "patch",
        "path": path_arg,
        "full_path": full,
        "old_snippet": old_snippet,
        "new_snippet": new_snippet,
        "diff_preview": diff_preview,
    }
    log_line("agent", "📝", "PROPOSE_PATCH", path_arg)
    return f"Patch proposed for {path_arg}. User will see the change and can Apply or Refuse. Diff preview: {diff_preview}"


async def exec_propose_file(args: Dict[str, Any], user_id: str) -> str:
    global _LAST_PROPOSAL
    path_arg = (args.get("path") or "").strip()
    content = args.get("content") or ""
    if not path_arg:
        return "Error: path is required."
    full = _path_under_allowed(path_arg)
    if not full:
        return f"Error: Path must be under one of: scripts/, docs/, ai_suggestions/. Got: {path_arg}"
    if os.path.exists(full):
        return f"Error: File already exists: {path_arg}. Use propose_patch to modify."
    _LAST_PROPOSAL = {
        "type": "file",
        "path": path_arg,
        "full_path": full,
        "content": content,
        "preview": content[:500] + "..." if len(content) > 500 else content,
    }
    log_line("agent", "📝", "PROPOSE_FILE", path_arg)
    return f"New file proposed: {path_arg}. User will see the content and can Create or Refuse. Preview: {content[:300]}..."


def apply_proposal(proposal: Dict[str, Any]) -> Tuple[bool, str]:
    if not proposal or not isinstance(proposal, dict):
        return False, "Invalid proposal"
    proposal_type = proposal.get("type")
    full_path = proposal.get("full_path")
    if not full_path:
        return False, "Missing path"
    full_path = os.path.normpath(os.path.realpath(full_path))
    allowed = _allowed_propose_dirs()
    if not any(full_path.startswith(os.path.normpath(base)) for base in allowed):
        return False, "Path not under allowed directories"
    if proposal_type == "patch":
        old_snippet = proposal.get("old_snippet")
        new_snippet = proposal.get("new_snippet")
        if not os.path.isfile(full_path):
            return False, "File no longer exists"
        try:
            with open(full_path, "r", encoding="utf-8", errors="replace") as handle:
                content = handle.read()
        except Exception as exc:
            return False, str(exc)
        if old_snippet not in content:
            return False, "Content no longer matches (file was changed)"
        new_content = content.replace(old_snippet, new_snippet, 1)
        try:
            with open(full_path, "w", encoding="utf-8") as handle:
                handle.write(new_content)
        except Exception as exc:
            return False, str(exc)
        log_line("agent", "✅", "APPLY_PATCH", full_path)
        return True, f"Patch applied to {proposal.get('path', full_path)}"
    if proposal_type == "file":
        content = proposal.get("content", "")
        try:
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as handle:
                handle.write(content)
        except Exception as exc:
            return False, str(exc)
        log_line("agent", "✅", "APPLY_FILE", full_path)
        return True, f"File created: {proposal.get('path', full_path)}"
    return False, "Unknown proposal type"