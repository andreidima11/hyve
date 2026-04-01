#!/usr/bin/env python3
"""Quick smoke test for direct_commands regex parsing."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from direct_commands import _parse_regex_multi

tests = [
    # Simple direct commands
    ("aprinde becul", [("turn_on", "becul")]),
    ("stinge lumina", [("turn_off", "lumina")]),
    ("turn on bedroom light", [("turn_on", "bedroom light")]),
    ("turn off the fan", [("turn_off", "fan")]),
    # Natural language
    ("fa lumina", [("turn_on", "lumina")]),
    ("da drumul la aer", [("turn_on", "aer")]),
    ("taie lumina", [("turn_off", "lumina")]),
    ("vreau becul aprins", [("turn_on", "becul")]),
    # Explicit multi-step commands should still parse directly
    ("aprinde becul și stinge lampa", [("turn_on", "becul"), ("turn_off", "lampa")]),
    # Coordinated multi-target commands should defer to semantic path
    ("turn off kitchen and bedroom lights", []),
    ("stinge luminile din sufragerie și dormitor", []),
    ("aprinde toate luminile", []),
    # Non-device requests
    ("ce vreme e?", []),
    ("salut", []),
]

ok = fail = 0
for msg, expected in tests:
    result = _parse_regex_multi(msg)
    if result == expected:
        print(f"  OK    {msg!r} -> {result}")
        ok += 1
    else:
        print(f"  FAIL  {msg!r} -> {result}  (expected {expected})")
        fail += 1

print(f"\n{ok}/{ok + fail} passed, {fail} failed")
