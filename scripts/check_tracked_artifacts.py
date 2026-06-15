#!/usr/bin/env python3
"""Fail if build/cache artifacts are tracked in git (prevents update dirty-tree surprises)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.update_git_tree import is_forbidden_tracked_path


def forbidden_tracked_files() -> list[str]:
    proc = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return []
    return sorted(
        line.strip()
        for line in (proc.stdout or "").splitlines()
        if line.strip() and is_forbidden_tracked_path(line.strip())
    )


def main() -> int:
    bad = forbidden_tracked_files()
    if not bad:
        print("Tracked-artifact check passed.")
        return 0
    print("Tracked-artifact check failed — remove these from git index:")
    for path in bad[:40]:
        print(f" - {path}")
    if len(bad) > 40:
        print(f" ... and {len(bad) - 40} more")
    print("\nRemediation: git rm --cached <path>  (files stay on disk; .gitignore keeps them out)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
