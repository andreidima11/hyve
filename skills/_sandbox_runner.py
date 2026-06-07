"""
Hyve Skill Sandbox Runner
============================
Launched as a subprocess to execute generated skills in isolation.

Security model (defense in depth):
  1. Static validation: forge._validate_skill_code() rejects dangerous imports/builtins at code level
  2. Resource limits: memory cap, file-size cap, no fork
  3. OS neutering: dangerous os methods (system, exec*, spawn*, popen, kill, fork)
     are replaced with a PermissionError-raising stub BEFORE any skill code runs
  4. Import hook — two policies:
     • standard: blocks network modules (socket/ssl/http/urllib) + dangerous modules
     • network:  allows socket/ssl/http/urllib for HTTP access; still blocks dangerous modules
     Dangerous modules always blocked: subprocess, ctypes, signal, multiprocessing,
     threading, importlib, pickle, shelve, marshal, code, codeop, compileall,
     xmlrpc, ftplib, smtplib, telnetlib, webbrowser, antigravity
  5. Isolated working directory (caller sets cwd to temp dir)
  6. Sensitive env vars stripped by caller before launch

Usage:
  python _sandbox_runner.py --skill-path /path/to/skill.py [--policy network] [--dry-run]

  Normal mode:  reads JSON input from stdin, writes JSON result to stdout.
  Dry-run mode: runs execute({}) and validates the return shape.
"""
import sys
import json
import argparse
import resource

# ── Pre-import modules needed by runner AND by skills (before hook) ────────
# These get cached in sys.modules so the import hook won't block them.
import importlib.util
import os
import os.path

# ── Neuter dangerous os methods ───────────────────────────────────────────
# Instead of blocking the entire os module (which breaks all stdlib that
# depends on it), we remove specific dangerous methods. Skills can still use
# os.path.join() etc., but cannot execute commands or kill processes.

def _sandbox_blocked(*_a, **_kw):
    raise PermissionError("This operation is blocked in the skill sandbox")

_OS_DANGEROUS_ATTRS = (
    # Command execution
    'system', 'popen',
    # Process replacement
    'execl', 'execle', 'execlp', 'execlpe',
    'execv', 'execve', 'execvp', 'execvpe',
    # Process spawning
    'spawnl', 'spawnle', 'spawnlp', 'spawnlpe',
    'spawnv', 'spawnve', 'spawnvp', 'spawnvpe',
    # Process/signal control
    'fork', 'forkpty', 'kill', 'killpg', 'plock',
    # File deletion (cwd is temp, but defense in depth)
    'remove', 'unlink', 'rmdir', 'removedirs',
    # Link creation (prevent symlink attacks)
    'symlink', 'link',
    # Dangerous env mutation
    'putenv', 'unsetenv',
)

for _attr in _OS_DANGEROUS_ATTRS:
    if hasattr(os, _attr):
        setattr(os, _attr, _sandbox_blocked)


# ── Pre-import network libs for network policy (after os neutering) ──────
# urllib.request internally imports os, socket, ssl, http.client.
# We import them now so they're cached. The import hook installed later
# will allow them through for 'network' policy.
try:
    import socket as _socket
    import ssl as _ssl
    import http.client as _http_client
    import urllib.request as _urllib_request
    import urllib.parse as _urllib_parse
except ImportError:
    pass  # non-critical if not available on this platform


# ── Module-level security constants ──────────────────────────────────────

# Always blocked regardless of policy
_ALWAYS_BLOCKED_TOP = frozenset({
    'subprocess', 'ctypes', 'signal',
    'multiprocessing', 'threading',
    'importlib',
    'pickle', 'shelve', 'marshal',
    'code', 'codeop', 'compileall',
    'xmlrpc', 'ftplib', 'smtplib', 'telnetlib',
    'webbrowser', 'antigravity',
})

# Full dotted names blocked even when top module is allowed
_ALWAYS_BLOCKED_FULL = frozenset({
    'http.server',
})

# Additional top-level modules blocked in 'standard' policy only
_STANDARD_EXTRA_BLOCKED = frozenset({
    'socket', 'ssl', 'http', 'urllib',
})

# Modules that were pre-imported and should be allowed through the hook
# (they're already in sys.modules, but the hook would block new imports)
_PRE_IMPORTED = frozenset({
    'os', 'os.path', 'json', 'sys', 'resource', 'importlib', 'importlib.util',
    'argparse',
})


def _apply_resource_limits():
    """Best-effort resource caps (Linux/macOS)."""
    limits = [
        (resource.RLIMIT_AS,    256 * 1024 * 1024),   # 256 MB virtual memory
        (resource.RLIMIT_FSIZE, 128 * 1024 * 1024),   # 128 MB max file writes
    ]
    if hasattr(resource, 'RLIMIT_NPROC'):
        limits.append((resource.RLIMIT_NPROC, 0))     # no child processes
    for res, val in limits:
        try:
            resource.setrlimit(res, (val, val))
        except (ValueError, resource.error):
            pass


def _install_import_hook(policy: str):
    """Replace builtins.__import__ with a filtering wrapper."""
    blocked_top = set(_ALWAYS_BLOCKED_TOP)
    if policy == "standard":
        blocked_top |= _STANDARD_EXTRA_BLOCKED
        # Purge pre-imported network modules from cache so the hook can block them
        for mod_name in list(sys.modules):
            top = mod_name.split('.')[0]
            if top in _STANDARD_EXTRA_BLOCKED:
                del sys.modules[mod_name]

    blocked_top_frozen = frozenset(blocked_top)

    _orig = (
        __builtins__.__import__
        if hasattr(__builtins__, '__import__')
        else __import__
    )

    def _guarded_import(name, *args, **kwargs):
        # Allow modules that are already cached (pre-imported by runner)
        if name in sys.modules:
            return _orig(name, *args, **kwargs)
        # Block by full dotted name (e.g. http.server)
        if name in _ALWAYS_BLOCKED_FULL:
            raise ImportError(f"Import of '{name}' is blocked by sandbox policy '{policy}'")
        # Block by top-level module
        top = name.split('.')[0]
        if top in blocked_top_frozen:
            raise ImportError(f"Import of '{top}' is blocked by sandbox policy '{policy}'")
        return _orig(name, *args, **kwargs)

    import builtins
    builtins.__import__ = _guarded_import


def _load_and_run(skill_path: str, input_data: dict) -> dict:
    """Load the skill module and call execute(input_data)."""
    spec = importlib.util.spec_from_file_location("_sandboxed_skill", skill_path)
    if not spec or not spec.loader:
        return {"success": False, "message": "Cannot load skill module"}
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    for attr_name in dir(mod):
        if attr_name.startswith("_"):
            continue
        obj = getattr(mod, attr_name)
        if isinstance(obj, type) and callable(getattr(obj, "execute", None)):
            return obj.execute(input_data)

    return {"success": False, "message": "No skill class with execute() found in module"}


def main():
    parser = argparse.ArgumentParser(description="Hyve skill sandbox runner")
    parser.add_argument("--skill-path", required=True)
    parser.add_argument("--policy", choices=["standard", "network"], default="standard")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # ── 1. Resource limits ──
    _apply_resource_limits()

    # ── 2. Import hook ──
    _install_import_hook(args.policy)

    # ── 3. Read input ──
    if args.dry_run:
        input_data = {}
    else:
        try:
            raw = sys.stdin.read()
            input_data = json.loads(raw) if raw.strip() else {}
        except Exception:
            input_data = {}

    # ── 4. Add skill directory to sys.path ──
    skill_dir = os.path.dirname(os.path.abspath(args.skill_path))
    sys.path.insert(0, skill_dir)

    # ── 5. Execute ──
    try:
        result = _load_and_run(args.skill_path, input_data)
    except Exception as e:
        if args.dry_run:
            # Any exception during dry-run (ImportError, PermissionError, etc.)
            # means the skill is broken — fail immediately
            print(f"{type(e).__name__}: {e}", file=sys.stderr)
            sys.exit(1)
        result = {"success": False, "message": f"{type(e).__name__}: {e}"}

    # ── 6. Validate & output ──
    if args.dry_run:
        if not isinstance(result, dict) or "success" not in result:
            print("INVALID: execute() must return dict with 'success' key", file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    else:
        if not isinstance(result, dict):
            result = {"success": False, "message": "Skill did not return a dict"}
        print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
