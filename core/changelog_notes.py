"""Read release note sections from CHANGELOG.md (shared by publish + Updates UI)."""

from __future__ import annotations

import re
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
CHANGELOG = _PROJECT_ROOT / "CHANGELOG.md"


def changelog_section(version: str, changelog_path: Path | None = None) -> str:
    """Return the markdown body for ``## [version]`` or empty string."""
    path = changelog_path or CHANGELOG
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^## \[{re.escape(str(version).strip())}\][^\n]*\n(.*?)(?=^## \[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(text)
    if not match:
        return ""
    return match.group(1).strip()
