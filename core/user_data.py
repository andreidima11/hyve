"""Paths and helpers for post-install user data (never committed to git).

Dashboard pages, device aliases, automation YAML, generated skills, etc. live
under these directories on disk. ``reset_user_data()`` wipes them for
``install_hyve.py --fresh`` or manual recovery.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Bundled skill modules kept in the repo (everything else under skills/ is local).
_SKILLS_KEEP = frozenset({"__init__.py", "_sandbox_runner.py", "template.py"})


def reset_user_data() -> list[str]:
    """Delete user-created files. Returns human-readable log lines."""
    removed: list[str] = []

    dashboards = ROOT / "dashboards"
    if dashboards.is_dir():
        for path in dashboards.iterdir():
            if path.name in {".gitkeep", "README.md"}:
                continue
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
                removed.append(f"dashboards/{path.name}/")
            else:
                path.unlink(missing_ok=True)
                removed.append(f"dashboards/{path.name}")

    aliases = ROOT / "config" / "device_aliases.yaml"
    if aliases.is_file():
        aliases.unlink()
        removed.append("config/device_aliases.yaml")

    automations = ROOT / "core" / "automations"
    if automations.is_dir():
        for path in automations.iterdir():
            if path.name in {".gitkeep", "README.md"}:
                continue
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
                removed.append(f"core/automations/{path.name}/")
            elif path.suffix == ".yaml":
                path.unlink(missing_ok=True)
                removed.append(f"core/automations/{path.name}")

    skills_dir = ROOT / "skills"
    if skills_dir.is_dir():
        for path in skills_dir.iterdir():
            if path.name == "snippets":
                continue
            if path.name == "generated" and path.is_dir():
                for child in path.rglob("*"):
                    if child.name == ".gitkeep":
                        continue
                    if child.is_file():
                        child.unlink(missing_ok=True)
                for child in sorted(path.rglob("*"), reverse=True):
                    if child.is_dir() and not any(child.iterdir()):
                        child.rmdir()
                removed.append("skills/generated/")
                continue
            if path.is_file() and path.suffix == ".py" and path.name not in _SKILLS_KEEP:
                path.unlink(missing_ok=True)
                removed.append(f"skills/{path.name}")

    return removed
