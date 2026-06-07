#!/usr/bin/env python3
"""Move inline extract logic from entity.py into extract.py for remaining components."""

from __future__ import annotations

import re
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


def _write(path: Path, lines: list[str]) -> None:
    path.write_text("".join(lines), encoding="utf-8")


def _dedent_method_body(lines: list[str], start: int, end: int) -> str:
    body = lines[start:end]
    if not body:
        return "    pass\n"
    # Drop first line (def ...) handled separately
    inner = body[1:]
    dedented = textwrap.dedent("".join(inner))
    return textwrap.indent(dedented.rstrip() + "\n", "    ")


def split_mosquitto() -> None:
    path = ROOT / "components" / "mosquitto" / "entity.py"
    lines = _read(path)
    marker = next(i for i, ln in enumerate(lines) if ln.startswith("# ── Discovery → entity"))
    extract_start = next(i for i, ln in enumerate(lines) if ln.strip() == "def extract_entities(self, payload: Any) -> list[dict[str, Any]]:")
    context_start = next(i for i, ln in enumerate(lines) if ln.startswith("    # ── Context ──"))
    helpers = lines[marker:]
    body = _dedent_method_body(lines, extract_start, context_start)

    extract_header = '''\
"""MQTT discovery and Zigbee2MQTT expose parsing → Hyve entities."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from integrations.entity_utils import slugify
from smart_home_registry import normalize_entity_record

log = logging.getLogger("integrations.mosquitto")

'''
    extract_fn = f"def extract_mosquitto_candidates(payload: Any) -> list[dict[str, Any]]:\n{body}\n"
    extract_path = ROOT / "components" / "mosquitto" / "extract.py"
    extract_path.write_text(extract_header + extract_fn + "".join(helpers), encoding="utf-8")

    import_block = (
        "from integrations.component_import import import_sibling\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_mosquitto_candidates = _extract_mod.extract_mosquitto_candidates\n"
        "_merge_payload = _extract_mod._merge_payload\n"
        "_drain_broker = _extract_mod._drain_broker\n"
        "_find_entity_record = _extract_mod._find_entity_record\n"
        "_build_command = _extract_mod._build_command\n"
        "_publish = _extract_mod._publish\n\n"
    )
    new_entity = lines[:marker]
    # Replace extract_entities method
    text = "".join(new_entity)
    text = re.sub(
        r"    def extract_entities\(self, payload: Any\) -> list\[dict\[str, Any\]\]:.*?"
        r"        return items\n",
        "    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n"
        "        return extract_mosquitto_candidates(payload)\n",
        text,
        count=1,
        flags=re.S,
    )
    if "extract_mosquitto_candidates" not in text:
        raise RuntimeError("mosquitto extract_entities replace failed")
    if "_extract_mod = import_sibling" not in text:
        text = text.replace(
            "_bridge_mod = import_sibling(Path(__file__).resolve().parent, \"bridge\")\n\n",
            "_bridge_mod = import_sibling(Path(__file__).resolve().parent, \"bridge\")\n\n" + import_block,
        )
    path.write_text(text, encoding="utf-8")
    print("split mosquitto")


def split_xiaomi() -> None:
    path = ROOT / "components" / "xiaomi_home" / "entity.py"
    text = path.read_text(encoding="utf-8")
    marker = "# ── entity mapping ──"
    idx = text.index(marker)
    mapping_block = text[idx:]
    entity_part = text[:idx].rstrip() + "\n"

    extract_header = '''\
"""Xiaomi Home MIoT profile → Hyve entity mapping."""

from __future__ import annotations

from typing import Any

import xiaomi_home_client as xh
from integrations.entity_utils import slugify

'''
    extract_fn = '''
def extract_xiaomi_home_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    profiles = payload.get("profiles") or {}
    out: list[dict[str, Any]] = []
    for did, profile in profiles.items():
        out.extend(_profile_to_entities(did, profile))
    return out
'''
    (ROOT / "components" / "xiaomi_home" / "extract.py").write_text(
        extract_header + mapping_block + extract_fn,
        encoding="utf-8",
    )

    entity_part = re.sub(
        r"    def extract_entities\(self, payload: Any\) -> list\[dict\[str, Any\]\]:.*?"
        r"        return out\n",
        "    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n"
        "        return extract_xiaomi_home_candidates(payload)\n",
        entity_part,
        count=1,
        flags=re.S,
    )
    if "extract_xiaomi_home_candidates" not in entity_part:
        raise RuntimeError("xiaomi extract replace failed")
    import_block = (
        "\nfrom pathlib import Path\n"
        "from integrations.component_import import import_sibling\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_xiaomi_home_candidates = _extract_mod.extract_xiaomi_home_candidates\n"
    )
    entity_part = entity_part.replace(
        "from integrations.entity_utils import slugify\n",
        import_block,
    )
    path.write_text(entity_part, encoding="utf-8")
    print("split xiaomi_home")


def split_roborock() -> None:
    path = ROOT / "components" / "roborock" / "entity.py"
    lines = _read(path)
    class_idx = next(i for i, ln in enumerate(lines) if ln.startswith("class RoborockEntity"))
    extract_start = next(i for i, ln in enumerate(lines) if ln.strip() == "def extract_entities(self, payload: Any) -> list[dict[str, Any]]:")
    extract_end = next(i for i, ln in enumerate(lines) if ln.startswith("    async def control_entity"))
    tail_start = next(i for i, ln in enumerate(lines) if ln.startswith("def _object_id("))

    extract_helpers = lines[74:232]  # _generic_state through _BINARY_SPECS
    extract_body = _dedent_method_body(lines, extract_start, extract_end)
    object_id_fn = lines[tail_start:]

    header = '''\
"""Roborock cloud snapshot → Hyve vacuum/sensor entities."""

from __future__ import annotations

from typing import Any

'''
    fn = "def extract_roborock_candidates(payload: Any) -> list[dict[str, Any]]:\n" + extract_body + "\n"
    extract_path = ROOT / "components" / "roborock" / "extract.py"
    _write(extract_path, [header, *extract_helpers, fn, *object_id_fn])

    new_entity = lines[:74] + lines[class_idx:extract_start]
    new_entity.append("    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n")
    new_entity.append("        return extract_roborock_candidates(payload)\n\n")
    new_entity.extend(lines[extract_end:tail_start])
    new_entity.append(
        "from pathlib import Path\n"
        "from integrations.component_import import import_sibling\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_roborock_candidates = _extract_mod.extract_roborock_candidates\n\n"
    )
    # insert import after future import block
    out = []
    for ln in new_entity:
        out.append(ln)
        if ln.strip() == "from typing import Any":
            out.append("\nfrom pathlib import Path\n")
            out.append("from integrations.component_import import import_sibling\n\n")
            out.append("_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n")
            out.append("extract_roborock_candidates = _extract_mod.extract_roborock_candidates\n")
    # dedupe - simpler rewrite
    text = "".join(lines[:74]) + "".join(lines[class_idx:extract_start])
    text += "    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n"
    text += "        return extract_roborock_candidates(payload)\n\n"
    text += "".join(lines[extract_end:tail_start])
    text = text.replace(
        "from typing import Any\n\nfrom integrations.base import BaseEntity\n",
        "from typing import Any\n\nfrom pathlib import Path\n"
        "from integrations.component_import import import_sibling\n"
        "from integrations.base import BaseEntity\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_roborock_candidates = _extract_mod.extract_roborock_candidates\n\n",
    )
    path.write_text(text, encoding="utf-8")
    print("split roborock")


def split_tapo() -> None:
    extract = '''\
"""Tapo/Kasa pre-built entity list passthrough."""

from __future__ import annotations

from typing import Any


def extract_tapo_candidates(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        items = payload.get("items")
        if isinstance(items, list):
            return items
    return []
'''
    (ROOT / "components" / "tapo" / "extract.py").write_text(extract, encoding="utf-8")
    path = ROOT / "components" / "tapo" / "entity.py"
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"    def extract_entities\(self, payload: Any\) -> list\[dict\[str, Any\]\]:.*?"
        r"        return \[\]\n",
        "    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n"
        "        return extract_tapo_candidates(payload)\n",
        text,
        count=1,
        flags=re.S,
    )
    if "extract_tapo_candidates" not in text:
        raise RuntimeError("tapo extract replace failed")
    text = text.replace(
        "from integrations.base import BaseEntity\n",
        "from pathlib import Path\n"
        "from integrations.component_import import import_sibling\n"
        "from integrations.base import BaseEntity\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_tapo_candidates = _extract_mod.extract_tapo_candidates\n\n",
    )
    path.write_text(text, encoding="utf-8")
    print("split tapo")


def split_frigate() -> None:
    path = ROOT / "components" / "frigate" / "entity.py"
    text = path.read_text(encoding="utf-8")

    # Pull extract-only class methods block
    start = text.index("    def _payload_parts(self")
    end = text.index("    def format_context(self")
    block = text[start:end]

    transforms = [
        (r"@staticmethod\n\s+", ""),
        (r"def _payload_parts\(self,", "def _payload_parts("),
        (r"def _base_attrs\(self,", "def _base_attrs("),
        (r"def _camera_attrs\(\s*\n\s*self,", "def _camera_attrs("),
        (r"def _append_sensor\(\s*\n\s*self,", "def _append_sensor("),
        (r"def _append_binary_sensor\(\s*\n\s*self,", "def _append_binary_sensor("),
        (r"def _append_switch\(\s*\n\s*self,", "def _append_switch("),
        (r"def _append_number\(\s*\n\s*self,", "def _append_number("),
        (r"def _append_select\(\s*\n\s*self,", "def _append_select("),
        (r"def extract_entities\(self, payload: Any\)", "def extract_frigate_candidates(payload: Any, entry_data: dict[str, Any] | None"),
        (r"self\._payload_parts", "_payload_parts"),
        (r"self\._base_url\(\)", "_base_url(entry_data)"),
        (r"self\._base_attrs", "_base_attrs"),
        (r"self\._camera_attrs", "_camera_attrs"),
        (r"self\._go2rtc_stream_name", "_go2rtc_stream_name"),
        (r"self\._append_sensor", "_append_sensor"),
        (r"self\._append_binary_sensor", "_append_binary_sensor"),
        (r"self\._append_switch", "_append_switch"),
        (r"self\._append_number", "_append_number"),
        (r"self\._append_select", "_append_select"),
        (r"self\.entry_data or \{\}", "entry_data or {}"),
        (r"FrigateEntity\._tracked_objects", "_tracked_objects"),
        (r"FrigateEntity\._go2rtc_stream_name", "_go2rtc_stream_name"),
        (r"FrigateEntity\._resolve_scheme", "_resolve_scheme"),
    ]
    for pat, repl in transforms:
        block = re.sub(pat, repl, block)

    header = '''\
"""Frigate NVR config/stats → Hyve camera and sensor entities."""

from __future__ import annotations

import logging
import re
from typing import Any

from integrations.entity_utils import slugify

log = logging.getLogger("integrations.frigate")

_TIMEOUT = 8.0
_UNKNOWN = "unknown"


'''
    helpers = text[text.index("def _as_bool"): text.index("\n\nclass FrigateEntity")]
    scheme_fn = '''
def _resolve_scheme(data: dict[str, Any]) -> str:
    port = int((data or {}).get("port") or 5000)
    return "https" if port in (8971, 443) else "http"


def _base_url(entry_data: dict[str, Any] | None) -> str:
    section = entry_data or {}
    scheme = _resolve_scheme(section)
    host = str(section.get("host") or "localhost").strip() or "localhost"
    port = int(section.get("port") or 5000)
    return f"{scheme}://{host}:{port}"


'''
    # Dedented class methods (4 spaces)
    block = textwrap.dedent(block)
    block = re.sub(r"^    ", "", block, flags=re.M)

    extract_path = ROOT / "components" / "frigate" / "extract.py"
    extract_path.write_text(header + helpers + scheme_fn + block, encoding="utf-8")

    new_text = text[: text.index("    def _payload_parts(self")]
    new_text += "    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:\n"
    new_text += "        return extract_frigate_candidates(payload, self.entry_data)\n\n"
    new_text += text[end:]
    new_text = re.sub(
        r"def _as_bool\(.*?def _dict_get\(.*?\n\n",
        "",
        new_text,
        count=1,
        flags=re.S,
    )
    new_text = new_text.replace(
        "from integrations.base import BaseEntity\n",
        "from pathlib import Path\n"
        "from integrations.component_import import import_sibling\n"
        "from integrations.base import BaseEntity\n\n"
        "_extract_mod = import_sibling(Path(__file__).resolve().parent, \"extract\")\n"
        "extract_frigate_candidates = _extract_mod.extract_frigate_candidates\n"
        "_as_bool = _extract_mod._as_bool\n"
        "_dict_get = _extract_mod._dict_get\n\n",
    )
    path.write_text(new_text, encoding="utf-8")
    print("split frigate")


def main() -> None:
    split_mosquitto()
    split_xiaomi()
    split_roborock()
    split_tapo()
    split_frigate()


if __name__ == "__main__":
    main()
