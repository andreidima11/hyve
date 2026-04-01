from __future__ import annotations

import subprocess
import sys
from shutil import which
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON = sys.executable


def _run_step(label: str, command: list[str]) -> int:
    print(f"\n==> {label}")
    print(" ".join(command))
    completed = subprocess.run(command, cwd=ROOT)
    return completed.returncode


def main() -> int:
    steps = [
        ("Python test suite", [PYTHON, "-m", "pytest", "-q"]),
        ("Frontend CSS build", [which("npm") or "npm", "run", "css:build"]),
        ("Release checks", [PYTHON, "scripts/release_checks.py"]),
    ]

    if which("npm") is None:
        print("\nRelease gate failed before execution: npm is not available in PATH")
        return 1

    for label, command in steps:
        code = _run_step(label, command)
        if code != 0:
            print(f"\nRelease gate failed during: {label}")
            return code

    print("\nRelease gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())