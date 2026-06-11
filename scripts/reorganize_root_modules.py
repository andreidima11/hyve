#!/usr/bin/env python3
"""Move root Python modules into core/ and brain/; rewrite imports."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# module_name -> dotted package path
MODULE_MAP: dict[str, str] = {
    "env_bootstrap": "core.env_bootstrap",
    "settings": "core.settings",
    "database": "core.database",
    "models": "core.models",
    "logger": "core.logger",
    "storage": "core.storage",
    "auth": "core.auth",
    "datetime_utils": "core.datetime_utils",
    "task_utils": "core.task_utils",
    "server_restart": "core.server_restart",
    "area_resolver": "core.area_resolver",
    "device_resolver": "core.device_resolver",
    "derived_entities": "core.derived_entities",
    "smart_home_registry": "core.smart_home_registry",
    "ui_catalog": "core.ui_catalog",
    "automation_definitions": "core.automation_definitions",
    "assist_keys": "core.assist_keys",
    "push_fcm": "core.push_fcm",
    "cctv_capture": "core.cctv_capture",
    "scheduler_service": "core.scheduler_service",
    "intent_router": "brain.intent_router",
    "memory_context": "brain.memory_context",
    "llm_client": "brain.llm_client",
    "direct_commands": "brain.direct_commands",
    "comfyui": "integrations.shims.comfyui",
    "forge": "integrations.shims.forge",
}

MOVES: list[tuple[str, str]] = [
    ("env_bootstrap.py", "core/env_bootstrap.py"),
    ("settings.py", "core/settings.py"),
    ("database.py", "core/database.py"),
    ("models.py", "core/models.py"),
    ("logger.py", "core/logger.py"),
    ("storage.py", "core/storage.py"),
    ("auth.py", "core/auth.py"),
    ("datetime_utils.py", "core/datetime_utils.py"),
    ("task_utils.py", "core/task_utils.py"),
    ("server_restart.py", "core/server_restart.py"),
    ("area_resolver.py", "core/area_resolver.py"),
    ("device_resolver.py", "core/device_resolver.py"),
    ("derived_entities.py", "core/derived_entities.py"),
    ("smart_home_registry.py", "core/smart_home_registry.py"),
    ("ui_catalog.py", "core/ui_catalog.py"),
    ("automation_definitions.py", "core/automation_definitions.py"),
    ("assist_keys.py", "core/assist_keys.py"),
    ("push_fcm.py", "core/push_fcm.py"),
    ("cctv_capture.py", "core/cctv_capture.py"),
    ("scheduler_service.py", "core/scheduler_service.py"),
    ("intent_router.py", "brain/intent_router.py"),
    ("memory_context.py", "brain/memory_context.py"),
    ("llm_client.py", "brain/llm_client.py"),
    ("direct_commands.py", "brain/direct_commands.py"),
    ("comfyui.py", "integrations/shims/comfyui.py"),
    ("forge.py", "integrations/shims/forge.py"),
    ("_extract_bytecode.py", "scripts/_extract_bytecode.py"),
    ("_extract_functions.py", "scripts/_extract_functions.py"),
]

ORDERED = sorted(MODULE_MAP, key=len, reverse=True)


def _rewrite_import_line(line: str) -> str:
    if line.lstrip().startswith("#"):
        return line
    if re.search(r"\bfrom routers import\b", line):
        return line
    out = line
    for mod in ORDERED:
        target = MODULE_MAP[mod]
        out = re.sub(rf"\bfrom {mod}\b", f"from {target}", out)
        out = re.sub(rf"\bimport {mod} as (\w+)\b", rf"import {target} as \1", out)
        out = re.sub(rf"\bimport {mod}\b", f"import {target} as {mod}", out)
    return out


def rewrite_file(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    lines = text.splitlines(keepends=True)
    new_lines = [_rewrite_import_line(ln) for ln in lines]
    new_text = "".join(new_lines)
    if new_text != text:
        path.write_text(new_text, encoding="utf-8")
        return True
    return False


def move_files() -> None:
    (ROOT / "integrations/shims").mkdir(parents=True, exist_ok=True)
    init = ROOT / "integrations/shims/__init__.py"
    if not init.exists():
        init.write_text('"""Legacy component import shims."""\n', encoding="utf-8")
    for src, dst in MOVES:
        s, d = ROOT / src, ROOT / dst
        if not s.exists():
            if d.exists():
                continue
            raise SystemExit(f"missing source: {src}")
        if d.exists():
            continue
        d.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "mv", str(s), str(d)], cwd=ROOT, check=True)


def rewrite_tree() -> int:
    changed = 0
    for path in ROOT.rglob("*.py"):
        if any(p in path.parts for p in (".venv", "venv", "node_modules", "site-packages")):
            continue
        if rewrite_file(path):
            changed += 1
    return changed


def main() -> None:
    move_files()
    n = rewrite_tree()
    print(f"Rewrote imports in {n} files")


if __name__ == "__main__":
    main()
