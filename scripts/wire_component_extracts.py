#!/usr/bin/env python3
"""Point component entity.py files at local extract.py modules."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ENTITY_EXTRACT = {
    "pago": "extract_pago_candidates",
    "fusion_solar": "extract_fusion_solar_candidates",
    "ariston_net": "extract_ariston_net_candidates",
    "eon_romania": "extract_eon_romania_candidates",
    "reteleelectrice": "extract_reteleelectrice_candidates",
    "open_meteo": "extract_weather_candidates",
    "midea_ac": "extract_midea_ac_candidates",
}

SLUGIFY_ONLY = ["frigate", "mosquitto", "reolink", "tapo", "xiaomi_home"]

LOCAL_IMPORT = '''\
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
{assignments}
'''

for slug, fn in ENTITY_EXTRACT.items():
    entity = ROOT / "components" / slug / "entity.py"
    text = entity.read_text(encoding="utf-8")
    text = re.sub(
        r"from integrations\.extractors import .+\n",
        "",
        text,
    )
    assignments = f"{fn} = _extract_mod.{fn}\n"
    block = LOCAL_IMPORT.format(assignments=assignments)
    if "_extract_mod" not in text:
        text = text.replace(
            "from integrations.base import BaseEntity\n",
            "from integrations.base import BaseEntity\n" + block,
            1,
        )
    entity.write_text(text, encoding="utf-8")
    print(f"updated {entity}")

for slug in SLUGIFY_ONLY:
    for rel in (f"components/{slug}/entity.py", f"components/{slug}/registry.py"):
        path = ROOT / rel
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(
            r"from integrations\.extractors import slugify\n",
            "from integrations.entity_utils import slugify\n",
            text,
        )
        path.write_text(text, encoding="utf-8")
        print(f"updated {path}")
