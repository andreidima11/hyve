#!/usr/bin/env python3
"""Deprecated alias — use scripts/install_hyve.py."""
from __future__ import annotations

import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("install_hyve.py")), run_name="__main__")
