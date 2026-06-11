#!/usr/bin/env python3
"""Regenerate all feature + submodule splits (run from repo root)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FEATURE = [
    "split_features_smarthome",
    "split_features_scenes",
    "split_features_areas",
    "split_features_memory",
    "split_features_apps",
    "split_features_derived",
]

SUBMODULE = [
    "split_smarthome_devices",
    "split_smarthome_modals",
    "split_scenes_page",
    "split_areas_page",
    "split_memory_page",
    "split_apps_page",
    "split_derived_page",
]


def run(name: str) -> None:
    script = ROOT / "scripts" / f"{name}.py"
    print(f"--- {name} ---")
    subprocess.run([sys.executable, str(script)], cwd=ROOT, check=True)


def main() -> None:
    for name in FEATURE + SUBMODULE:
        run(name)
    print("Done. Run: npm run js:build")


if __name__ == "__main__":
    main()
