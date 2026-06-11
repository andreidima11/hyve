#!/usr/bin/env python3
"""Split static/js/features_sessions.ts into static/js/sessions/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_sessions.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/sessions"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


TYPES = chunk(7, 14).replace("interface ", "export interface ")

RENDER = fix_imports(
    """/**
 * Chat sessions — delete confirm button HTML.
 */
import { t } from '../lang/index.js';
import { escapeHtml } from '../utils.js';

"""
    + chunk(142, 161).replace("function _sessionDeleteWrapHtml", "export function sessionDeleteWrapHtml", 1).replace(
        "function _sessionDeleteButtonHtml", "export function sessionDeleteButtonHtml", 1
    )
)

PAGE = (
    fix_imports(chunk(1, 5))
    + """
import type { SessionDetail, SessionSummary } from './types.js';
import { sessionDeleteButtonHtml, sessionDeleteWrapHtml } from './render.js';

"""
    + chunk(16, 141)
    + chunk(163, 199).replace("_sessionDeleteWrapHtml", "sessionDeleteWrapHtml").replace(
        "_sessionDeleteButtonHtml", "sessionDeleteButtonHtml"
    )
    + chunk(201, 240)
)

FACADE = """/**
 * Chat sessions sidebar — list, open, create, delete, clear context.
 */
export {
    loadSessionsList,
    openSession,
    newChatSession,
    deleteSession,
    cancelDeleteSession,
    confirmDeleteSession,
    clearSessionContext,
} from './sessions/page.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "types.ts").write_text(TYPES)
    (OUT / "render.ts").write_text(RENDER)
    (OUT / "page.ts").write_text(PAGE)
    (ROOT / "static/js/features_sessions.ts").write_text(FACADE)
    print(f"types.ts: {len(TYPES.splitlines())} lines")
    print(f"render.ts: {len(RENDER.splitlines())} lines")
    print(f"page.ts: {len(PAGE.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
