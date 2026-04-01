"""
Forge: pipeline pentru crearea autonomă de skill-uri.
Cerința user → Coder (LLM) → cod → validare → test dry-run → versionare → salvare.
"""
import os
import re
import json
import asyncio
import subprocess
import tempfile
import textwrap
import shutil
from datetime import datetime
from typing import Tuple, Optional, Dict, Any, List, Callable

import httpx

SKILLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
SKILLS_GENERATED = os.path.join(SKILLS_DIR, "generated")
TEMPLATE_PATH = os.path.join(SKILLS_DIR, "template.py")
SNIPPETS_DIR = os.path.join(SKILLS_DIR, "snippets")
VERSIONS_DIR = os.path.join(SKILLS_GENERATED, "__versions__")
DEFAULT_FORGE_TIMEOUT = 180.0
FORGE_DRY_RUN_TIMEOUT = 15
MAX_VERSIONS_PER_SKILL = 20


def _read_template() -> str:
    with open(TEMPLATE_PATH, "r", encoding="utf-8") as f:
        return f.read()


def _extract_python_block(text: str) -> str:
    """Extrage un bloc de cod Python (```python ... ```), curăță și dedentează."""
    if not text:
        return ""
    # Prefer bloc care conține class + execute (evită fragmente)
    for pattern in [r"```(?:python)?\s*\n(.*?)\n```", r"```\s*\n(.*?)\n```"]:
        for m in re.finditer(pattern, text, re.DOTALL):
            block = m.group(1).strip()
            # Elimină linii care sunt doar backticks sau tag-uri
            block = "\n".join(
                line for line in block.split("\n")
                if line.strip() not in ("```", "</think>", "```python")
            ).strip()
            if "class " in block and "def execute(" in block:
                try:
                    return textwrap.dedent(block)
                except Exception:
                    return block
    if "class " in text and "def execute(" in text:
        start = text.find("class ")
        end = text.rfind("\n\n") + 1
        if end <= start:
            end = len(text)
        block = text[start:end].strip()
        try:
            return textwrap.dedent(block)
        except Exception:
            return block
    return text.strip()


def _extract_python_preview(text: str) -> str:
    """Extract best-effort in-progress Python from a partial model response."""
    if not text:
        return ""
    s = text.replace("\r\n", "\n")
    fence_match = re.search(r"```(?:python)?\s*\n", s, re.IGNORECASE)
    if fence_match:
        code = s[fence_match.end():]
        closing = code.rfind("\n```")
        if closing >= 0:
            code = code[:closing]
        return code.rstrip()
    if "class " in s or "def execute(" in s:
        start = s.find("class ")
        if start < 0:
            start = 0
        return s[start:].strip()
    return ""


def _build_repair_prompt(current_code: str, error_message: str, allow_network: bool = False) -> Tuple[str, str]:
    constraints = "Use only Python standard library (no pip, no third-party packages). No network/socket/urllib access."
    if allow_network:
        constraints = (
            "You may use socket, urllib.request, http.client, ssl (standard library) for network access. "
            "No third-party packages."
        )

    system_prompt = f"""You are a Python skill repair agent.
Output ONLY valid Python code in a single ```python block. No explanations.

REQUIREMENTS:
- One class with static method execute(input_data: dict) -> dict.
- Return a dict with at least: success (bool) and message (str). Optional: data (dict).
- Keep class attributes name and description.
- Skills are self-contained sandboxed Python. Do NOT call app/agent tools like run_shell, search_web, read_web_page, control_device, or allow_shell from inside the skill.
- {constraints}
- Fix the code so it passes validation and dry-run.
"""
    user_prompt = (
        f"The current generated skill failed.\n\n"
        f"Error:\n{error_message.strip()}\n\n"
        f"Current code:\n```python\n{current_code.strip()}\n```"
    )
    return system_prompt, user_prompt


_FORGE_BLOCKED_IMPORTS = {
    "os", "subprocess", "sys", "shutil", "socket", "ctypes", "signal",
    "multiprocessing", "threading", "pathlib", "importlib",
    "pickle", "shelve", "marshal", "code", "codeop", "compileall",
    "http.server", "xmlrpc", "ftplib", "smtplib", "telnetlib",
}

# Modules allowed when allow_network=True (needed for HTTP/web skills)
_FORGE_NETWORK_ALLOWED = {"socket", "ssl", "http", "urllib"}

# Regex patterns for dangerous builtin calls (word-boundary aware to avoid
# false positives like "urlopen" matching "open").
_FORGE_BLOCKED_BUILTIN_PATTERNS = [
    (r'\b__import__\b',  '__import__'),
    (r'(?<!\w)exec\s*\(', 'exec'),
    (r'(?<!\w)eval\s*\(', 'eval'),
    (r'(?<!\w)compile\s*\(', 'compile'),
    (r'(?<!\w)globals\s*\(', 'globals'),
    (r'(?<!\w)locals\s*\(', 'locals'),
    (r'(?<!\w)getattr\s*\(', 'getattr'),
    (r'(?<!\w)setattr\s*\(', 'setattr'),
    (r'(?<!\w)delattr\s*\(', 'delattr'),
    (r'(?<!\w)open\s*\(', 'open'),
]


def _validate_skill_code(code: str, allow_network: bool = False) -> Tuple[bool, str]:
    """Verifică că codul conține o clasă cu execute(input) -> dict, plus import safety.
    When allow_network=True, socket/urllib/http/ssl imports are permitted."""
    if "def execute(" not in code or "class " not in code:
        return False, "Code must define a class with execute(input_data: dict) -> dict."
    if "execute" not in code or "return" not in code:
        return False, "execute() must return a dict (e.g. success, message)."
    # --- Security: block dangerous imports ---
    blocked = _FORGE_BLOCKED_IMPORTS - _FORGE_NETWORK_ALLOWED if allow_network else _FORGE_BLOCKED_IMPORTS
    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # Check 'import X' and 'from X import ...'
        m = re.match(r'(?:from\s+(\S+)|import\s+(\S+))', stripped)
        if m:
            mod_name = (m.group(1) or m.group(2)).split(".")[0]
            if mod_name in blocked:
                return False, f"Import of '{mod_name}' is not allowed in skills for security reasons."
            # Always block http.server even with allow_network
            full_mod = (m.group(1) or m.group(2))
            if full_mod == "http.server":
                return False, "Import of 'http.server' is not allowed in skills for security reasons."
    # Check dangerous builtins (word-boundary aware)
    for pattern, label in _FORGE_BLOCKED_BUILTIN_PATTERNS:
        if re.search(pattern, code):
            return False, f"Use of '{label}' is not allowed in skills for security reasons."
    return True, ""


def _sanitize_filename(name: str) -> str:
    """Nume sigur pentru fișier."""
    s = re.sub(r"[^\w\s-]", "", name)[:40].strip() or "skill"
    return re.sub(r"[-\s]+", "_", s).lower()


def _extract_skill_name_from_code(code: str) -> str:
    """Extrage atributul name = \"...\" din cod (clasa skill). Folosit pentru numele fișierului."""
    m = re.search(r'\bname\s*=\s*["\']([^"\']+)["\']', code)
    if m:
        return _sanitize_filename(m.group(1))
    return ""


def _log(title: str, msg: str):
    try:
        from brain import log_line
        log_line("ha", "🔧", title, msg)
    except Exception:
        pass


def _runtime_network_enabled() -> bool:
    """True when generated skills are allowed to run with network policy at runtime."""
    try:
        import settings as _settings
        searxng_cfg = _settings.CFG.get("searxng") or {}
        return bool(searxng_cfg.get("enabled") and (searxng_cfg.get("url") or "").strip())
    except Exception:
        return False


def _infer_allow_network(*texts: Optional[str]) -> bool:
    """Infer whether a skill needs network policy and whether runtime can support it."""
    if not _runtime_network_enabled():
        return False
    haystack = "\n".join(t for t in texts if t).lower()
    network_markers = (
        "import urllib", "from urllib", "urllib.",
        "import socket", "from socket", "socket.",
        "import ssl", "from ssl", "ssl.",
        "import http", "from http", "http.client",
        "_searxng_url", "urlopen(", "create_connection(",
        "http://", "https://",
        "blocked by sandbox policy 'standard'", "blocked by the sandbox policy",
    )
    return any(marker in haystack for marker in network_markers)


def _load_snippets() -> Dict[str, str]:
    """Încarcă snippet-uri din skills/snippets/*.py (nume = filename fără .py)."""
    out = {}
    if not os.path.isdir(SNIPPETS_DIR):
        return out
    for f in sorted(os.listdir(SNIPPETS_DIR)):
        if not f.endswith(".py") or f.startswith("_"):
            continue
        path = os.path.join(SNIPPETS_DIR, f)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fp:
                out[os.path.splitext(f)[0]] = fp.read().strip()
        except Exception:
            pass
    return out


def _run_skill_code_dry_run(code: str, timeout: int = FORGE_DRY_RUN_TIMEOUT,
                           allow_network: bool = False) -> Tuple[bool, str]:
    """
    Sandboxed dry-run via _sandbox_runner.py: writes code to a temp file,
    runs execute({}) in a subprocess with resource limits and import restrictions.
    Uses 'network' policy when allow_network=True (skill needs urllib for HTTP).
    Returns (ok, error_msg).
    """
    import sys as _sys
    runner_path = os.path.join(SKILLS_DIR, "_sandbox_runner.py")
    fd, path = tempfile.mkstemp(suffix=".py", prefix="forge_dry_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(code)

        env = os.environ.copy()
        for sensitive_key in ("HOME_ASSISTANT_TOKEN", "OPENAI_API_KEY", "LLM_API_KEY",
                              "DATABASE_URL", "SECRET_KEY", "JWT_SECRET"):
            env.pop(sensitive_key, None)

        policy = "network" if allow_network else "standard"
        cmd = [
            _sys.executable, runner_path,
            "--skill-path", path,
            "--policy", policy,
            "--dry-run",
        ]

        with tempfile.TemporaryDirectory(prefix="forge_sandbox_") as sandbox_dir:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=sandbox_dir,
                env=env,
            )

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip() or "execute() failed or timed out"
            return False, err[:500]
        return True, ""
    except subprocess.TimeoutExpired:
        return False, f"Dry run timed out ({timeout}s)"
    except Exception as e:
        return False, str(e)[:500]
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


def _save_version(skill_filename: str, code: str) -> None:
    """Salvează o copie în __versions__/skillname_YYYYMMDD_HHMMSS.py."""
    os.makedirs(VERSIONS_DIR, exist_ok=True)
    base = os.path.splitext(skill_filename)[0]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    version_path = os.path.join(VERSIONS_DIR, f"{base}_{ts}.py")
    try:
        with open(version_path, "w", encoding="utf-8") as f:
            f.write(code)
        # Păstrăm doar ultimele N versiuni per skill
        prefix = base + "_"
        existing = [f for f in os.listdir(VERSIONS_DIR) if f.startswith(prefix) and f.endswith(".py")]
        existing.sort(reverse=True)
        for f in existing[MAX_VERSIONS_PER_SKILL:]:
            try:
                os.unlink(os.path.join(VERSIONS_DIR, f))
            except Exception:
                pass
    except Exception:
        pass


def list_skill_versions(skill_name: str) -> List[Dict[str, Any]]:
    """Listează versiunile salvate pentru un skill generat. Fiecare: {id, path, timestamp}."""
    base = _sanitize_filename(skill_name)
    prefix = base + "_"
    out = []
    if not os.path.isdir(VERSIONS_DIR):
        return out
    for f in sorted(os.listdir(VERSIONS_DIR), reverse=True):
        if not f.startswith(prefix) or not f.endswith(".py"):
            continue
        path = os.path.join(VERSIONS_DIR, f)
        if not os.path.isfile(path):
            continue
        ts = f[len(prefix):-3]  # YYYYMMDD_HHMMSS
        out.append({"id": ts, "path": path, "timestamp": ts})
    return out[:MAX_VERSIONS_PER_SKILL]


def restore_skill_version(skill_name: str, version_id: str) -> Tuple[bool, str]:
    """Restaurează o versiune (version_id = YYYYMMDD_HHMMSS). Returnează (ok, message)."""
    base = _sanitize_filename(skill_name)
    version_path = os.path.join(VERSIONS_DIR, f"{base}_{version_id}.py")
    if not os.path.isfile(version_path):
        return False, "Version not found."
    try:
        with open(version_path, "r", encoding="utf-8") as f:
            code = f.read()
    except Exception as e:
        return False, str(e)
    ok, err = _validate_skill_code(code)
    if not ok:
        return False, f"Version invalid: {err}"
    filepath = os.path.join(SKILLS_GENERATED, base + ".py")
    os.makedirs(SKILLS_GENERATED, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(code)
    try:
        import skills as skills_mod
        skills_mod._REGISTRY = None
    except Exception:
        pass
    return True, f"Restored {skill_name} to version {version_id}."


def _coder_headers(cfg: Dict[str, Any]) -> dict:
    """Headers for Coder. Z.AI docs: Content-Type, Authorization, Accept-Language."""
    api_key = (cfg.get("api_key") or "").strip()
    headers = {"Content-Type": "application/json", "Accept-Language": "en-US,en"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _normalize_coder_url(url: str) -> str:
    """Append /chat/completions for Z.AI Coding (and similar) base URLs."""
    u = (url or "").strip()
    if not u or "chat/completions" in u or "chat/" in u:
        return u
    base = u.rstrip("/")
    if base.endswith("/v4") or base.endswith("/v1"):
        return base + "/chat/completions"
    return u


async def _call_coder(messages: List[Dict[str, str]], cfg: Dict[str, Any]) -> Tuple[bool, str, str]:
    """Apelează Coder cu messages. Returnează (ok, raw_content, error_msg). Retry la 429 (rate limit)."""
    return await _call_coder_with_stream(messages, cfg)


async def _maybe_emit_stream_callback(callback: Optional[Callable[[str, str], None]], full_text: str, delta: str) -> None:
    if not callback:
        return
    try:
        result = callback(full_text, delta)
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        pass


async def _call_coder_with_stream(
    messages: List[Dict[str, str]],
    cfg: Dict[str, Any],
    stream_callback: Optional[Callable[[str, str], None]] = None,
) -> Tuple[bool, str, str]:
    """Call coder with optional streaming callback receiving (full_text, delta)."""
    forge_timeout = float(cfg.get("timeout") or DEFAULT_FORGE_TIMEOUT)
    headers = _coder_headers(cfg)
    coder_url = _normalize_coder_url(cfg.get("target_url") or "")
    payload = {
        "model": cfg["model_name"],
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 2000,
        "stream": bool(stream_callback),
        "thinking": {"type": "disabled"},
    }
    last_resp = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=forge_timeout) as client:
                if stream_callback:
                    raw_parts: List[str] = []
                    async with client.stream("POST", coder_url, json=payload, headers=headers) as resp:
                        if resp.status_code != 200:
                            err_text = (await resp.aread()).decode(errors="replace")[:500]
                            last_resp = resp
                            body_text = err_text
                            api_msg = ""
                            try:
                                j = json.loads(body_text) if body_text else {}
                                err = j.get("error") or j
                                if isinstance(err, dict):
                                    api_msg = err.get("message") or err.get("msg") or ""
                            except Exception:
                                api_msg = body_text.strip()[:200] if body_text else ""
                            msg = f"Coder API error {resp.status_code}"
                            if api_msg:
                                msg = f"Coder {resp.status_code}: {api_msg}"
                            elif resp.status_code == 429:
                                msg = "Coder 429 (rate limit or insufficient quota). Check Z.AI Usage / plan for Coding."
                            try:
                                from logger import log_line
                                log_line("agent", "⚠️", "CODER API", msg)
                            except Exception:
                                pass
                            if resp.status_code == 429 and attempt == 0:
                                await asyncio.sleep(5)
                                continue
                            return False, "", msg

                        async for line in resp.aiter_lines():
                            parts = [p.strip() for p in (line or "").strip().split("data:") if p.strip()]
                            for data_str in parts:
                                if data_str == "[DONE]":
                                    continue
                                try:
                                    chunk = json.loads(data_str)
                                except json.JSONDecodeError:
                                    continue
                                if isinstance(chunk.get("error"), (dict, str)):
                                    err_detail = chunk["error"]
                                    if isinstance(err_detail, dict):
                                        err_detail = err_detail.get("message") or json.dumps(err_detail, ensure_ascii=False)
                                    return False, "", f"Coder SSE: {err_detail}"
                                choice = (chunk.get("choices") or [{}])[0] if isinstance((chunk.get("choices") or [{}])[0], dict) else {}
                                delta = choice.get("delta") or {}
                                content = delta.get("content") or ""
                                if isinstance(content, list):
                                    content = "".join(
                                        part.get("text", "") if isinstance(part, dict) else str(part or "")
                                        for part in content
                                    )
                                if not isinstance(content, str):
                                    content = str(content or "")
                                if content:
                                    raw_parts.append(content)
                                    await _maybe_emit_stream_callback(stream_callback, "".join(raw_parts), content)
                    raw = "".join(raw_parts)
                    if raw:
                        return True, raw, ""
                    return False, "", "Coder returned empty content"

                last_resp = await client.post(coder_url, json=payload, headers=headers)
        except (httpx.TimeoutException, asyncio.TimeoutError):
            raise

        if last_resp.status_code == 200:
            break
        if last_resp.status_code == 429 and attempt == 0:
            await asyncio.sleep(5)
            continue
        break
    resp = last_resp
    if resp.status_code != 200:
        body_text = ""
        try:
            body_text = resp.text[:500] if resp.text else ""
        except Exception:
            pass
        api_msg = ""
        try:
            j = resp.json() if body_text else {}
            err = j.get("error") or j
            if isinstance(err, dict):
                api_msg = err.get("message") or err.get("msg") or ""
        except Exception:
            api_msg = body_text.strip()[:200] if body_text else ""
        msg = f"Coder API error {resp.status_code}"
        if api_msg:
            msg = f"Coder {resp.status_code}: {api_msg}"
        else:
            if resp.status_code == 429:
                msg = "Coder 429 (rate limit or insufficient quota). Check Z.AI Usage / plan for Coding."
        try:
            from logger import log_line
            log_line("agent", "⚠️", "CODER API", msg)
        except Exception:
            pass
        return False, "", msg
    try:
        data = resp.json()
    except Exception as e:
        return False, "", f"Coder response not JSON: {e}"
    raw = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not raw:
        return False, "", "Coder returned empty content"
    return True, raw, ""


def _build_create_prompt(
    user_request: str,
    name_hint: Optional[str] = None,
    inputs_hint: Optional[str] = None,
    allow_network: bool = False,
) -> Tuple[str, str]:
    """Construiește system și user prompt pentru creare skill."""
    template_src = _read_template()
    snippets = _load_snippets()
    # SearXNG: when enabled + allow_network → skills must use app-injected _search_web, not direct HTTP
    try:
        import settings as _settings
        searxng_cfg = _settings.CFG.get("searxng") or {}
        searxng_enabled = bool(searxng_cfg.get("enabled"))
        searxng_url = (searxng_cfg.get("url") or "").strip()
        if not searxng_enabled or not searxng_url or not allow_network:
            snippets.pop("searxng_http", None)
            snippets.pop("search_via_app", None)
        elif allow_network:
            # Force Forge to use search_via_app only (no URL/auth in skill)
            snippets.pop("searxng_http", None)
    except Exception:
        snippets.pop("searxng_http", None)
        snippets.pop("search_via_app", None)
    try:
        import settings as _settings
        searxng_cfg = _settings.CFG.get("searxng") or {}
        if snippets.get("searxng_http") and (searxng_cfg.get("url") or "").strip():
            snippets["searxng_http"] = snippets["searxng_http"].replace(
                "{{SEARXNG_APP_URL}}",
                (searxng_cfg.get("url") or "").strip(),
            )
    except Exception:
        pass
    snippets_block = ""
    if snippets:
        snippets_block = "\n\nOPTIONAL SNIPPETS (use if relevant; adapt to your class):\n" + "\n---\n".join(
            f"[{name}]\n{content}" for name, content in snippets.items()
        )
    search_refusal = ""
    search_use_app = ""
    if "searxng_http" not in snippets and "search_via_app" not in snippets:
        search_refusal = "\n- If the user request requires web search or SearXNG (e.g. search news, search web), output exactly: CANNOT_SEARXNG_DISABLED"
    if "search_via_app" in snippets:
        search_use_app = (
            "\n- For web/search tasks: the app injects input_data['_searxng_url'] (a string URL) at runtime."
            "\n  Use urllib.request + urllib.parse (stdlib) to query it. Do NOT use httpx/requests."
            "\n  Example: url = f\"{input_data['_searxng_url'].rstrip('/')}/search?\" + urllib.parse.urlencode({'q': query, 'format': 'json'})"
            "\n  Then urllib.request.urlopen(url, timeout=10) → json.loads → results."
        )

    constraints = "Use only Python standard library (no pip, no third-party packages). No network/socket/urllib access."
    if allow_network:
        constraints = (
            "You may use socket, urllib.request, http.client, ssl (standard library) for network access. "
            "No third-party packages. For web search, use input_data.get('_searxng_url') with urllib.request."
        )

    system_prompt = f"""You are a Python code generator. Output ONLY valid Python code. No explanations, no "Final Review", no text before or after the code.

TEMPLATE (follow this structure):
{template_src}

RULES:
- One class with static method: execute(input_data: dict) -> dict.
- input_data has string values (e.g. "query", "user_id").
- Return dict with at least "success": bool and "message": str; optional "data": dict.
- Set class attributes: name = "skill_name", description = "What it does."
- Skills are self-contained sandboxed Python. Do NOT call app/agent tools like run_shell, search_web, read_web_page, control_device, or allow_shell from inside the skill.
- {constraints}
{snippets_block}
{search_refusal}
{search_use_app}

OUTPUT FORMAT: Output exactly one ```python block with the full code. Nothing else. No commentary before or after."""

    user_parts = [f"Generate a skill that does the following.\n\nRequirement: {user_request.strip()}"]
    if name_hint:
        user_parts.append(f"Suggested name: {name_hint.strip()}.")
    if inputs_hint:
        user_parts.append(f"Inputs the skill will receive: {inputs_hint.strip()}.")
    user_prompt = "\n".join(user_parts)
    return system_prompt, user_prompt


async def run_forge(
    user_request: str,
    save: bool = True,
    name_hint: Optional[str] = None,
    inputs_hint: Optional[str] = None,
    allow_network: bool = False,
    status_callback: Optional[Callable[[str, str], None]] = None,
    preview_callback: Optional[Callable[[str, bool], None]] = None,
) -> Tuple[bool, str, Optional[str]]:
    """
    Pipeline: user_request → Coder → cod → validare → dry-run test → [salvare + versionare].
    status_callback(type, label) is called at each step for UI (e.g. chat status steps).
    """
    def _status(t: str, label: str) -> None:
        if status_callback:
            try:
                status_callback(t, label)
            except Exception:
                pass

    def _preview(code: str, done: bool = False) -> None:
        if preview_callback is None:
            return
        try:
            preview_callback(code, done)
        except Exception:
            pass

    _log("FORGE", f"Starting pipeline for: {user_request[:60]}...")
    _status("forge_start", "Pornind Forge...")
    if not user_request or len(user_request.strip()) < 3:
        _log("FORGE", "Aborted: request too short.")
        return False, "Forge: request too short.", None

    from brain import get_coder_cfg
    cfg = get_coder_cfg()
    if not cfg.get("target_url") or not cfg.get("model_name"):
        _log("FORGE", "Aborted: No model configured (Coder or main LLM).")
        return False, "Forge: Nici modelul Coder, nici modelul principal (LLM) nu sunt configurate. Setări → Modele.", None

    try:
        system_prompt, user_prompt = _build_create_prompt(user_request, name_hint, inputs_hint, allow_network)
        _log("FORGE", f"Calling Coder ({cfg.get('model_name', '?')})...")
        _status("forge_coder", f"Apel Coder ({cfg.get('model_name', '?')})...")
        last_preview = ""

        async def _on_stream(full_raw: str, _delta: str) -> None:
            nonlocal last_preview
            preview = _extract_python_preview(full_raw)
            if preview and preview != last_preview:
                last_preview = preview
                _preview(preview, False)

        code = ""
        raw = ""
        last_error = ""
        max_attempts = 3

        for attempt in range(max_attempts):
            if attempt == 0:
                req_messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}]
            else:
                repair_system, repair_user = _build_repair_prompt(code or last_preview or raw, last_error, allow_network)
                _log("FORGE", f"Repair attempt {attempt}/{max_attempts - 1}...")
                _status("forge_repair", f"Reparare cod ({attempt}/{max_attempts - 1})...")
                req_messages = [{"role": "system", "content": repair_system}, {"role": "user", "content": repair_user}]

            ok, raw, err = await _call_coder_with_stream(
                req_messages,
                cfg,
                stream_callback=_on_stream,
            )
            if not ok:
                _log("FORGE FAIL", err or "Coder error")
                return False, f"Forge: {err}", None

            if "CANNOT_SEARXNG_DISABLED" in (raw or ""):
                _log("FORGE", "Coder refused: SearXNG not enabled")
                return False, "Cannot create this skill: SearXNG is not enabled. Enable it in Setări → Integrări → SearXNG.", None

            code = _extract_python_block(raw)
            if not code:
                _log("FORGE RAW", (raw or "")[:300].replace("\n", " "))
                last_error = "No valid Python code in Coder response (expected single ```python block)."
                if attempt < max_attempts - 1:
                    continue
                return False, f"Forge: {last_error}", None

            _preview(code, True)

            _log("FORGE", "Code received, validating...")
            _status("forge_validate", "Validare cod...")
            ok, err = _validate_skill_code(code, allow_network=allow_network)
            if not ok:
                last_error = f"Invalid skill. {err}"
                _log("FORGE FAIL", err or "Validation failed")
                if attempt < max_attempts - 1:
                    continue
                return False, f"Forge: {last_error}", None

            _log("FORGE", "Dry-run test (execute with empty input)...")
            _status("forge_dryrun", "Test dry-run...")
            ok, dry_err = _run_skill_code_dry_run(code, allow_network=allow_network)
            if not ok:
                last_error = f"Skill failed dry-run test. {dry_err}"
                _log("FORGE FAIL", f"Dry run: {dry_err}")
                if attempt < max_attempts - 1:
                    continue
                return False, f"Forge: {last_error}", None

            break

        name_from_code = _extract_skill_name_from_code(code)
        filename = (name_from_code + ".py") if name_from_code else _sanitize_filename(user_request[:30]) + ".py"

        if not save:
            return True, code, filename

        filepath = os.path.join(SKILLS_GENERATED, filename)
        os.makedirs(SKILLS_GENERATED, exist_ok=True)
        _status("forge_save", "Salvare skill...")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(code)
        _save_version(filename, code)
        try:
            import skills as skills_mod
            skills_mod._REGISTRY = None
        except Exception:
            pass
        _log("FORGE", f"Skill created and saved: {filename}")
        _status("forge_done", f"Skill salvat: {filename}")
        return True, f"SUCCESS: Skill created and saved as '{filename}'. It appears in Skills now.", None
    except (httpx.TimeoutException, asyncio.TimeoutError) as e:
        msg = str(e) or "Request timed out"
        _log("FORGE FAIL", f"Timeout: {msg}")
        return False, f"Forge: Coder request timed out. Increase intelligence.coder.timeout or use a faster model.", None
    except Exception as e:
        msg = str(e) or f"{type(e).__name__}"
        _log("FORGE FAIL", msg)
        return False, f"Forge error: {msg}", None


async def run_forge_edit(skill_name: str, instruction: str) -> Tuple[bool, str]:
    """Modifică un skill existent: încarcă sursa, trimite la Coder cu instrucțiunea, validează, test, salvează."""
    import skills as skills_mod
    current = skills_mod.get_skill_source(skill_name)
    if not current:
        return False, f"Forge: Skill '{skill_name}' not found."
    from brain import get_coder_cfg
    cfg = get_coder_cfg()
    if not cfg.get("target_url") or not cfg.get("model_name"):
        return False, "Forge: Coder not configured."
    allow_network = _infer_allow_network(current, instruction)
    constraints = "Use only Python standard library (no pip, no third-party packages). No network/socket/urllib access."
    if allow_network:
        constraints = "You may use socket, urllib.request, http.client, ssl (standard library) for network access. No third-party packages."
    system = f"""You are a Python code editor. You will receive current code and an instruction to modify it.
Output ONLY the full modified Python code in a single ```python block. No explanations, no "Final Review", nothing else.
Keep the same structure: one class with name, description, and static execute(input_data: dict) -> dict.
Return dict with "success", "message", and optionally "data".
Skills are self-contained sandboxed Python. Do NOT call app/agent tools like run_shell, search_web, read_web_page, control_device, or allow_shell from inside the skill.
{constraints}"""
    user = f"Current code:\n```python\n{current}\n```\n\nModify it as follows: {instruction.strip()}"
    ok, raw, err = await _call_coder(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        cfg,
    )
    if not ok:
        return False, f"Forge edit: {err}"
    code = _extract_python_block(raw)
    if not code:
        return False, "Forge edit: No valid Python block in Coder response."
    ok, err = _validate_skill_code(code, allow_network=allow_network)
    if not ok:
        return False, f"Forge edit: Invalid code. {err}"
    ok, dry_err = _run_skill_code_dry_run(code, allow_network=allow_network)
    if not ok:
        return False, f"Forge edit: Modified skill failed dry-run. {dry_err}"
    for s in skills_mod.get_skill_registry_with_classes():
        if s["name"] == skill_name:
            path = s["path"]
            if not path or "generated" not in path:
                return False, "Forge edit: Can only overwrite generated skills. Use Skills UI to edit built-in."
            with open(path, "w", encoding="utf-8") as f:
                f.write(code)
            _save_version(os.path.basename(path), code)
            skills_mod._REGISTRY = None
            return True, f"Skill '{skill_name}' updated successfully."
    return False, f"Skill '{skill_name}' not found in registry."


async def run_forge_improve(skill_name: str, error_message: str) -> Tuple[bool, str]:
    """Îmbunătățește un skill după eșec: trimite la Coder eroarea + codul curent, primește fix."""
    import skills as skills_mod
    current = skills_mod.get_skill_source(skill_name)
    if not current:
        return False, f"Forge: Skill '{skill_name}' not found."
    from brain import get_coder_cfg
    cfg = get_coder_cfg()
    if not cfg.get("target_url") or not cfg.get("model_name"):
        return False, "Forge: Coder not configured."
    allow_network = _infer_allow_network(current, error_message)
    system, user = _build_repair_prompt(current, error_message, allow_network=allow_network)
    ok, raw, err = await _call_coder(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        cfg,
    )
    if not ok:
        return False, f"Forge improve: {err}"
    code = _extract_python_block(raw)
    if not code:
        return False, "Forge improve: No valid Python block in Coder response."
    ok, err = _validate_skill_code(code, allow_network=allow_network)
    if not ok:
        return False, f"Forge improve: Invalid code. {err}"
    ok, dry_err = _run_skill_code_dry_run(code, allow_network=allow_network)
    if not ok:
        return False, f"Forge improve: Fixed skill still failed dry-run. {dry_err}"
    for s in skills_mod.get_skill_registry_with_classes():
        if s["name"] == skill_name:
            path = s["path"]
            if not path or "generated" not in path:
                return False, "Forge improve: Can only overwrite generated skills."
            with open(path, "w", encoding="utf-8") as f:
                f.write(code)
            _save_version(os.path.basename(path), code)
            skills_mod._REGISTRY = None
            return True, f"Skill '{skill_name}' fixed and saved."
    return False, f"Skill '{skill_name}' not found."


def run_forge_confirm(code: str, suggested_filename: str) -> Tuple[bool, str]:
    """Salvează codul generat (după preview). Validează, dry-run, versionare, salvare."""
    if not code or not suggested_filename.strip():
        return False, "Missing code or filename."
    fn = suggested_filename.strip()
    if not fn.endswith(".py"):
        fn = fn + ".py"
    fn = _sanitize_filename(os.path.splitext(fn)[0]) + ".py"
    ok, err = _validate_skill_code(code)
    if not ok:
        return False, f"Invalid skill: {err}"
    ok, dry_err = _run_skill_code_dry_run(code)
    if not ok:
        return False, f"Skill failed dry-run: {dry_err}"
    filepath = os.path.join(SKILLS_GENERATED, fn)
    os.makedirs(SKILLS_GENERATED, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(code)
    _save_version(fn, code)
    try:
        import skills as skills_mod
        skills_mod._REGISTRY = None
    except Exception:
        pass
    return True, f"Skill saved as '{fn}'."
