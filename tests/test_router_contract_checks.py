"""Router HTTP error contract checks."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_router_contract_script_passes():
    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_router_contracts.py")],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
