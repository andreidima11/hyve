#!/usr/bin/env python3
"""Split per-integration extractors from integrations/extractors.py into components/."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACTORS = ROOT / "integrations" / "extractors.py"
SRC = EXTRACTORS.read_text(encoding="utf-8")
LINES = SRC.splitlines(keepends=True)

HEADER = '''\
from __future__ import annotations

from typing import Any

from integrations.entity_utils import finalize_entities as _finalize, slugify

'''

# (slug, start_line_1based, end_line_1based_inclusive, export_name)
CHUNKS: list[tuple[str, int, int, str]] = [
    ("pago", 142, 276, "extract_pago_candidates"),
    ("eon_romania", 279, 751, "extract_eon_romania_candidates"),
    ("ariston_net", 752, 1086, "extract_ariston_net_candidates"),
    ("open_meteo", 1087, 1147, "extract_weather_candidates"),
    ("midea_ac", 1149, 1406, "extract_midea_ac_candidates"),  # includes module constants + helpers
    ("reteleelectrice", 1407, 2065, "extract_reteleelectrice_candidates"),
]


def slice_lines(start: int, end: int) -> str:
    return "".join(LINES[start - 1 : end])


def main() -> None:
    for slug, start, end, export_name in CHUNKS:
        dest = ROOT / "components" / slug / "extract.py"
        body = slice_lines(start, end)
        dest.write_text(HEADER + body, encoding="utf-8")
        print(f"wrote {dest} ({export_name})")

    fusion_src = ROOT / "components" / "fusion_solar" / "extract.py"
    fusion_dest = fusion_src
    text = fusion_src.read_text(encoding="utf-8")
    text = text.replace(
        "from core.smart_home_registry import normalize_entity_record\n\n\n"
        "def _slugify(value: str) -> str:\n"
        "    text = re.sub(r\"[^a-z0-9]+\", \"_\", (value or \"\").strip().lower())\n"
        "    return text.strip(\"_\") or \"device\"\n\n\n"
        "def _finalize(items: list[dict[str, Any]], default_source: str = \"\") -> list[dict[str, Any]]:\n"
        "    for item in items:\n"
        "        normalize_entity_record(item, default_source=default_source)\n"
        "    return items\n",
        "from integrations.entity_utils import finalize_entities as _finalize, slugify as _slugify\n",
    )
    fusion_dest.write_text(text, encoding="utf-8")
    print(f"wrote {fusion_dest}")


if __name__ == "__main__":
    main()
