#!/usr/bin/env python3
"""Fix indentation in frigate/extract.py after automated split."""

from __future__ import annotations

import re
from pathlib import Path

path = Path(__file__).resolve().parent.parent / "components" / "frigate" / "extract.py"
lines = path.read_text(encoding="utf-8").splitlines()

out: list[str] = []
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith("def "):
        line = line.replace("( payload", "(payload")
        line = line.replace(
            "entry_data: dict[str, Any] | None ->",
            "entry_data: dict[str, Any] | None = None) ->",
        )
        out.append(line)
        i += 1
        while i < len(lines) and not lines[i].startswith("def "):
            body = lines[i]
            if body.strip():
                if not body.startswith("    "):
                    body = "    " + body
            out.append(body)
            i += 1
        out.append("")
    else:
        out.append(line)
        i += 1

path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
print("fixed frigate extract indentation")
