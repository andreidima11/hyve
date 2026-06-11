#!/usr/bin/env python3
"""Split static/js/features_admin_skills.ts into static/js/admin_skills/ modules."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIG = subprocess.check_output(
    ["git", "show", "HEAD:static/js/features_admin_skills.ts"],
    cwd=ROOT,
    text=True,
)
lines = ORIG.splitlines(keepends=True)
OUT = ROOT / "static/js/admin_skills"


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def fix_imports(text: str) -> str:
    return re.sub(r"from '\./", "from '../", text)


TYPES = chunk(6, 19).replace("interface ", "export interface ")

USERS = (
    """/**
 * Admin — user management.
 */
"""
    + fix_imports(chunk(1, 4))
    + "import type { AdminUser } from './types.js';\n\n"
    + chunk(22, 77)
)

SKILLS = (
    fix_imports(chunk(1, 4))
    + "import type { SkillSummary } from './types.js';\n"
    + "import { skillState } from './state.js';\n\n"
    + chunk(80, 80).replace("let skillEditName: string | null = null;", "")
    + re.sub(r"\bskillEditName\b", "skillState.editName", chunk(82, 218))
)

STATE = """/**
 * Skills editor — modal state.
 */
export const skillState = {
    editName: null as string | null,
};

"""

FACADE = """/**
 * Admin users + skills management.
 */
export { loadAdminUsers, createUser, deleteUser } from './admin_skills/users.js';

export {
    loadSkills,
    openSkillEdit,
    closeSkillEditModal,
    saveSkillEdit,
    deleteSkill,
    toggleSkillDesc,
    toggleSkillDisabled,
} from './admin_skills/skills.js';
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "types.ts").write_text(TYPES)
    (OUT / "state.ts").write_text(STATE)
    (OUT / "users.ts").write_text(USERS)
    (OUT / "skills.ts").write_text(SKILLS)
    (ROOT / "static/js/features_admin_skills.ts").write_text(FACADE)
    print(f"types.ts: {len(TYPES.splitlines())} lines")
    print(f"state.ts: {len(STATE.splitlines())} lines")
    print(f"users.ts: {len(USERS.splitlines())} lines")
    print(f"skills.ts: {len(SKILLS.splitlines())} lines")
    print(f"facade: {len(FACADE.splitlines())} lines")


if __name__ == "__main__":
    main()
