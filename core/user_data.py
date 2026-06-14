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
_KEEP_NAMES = frozenset({".gitkeep", "README.md"})
_GENERATED_MEDIA_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"})


def _clear_user_dir(root: Path, *, keep_names: frozenset[str] = _KEEP_NAMES) -> list[str]:
    """Remove everything under ``root`` except ``keep_names`` entries."""
    removed: list[str] = []
    if not root.is_dir():
        return removed
    for path in root.iterdir():
        if path.name in keep_names:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            removed.append(f"{root.name}/{path.name}/")
        else:
            path.unlink(missing_ok=True)
            removed.append(f"{root.name}/{path.name}")
    return removed


def reset_user_data() -> list[str]:
    """Delete user-created files. Returns human-readable log lines."""
    removed: list[str] = []

    removed.extend(_clear_user_dir(ROOT / "dashboards"))

    aliases = ROOT / "config" / "device_aliases.yaml"
    if aliases.is_file():
        aliases.unlink()
        removed.append("config/device_aliases.yaml")

    removed.extend(_clear_user_dir(ROOT / "core" / "automations"))
    removed.extend(_clear_user_dir(ROOT / "comfyui_workflows"))

    generated = ROOT / "static" / "generated"
    if generated.is_dir():
        for path in generated.iterdir():
            if path.name in _KEEP_NAMES or path.name == "vendor":
                continue
            if path.is_file() and path.suffix.lower() in _GENERATED_MEDIA_SUFFIXES:
                path.unlink(missing_ok=True)
                removed.append(f"static/generated/{path.name}")
            elif path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
                removed.append(f"static/generated/{path.name}/")

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
