"""
Registry de skill-uri Memini: încarcă din skills/*.py (excl. template) și skills/generated/*.py.
Fiecare modul trebuie să exporte o clasă cu execute(input: dict) -> dict.
"""
import os
import json
import importlib.util
import subprocess
import sys
import tempfile
import concurrent.futures
from typing import Dict, List, Any, Optional, Tuple

SKILL_RUN_TIMEOUT = 30  # seconds; skills that run longer are killed
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

SKILLS_DIR = os.path.dirname(os.path.abspath(__file__))
GENERATED_DIR = os.path.join(SKILLS_DIR, "generated")
_REGISTRY: Optional[List[Dict[str, Any]]] = None


def _is_generated_path(path: str) -> bool:
    return path.startswith(GENERATED_DIR) or "generated" in os.path.normpath(path)


def _load_skill_module(filepath: str) -> Optional[Any]:
    """Încarcă un modul .py și returnează clasa cu execute() (prima găsită)."""
    name = os.path.splitext(os.path.basename(filepath))[0]
    if name.startswith("_"):
        return None
    try:
        spec = importlib.util.spec_from_file_location(f"skills.{name}", filepath)
        if not spec or not spec.loader:
            return None
        mod = importlib.util.module_from_spec(spec)
        if spec.submodule_search_locations:
            sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        for attr_name in dir(mod):
            if attr_name.startswith("_"):
                continue
            obj = getattr(mod, attr_name)
            if isinstance(obj, type) and callable(getattr(obj, "execute", None)):
                return obj
        return None
    except Exception:
        return None


def _scan_skills() -> List[Dict[str, Any]]:
    """Scanează skills/ și skills/generated/ pentru .py (excl. __init__, template)."""
    registry = []
    for base_dir in (SKILLS_DIR, GENERATED_DIR):
        if not os.path.isdir(base_dir):
            continue
        for f in sorted(os.listdir(base_dir)):
            if not f.endswith(".py") or f.startswith("_") or f == "__init__.py":
                continue
            if f == "template.py":
                continue
            path = os.path.join(base_dir, f)
            if not os.path.isfile(path):
                continue
            cls = _load_skill_module(path)
            if cls:
                name = getattr(cls, "name", os.path.splitext(f)[0])
                desc = getattr(cls, "description", "")
                registry.append({
                    "name": name,
                    "description": desc,
                    "path": path,
                    "cls": cls,
                    "generated": _is_generated_path(path),
                })
    return registry


def get_skill_registry() -> List[Dict[str, Any]]:
    """Returnează lista de skill-uri (name, description, path, generated). Re-scanează la fiecare apel."""
    global _REGISTRY
    _REGISTRY = _scan_skills()
    return [
        {"name": s["name"], "description": s["description"], "path": s["path"], "generated": s["generated"]}
        for s in _REGISTRY
    ]


def get_skill_source(skill_name: str) -> Optional[str]:
    """Citește sursa unui skill după nume. None dacă nu există."""
    for s in get_skill_registry_with_classes():
        if s["name"] == skill_name:
            try:
                with open(s["path"], "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                return None
    return None


def update_skill_source(skill_name: str, source: str) -> Tuple[bool, str]:
    """Actualizează sursa unui skill — orice skill, inclusiv built-in. Returnează (ok, message)."""
    for s in get_skill_registry_with_classes():
        if s["name"] == skill_name:
            path = s["path"]
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(source)
                global _REGISTRY
                _REGISTRY = None
                return True, "Updated."
            except Exception as e:
                return False, str(e)
    return False, "Skill not found."


def delete_skill(skill_name: str) -> Tuple[bool, str]:
    """Șterge un skill (fișier) — orice skill, inclusiv built-in. Returnează (ok, message)."""
    for s in get_skill_registry_with_classes():
        if s["name"] == skill_name:
            path = s["path"]
            try:
                os.remove(path)
                global _REGISTRY
                _REGISTRY = None
                return True, "Deleted."
            except Exception as e:
                return False, str(e)
    return False, "Skill not found."


def get_skill_registry_with_classes() -> List[Dict[str, Any]]:
    """Returnează registry-ul cu clase încărcate (pentru execuție)."""
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _scan_skills()
    return _REGISTRY


def run_skill(skill_name: str, input_data: Dict[str, Any], timeout: int = SKILL_RUN_TIMEOUT,
              allow_network: bool = False) -> Dict[str, Any]:
    """Execute a skill by name.

    Generated skills always run in a sandboxed subprocess (via _sandbox_runner.py).
    Built-in skills run directly in-process (trusted code).

    Args:
        allow_network: when True, the sandbox allows socket/urllib for HTTP access.
                       Needed for skills that use SearXNG (_searxng_url in input_data).
    """
    for s in get_skill_registry_with_classes():
        if s["name"] == skill_name:
            if s.get("generated"):
                policy = "network" if allow_network else "standard"
                return _run_skill_sandboxed(s["path"], input_data, timeout, policy=policy)
            # Built-in skills → direct execution (trusted code)
            try:
                future = _executor.submit(s["cls"].execute, input_data or {})
                result = future.result(timeout=timeout)
                if not isinstance(result, dict):
                    return {"success": False, "message": "Skill did not return a dict.", "data": {}}
                return result
            except concurrent.futures.TimeoutError:
                return {"success": False, "message": f"Skill timed out after {timeout}s.", "data": {}}
            except Exception as e:
                return {"success": False, "message": str(e), "data": {}}
    return {"success": False, "message": f"Skill '{skill_name}' not found.", "data": {}}


_SANDBOX_RUNNER = os.path.join(SKILLS_DIR, "_sandbox_runner.py")


def _run_skill_sandboxed(skill_path: str, input_data: Dict[str, Any],
                         timeout: int = SKILL_RUN_TIMEOUT,
                         policy: str = "standard") -> Dict[str, Any]:
    """Execute a generated skill in a sandboxed subprocess via _sandbox_runner.py.

    Security layers (handled by the runner):
      1. Resource limits (memory 256 MB, no fork)
      2. Import hook blocks dangerous modules per policy
      3. Isolated cwd (temp directory)
      4. Sensitive env vars stripped

    Communication: input_data → stdin (JSON), result → stdout (JSON).
    """
    # Build JSON-safe input (strip any callables that slipped through)
    safe_input = {}
    for k, v in (input_data or {}).items():
        if callable(v):
            continue
        safe_input[k] = v

    try:
        env = os.environ.copy()
        for k in ("HOME_ASSISTANT_TOKEN", "OPENAI_API_KEY", "LLM_API_KEY",
                   "DATABASE_URL", "SECRET_KEY", "JWT_SECRET"):
            env.pop(k, None)

        cmd = [
            sys.executable, _SANDBOX_RUNNER,
            "--skill-path", skill_path,
            "--policy", policy,
        ]

        input_json = json.dumps(safe_input, ensure_ascii=False, default=str)

        with tempfile.TemporaryDirectory(prefix="skill_sandbox_") as sandbox_dir:
            proc = subprocess.run(
                cmd,
                input=input_json,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=sandbox_dir,
                env=env,
            )

        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()[:500]
            return {"success": False, "message": f"Skill execution failed: {err}", "data": {}}

        stdout = (proc.stdout or "").strip()
        if not stdout:
            return {"success": False, "message": "Skill produced no output.", "data": {}}

        try:
            result = json.loads(stdout)
            if not isinstance(result, dict):
                return {"success": False, "message": "Skill did not return a dict.", "data": {}}
            return result
        except json.JSONDecodeError:
            return {"success": True, "message": stdout[:500], "data": {}}

    except subprocess.TimeoutExpired:
        return {"success": False, "message": f"Skill timed out after {timeout}s.", "data": {}}
    except Exception as e:
        return {"success": False, "message": f"Sandbox error: {type(e).__name__}: {e}", "data": {}}
